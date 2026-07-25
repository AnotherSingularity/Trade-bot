import { STRATEGY, STRATEGY_VERSION, TOKEN_UNIVERSE } from '@horizon/shared';
import {
  countOpenPositions,
  getAllTokenStats,
  getBotConfig,
  getOpenPositions,
  logActivity,
  shrunkWinRate,
  updateBotConfig,
} from '../db/queries';
import { CLAUDE_MODEL } from '@horizon/shared';
import { CoinbaseError, getCandles, getProduct } from './coinbase';
import { evaluateSignal } from './claude';
import { detectBestMode, type MarketSnapshot } from './modes';
import { closePosition, openPosition, shouldExit } from './executor';
import { getMarketWindow, isTradeableNow } from './marketWindow';
import { withLease, SCAN_LEASE_KEY } from '../jobs/lease';
import { ENV } from '../env';

/**
 * Scan cycle — rebuilt to enforce Phase 0 semantics:
 *
 *   • manageOpenRisk() ALWAYS runs — regardless of isRunning, isPaused,
 *     window, or circuit breaker. Existing exposure is never abandoned.
 *   • scanForEntries() is gated on all four AND on completed startup
 *     reconciliation. It also RELOADS bot config after risk management so a
 *     circuit breaker tripped by an exit inside the same cycle blocks entries
 *     in that same cycle.
 *   • The whole cycle runs under a Redis leader lease so only one replica can
 *     open positions at a time.
 */

export async function runScanCycle(): Promise<void> {
  // Lease guards ENTRY submission. Risk management still runs even if we
  // don't hold the lease so a lagging replica doesn't leave exposure unmanaged;
  // executor's per-position optimistic lock prevents duplicate exits.
  await manageOpenRisk();

  const leased = await withLease(SCAN_LEASE_KEY, 2 * 60 * 1000, async () => {
    await scanForEntries();
    return true;
  });
  if (!leased.ran) {
    await logActivity({
      type: 'scan',
      severity: 'info',
      action: 'LEASE_HELD_ELSEWHERE',
      detail: 'Another replica held the scan lease — entry scan skipped',
    });
  }
}

// ---------------------------------------------------------------------------
// Risk management — always runs
// ---------------------------------------------------------------------------

export async function manageOpenRisk(): Promise<void> {
  const open = await getOpenPositions();
  for (const position of open) {
    try {
      const product = await getProduct(position.token);
      const currentPrice = Number(product.price);
      const decision = shouldExit(position, currentPrice);
      if (decision.exit) {
        const result = await closePosition(position, decision.reason);
        if (result.kind !== 'closed') {
          await logActivity({
            type: 'error',
            severity: 'high',
            token: position.token,
            action: 'EXIT_NOT_COMPLETED',
            detail: `${decision.reason} attempted, result=${result.kind} reason=${result.reason}`,
          });
        }
      }
    } catch (err) {
      const msg =
        err instanceof CoinbaseError
          ? `${err.class}:${err.code} ${err.message}`
          : err instanceof Error
            ? err.message
            : 'unknown';
      await logActivity({
        type: 'error',
        severity: 'warn',
        token: position.token,
        action: 'MANAGE_FAILED',
        detail: msg,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry scanning — gated
// ---------------------------------------------------------------------------

export async function scanForEntries(): Promise<void> {
  // Reload config here (not before manageOpenRisk) so a CB triggered by an
  // exit above blocks entries in this same cycle.
  const cfg = await getBotConfig();

  if (cfg.reconciliationStatus !== 'ok') {
    await logActivity({
      type: 'scan',
      severity: 'warn',
      action: 'SKIP_ENTRIES',
      detail: `Startup reconciliation not complete (${cfg.reconciliationStatus})`,
    });
    return;
  }
  if (!cfg.isRunning) return;
  if (cfg.isPaused) {
    await logActivity({ type: 'scan', action: 'SKIP_ENTRIES', detail: 'Bot is paused' });
    return;
  }
  if (cfg.circuitBreakerUntil && cfg.circuitBreakerUntil > new Date()) {
    await logActivity({
      type: 'scan',
      severity: 'warn',
      action: 'SKIP_ENTRIES',
      detail: `Circuit breaker active until ${cfg.circuitBreakerUntil.toISOString()}`,
    });
    return;
  }
  // Clear expired CB.
  if (cfg.circuitBreakerUntil && cfg.circuitBreakerUntil <= new Date()) {
    await updateBotConfig({ circuitBreakerUntil: null, consecutiveLosses: 0 });
    await logActivity({
      type: 'system',
      action: 'CIRCUIT_RESET',
      detail: 'Circuit breaker cleared',
    });
  }

  if (!isTradeableNow()) {
    await logActivity({
      type: 'scan',
      action: 'SKIP_ENTRIES',
      detail: `Outside trading window (${getMarketWindow()})`,
    });
    return;
  }

  await selectAndOpenEntries();
}

async function selectAndOpenEntries(): Promise<void> {
  const openCount = await countOpenPositions();
  const availableSlots = STRATEGY.MAX_OPEN_POSITIONS - openCount;
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

  // Score EVERY eligible token first, then rank — no more "first past the post"
  // ordering bias. Uses Bayesian-shrunk win rate so a token with a single win
  // doesn't dominate.
  interface Candidate {
    token: string;
    price: number;
    volume24h: number;
    changePct24h: number;
    winRate: number | null;
    priorityScore: number;
    closes: number[];
    candles: unknown[];
  }
  const eligible = TOKEN_UNIVERSE.filter((t) => {
    const s = statByToken.get(t);
    return (s?.isActive ?? true) && !openTokens.has(t);
  });

  const scanSeed = new Date().toISOString();
  const candidates: Candidate[] = [];
  let scanned = 0;
  let passedVolume = 0;

  for (const token of eligible) {
    scanned++;
    try {
      const product = await getProduct(token);
      const price = Number(product.price);
      const volume24hBase = Number(product.volume_24h);
      const volume24h = volume24hBase * price;
      const changePct24h = Number(product.price_percentage_change_24h);
      if (volume24h < STRATEGY.MIN_VOLUME_24HR) continue;
      passedVolume++;
      const { closes, candles } = await getCandles(token, 'ONE_HOUR', 100);
      const s = statByToken.get(token);
      const winRate = s && s.totalTrades > 0 ? shrunkWinRate(s.wins, s.losses) : null;
      candidates.push({
        token,
        price,
        volume24h,
        changePct24h,
        winRate,
        priorityScore: winRate ?? 50,
        closes,
        candles,
      });
    } catch (err) {
      const msg =
        err instanceof CoinbaseError
          ? `${err.class}:${err.code} ${err.message}`
          : err instanceof Error
            ? err.message
            : 'unknown';
      await logActivity({
        type: 'error',
        severity: 'warn',
        token,
        action: 'SCAN_FETCH_FAILED',
        detail: msg,
      });
    }
  }

  // Rank by shrunk win rate, then evaluate modes.
  candidates.sort((a, b) => b.priorityScore - a.priorityScore);

  let opened = 0;
  let passedSignal = 0;
  for (const c of candidates) {
    if (opened >= availableSlots) break;

    const snapshot: MarketSnapshot = {
      token: c.token,
      price: c.price,
      volume24h: c.volume24h,
      changePct24h: c.changePct24h,
      closes: c.closes,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candles: c.candles as any,
      winRate: c.winRate,
    };
    const detected = detectBestMode(snapshot);
    if (!detected) continue;

    const { evaluation, signals } = detected;
    const modeCfg = STRATEGY.MODES[evaluation.mode];

    const claude = ENV.anthropicConfigured
      ? await evaluateSignal(evaluation.mode, signals)
      : { confidence: 0, shouldEnter: false, reason: 'Anthropic not configured' };

    if (!claude.shouldEnter || claude.confidence < modeCfg.claudeThreshold) {
      await logActivity({
        type: 'signal',
        token: c.token,
        action: 'SIGNAL_REJECTED',
        detail: `${evaluation.mode} ${evaluation.passedSignals}/${evaluation.totalSignals}; Claude ${(claude.confidence * 100).toFixed(
          0,
        )}% < ${(modeCfg.claudeThreshold * 100).toFixed(0)}% — ${claude.reason}`,
      });
      continue;
    }
    passedSignal++;

    let allocationPct = modeCfg.allocationPct;
    if (c.winRate !== null && c.winRate < STRATEGY.WIN_RATE_REDUCE) {
      allocationPct = STRATEGY.WIN_RATE_REDUCED_PCT;
    }

    await logActivity({
      type: 'signal',
      token: c.token,
      action: 'SIGNAL_CONFIRMED',
      detail: `${evaluation.mode} confirmed @ ${(claude.confidence * 100).toFixed(0)}% — ${claude.reason}`,
    });

    const result = await openPosition({
      token: c.token,
      mode: evaluation.mode,
      scanPrice: c.price,
      allocationPct,
      claudeReason: claude.reason,
      claudeModel: CLAUDE_MODEL,
      claudeConfidence: claude.confidence,
      scanSeed,
    });
    if (result.kind === 'opened') opened++;
  }

  await logActivity({
    type: 'scan',
    action: 'SCAN_COMPLETE',
    detail: `Scanned ${scanned}, ${passedVolume} passed volume, ${passedSignal} confirmed, ${opened} opened (strategy v${STRATEGY_VERSION})`,
    tokensScanned: scanned,
    passedVolumeFilter: passedVolume,
    passedSignalThreshold: passedSignal,
  });
}
