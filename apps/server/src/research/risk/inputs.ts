import { createHash } from 'node:crypto';
import type { CashFlowForecast } from '../../trading/cashFlowForecast';

/**
 * Phase 2C §D — Canonical RiskEngine input.
 *
 * Immutable. Every input carries a `dataAvailableAt` timestamp so
 * the honesty barrier is preserved. Unknown pending intents FAIL
 * CLOSED — never treated as "no intent".
 *
 * Money-typed values are represented as decimal strings so this
 * layer stays decimal-safe without coupling to a specific Money
 * implementation.
 */

export type StrategyMode = 'shadow' | 'live' | 'unknown';
export type ProtectionState = 'protected' | 'unprotected' | 'degraded' | 'unknown';
export type ReconciliationState = 'healthy' | 'degraded' | 'unresolved';

export interface CurrentPositionInput {
  productId: string;
  entryDecisionChainId: number | null;
  remainingBaseSize: string;
  weightedAverageEntry: string;
  entryFeesPaid: string;
  activeStopPrice: string | null;
  protectionState: ProtectionState;
  clusterKey: string | null;
  strategyMode: StrategyMode;
  markPrice: string | null;
  approximateBtcBeta: number | null;
  approximateEthBeta: number | null;
  dataAvailableAt: Date;
}

export interface PendingIntentInput {
  intentId: string;
  productId: string;
  direction: 'entry' | 'exit';
  proposedBaseSize: string;
  proposedQuoteSize: string;
  strategyMode: StrategyMode;
  clusterKey: string | null;
  status: 'known' | 'unknown';
  dataAvailableAt: Date;
}

export interface PortfolioLedgerStateInput {
  cash: string;
  reservedCash: string;
  totalEquity: string;
  peakEquity: string;
  peakEquityAt: Date;
  isConsistent: boolean;
  hasUnresolvedLegacy: boolean;
  dataAvailableAt: Date;
}

export interface LiquidityEvidenceInput {
  productId: string;
  quoteVolume24h: number | null;
  approximateSpreadBps: number | null;
  minOrderNotionalQuote: number | null;
  amihudIlliquidity: number | null;
  zeroVolumeFrequency: number | null;
  candleGapFrequency: number | null;
  hygieneEligible: boolean;
  dataAvailableAt: Date;
}

export interface VolatilityEvidenceInput {
  productId: string;
  realizedVolatility: number | null;
  volatilitySampleCount: number | null;
  volatilityConfidence: number | null;
  volatilityFloor: number;
  volatilityCeiling: number;
  targetVolatility: number;
  annualizationFactor: number;
  samplingIntervalSeconds: number;
  dataAvailableAt: Date;
}

export interface BenchmarkBetaEvidenceInput {
  productId: string;
  btcBeta: number | null;
  btcBetaConfidence: number | null;
  btcSampleCount: number | null;
  ethBeta: number | null;
  ethBetaConfidence: number | null;
  ethSampleCount: number | null;
  alignmentProven: boolean;
  dataAvailableAt: Date;
}

export interface DrawdownStateInput {
  peakEquity: string;
  currentEquity: string;
  currentDrawdown: string;
  maximumDrawdown: string;
  peakEquityAt: Date;
  dataAvailableAt: Date;
}

export interface DailyLossStateInput {
  periodStart: Date;
  periodEnd: Date;
  startingEquity: string;
  currentEquity: string;
  realizedNetPnl: string;
  dataAvailableAt: Date;
}

export interface WeeklyLossStateInput {
  periodStart: Date;
  periodEnd: Date;
  startingEquity: string;
  currentEquity: string;
  realizedNetPnl: string;
  dataAvailableAt: Date;
}

export interface ProductMetadataInput {
  productId: string;
  baseIncrement: string;
  quoteIncrement: string;
  baseMinimum: string;
  quoteMinimum: string | null;
  isSpot: boolean;
  quoteCurrency: string;
  isValid: boolean;
  dataAvailableAt: Date;
}

export interface ProtectionStateInput {
  candidateHasApprovedProtection: boolean;
  degraded: boolean;
  failureReason: string | null;
  dataAvailableAt: Date;
}

export interface ReconciliationStateInput {
  state: ReconciliationState;
  lastReconciledAt: Date | null;
  accountingDiscrepancy: boolean;
  dataAvailableAt: Date;
}

export interface CostForecastReference {
  forecastId: string;
  forecastVersion: string;
  forecast: CashFlowForecast;
}

export interface PortfolioRiskInput {
  decisionChainId: number;
  candidateId: string;
  productId: string;
  championMode: StrategyMode;
  clusterKey: string | null;
  proposedBaseSize: string;
  proposedQuoteSize: string;
  approvedEntryPrice: string;
  targetPrice: string;
  stopPrice: string;
  costForecast: CostForecastReference;
  cashAvailable: string;
  cashReserved: string;
  currentPositions: readonly CurrentPositionInput[];
  pendingEntryIntents: readonly PendingIntentInput[];
  pendingExitIntents: readonly PendingIntentInput[];
  portfolioLedgerState: PortfolioLedgerStateInput;
  protectionState: ProtectionStateInput;
  reconciliationState: ReconciliationStateInput;
  productMetadata: ProductMetadataInput;
  liquidityEvidence: LiquidityEvidenceInput;
  volatilityEvidence: VolatilityEvidenceInput;
  benchmarkBetaEvidence: BenchmarkBetaEvidenceInput;
  correlationSnapshotId: number | null;
  clusterSnapshotId: number | null;
  drawdownState: DrawdownStateInput;
  dailyLossState: DailyLossStateInput;
  weeklyLossState: WeeklyLossStateInput;
  safeEnvironment: { dryRun: boolean; orderSubmissionEnabled: boolean };
  observedAt: Date;
  dataAvailableAt: Date;
}

/**
 * Deterministic hash of the input bundle. Every candidate decision
 * carries this hash so any re-computation can be verified byte-stable.
 */
export function hashRiskInput(input: PortfolioRiskInput): string {
  const seed = {
    v: 'p2c-input-1',
    pid: input.productId,
    cand: input.candidateId,
    chain: input.decisionChainId,
    baseSize: input.proposedBaseSize,
    quoteSize: input.proposedQuoteSize,
    entry: input.approvedEntryPrice,
    target: input.targetPrice,
    stop: input.stopPrice,
    cash: input.cashAvailable,
    reserved: input.cashReserved,
    cost: {
      id: input.costForecast.forecastId,
      v: input.costForecast.forecastVersion,
      netStop: input.costForecast.forecast.netStopPnl.toDecimalString(),
      netTarget: input.costForecast.forecast.netTargetPnl.toDecimalString(),
      total: input.costForecast.forecast.totalForecastCost.toDecimalString(),
    },
    positions: [...input.currentPositions]
      .sort((a, b) => a.productId.localeCompare(b.productId))
      .map((p) => ({
        pid: p.productId,
        base: p.remainingBaseSize,
        avg: p.weightedAverageEntry,
        stop: p.activeStopPrice,
        prot: p.protectionState,
        cluster: p.clusterKey,
      })),
    entries: [...input.pendingEntryIntents]
      .sort((a, b) => a.intentId.localeCompare(b.intentId))
      .map((i) => ({ id: i.intentId, pid: i.productId, base: i.proposedBaseSize, s: i.status })),
    exits: [...input.pendingExitIntents]
      .sort((a, b) => a.intentId.localeCompare(b.intentId))
      .map((i) => ({ id: i.intentId, pid: i.productId, base: i.proposedBaseSize, s: i.status })),
    ledger: {
      cash: input.portfolioLedgerState.cash,
      reserved: input.portfolioLedgerState.reservedCash,
      equity: input.portfolioLedgerState.totalEquity,
      peak: input.portfolioLedgerState.peakEquity,
      ok: input.portfolioLedgerState.isConsistent,
      legacy: input.portfolioLedgerState.hasUnresolvedLegacy,
    },
    protection: input.protectionState,
    recon: input.reconciliationState.state,
    integrity: {
      dry: input.safeEnvironment.dryRun,
      submit: input.safeEnvironment.orderSubmissionEnabled,
    },
    liq: input.liquidityEvidence,
    vol: input.volatilityEvidence,
    beta: input.benchmarkBetaEvidence,
    dd: input.drawdownState,
    daily: input.dailyLossState,
    weekly: input.weeklyLossState,
    now: input.observedAt.toISOString(),
  };
  return createHash('sha256').update(JSON.stringify(seed)).digest('hex');
}
