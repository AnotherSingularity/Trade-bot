import { STRATEGY, TOKEN_UNIVERSE } from '@horizon/shared';
import {
  countOpenPositions,
  getAllTokenStats,
  getBotConfig,
  getOpenPositions,
  logActivity,
  updateBotConfig,
} from '../db/queries';
import { getCandles, getProduct } from './coinbase';
import { evaluateSignal } from './claude';
import { detectBestMode, type MarketSnapshot } from './modes';
import { closePositionAtPrice, openPosition, shouldExit } from './executor';
import { getMarketWindow, isTradeableNow } from './marketWindow';
import { ENV } from '../env';

/**
 * The scan cycle — the heart of the bot. Runs every 5 minutes via BullMQ.
 *
 * Order of operations:
 *  1. Gatekeeping (running / paused / circuit breaker / market window).
 *  2. Manage open positions → exit on TP/SL/early-exit.
 *  3. Scan token universe for new entries (respecting max positions + filters).
 */
export async function runScanCycle(): Promise<void> {
  const cfg = await getBotConfig();

  if (!cfg.isRunning) return;
  if (cfg.isPaused) {
    await logActivity({ type: 'scan', action: 'SKIP', detail: 'Bot is paused' });
    return;
  }

  // Circuit breaker check (auto-clears when the timeout passes).
  if (cfg.circuitBreakerUntil && cfg.circuitBreakerUntil > new Date()) {
    await logActivity({
      type: 'scan',
      action: 'SKIP',
      detail: `Circuit breaker active until ${cfg.circuitBreakerUntil.toISOString()}`,
    });
    return;
  }
  if (cfg.circuitBreakerUntil && cfg.circuitBreakerUntil <= new Date()) {
    await updateBotConfig({ circuitBreakerUntil: null, consecutiveLosses: 0 });
    await logActivity({ type: 'system', action: 'CIRCUIT_RESET', detail: 'Circuit breaker cleared' });
  }

  // Always manage existing positions, even outside trade windows.
  await manageOpenPositions();

  if (!isTradeableNow()) {
    await logActivity({
      type: 'scan',
      action: 'SKIP',
      detail: `Outside trading window (${getMarketWindow()})`,
    });
    return;
  }

  await scanForEntries();
}

/** Checks every open position against its exit rules using live prices. */
export async function manageOpenPositions(): Promise<void> {
  const open = await getOpenPositions();
  for (const position of open) {
    try {
      const product = await getProduct(position.token);
      const currentPrice = Number(product.price);
      const decision = shouldExit(position, currentPrice);
      if (decision.exit) {
        await closePositionAtPrice(position, currentPrice, decision.reason);
      }
    } catch (err) {
      await logActivity({
        type: 'error',
        token: position.token,
        action: 'MANAGE_FAILED',
        detail: err instanceof Error ? err.message : 'Failed to evaluate exit',
      });
    }
  }
}

/** Scans the token universe and opens qualifying positions. */
export async function scanForEntries(): Promise<void> {
  const openCount = await countOpenPositions();
  let availableSlots = STRATEGY.MAX_OPEN_POSITIONS - openCount;

  if (availableSlots <= 0) {
    await logActivity({
      type: 'scan',
      action: 'SCAN_COMPLETE',
      detail: `Max positions open (${openCount}/${STRATEGY.MAX_OPEN_POSITIONS})`,
      tokensScanned: 0,
    });
    return;
  }

  const stats = await getAllTokenStats();
  const statByToken = new Map(stats.map((s) => [s.token, s]));
  const openTokens = new Set((await getOpenPositions()).map((p) => p.token));

  // Prioritize tokens with high historical win rate.
  const candidates = [...TOKEN_UNIVERSE]
    .filter((t) => {
      const s = statByToken.get(t);
      // Skip deactivated tokens and tokens we already hold.
      return (s?.isActive ?? true) && !openTokens.has(t);
    })
    .sort((a, b) => (Number(statByToken.get(b)?.winRate ?? 0)) - (Number(statByToken.get(a)?.winRate ?? 0)));

  let scanned = 0;
  let passedVolume = 0;
  let passedSignal = 0;

  for (const token of candidates) {
    if (availableSlots <= 0) break;
    scanned++;
    try {
      const product = await getProduct(token);
      const price = Number(product.price);
      const volume24h = Number(product.volume_24h) * price; // volume in base × price ≈ USD
      const changePct24h = Number(product.price_percentage_change_24h);

      if (volume24h < STRATEGY.MIN_VOLUME_24HR) continue;
      passedVolume++;

      const { closes, candles } = await getCandles(token, 'ONE_HOUR', 100);
      const statRow = statByToken.get(token);
      const winRate = statRow && statRow.totalTrades > 0 ? Number(statRow.winRate) : null;

      const snapshot: MarketSnapshot = {
        token,
        price,
        volume24h,
        changePct24h,
        closes,
        candles,
        winRate,
      };

      const detected = detectBestMode(snapshot);
      if (!detected) continue;

      const { evaluation, signals } = detected;
      const modeCfg = STRATEGY.MODES[evaluation.mode];

      // Claude confirmation.
      const claude = ENV.anthropicConfigured
        ? await evaluateSignal(evaluation.mode, signals)
        : { confidence: 0, shouldEnter: false, reason: 'Anthropic not configured — skipped' };

      if (!claude.shouldEnter || claude.confidence < modeCfg.claudeThreshold) {
        await logActivity({
          type: 'signal',
          token,
          action: 'SIGNAL_REJECTED',
          detail: `${evaluation.mode} ${evaluation.passedSignals}/${evaluation.totalSignals} signals; Claude ${(
            claude.confidence * 100
          ).toFixed(0)}% < ${(modeCfg.claudeThreshold * 100).toFixed(0)}% — ${claude.reason}`,
        });
        continue;
      }
      passedSignal++;

      // Win-rate based allocation adjustment.
      let allocationPct = modeCfg.allocationPct;
      if (winRate !== null && winRate < STRATEGY.WIN_RATE_REDUCE) {
        allocationPct = STRATEGY.WIN_RATE_REDUCED_PCT;
      }

      await logActivity({
        type: 'signal',
        token,
        action: 'SIGNAL_CONFIRMED',
        detail: `${evaluation.mode} confirmed @ ${(claude.confidence * 100).toFixed(0)}% — ${claude.reason}`,
      });

      const opened = await openPosition({
        token,
        mode: evaluation.mode,
        price,
        allocationPct,
        claudeReason: claude.reason,
      });
      if (opened) availableSlots--;
    } catch (err) {
      await logActivity({
        type: 'error',
        token,
        action: 'SCAN_FAILED',
        detail: err instanceof Error ? err.message : 'Scan error',
      });
    }
  }

  await logActivity({
    type: 'scan',
    action: 'SCAN_COMPLETE',
    detail: `Scanned ${scanned} tokens, ${passedVolume} passed volume, ${passedSignal} confirmed`,
    tokensScanned: scanned,
    passedVolumeFilter: passedVolume,
    passedSignalThreshold: passedSignal,
  });
}
