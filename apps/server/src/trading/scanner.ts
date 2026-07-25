import { createHash } from 'node:crypto';
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
import {
  completeScanRun,
  createDecisionChain,
  recordEligibility,
  recordObservation,
  recordRoutingDecision,
  recordSetupEvaluation,
  startScanRun,
  transitionChainStatus,
  type ChainStatus,
} from '../db/lineage';
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

  // Phase 1.1 Gate 2: every scan attempt creates a scan_run record —
  // including scans that are blocked before per-token evaluation. Blocking
  // conditions attach to scan_runs (bot-wide), not to per-token chains.
  const scanRun = await startScanRun({
    triggerType: 'scheduled',
    scannerVersion: STRATEGY_VERSION,
    botState: cfg.isRunning ? (cfg.isPaused ? 'paused' : 'running') : 'stopped',
    reconciliationStatus: cfg.reconciliationStatus,
    marketWindowState: getMarketWindow(),
  });

  const blockAndReturn = async (reason: string): Promise<void> => {
    await completeScanRun(scanRun.id, 'blocked', reason);
  };

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
    await blockAndReturn(label);
    return;
  }
  if (!cfg.isRunning) {
    await blockAndReturn('bot_not_running');
    return;
  }
  if (cfg.isPaused) {
    await logActivity({ type: 'scan', action: 'SKIP_ENTRIES', detail: 'Bot is paused' });
    await blockAndReturn('paused');
    return;
  }
  if (cfg.circuitBreakerUntil && cfg.circuitBreakerUntil > new Date()) {
    await logActivity({
      type: 'scan',
      severity: 'warn',
      action: 'SKIP_ENTRIES',
      detail: `Circuit breaker active until ${cfg.circuitBreakerUntil.toISOString()}`,
    });
    await blockAndReturn('circuit_breaker');
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
    await blockAndReturn('market_window_exclusion');
    return;
  }

  try {
    await selectAndOpenEntries(lease, scanRun.id);
    await completeScanRun(scanRun.id, 'completed');
  } catch (err) {
    await completeScanRun(scanRun.id, 'failed', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function selectAndOpenEntries(lease?: Lease, scanRunId?: number): Promise<void> {
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
  // scanRunId is required for lineage. Callers of scanForEntries always pass it;
  // tests / debug calls of selectAndOpenEntries via legacy paths still work
  // because a synthetic scan run is created here.
  if (scanRunId === undefined) {
    const cfg = await getBotConfig();
    const synthetic = await startScanRun({
      triggerType: 'legacy_direct_call',
      scannerVersion: STRATEGY_VERSION,
      botState: cfg.isRunning ? 'running' : 'stopped',
      reconciliationStatus: cfg.reconciliationStatus,
      marketWindowState: getMarketWindow(),
    });
    scanRunId = synthetic.id;
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
    decisionChainId: number;
    marketObservationId: number;
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
    // Gate 2: create a decision chain for EVERY token evaluated — including
    // ones that get rejected at volume or fail data fetch.
    const observedAt = new Date();
    const chain = await createDecisionChain({
      scanRunId: scanRunId!,
      productId: `${token}-USD`,
      strategyVersion: STRATEGY_VERSION,
      observedAt,
      dataAvailableAt: observedAt,
      decisionStartedAt: observedAt,
    });
    try {
      const product = await getProduct(token);
      const price = Number(product.price);
      const volume24hBase = Number(product.volume_24h);
      const volume24h = volume24hBase * price;
      const changePct24h = Number(product.price_percentage_change_24h);
      const observation = await recordObservation({
        decisionChainId: chain.id,
        productId: `${token}-USD`,
        observedAt,
        dataAvailableAt: observedAt,
        marketDataVersion: FEATURE_VERSION,
        price: String(price),
        volume24h: String(volume24h),
        dataQualityStatus: 'valid',
        payload: { price, volume24h, changePct24h, product_id: product.product_id },
      });
      if (volume24h < STRATEGY.MIN_VOLUME_24HR) {
        await recordEligibility({
          decisionChainId: chain.id,
          marketObservationId: observation.id,
          eligible: false,
          reasonCode: 'insufficient_volume',
          reasonDetail: `24h volume ${volume24h.toFixed(2)} < ${STRATEGY.MIN_VOLUME_24HR}`,
          policyVersion: STRATEGY_VERSION,
        });
        await transitionChainStatus(chain.id, 'ineligible', {
          completeness: 'complete',
          markDecisionCompleted: true,
        });
        continue;
      }
      // Eligible → continue building candidate.
      await recordEligibility({
        decisionChainId: chain.id,
        marketObservationId: observation.id,
        eligible: true,
        reasonCode: 'eligible',
        policyVersion: STRATEGY_VERSION,
      });
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
        decisionChainId: chain.id,
        marketObservationId: observation.id,
      });
    } catch (err) {
      const msg =
        err instanceof CoinbaseError
          ? `${err.class}:${err.code} ${err.message}`
          : err instanceof Error
            ? err.message
            : 'unknown';
      // Record the data failure on the chain — never fabricate the observation.
      await recordEligibility({
        decisionChainId: chain.id,
        eligible: false,
        reasonCode: 'market_data_failure',
        reasonDetail: msg.slice(0, 250),
        policyVersion: STRATEGY_VERSION,
      });
      await transitionChainStatus(chain.id, 'failed', {
        completeness: 'complete',
        markDecisionCompleted: true,
      });
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

    // Gate 2: record setup evaluation for every candidate — whether or not a
    // mode was detected. A no-detection outcome routes to no_trade.
    const inputHash = createHash('sha256')
      .update(JSON.stringify({ price: c.price, volume: c.volume24h, closes: c.closes }))
      .digest('hex');
    const setupEval = await recordSetupEvaluation({
      decisionChainId: c.decisionChainId,
      marketObservationId: c.marketObservationId,
      modeEvaluated: detected?.evaluation.mode,
      setupDetected: !!detected,
      strategyVersion: STRATEGY_VERSION,
      indicatorVersion: FEATURE_VERSION,
      inputHash,
      reasonCodes: detected ? [`mode:${detected.evaluation.mode}`] : ['no_setup'],
    });
    if (!detected) {
      await recordRoutingDecision({
        decisionChainId: c.decisionChainId,
        setupEvaluationId: setupEval.id,
        routingOutcome: 'no_trade',
        reasonCodes: ['no_setup'],
        strategyVersion: STRATEGY_VERSION,
      });
      await transitionChainStatus(c.decisionChainId, 'no_setup', {
        completeness: 'complete',
        markDecisionCompleted: true,
      });
      continue;
    }

    const { evaluation, signals } = detected;
    const modeCfg = STRATEGY.MODES[evaluation.mode];

    const routing = await recordRoutingDecision({
      decisionChainId: c.decisionChainId,
      setupEvaluationId: setupEval.id,
      selectedMode: evaluation.mode,
      routingOutcome:
        evaluation.mode === 'reversion'
          ? 'reversion'
          : evaluation.mode === 'breakout'
            ? 'breakout'
            : 'macro_floor',
      reasonCodes: [
        `passedSignals:${signals.passedSignals}/${signals.totalSignals}`,
        `mode:${evaluation.mode}`,
      ],
      strategyVersion: STRATEGY_VERSION,
    });
    await transitionChainStatus(c.decisionChainId, 'candidate');

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
      decisionChainId: c.decisionChainId,
      marketObservationId: c.marketObservationId,
      setupEvaluationId: setupEval.id,
      routingDecisionId: routing.id,
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
        decisionChainId: c.decisionChainId,
      });
      await transitionChainStatus(c.decisionChainId, 'economically_rejected', {
        completeness: 'complete',
        markDecisionCompleted: true,
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
      decisionChainId: c.decisionChainId,
      routingDecisionId: routing.id,
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
      decisionChainId: c.decisionChainId,
    });

    if (gate.decision !== 'accept') {
      evGateRejects++;
      await transitionChainStatus(c.decisionChainId, 'quantitatively_rejected', {
        completeness: 'complete',
        markDecisionCompleted: true,
      });
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
      await transitionChainStatus(c.decisionChainId, 'quantitatively_rejected', {
        completeness: 'complete',
        markDecisionCompleted: true,
        actor: 'claude',
        metadata: { confidence: claude.confidence, threshold: modeCfg.claudeThreshold },
      });
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

    // Approved — the chain will finalize decisionCompletedAt once the
    // executor either opens or fails to open the position. Mark approved now.
    await transitionChainStatus(c.decisionChainId, 'approved');

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
      // §H FIX: durable fencing generation. Persisted on the intent so the
      // atomic transaction can reject a stale worker even if lease.isValid()
      // was true at precheck.
      fenceGeneration: lease?.fenceGeneration,
      fenceResourceKey: lease?.key,
      decisionChainId: c.decisionChainId,
    });
    // Gate 2: update chain status based on the executor outcome.
    const nextStatus: ChainStatus =
      result.kind === 'opened'
        ? 'position_open'
        : result.kind === 'skipped' || result.kind === 'rejected'
          ? 'failed'
          : 'order_pending';
    await transitionChainStatus(c.decisionChainId, nextStatus, {
      completeness: 'complete',
      markDecisionCompleted: true,
      metadata: { executorResult: result.kind, reason: result.reason },
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
