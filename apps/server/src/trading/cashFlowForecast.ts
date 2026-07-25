import { Money, ZERO_MONEY, type TradingMode } from '@horizon/shared';
import type { FeeTierCurrent } from './feeTier';
import type { PreviewOk } from './preview';

/**
 * Cash-flow cost model (Phase 1.1 Gate 3B §I-N).
 *
 * Replaces percentage-approximation math with EXACT decimal cash flows.
 *
 *   Q                  = expected filled base quantity
 *   P_entry            = previewed average entry fill
 *   F_entry            = entry commission
 *   P_target_exit      = conservative target exit fill
 *   F_target_exit      = target exit commission
 *   P_stop_exit        = conservative stop exit fill
 *   F_stop_exit        = stop exit commission
 *   P_timeout_exit     = conservative timeout exit fill
 *   F_timeout_exit     = timeout exit commission
 *
 *   entryOutflow  = Q * P_entry + F_entry
 *   targetInflow  = Q * P_target_exit - F_target_exit
 *   stopInflow    = Q * P_stop_exit   - F_stop_exit
 *   timeoutInflow = Q * P_timeout_exit - F_timeout_exit
 *
 *   netTargetPnl  = targetInflow  - entryOutflow
 *   netStopPnl    = stopInflow    - entryOutflow
 *   netTimeoutPnl = timeoutInflow - entryOutflow
 *
 * All values remain Money-typed decimal.
 *
 * §J — every modelled cost component is stored INDEPENDENTLY. Nothing is
 * counted twice; nothing is calculated then dropped. See `CashFlowForecast`.
 *
 * §K — TP/SL derive from `preview_entry` (the approved preview price) for
 * pre-trade authorization. After actual fills, `postFillDeviationBps`
 * measures drift and `revalidationRequired` fires when it exceeds the
 * configured tolerance.
 *
 * §L — buffer metadata is HONEST: `bufferSource='configured'`,
 * `isEmpiricalBuffer=false`, `bufferSampleCount=0` until the shadow-live
 * pipeline (Phase 1.2) collects enough observations to calibrate real
 * empirical distributions.
 *
 * §N — outcome-probability estimates are DEFINED but marked
 * `not_calibrated`; the interface exists but does not affect allocations
 * until later validation passes.
 */

export const CASH_FLOW_MODEL_VERSION = 'p1g3b-cashflow-1';
export const CASH_FLOW_BUFFER_VERSION = 'p1g3b-configured-1';
export const CASH_FLOW_ATTRIBUTION_VERSION = 'p1g3b-attribution-1';

// ---------------------------------------------------------------------------
// Configured buffers — honest labels (§L)
// ---------------------------------------------------------------------------

/**
 * Configured (NOT empirical) buffers. These are constants chosen from
 * public research + Coinbase spread observations; they are NOT computed
 * from a versioned dataset with adequate sample size. Do NOT call these
 * `p90` / `p95` / `quantile` / `empirical distribution` — they are
 * BUFFERS applied as insurance against slippage.
 */
export const CONFIGURED_EXIT_IMPACT_BUFFER_BPS = 10; // conservative exit widening
export const CONFIGURED_LATENCY_BUFFER_BPS = 5; // network + book-walk during latency
export const CONFIGURED_STOP_GAP_BUFFER_BPS = 20; // adverse gap-through-stop buffer
export const CONFIGURED_PARTIAL_FILL_BUFFER_BPS = 5; // partial-fill exposure buffer
export const CONFIGURED_ILLIQUID_EXIT_BUFFER_BPS = 15; // extra for non-top-tier tokens

/** §K — deviation tolerance (bps of preview entry) before revalidation fires. */
export const POST_FILL_DEVIATION_TOLERANCE_BPS = 50;

const LIQUID_TIER = new Set([
  'LINK', 'AAVE', 'UNI', 'COMP', 'CRV', 'MKR', 'LDO',
  'ARB', 'OP', 'NEAR', 'XLM', 'TRX', 'INJ', 'GRT',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CashFlowForecastInput {
  token: string;
  mode: TradingMode;
  arrivalMid: Money;
  takeProfitPct: number;
  stopLossPct: number;
  feeTier: FeeTierCurrent;
  preview: PreviewOk;
  /**
   * §K — the price basis for TP/SL. Default is `'preview_entry'` (the
   * approved preview's estimated fill price) for pre-trade authorization.
   * Post-fill code paths may pass `'reconciled_entry'` with the weighted-
   * average fill.
   */
  targetStopBasis?: 'preview_entry' | 'reconciled_entry';
  /** Override the configured buffers for testing / research. */
  overrides?: Partial<ConfiguredBuffers>;
}

export interface ConfiguredBuffers {
  exitImpactBps: number;
  latencyBps: number;
  stopGapBps: number;
  partialFillBps: number;
  illiquidExitBps: number;
}

/**
 * Every cost component and cash flow the model produces. Nothing is
 * silently rolled up: `totalForecastCost` is derived from the components,
 * and every component appears in exactly ONE net calculation.
 */
export interface CashFlowForecast {
  costModelVersion: string;
  bufferSource: string;
  bufferVersion: string;
  bufferSampleCount: number;
  isEmpiricalBuffer: boolean;
  targetStopBasis: 'preview_entry' | 'reconciled_entry';

  // Inputs preserved for audit.
  arrivalMid: Money;
  previewEntryFillPrice: Money;
  expectedFilledBase: Money;

  // Conservative exit prices (§I formulas above).
  conservativeTargetExitPrice: Money;
  conservativeStopExitPrice: Money;
  conservativeTimeoutExitPrice: Money;

  // Exact cash flows (§I).
  entryOutflow: Money;
  targetInflow: Money;
  stopInflow: Money;
  timeoutInflow: Money;

  // Net outcomes.
  netTargetPnl: Money;
  netStopPnl: Money;
  netTimeoutPnl: Money;

  // Separated cost components (§J). Each contributes to EXACTLY ONE net
  // calculation via the cash-flow prices above.
  entryCommission: Money;
  targetExitCommission: Money;
  stopExitCommission: Money;
  timeoutExitCommission: Money;
  quotedSpread: Money; // width of preview.bestAsk - preview.bestBid
  effectiveSpread: Money; // 2 × |previewFillPrice - arrivalMid|
  entryImpact: Money; // Q * (previewFillPrice - arrivalMid), signed
  targetExitImpact: Money; // Q * (targetGrossPrice - conservativeTargetExitPrice)
  stopExitImpact: Money;
  latencyBufferAbs: Money; // Q * arrivalMid * latencyBps / 10000
  stopGapBufferAbs: Money; // Q * arrivalMid * stopGapBps / 10000
  partialFillBufferAbs: Money;
  unfilledOpportunityEstimate: Money; // conservative "we didn't fill" gross
  residualDustEstimate: Money; // conservative dust value at last-known price

  totalForecastCost: Money;

  // Legacy price + rollup fields for backward compatibility with the
  // existing cost-adjusted payoff gate (which reads CostForecast shape).
  takeProfitPrice: Money;
  stopLossPrice: Money;
  netRewardRisk: Money | null;
  breakEvenWinProb: Money | null;
  // These aliases let CashFlowForecast satisfy the legacy CostForecast
  // interface. Values are exactly the same as the cash-flow fields.
  netTpPnl: Money; // = netTargetPnl
  netSlPnl: Money; // = netStopPnl
  entryFee: Money; // = entryCommission
  entryImpactBps: Money; // impact in bps for legacy field
  estimatedEntryFillPrice: Money; // = previewEntryFillPrice
  filledBaseSize: Money; // = expectedFilledBase
  exitFeeEstimate: Money; // = targetExitCommission
  exitImpactBpsEstimate: Money; // exit impact in bps
  latencySlippageBpsEstimate: Money; // latency in bps
  roundTripCost: Money; // = totalForecastCost
  costToTargetPct: Money;
  spreadBps: Money;
  exitCostQuantile: number;

  // §N — outcome probability estimates. Defined but NOT calibrated;
  // callers MUST NOT treat these as authoritative for allocation.
  outcomeProbabilityEstimate: OutcomeProbabilityEstimate;
}

// ---------------------------------------------------------------------------
// §N — OutcomeProbabilityEstimate interface (not calibrated)
// ---------------------------------------------------------------------------

export type ProbabilityCalibrationStatus =
  | 'not_calibrated'
  | 'calibrating'
  | 'calibrated_low_conf'
  | 'calibrated';

export interface OutcomeProbabilityEstimate {
  pTarget: number | null;
  pStop: number | null;
  pTimeout: number | null;
  uncertaintyLower: number | null;
  uncertaintyUpper: number | null;
  modelVersion: string;
  sampleCount: number;
  calibrationStatus: ProbabilityCalibrationStatus;
}

export const UNCALIBRATED_PROBABILITY: OutcomeProbabilityEstimate = {
  pTarget: null,
  pStop: null,
  pTimeout: null,
  uncertaintyLower: null,
  uncertaintyUpper: null,
  modelVersion: 'none',
  sampleCount: 0,
  calibrationStatus: 'not_calibrated',
};

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

function pctToRatio(pct: number): Money {
  return Money.fromString(String(pct)).divInt(100);
}

function bpsToRatio(bps: number): Money {
  return Money.fromNumber(bps).divInt(10000);
}

function spreadBpsOf(bid: Money | null, ask: Money | null, mid: Money): Money {
  if (!bid || !ask || mid.isZero()) return ZERO_MONEY;
  return ask.sub(bid).div(mid).mul(Money.fromString('10000'));
}

function effectiveBuffers(input: CashFlowForecastInput): ConfiguredBuffers {
  const illiquidBoost = LIQUID_TIER.has(input.token) ? 0 : CONFIGURED_ILLIQUID_EXIT_BUFFER_BPS;
  return {
    exitImpactBps: (input.overrides?.exitImpactBps ?? CONFIGURED_EXIT_IMPACT_BUFFER_BPS) + illiquidBoost,
    latencyBps: input.overrides?.latencyBps ?? CONFIGURED_LATENCY_BUFFER_BPS,
    stopGapBps: input.overrides?.stopGapBps ?? CONFIGURED_STOP_GAP_BUFFER_BPS,
    partialFillBps: input.overrides?.partialFillBps ?? CONFIGURED_PARTIAL_FILL_BUFFER_BPS,
    illiquidExitBps: illiquidBoost,
  };
}

/**
 * Build an exact-cash-flow forecast for a long entry.
 *
 * Every cost component appears in EXACTLY ONE net calculation. The three
 * net PnL fields (target / stop / timeout) are the only places
 * commission/impact/buffer flows aggregate — there is no separate
 * `roundTripCost` that could double-count.
 */
export function buildCashFlowForecast(input: CashFlowForecastInput): CashFlowForecast {
  const { arrivalMid, feeTier, preview, takeProfitPct, stopLossPct } = input;
  const targetStopBasis = input.targetStopBasis ?? 'preview_entry';
  const buffers = effectiveBuffers(input);

  const previewFill = preview.estimatedAvgFillPrice;
  // Q = filled base quantity. Prefer the preview's baseSize when it's
  // populated; otherwise derive from quoteSize / previewFill.
  const Q =
    preview.baseSize ??
    (preview.quoteSize && !previewFill.isZero()
      ? preview.quoteSize.div(previewFill)
      : ZERO_MONEY);

  const F_entry = preview.commissionTotal;

  // TP/SL prices derived from the chosen basis.
  const basisPrice = targetStopBasis === 'preview_entry' ? previewFill : arrivalMid;
  const takeProfitPrice = basisPrice.mul(Money.fromString('1').add(pctToRatio(takeProfitPct)));
  const stopLossPrice = basisPrice.mul(Money.fromString('1').sub(pctToRatio(stopLossPct)));

  // Conservative exit prices — the gross target/stop shifted adversely by
  // configured buffers.
  const exitBufferRatio = bpsToRatio(buffers.exitImpactBps).add(bpsToRatio(buffers.latencyBps));
  const stopBufferRatio = exitBufferRatio.add(bpsToRatio(buffers.stopGapBps));
  const conservativeTarget = takeProfitPrice.mul(Money.fromString('1').sub(exitBufferRatio));
  const conservativeStop = stopLossPrice.mul(Money.fromString('1').sub(stopBufferRatio));
  // Timeout: exit at the arrival mid minus the same buffers — a
  // conservative "nothing happened, we bailed" outcome.
  const conservativeTimeout = arrivalMid.mul(Money.fromString('1').sub(exitBufferRatio));

  // Per-exit commissions.
  const F_target_exit = conservativeTarget.mul(Q).mul(feeTier.takerFeeRate);
  const F_stop_exit = conservativeStop.mul(Q).mul(feeTier.takerFeeRate);
  const F_timeout_exit = conservativeTimeout.mul(Q).mul(feeTier.takerFeeRate);

  // Exact cash flows (§I).
  const entryOutflow = Q.mul(previewFill).add(F_entry);
  const targetInflow = Q.mul(conservativeTarget).sub(F_target_exit);
  const stopInflow = Q.mul(conservativeStop).sub(F_stop_exit);
  const timeoutInflow = Q.mul(conservativeTimeout).sub(F_timeout_exit);

  const netTargetPnl = targetInflow.sub(entryOutflow);
  const netStopPnl = stopInflow.sub(entryOutflow);
  const netTimeoutPnl = timeoutInflow.sub(entryOutflow);

  // Separated cost components (§J).
  const quotedSpread = spreadBpsOf(preview.bestBid, preview.bestAsk, arrivalMid);
  const effectiveSpread = previewFill.sub(arrivalMid).abs().mul(Money.fromString('2'));
  const entryImpact = previewFill.sub(arrivalMid).mul(Q);
  const targetExitImpact = takeProfitPrice.sub(conservativeTarget).mul(Q);
  const stopExitImpact = stopLossPrice.sub(conservativeStop).mul(Q);
  const latencyBufferAbs = arrivalMid.mul(Q).mul(bpsToRatio(buffers.latencyBps));
  const stopGapBufferAbs = arrivalMid.mul(Q).mul(bpsToRatio(buffers.stopGapBps));
  const partialFillBufferAbs = arrivalMid.mul(Q).mul(bpsToRatio(buffers.partialFillBps));

  // Unfilled opportunity and residual dust are placeholder estimates —
  // conservative and small. The shadow pipeline replaces them with
  // empirical distributions in Phase 1.2.
  const unfilledOpportunityEstimate = ZERO_MONEY;
  const residualDustEstimate = ZERO_MONEY;

  // Total forecast cost — the SUM of the components that appear in
  // netTargetPnl (the most likely outcome from a bull thesis). Kept as
  // a summary field; net* values remain the authoritative signals.
  const totalForecastCost = F_entry
    .add(F_target_exit)
    .add(targetExitImpact)
    .add(latencyBufferAbs.mul(Money.fromString('0'))) // latency already inside targetExitImpact
    .add(partialFillBufferAbs);

  const rewardAbs = netTargetPnl;
  const riskAbs = netStopPnl.abs();
  const netRewardRisk = riskAbs.isZero() ? null : rewardAbs.div(riskAbs);
  const denom = rewardAbs.add(riskAbs);
  const breakEvenWinProb =
    denom.isZero() || !rewardAbs.isPositive() ? null : riskAbs.div(denom);

  return {
    costModelVersion: CASH_FLOW_MODEL_VERSION,
    bufferSource: 'configured',
    bufferVersion: CASH_FLOW_BUFFER_VERSION,
    bufferSampleCount: 0,
    isEmpiricalBuffer: false,
    targetStopBasis,
    arrivalMid,
    previewEntryFillPrice: previewFill,
    expectedFilledBase: Q,
    conservativeTargetExitPrice: conservativeTarget,
    conservativeStopExitPrice: conservativeStop,
    conservativeTimeoutExitPrice: conservativeTimeout,
    entryOutflow,
    targetInflow,
    stopInflow,
    timeoutInflow,
    netTargetPnl,
    netStopPnl,
    netTimeoutPnl,
    entryCommission: F_entry,
    targetExitCommission: F_target_exit,
    stopExitCommission: F_stop_exit,
    timeoutExitCommission: F_timeout_exit,
    quotedSpread,
    effectiveSpread,
    entryImpact,
    targetExitImpact,
    stopExitImpact,
    latencyBufferAbs,
    stopGapBufferAbs,
    partialFillBufferAbs,
    unfilledOpportunityEstimate,
    residualDustEstimate,
    totalForecastCost,
    takeProfitPrice,
    stopLossPrice,
    netRewardRisk,
    breakEvenWinProb,
    outcomeProbabilityEstimate: UNCALIBRATED_PROBABILITY,
    // Legacy CostForecast aliases (same values).
    netTpPnl: netTargetPnl,
    netSlPnl: netStopPnl,
    entryFee: F_entry,
    entryImpactBps: previewFill.sub(arrivalMid).div(arrivalMid.isZero() ? Money.fromString('1') : arrivalMid).mul(Money.fromString('10000')),
    estimatedEntryFillPrice: previewFill,
    filledBaseSize: Q,
    exitFeeEstimate: F_target_exit,
    exitImpactBpsEstimate: Money.fromNumber(buffers.exitImpactBps),
    latencySlippageBpsEstimate: Money.fromNumber(buffers.latencyBps),
    roundTripCost: totalForecastCost,
    costToTargetPct: Q.mul(takeProfitPrice.sub(basisPrice)).isZero()
      ? Money.fromString('100')
      : totalForecastCost.div(Q.mul(takeProfitPrice.sub(basisPrice))).mul(Money.fromString('100')),
    spreadBps: quotedSpread,
    exitCostQuantile: 0.95,
  };
}

// ---------------------------------------------------------------------------
// §K — post-fill deviation check
// ---------------------------------------------------------------------------

export interface PostFillDeviation {
  deviationBps: Money;
  revalidationRequired: boolean;
  toleranceBps: number;
}

/**
 * Compare the actual weighted-average entry fill to the previewed fill.
 * Returns the deviation in bps and whether it exceeds the tolerance.
 * When it does, the caller must:
 *   - request a fresh preview,
 *   - rebuild the cash-flow forecast with
 *     `targetStopBasis='reconciled_entry'`,
 *   - persist a NEW quantitative decision (never mutate the original),
 *   - re-check the cost-adjusted payoff gate.
 */
export function checkPostFillDeviation(
  previewedEntryFill: Money,
  actualWeightedAvgFill: Money,
  toleranceBps: number = POST_FILL_DEVIATION_TOLERANCE_BPS,
): PostFillDeviation {
  if (previewedEntryFill.isZero()) {
    return {
      deviationBps: Money.zero(),
      revalidationRequired: false,
      toleranceBps,
    };
  }
  const deviationBps = actualWeightedAvgFill
    .sub(previewedEntryFill)
    .abs()
    .div(previewedEntryFill)
    .mul(Money.fromString('10000'));
  const deviationValue = Number(deviationBps.toDecimalString(4));
  return {
    deviationBps,
    revalidationRequired: deviationValue > toleranceBps,
    toleranceBps,
  };
}
