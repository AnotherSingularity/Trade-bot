import { Money } from '@horizon/shared';
import type { CashFlowForecast } from '../../trading/cashFlowForecast';
import {
  type RiskMeasurement,
  invalidMeasurement,
  validMeasurement,
} from './contract';
import type {
  CurrentPositionInput,
  LiquidityEvidenceInput,
  PendingIntentInput,
  PortfolioRiskInput,
  VolatilityEvidenceInput,
} from './inputs';

/**
 * Phase 2C §F–§I — Risk measurements.
 *
 * Every function here returns a `RiskMeasurement<T>`. Failures are
 * fail-closed: invalid inputs never become zero, unknown exposure
 * never becomes no exposure, missing volatility never inflates size.
 */

export const RISK_MEASUREMENT_MODEL_VERSION = 'p2c-measure-1';

// ---------------------------------------------------------------------------
// §F — Exact candidate stop-loss risk (Gate 3B cash-flow authoritative basis)
// ---------------------------------------------------------------------------

export interface CandidateStopRiskResult {
  totalModeledStopLoss: number; // >= 0, in quote currency
  grossPriceRisk: number;
  netStopPnl: number;
}

export function measureCandidateStopRisk(
  input: PortfolioRiskInput,
): RiskMeasurement<CandidateStopRiskResult> {
  const meta = {
    measurementKey: 'candidate.total_modeled_stop_loss',
    unit: 'quote',
    observedAt: input.observedAt,
    dataAvailableAt: input.costForecast.forecast.expectedFilledBase
      ? input.observedAt
      : input.observedAt,
    policyVersion: 'p2c-risk-1',
    modelVersion: input.costForecast.forecastVersion,
    inputHash: `cand-stop:${input.costForecast.forecastId}`,
  };
  const forecast = input.costForecast.forecast;
  if (!forecast) {
    return invalidMeasurement<CandidateStopRiskResult>('invalid_input', {
      ...meta,
      failureReason: 'missing cost forecast',
    });
  }
  const netStopPnl = forecastNumber(forecast.netStopPnl);
  const total = Math.max(0, -netStopPnl);
  const arrivalMid = forecastNumber(forecast.arrivalMid);
  const stopPrice = Number(input.stopPrice);
  const filledBase = forecastNumber(forecast.expectedFilledBase);
  const grossPriceRisk = Math.max(0, (arrivalMid - stopPrice) * filledBase);
  if (!Number.isFinite(total) || !Number.isFinite(grossPriceRisk)) {
    return invalidMeasurement<CandidateStopRiskResult>('numerical_failure', {
      ...meta,
      failureReason: 'non-finite value from forecast',
    });
  }
  return validMeasurement<CandidateStopRiskResult>({
    ...meta,
    value: { totalModeledStopLoss: total, grossPriceRisk, netStopPnl },
    confidence: 1,
    sampleCount: 1,
    diagnostics: {
      entryCommission: forecastNumber(forecast.entryCommission),
      stopExitCommission: forecastNumber(forecast.stopExitCommission),
      stopExitImpact: forecastNumber(forecast.stopExitImpact),
      stopGapBufferAbs: forecastNumber(forecast.stopGapBufferAbs),
      latencyBufferAbs: forecastNumber(forecast.latencyBufferAbs),
      partialFillBufferAbs: forecastNumber(forecast.partialFillBufferAbs),
      residualDustEstimate: forecastNumber(forecast.residualDustEstimate),
    },
  });
}

function forecastNumber(m: Money): number {
  return Number(m.toDecimalString());
}

// ---------------------------------------------------------------------------
// §G — Existing position risk
// ---------------------------------------------------------------------------

export interface PositionRiskAssessment {
  productId: string;
  entryDecisionChainId: number | null;
  remainingBaseSize: number;
  weightedAverageEntry: number;
  grossQuoteExposure: number;
  openStopRisk: number | null;
  state: 'measured' | 'partially_measured' | 'unprotected' | 'reconciliation_required' | 'unknown';
  protectionState: string;
  reason: string;
  dataAvailableAt: Date;
}

const CONFIGURED_STOP_GAP_BPS_UNPROTECTED = 100; // conservative 100bps gap for unprotected exit

export function measureExistingPositions(
  input: PortfolioRiskInput,
): { assessments: PositionRiskAssessment[]; measurement: RiskMeasurement<number> } {
  const assessments: PositionRiskAssessment[] = [];
  let totalOpenRisk = 0;
  let hasUnknown = false;
  for (const p of input.currentPositions) {
    const a = assessPosition(p);
    assessments.push(a);
    if (a.state === 'unknown' || a.state === 'reconciliation_required') hasUnknown = true;
    if (a.openStopRisk != null) totalOpenRisk += a.openStopRisk;
  }
  const measurement: RiskMeasurement<number> = hasUnknown
    ? invalidMeasurement<number>('unresolved_state', {
        measurementKey: 'portfolio.total_open_stop_risk',
        unit: 'quote',
        observedAt: input.observedAt,
        dataAvailableAt: input.observedAt,
        policyVersion: 'p2c-risk-1',
        modelVersion: RISK_MEASUREMENT_MODEL_VERSION,
        inputHash: `open-risk:${input.currentPositions.length}`,
        failureReason: 'one or more positions in an unknown or reconciliation-required state',
      })
    : validMeasurement<number>({
        measurementKey: 'portfolio.total_open_stop_risk',
        value: totalOpenRisk,
        unit: 'quote',
        confidence: 1,
        sampleCount: input.currentPositions.length,
        observedAt: input.observedAt,
        dataAvailableAt: input.observedAt,
        policyVersion: 'p2c-risk-1',
        modelVersion: RISK_MEASUREMENT_MODEL_VERSION,
        inputHash: `open-risk:${input.currentPositions.length}`,
      });
  return { assessments, measurement };
}

function assessPosition(p: CurrentPositionInput): PositionRiskAssessment {
  const base = Number(p.remainingBaseSize);
  const avg = Number(p.weightedAverageEntry);
  const mark = p.markPrice != null ? Number(p.markPrice) : avg;
  const gross = base * mark;
  if (!Number.isFinite(base) || !Number.isFinite(avg) || base <= 0 || avg <= 0) {
    return {
      productId: p.productId,
      entryDecisionChainId: p.entryDecisionChainId,
      remainingBaseSize: base,
      weightedAverageEntry: avg,
      grossQuoteExposure: 0,
      openStopRisk: null,
      state: 'unknown',
      protectionState: p.protectionState,
      reason: 'invalid_size_or_entry',
      dataAvailableAt: p.dataAvailableAt,
    };
  }
  if (p.protectionState === 'unknown') {
    return {
      productId: p.productId,
      entryDecisionChainId: p.entryDecisionChainId,
      remainingBaseSize: base,
      weightedAverageEntry: avg,
      grossQuoteExposure: gross,
      openStopRisk: null,
      state: 'reconciliation_required',
      protectionState: p.protectionState,
      reason: 'protection_state_unknown',
      dataAvailableAt: p.dataAvailableAt,
    };
  }
  if (p.protectionState === 'unprotected') {
    // Conservative treatment: full gross exposure minus one adverse candle
    // priced at avg × (1 - gap) — the entire notional is at risk.
    const conservativeStop = avg * (1 - CONFIGURED_STOP_GAP_BPS_UNPROTECTED / 10_000);
    const priceMove = Math.max(0, avg - conservativeStop);
    const grossRisk = base * priceMove;
    // Add explicit whole-notional worst-case (in case protection never engages).
    const worstCase = gross; // gap-through
    return {
      productId: p.productId,
      entryDecisionChainId: p.entryDecisionChainId,
      remainingBaseSize: base,
      weightedAverageEntry: avg,
      grossQuoteExposure: gross,
      openStopRisk: Math.max(grossRisk, worstCase * 0.05), // 5% floor as conservative anchor
      state: 'unprotected',
      protectionState: p.protectionState,
      reason: 'no_active_stop',
      dataAvailableAt: p.dataAvailableAt,
    };
  }
  const stop = p.activeStopPrice != null ? Number(p.activeStopPrice) : null;
  if (stop == null || !Number.isFinite(stop) || stop <= 0) {
    return {
      productId: p.productId,
      entryDecisionChainId: p.entryDecisionChainId,
      remainingBaseSize: base,
      weightedAverageEntry: avg,
      grossQuoteExposure: gross,
      openStopRisk: null,
      state: 'partially_measured',
      protectionState: p.protectionState,
      reason: 'missing_active_stop',
      dataAvailableAt: p.dataAvailableAt,
    };
  }
  const priceMove = Math.max(0, mark - stop);
  const commissionBps = 10; // conservative exit fee
  const impactBps = 15;
  const gapBps = 20;
  const totalCostBps = commissionBps + impactBps + gapBps;
  const costPortion = gross * (totalCostBps / 10_000);
  const openRisk = base * priceMove + costPortion;
  return {
    productId: p.productId,
    entryDecisionChainId: p.entryDecisionChainId,
    remainingBaseSize: base,
    weightedAverageEntry: avg,
    grossQuoteExposure: gross,
    openStopRisk: openRisk,
    state: p.protectionState === 'degraded' ? 'partially_measured' : 'measured',
    protectionState: p.protectionState,
    reason: p.protectionState === 'degraded' ? 'degraded_protection' : 'ok',
    dataAvailableAt: p.dataAvailableAt,
  };
}

// ---------------------------------------------------------------------------
// §H — Portfolio exposure catalog
// ---------------------------------------------------------------------------

export interface ExposureBreakdown {
  grossQuoteExposure: number;
  netDirectionalExposure: number;
  cashUtilization: number;
  cashReserveRemaining: number;
  totalOpenStopRisk: number;
  pendingEntryRisk: number;
  pendingExitResidualRisk: number;
  productExposure: Map<string, number>;
  modeExposure: Map<string, number>;
  clusterExposure: Map<string, number>;
  unprotectedExposure: number;
  illiquidExposure: number;
  postCandidateProductExposure: Map<string, number>;
  postCandidateModeExposure: Map<string, number>;
  postCandidateClusterExposure: Map<string, number>;
}

export function measureExposure(
  input: PortfolioRiskInput,
  positionAssessments: readonly PositionRiskAssessment[],
): ExposureBreakdown {
  const productExposure = new Map<string, number>();
  const modeExposure = new Map<string, number>();
  const clusterExposure = new Map<string, number>();
  let gross = 0;
  let net = 0;
  let unprotected = 0;
  let openStopRisk = 0;
  for (const a of positionAssessments) {
    gross += a.grossQuoteExposure;
    net += a.grossQuoteExposure; // long-only baseline
    productExposure.set(a.productId, (productExposure.get(a.productId) ?? 0) + a.grossQuoteExposure);
    if (a.state === 'unprotected') unprotected += a.grossQuoteExposure;
    if (a.openStopRisk != null) openStopRisk += a.openStopRisk;
  }
  for (const p of input.currentPositions) {
    modeExposure.set(p.strategyMode, (modeExposure.get(p.strategyMode) ?? 0) + gross);
    if (p.clusterKey) {
      clusterExposure.set(p.clusterKey, (clusterExposure.get(p.clusterKey) ?? 0) + Number(p.remainingBaseSize) * Number(p.markPrice ?? p.weightedAverageEntry));
    }
  }
  const pendingEntryRisk = input.pendingEntryIntents
    .filter((i) => i.status === 'known')
    .reduce((s, i) => s + Number(i.proposedQuoteSize), 0);
  // Unknown pending entries: fail-closed by adding worst-case notional as gross.
  const unknownEntryPenalty = input.pendingEntryIntents.filter((i) => i.status === 'unknown').length * 1_000_000; // large sentinel
  const pendingExitResidual = input.pendingExitIntents
    .filter((i) => i.status === 'known')
    .reduce((s, i) => s + Number(i.proposedQuoteSize), 0);

  const equity = Number(input.portfolioLedgerState.totalEquity);
  const cash = Number(input.cashAvailable);
  const reserved = Number(input.cashReserved);
  const cashUtilization = equity > 0 ? gross / equity : 0;
  const cashReserveRemaining = equity > 0 ? (cash - reserved) / equity : 0;

  // Post-candidate views: add candidate's proposed exposure.
  const candidateQuote = Number(input.proposedQuoteSize);
  const postProduct = new Map(productExposure);
  postProduct.set(input.productId, (postProduct.get(input.productId) ?? 0) + candidateQuote);
  const postMode = new Map(modeExposure);
  postMode.set(input.championMode, (postMode.get(input.championMode) ?? 0) + candidateQuote);
  const postCluster = new Map(clusterExposure);
  if (input.clusterKey) {
    postCluster.set(input.clusterKey, (postCluster.get(input.clusterKey) ?? 0) + candidateQuote);
  }
  // Illiquid exposure: sum position gross for products whose hygiene state is 'unknown' or spread > threshold.
  const illiquidExposure = input.liquidityEvidence.hygieneEligible ? 0 : Number(input.proposedQuoteSize);
  return {
    grossQuoteExposure: gross + unknownEntryPenalty,
    netDirectionalExposure: net + unknownEntryPenalty,
    cashUtilization,
    cashReserveRemaining,
    totalOpenStopRisk: openStopRisk,
    pendingEntryRisk,
    pendingExitResidualRisk: pendingExitResidual,
    productExposure,
    modeExposure,
    clusterExposure,
    unprotectedExposure: unprotected,
    illiquidExposure,
    postCandidateProductExposure: postProduct,
    postCandidateModeExposure: postMode,
    postCandidateClusterExposure: postCluster,
  };
}

/** Sum a Map<string, number> to a scalar (used for reporting). */
export function sumMap(m: Map<string, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}

// ---------------------------------------------------------------------------
// §I — Volatility-target sizing
// ---------------------------------------------------------------------------

export interface VolatilitySizingResult {
  multiplier: number;
  rawMultiplier: number;
  observedVolatility: number | null;
  targetVolatility: number;
  reason: string;
}

export function measureVolatilitySizing(
  input: PortfolioRiskInput,
  vol: VolatilityEvidenceInput = input.volatilityEvidence,
): RiskMeasurement<VolatilitySizingResult> {
  const meta = {
    measurementKey: 'candidate.volatility_multiplier',
    unit: 'ratio',
    observedAt: input.observedAt,
    dataAvailableAt: vol.dataAvailableAt,
    policyVersion: 'p2c-risk-1',
    modelVersion: RISK_MEASUREMENT_MODEL_VERSION,
    inputHash: `vol:${vol.productId}:${vol.realizedVolatility}:${vol.samplingIntervalSeconds}:${vol.annualizationFactor}`,
  };
  if (vol.realizedVolatility == null) {
    return invalidMeasurement<VolatilitySizingResult>('unsupported', {
      ...meta,
      failureReason: 'realized volatility unavailable',
    });
  }
  if (!(vol.realizedVolatility >= 0) || !Number.isFinite(vol.realizedVolatility)) {
    return invalidMeasurement<VolatilitySizingResult>('invalid_input', {
      ...meta,
      failureReason: 'realized volatility is negative or non-finite',
    });
  }
  if (vol.volatilitySampleCount != null && vol.volatilitySampleCount < 32) {
    return invalidMeasurement<VolatilitySizingResult>('insufficient_history', {
      ...meta,
      failureReason: `only ${vol.volatilitySampleCount} vol samples`,
    });
  }
  const observed = Math.max(vol.realizedVolatility, vol.volatilityFloor);
  const rawMultiplier = observed > 0 ? vol.targetVolatility / observed : 0;
  // BOUND to [0, 1]: never increase size.
  const multiplier = Math.max(0, Math.min(1, rawMultiplier));
  const lowConfidence = vol.volatilityConfidence != null && vol.volatilityConfidence < 0.7;
  return validMeasurement<VolatilitySizingResult>({
    ...meta,
    value: {
      multiplier: lowConfidence ? Math.min(multiplier, 0.5) : multiplier,
      rawMultiplier,
      observedVolatility: vol.realizedVolatility,
      targetVolatility: vol.targetVolatility,
      reason: vol.realizedVolatility >= vol.targetVolatility ? 'reduce_from_high_vol' : 'ceiling_at_1',
    },
    confidence: vol.volatilityConfidence ?? 1,
    sampleCount: vol.volatilitySampleCount ?? null,
    lowConfidence,
    lowConfidenceReason: lowConfidence ? 'low volatility evidence confidence' : undefined,
    diagnostics: {
      annualizationFactor: vol.annualizationFactor,
      samplingIntervalSeconds: vol.samplingIntervalSeconds,
      floor: vol.volatilityFloor,
      ceiling: vol.volatilityCeiling,
    },
  });
}

// ---------------------------------------------------------------------------
// Utility helpers used by higher-level composition
// ---------------------------------------------------------------------------

export function knownPendingIntents(intents: readonly PendingIntentInput[]): PendingIntentInput[] {
  return intents.filter((i) => i.status === 'known');
}

export function anyUnknownPendingIntent(intents: readonly PendingIntentInput[]): boolean {
  return intents.some((i) => i.status === 'unknown');
}

export function forecastCostFromCashFlow(forecast: CashFlowForecast): number {
  return forecastNumber(forecast.totalForecastCost);
}

/** Compute per-product hygiene ratio for reporting. */
export function isProductLiquid(l: LiquidityEvidenceInput): boolean {
  if (!l.hygieneEligible) return false;
  if (l.zeroVolumeFrequency != null && l.zeroVolumeFrequency > 0.2) return false;
  if (l.candleGapFrequency != null && l.candleGapFrequency > 0.1) return false;
  return true;
}
