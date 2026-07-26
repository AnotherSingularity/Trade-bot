import { Money } from '@horizon/shared';
import type { CashFlowForecast } from '../../../src/trading/cashFlowForecast';
import { UNCALIBRATED_PROBABILITY } from '../../../src/trading/cashFlowForecast';
import type {
  BenchmarkBetaEvidenceInput,
  CurrentPositionInput,
  DailyLossStateInput,
  DrawdownStateInput,
  LiquidityEvidenceInput,
  PendingIntentInput,
  PortfolioLedgerStateInput,
  PortfolioRiskInput,
  ProductMetadataInput,
  ProtectionStateInput,
  ReconciliationStateInput,
  VolatilityEvidenceInput,
  WeeklyLossStateInput,
} from '../../../src/research/risk/inputs';

/**
 * Phase 2C §AA — Replay fixture catalog.
 *
 * Builders return byte-stable `PortfolioRiskInput` bundles for use in
 * every §AD test. `baseRiskInput()` is the healthy baseline; each
 * builder mutates a single dimension to isolate one scenario.
 */

export const FIXTURE_NOW = new Date('2026-05-01T00:00:00.000Z');

function m(v: string): Money {
  return Money.fromString(v);
}

function bps(n: number): Money {
  return Money.fromBps(n);
}

export function buildForecast(
  entryPx: string,
  stopPx: string,
  baseSize: string,
): CashFlowForecast {
  const px = m(entryPx);
  const sp = m(stopPx);
  const q = m(baseSize);
  const commission = q.mul(px).mul(bps(10));
  const gapBuffer = q.mul(px).mul(bps(20));
  const priceMove = px.sub(sp);
  const stopInflow = q.mul(sp);
  const entryOut = q.mul(px).add(commission);
  const netStopPnl = stopInflow.sub(entryOut).sub(gapBuffer);
  return {
    costModelVersion: 'p1g3b-cashflow-1',
    bufferSource: 'configured',
    bufferVersion: 'p1g3b-configured-1',
    bufferSampleCount: 0,
    isEmpiricalBuffer: false,
    targetStopBasis: 'preview_entry',
    arrivalMid: px,
    previewEntryFillPrice: px,
    expectedFilledBase: q,
    conservativeTargetExitPrice: px,
    conservativeStopExitPrice: sp,
    conservativeTimeoutExitPrice: px,
    entryOutflow: entryOut,
    targetInflow: q.mul(px),
    stopInflow,
    timeoutInflow: q.mul(px),
    netTargetPnl: m('0'),
    netStopPnl,
    netTimeoutPnl: m('0'),
    entryCommission: commission,
    targetExitCommission: commission,
    stopExitCommission: commission,
    timeoutExitCommission: commission,
    quotedSpread: bps(2),
    effectiveSpread: bps(2),
    entryImpact: m('0'),
    targetExitImpact: m('0'),
    stopExitImpact: q.mul(px).mul(bps(15)),
    latencyBufferAbs: q.mul(px).mul(bps(5)),
    stopGapBufferAbs: gapBuffer,
    partialFillBufferAbs: q.mul(px).mul(bps(5)),
    unfilledOpportunityEstimate: m('0'),
    residualDustEstimate: m('0'),
    totalForecastCost: commission.add(gapBuffer),
    takeProfitPrice: px,
    stopLossPrice: sp,
    netRewardRisk: null,
    breakEvenWinProb: null,
    netTpPnl: m('0'),
    netSlPnl: netStopPnl,
    entryFee: commission,
    entryImpactBps: bps(0),
    estimatedEntryFillPrice: px,
    filledBaseSize: q,
    exitFeeEstimate: commission,
    exitImpactBpsEstimate: bps(15),
    latencySlippageBpsEstimate: bps(5),
    roundTripCost: commission.add(gapBuffer),
    costToTargetPct: m('0'),
    spreadBps: bps(2),
    exitCostQuantile: 0,
    outcomeProbabilityEstimate: UNCALIBRATED_PROBABILITY,
    // priceMove kept so tests can reason about it; not part of the type
  } as CashFlowForecast & { priceMove: Money };
  void priceMove;
}

// Every builder starts from this healthy baseline.
export function baseRiskInput(overrides: Partial<PortfolioRiskInput> = {}): PortfolioRiskInput {
  const forecast = buildForecast('100', '95', '1');
  const productMetadata: ProductMetadataInput = {
    productId: 'AAA-USD',
    baseIncrement: '0.001',
    quoteIncrement: '0.01',
    baseMinimum: '0.01',
    quoteMinimum: '1',
    isSpot: true,
    quoteCurrency: 'USD',
    isValid: true,
    dataAvailableAt: FIXTURE_NOW,
  };
  const ledger: PortfolioLedgerStateInput = {
    cash: '100000',
    reservedCash: '0',
    totalEquity: '100000',
    peakEquity: '100000',
    peakEquityAt: new Date('2026-04-01T00:00:00Z'),
    isConsistent: true,
    hasUnresolvedLegacy: false,
    dataAvailableAt: FIXTURE_NOW,
  };
  const liquidity: LiquidityEvidenceInput = {
    productId: 'AAA-USD',
    quoteVolume24h: 100_000_000,
    approximateSpreadBps: 5,
    minOrderNotionalQuote: 5,
    amihudIlliquidity: 1e-12,
    zeroVolumeFrequency: 0,
    candleGapFrequency: 0,
    hygieneEligible: true,
    dataAvailableAt: FIXTURE_NOW,
  };
  const volatility: VolatilityEvidenceInput = {
    productId: 'AAA-USD',
    realizedVolatility: 0.015,
    volatilitySampleCount: 288,
    volatilityConfidence: 0.9,
    volatilityFloor: 0.005,
    volatilityCeiling: 0.1,
    targetVolatility: 0.02,
    annualizationFactor: 288,
    samplingIntervalSeconds: 300,
    dataAvailableAt: FIXTURE_NOW,
  };
  const beta: BenchmarkBetaEvidenceInput = {
    productId: 'AAA-USD',
    btcBeta: 0.8,
    btcBetaConfidence: 0.9,
    btcSampleCount: 500,
    ethBeta: 0.7,
    ethBetaConfidence: 0.9,
    ethSampleCount: 500,
    alignmentProven: true,
    dataAvailableAt: FIXTURE_NOW,
  };
  const drawdown: DrawdownStateInput = {
    peakEquity: '100000',
    currentEquity: '100000',
    currentDrawdown: '0',
    maximumDrawdown: '0',
    peakEquityAt: new Date('2026-04-01T00:00:00Z'),
    dataAvailableAt: FIXTURE_NOW,
  };
  const daily: DailyLossStateInput = {
    periodStart: new Date('2026-05-01T00:00:00Z'),
    periodEnd: new Date('2026-05-02T00:00:00Z'),
    startingEquity: '100000',
    currentEquity: '100000',
    realizedNetPnl: '0',
    dataAvailableAt: FIXTURE_NOW,
  };
  const weekly: WeeklyLossStateInput = {
    periodStart: new Date('2026-04-27T00:00:00Z'),
    periodEnd: new Date('2026-05-04T00:00:00Z'),
    startingEquity: '100000',
    currentEquity: '100000',
    realizedNetPnl: '0',
    dataAvailableAt: FIXTURE_NOW,
  };
  const protection: ProtectionStateInput = {
    candidateHasApprovedProtection: true,
    degraded: false,
    failureReason: null,
    dataAvailableAt: FIXTURE_NOW,
  };
  const recon: ReconciliationStateInput = {
    state: 'healthy',
    lastReconciledAt: new Date('2026-04-30T23:59:00Z'),
    accountingDiscrepancy: false,
    dataAvailableAt: FIXTURE_NOW,
  };
  return {
    decisionChainId: 1,
    candidateId: 'cand-1',
    productId: 'AAA-USD',
    championMode: 'shadow',
    clusterKey: 'cluster:A',
    proposedBaseSize: '1',
    proposedQuoteSize: '100',
    approvedEntryPrice: '100',
    targetPrice: '110',
    stopPrice: '95',
    costForecast: {
      forecastId: 'fc-1',
      forecastVersion: 'p1g3b-cashflow-1',
      forecast,
    },
    cashAvailable: '100000',
    cashReserved: '0',
    currentPositions: [],
    pendingEntryIntents: [],
    pendingExitIntents: [],
    portfolioLedgerState: ledger,
    protectionState: protection,
    reconciliationState: recon,
    productMetadata,
    liquidityEvidence: liquidity,
    volatilityEvidence: volatility,
    benchmarkBetaEvidence: beta,
    correlationSnapshotId: null,
    clusterSnapshotId: null,
    drawdownState: drawdown,
    dailyLossState: daily,
    weeklyLossState: weekly,
    safeEnvironment: { dryRun: true, orderSubmissionEnabled: false },
    observedAt: FIXTURE_NOW,
    dataAvailableAt: FIXTURE_NOW,
    ...overrides,
  };
}

// Helper builders for common overrides.
export function withPosition(input: PortfolioRiskInput, p: Partial<CurrentPositionInput>): PortfolioRiskInput {
  const position: CurrentPositionInput = {
    productId: 'BBB-USD',
    entryDecisionChainId: 42,
    remainingBaseSize: '10',
    weightedAverageEntry: '50',
    entryFeesPaid: '0.5',
    activeStopPrice: '48',
    protectionState: 'protected',
    clusterKey: 'cluster:B',
    strategyMode: 'shadow',
    markPrice: '50',
    approximateBtcBeta: 0.8,
    approximateEthBeta: 0.7,
    dataAvailableAt: FIXTURE_NOW,
    ...p,
  };
  return { ...input, currentPositions: [...input.currentPositions, position] };
}

export function withPendingEntry(input: PortfolioRiskInput, i: Partial<PendingIntentInput> = {}): PortfolioRiskInput {
  const intent: PendingIntentInput = {
    intentId: `pending-${input.pendingEntryIntents.length + 1}`,
    productId: 'AAA-USD',
    direction: 'entry',
    proposedBaseSize: '0.5',
    proposedQuoteSize: '50',
    strategyMode: 'shadow',
    clusterKey: 'cluster:A',
    status: 'known',
    dataAvailableAt: FIXTURE_NOW,
    ...i,
  };
  return { ...input, pendingEntryIntents: [...input.pendingEntryIntents, intent] };
}
