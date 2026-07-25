import { CLAUDE_MODEL, Money, STRATEGY, STRATEGY_VERSION, TOKEN_UNIVERSE } from '@horizon/shared';
import {
  countOpenPositions,
  getAllTokenStats,
  getBotConfig,
  getOpenPositions,
  insertExecutionCostForecast,
  insertQuantitativeDecision,
  insertSignalCandidate,
  logActivity,
  shrunkWinRate,
  updateBotConfig,
} from '../db/queries';
import { CoinbaseError, getCandles, getProduct } from './coinbase';
import { evaluateSignal } from './claude';
import { detectBestMode, type MarketSnapshot } from './modes';
import { closePosition, getPortfolioCash, openPosition, shouldExit } from './executor';
import { getMarketWindow, isTradeableNow } from './marketWindow';
import { withRenewingLease, SCAN_LEASE_KEY, type Lease } from '../jobs/lease';
import { getCurrentFeeTierOrFailClosed } from './feeTier';
import { previewCandidate } from './preview';
import { buildCostForecast, COST_MODEL_VERSION } from './costModel';
import { applyEvGate, EV_GATE_VERSION } from './evGate';
import { ENV } from '../env';

/** Bumps when the feature set persisted with each candidate row changes. */
const FEATURE_VERSION = 'p1s1-1';

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

  // Phase 1.1.a §H: renewing lease with fencing token. TTL 90s; renewal
  // fires every ~30s while the scan is running. Every entry-open call must
  // recheck lease.isValid() so a worker whose renewal failed cannot commit
  // an entry a fresher holder is about to take.
  const leased = await withRenewingLease(SCAN_LEASE_KEY, 90_000, async (lease) => {
    await scanForEntries(lease);
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
      const currentPrice = Money.fromString(product.price);
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

export async function scanForEntries(lease?: Lease): Promise<void> {
  // Reload config here (not before manageOpenRisk) so a CB triggered by an
  // exit above blocks entries in this same cycle.
  const cfg = await getBotConfig();

  if (cfg.reconciliationStatus !== 'ok') {
    const label =
      cfg.reconciliationStatus === 'degraded'
        ? 'GLOBAL UNKNOWN-ORDER LOCK ENGAGED'
        : `reconciliation ${cfg.reconciliationStatus}`;
    await logActivity({
      type: 'scan',
      severity: cfg.reconciliationStatus === 'degraded' ? 'critical' : 'warn',
      action: 'SKIP_ENTRIES',
      detail: `Entries blocked: ${label}${cfg.reconciliationDetail ? ` — ${cfg.reconciliationDetail}` : ''}`,
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

  await selectAndOpenEntries(lease);
}

async function selectAndOpenEntries(lease?: Lease): Promise<void> {
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

  // Fetch the fee tier ONCE per cycle — fail-closed if unavailable. Every
  // cost forecast in this cycle links to the resulting snapshot id.
  let feeTier: Awaited<ReturnType<typeof getCurrentFeeTierOrFailClosed>>;
  try {
    feeTier = await getCurrentFeeTierOrFailClosed();
  } catch (err) {
    await logActivity({
      type: 'system',
      severity: 'critical',
      action: 'SCAN_ABORTED_FEE_TIER',
      detail: `Fee tier unavailable — aborting entry scan. ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return;
  }

  const bankroll = await getPortfolioCash();
  const marketWindow = getMarketWindow();

  let opened = 0;
  let passedSignal = 0;
  let evGateRejects = 0;

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

    // --------- Record the candidate (immutable) ---------
    const candidateRow = await insertSignalCandidate({
      scanSeed,
      token: c.token,
      mode: evaluation.mode,
      scanPrice: String(c.price),
      volume24h: String(c.volume24h),
      changePct24h: String(c.changePct24h),
      rsi: signals.rsi !== null ? String(signals.rsi) : null,
      macdHistogram:
        signals.macdHistogram !== null ? String(signals.macdHistogram) : null,
      emaTrend: signals.emaTrend,
      bollingerPosition: signals.bollingerPosition,
      passedSignals: signals.passedSignals,
      totalSignals: signals.totalSignals,
      tokenWinRate: c.winRate !== null ? String(c.winRate) : null,
      tokenTradeCount: null,
      strategyVersion: STRATEGY_VERSION,
      featureVersion: FEATURE_VERSION,
      regimeLabel: 'unclassified', // regime engine arrives in slice 2
      regimeConfidence: null,
      marketWindow,
    });

    // --------- Size (win-rate adjustment) ---------
    let allocationPct = modeCfg.allocationPct;
    if (c.winRate !== null && c.winRate < STRATEGY.WIN_RATE_REDUCE) {
      allocationPct = STRATEGY.WIN_RATE_REDUCED_PCT;
    }
    const quoteSize = bankroll.pct(allocationPct);

    // --------- Preview (Phase 1 §B) ---------
    const arrivalMid = Money.fromNumber(c.price);
    const previewResult = await previewCandidate({
      intent: {
        side: 'BUY',
        token: c.token,
        clientOrderId: '__preview__',
        quoteSize: quoteSize.toDecimalString(),
      },
      arrivalMid,
      takerRate: feeTier.takerFeeRate,
    });

    if (previewResult.status === 'rejected') {
      await insertQuantitativeDecision({
        candidateId: candidateRow.id,
        costForecastId: null,
        decision:
          previewResult.reason === 'preview_warning'
            ? 'reject_preview_warning'
            : previewResult.reason === 'preview_failure'
              ? 'reject_preview_error'
              : previewResult.reason === 'missing_commission' ||
                  previewResult.reason === 'missing_est_avg_fill'
                ? 'reject_data_stale'
                : 'reject_preview_error',
        rejectionReason: previewResult.detail.slice(0, 250),
        rejectionDetail: { reason: previewResult.reason, warnings: previewResult.warnings },
        netTpPnl: null,
        netSlPnl: null,
        netRewardRisk: null,
        expectedValue: null,
        breakEvenWinProb: null,
        strategyVersion: STRATEGY_VERSION,
        costModelVersion: COST_MODEL_VERSION,
        evGateVersion: EV_GATE_VERSION,
      });
      continue;
    }

    // --------- Cost forecast (Phase 1 §D, MV) ---------
    const forecast = buildCostForecast({
      token: c.token,
      mode: evaluation.mode,
      arrivalMid,
      takeProfitPct: modeCfg.takeProfitPct,
      stopLossPct: modeCfg.stopLossPct,
      feeTier,
      preview: previewResult,
    });

    const forecastRow = await insertExecutionCostForecast({
      candidateId: candidateRow.id,
      feeTierSnapshotId: feeTier.snapshotId,
      previewOrderTotal: previewResult.orderTotal?.toDecimalString() ?? null,
      previewCommissionTotal: previewResult.commissionTotal.toDecimalString(),
      previewBestBid: previewResult.bestBid?.toDecimalString() ?? null,
      previewBestAsk: previewResult.bestAsk?.toDecimalString() ?? null,
      previewEstimatedAvgFillPrice: previewResult.estimatedAvgFillPrice.toDecimalString(),
      previewBaseSize: previewResult.baseSize?.toDecimalString() ?? null,
      previewQuoteSize: previewResult.quoteSize?.toDecimalString() ?? null,
      arrivalMid: forecast.arrivalMid.toDecimalString(),
      spreadBps: forecast.spreadBps.toDecimalString(4),
      entryFee: forecast.entryFee.toDecimalString(),
      exitFeeEstimate: forecast.exitFeeEstimate.toDecimalString(),
      entryImpactBps: forecast.entryImpactBps.toDecimalString(4),
      exitImpactBpsEstimate: forecast.exitImpactBpsEstimate.toDecimalString(4),
      latencySlippageBpsEstimate: forecast.latencySlippageBpsEstimate.toDecimalString(4),
      roundTripCost: forecast.roundTripCost.toDecimalString(),
      costToTargetPct: forecast.costToTargetPct.toDecimalString(4),
      takeProfitPrice: forecast.takeProfitPrice.toDecimalString(),
      stopLossPrice: forecast.stopLossPrice.toDecimalString(),
      netTpPnl: forecast.netTpPnl.toDecimalString(),
      netSlPnl: forecast.netSlPnl.toDecimalString(),
      netRewardRisk: forecast.netRewardRisk ? forecast.netRewardRisk.toDecimalString(4) : null,
      breakEvenWinProb: forecast.breakEvenWinProb
        ? forecast.breakEvenWinProb.toDecimalString(4)
        : null,
      costModelVersion: forecast.costModelVersion,
      exitCostQuantile: String(forecast.exitCostQuantile),
      previewWarnings: previewResult.warnings.length > 0 ? previewResult.warnings : null,
      previewRawResponse: previewResult.raw as unknown as Record<string, unknown>,
    });

    // --------- EV / cost / R/R gate (Phase 1 §E) ---------
    const gate = applyEvGate(forecast);
    const decisionRow = await insertQuantitativeDecision({
      candidateId: candidateRow.id,
      costForecastId: forecastRow.id,
      decision: gate.decision,
      rejectionReason: gate.decision === 'accept' ? null : gate.reason.slice(0, 250),
      rejectionDetail: gate.detail,
      netTpPnl: forecast.netTpPnl.toDecimalString(),
      netSlPnl: forecast.netSlPnl.toDecimalString(),
      netRewardRisk: forecast.netRewardRisk ? forecast.netRewardRisk.toDecimalString(4) : null,
      expectedValue: gate.expectedValue.toDecimalString(),
      breakEvenWinProb: forecast.breakEvenWinProb
        ? forecast.breakEvenWinProb.toDecimalString(4)
        : null,
      strategyVersion: STRATEGY_VERSION,
      costModelVersion: forecast.costModelVersion,
      evGateVersion: gate.version,
    });

    if (gate.decision !== 'accept') {
      evGateRejects++;
      await logActivity({
        type: 'signal',
        token: c.token,
        action: 'EV_GATE_REJECT',
        severity: 'info',
        detail: `${evaluation.mode} ${gate.decision}: ${gate.reason} — netTP=${forecast.netTpPnl.toDecimalString(
          2,
        )}, R/R=${forecast.netRewardRisk ? forecast.netRewardRisk.toDecimalString(2) : 'n/a'}`,
      });
      continue;
    }

    // --------- Claude (only after ALL quantitative gates pass) ---------
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

    await logActivity({
      type: 'signal',
      token: c.token,
      action: 'SIGNAL_CONFIRMED',
      detail: `${evaluation.mode} confirmed @ ${(claude.confidence * 100).toFixed(0)}% — ${claude.reason}`,
    });

    // Phase 1.1.a §H: re-check the fencing lease before committing an entry.
    // A long scan may have lost its lease to a fresher replica; if so, abort
    // rather than compete with the new writer.
    if (lease && !lease.isValid()) {
      await logActivity({
        type: 'scan',
        severity: 'warn',
        action: 'LEASE_LOST_MID_SCAN',
        detail: `Fence generation ${lease.fenceGeneration} lost the lease before opening ${c.token} — aborting remaining entries`,
      });
      break;
    }

    const result = await openPosition({
      token: c.token,
      mode: evaluation.mode,
      scanPrice: c.price,
      allocationPct,
      claudeReason: claude.reason,
      claudeModel: CLAUDE_MODEL,
      claudeConfidence: claude.confidence,
      decisionId: decisionRow.id, // §B: stable economic identity
    });
    if (result.kind === 'opened') opened++;
  }

  await logActivity({
    type: 'scan',
    action: 'SCAN_COMPLETE',
    detail: `Scanned ${scanned}, ${passedVolume} passed volume, ${evGateRejects} rejected by EV gate, ${passedSignal} Claude-confirmed, ${opened} opened (strategy v${STRATEGY_VERSION}, feeTier ${feeTier.pricingTier}${feeTier.synthetic ? '/synthetic' : ''})`,
    tokensScanned: scanned,
    passedVolumeFilter: passedVolume,
    passedSignalThreshold: passedSignal,
  });
}
