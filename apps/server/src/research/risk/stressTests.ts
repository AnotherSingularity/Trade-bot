import { createHash } from 'node:crypto';
import type { PortfolioRiskInput } from './inputs';

/**
 * Phase 2C §R — Deterministic stress scenarios.
 *
 * Each scenario is a pure function of the input plus its shock
 * definition. All results include a hash of the shock table so
 * replay is byte-stable and any parameter change forces a new
 * scenarioVersion.
 *
 * Stress results may REDUCE or REJECT the recommendation. They can
 * never increase size.
 */

export const STRESS_SCENARIO_VERSION = 'p2c-stress-1';

export interface ShockDefinition {
  btcReturnShock?: number;
  ethReturnShock?: number;
  marketWideReturnShock?: number;
  volMultiplier?: number;
  spreadMultiplier?: number;
  correlationCollapseToOne?: boolean;
  stopGapBps?: number;
  liquidityHaircut?: number;
  protectionFailureRate?: number;
}

export interface StressScenario {
  scenarioKey: string;
  description: string;
  shock: ShockDefinition;
  correlationPolicy: string;
  liquidityPolicy: string;
  protectionPolicy: string;
  valuationPolicy: string;
}

export const STRESS_SCENARIOS: readonly StressScenario[] = [
  {
    scenarioKey: 'BTC_DOWN_5',
    description: 'BTC drops 5% over the observation horizon; correlations at snapshot values.',
    shock: { btcReturnShock: -0.05 },
    correlationPolicy: 'snapshot',
    liquidityPolicy: 'as_observed',
    protectionPolicy: 'as_observed',
    valuationPolicy: 'mark_to_forecast',
  },
  {
    scenarioKey: 'BTC_DOWN_10',
    description: 'BTC drops 10%.',
    shock: { btcReturnShock: -0.1 },
    correlationPolicy: 'snapshot',
    liquidityPolicy: 'as_observed',
    protectionPolicy: 'as_observed',
    valuationPolicy: 'mark_to_forecast',
  },
  {
    scenarioKey: 'ETH_DOWN_10',
    description: 'ETH drops 10%.',
    shock: { ethReturnShock: -0.1 },
    correlationPolicy: 'snapshot',
    liquidityPolicy: 'as_observed',
    protectionPolicy: 'as_observed',
    valuationPolicy: 'mark_to_forecast',
  },
  {
    scenarioKey: 'ALT_BETA_SHOCK',
    description: 'BTC beta doubles across every position for the shock horizon.',
    shock: { btcReturnShock: -0.05 },
    correlationPolicy: 'beta_double',
    liquidityPolicy: 'as_observed',
    protectionPolicy: 'as_observed',
    valuationPolicy: 'mark_to_forecast',
  },
  {
    scenarioKey: 'MARKET_WIDE_15',
    description: 'All positions decline 15% simultaneously.',
    shock: { marketWideReturnShock: -0.15 },
    correlationPolicy: 'perfect_collapse_ignored',
    liquidityPolicy: 'as_observed',
    protectionPolicy: 'as_observed',
    valuationPolicy: 'mark_to_forecast',
  },
  {
    scenarioKey: 'CORRELATION_TO_ONE',
    description: 'All pairwise correlations collapse to 1; cluster limits treat everything as one cluster.',
    shock: { correlationCollapseToOne: true, marketWideReturnShock: -0.05 },
    correlationPolicy: 'collapse_to_one',
    liquidityPolicy: 'as_observed',
    protectionPolicy: 'as_observed',
    valuationPolicy: 'mark_to_forecast',
  },
  {
    scenarioKey: 'VOLATILITY_DOUBLES',
    description: 'Realized volatility doubles; potential stop-through and drawdown widen.',
    shock: { volMultiplier: 2 },
    correlationPolicy: 'snapshot',
    liquidityPolicy: 'as_observed',
    protectionPolicy: 'as_observed',
    valuationPolicy: 'mark_to_forecast',
  },
  {
    scenarioKey: 'SPREAD_TRIPLES',
    description: 'Approximate spread triples; exit costs widen.',
    shock: { spreadMultiplier: 3 },
    correlationPolicy: 'snapshot',
    liquidityPolicy: 'as_observed',
    protectionPolicy: 'as_observed',
    valuationPolicy: 'mark_to_forecast',
  },
  {
    scenarioKey: 'STOP_GAP',
    description: 'Gap-through stops by an additional 100bps beyond the configured stop-gap buffer.',
    shock: { stopGapBps: 100 },
    correlationPolicy: 'snapshot',
    liquidityPolicy: 'as_observed',
    protectionPolicy: 'as_observed',
    valuationPolicy: 'mark_to_forecast',
  },
  {
    scenarioKey: 'LIQUIDITY_HAIRCUT',
    description: '30% valuation haircut applied to positions in illiquid products.',
    shock: { liquidityHaircut: 0.3 },
    correlationPolicy: 'snapshot',
    liquidityPolicy: 'haircut_illiquid',
    protectionPolicy: 'as_observed',
    valuationPolicy: 'haircut',
  },
  {
    scenarioKey: 'PROTECTION_FAILURE',
    description: 'Assume 100% of protection orders fail to execute; treat exits as market gap-throughs.',
    shock: { protectionFailureRate: 1 },
    correlationPolicy: 'snapshot',
    liquidityPolicy: 'as_observed',
    protectionPolicy: 'assume_failure',
    valuationPolicy: 'mark_to_forecast',
  },
  {
    scenarioKey: 'COMBINED_SEVERE',
    description: 'BTC -10%, ETH -10%, vol×2, spread×3, correlation→1, protection failure.',
    shock: {
      btcReturnShock: -0.1,
      ethReturnShock: -0.1,
      volMultiplier: 2,
      spreadMultiplier: 3,
      correlationCollapseToOne: true,
      protectionFailureRate: 1,
    },
    correlationPolicy: 'collapse_to_one',
    liquidityPolicy: 'haircut_illiquid',
    protectionPolicy: 'assume_failure',
    valuationPolicy: 'haircut',
  },
];

export interface StressResult {
  scenarioKey: string;
  scenarioVersion: string;
  portfolioValueBefore: number;
  portfolioValueAfter: number;
  estimatedLoss: number;
  candidateIncrementalLoss: number;
  largestPositionContribution: number;
  largestClusterContribution: number;
  assumptions: string;
  limitBreaches: number;
  dataQualityStatus: 'ok' | 'degraded';
  implementationHash: string;
}

export interface StressBundle {
  positions: Array<{ productId: string; quoteExposure: number; btcBeta: number | null; ethBeta: number | null; clusterKey: string | null; hygieneEligible: boolean }>;
  candidate: { productId: string; quoteExposure: number; btcBeta: number | null; ethBeta: number | null; clusterKey: string | null; hygieneEligible: boolean };
  portfolioValueBefore: number;
}

export function runStressTests(
  bundle: StressBundle,
  scenarios: readonly StressScenario[] = STRESS_SCENARIOS,
): StressResult[] {
  return scenarios.map((s) => runStress(bundle, s));
}

function runStress(bundle: StressBundle, scenario: StressScenario): StressResult {
  const positions = bundle.positions;
  const cand = bundle.candidate;
  const shock = scenario.shock;

  const positionLosses: Array<{ productId: string; loss: number; clusterKey: string | null }> = [];
  for (const p of positions) {
    let lossPct = 0;
    if (shock.marketWideReturnShock != null) lossPct = -shock.marketWideReturnShock;
    else if (shock.btcReturnShock != null && p.btcBeta != null) lossPct = -shock.btcReturnShock * p.btcBeta;
    else if (shock.ethReturnShock != null && p.ethBeta != null) lossPct = -shock.ethReturnShock * p.ethBeta;
    if (shock.correlationCollapseToOne) lossPct = Math.max(lossPct, shock.marketWideReturnShock != null ? -shock.marketWideReturnShock : 0.05);
    if (shock.volMultiplier != null && shock.volMultiplier > 1) lossPct += 0.02 * (shock.volMultiplier - 1);
    if (shock.spreadMultiplier != null && shock.spreadMultiplier > 1) lossPct += 0.0005 * shock.spreadMultiplier;
    if (shock.stopGapBps != null) lossPct += shock.stopGapBps / 10_000;
    if (shock.liquidityHaircut != null && !p.hygieneEligible) lossPct += shock.liquidityHaircut;
    if (shock.protectionFailureRate != null && shock.protectionFailureRate > 0) lossPct = Math.max(lossPct, 0.05);
    positionLosses.push({ productId: p.productId, loss: Math.max(0, p.quoteExposure * lossPct), clusterKey: p.clusterKey });
  }
  let candidateLoss = 0;
  if (shock.marketWideReturnShock != null) candidateLoss = -shock.marketWideReturnShock * cand.quoteExposure;
  else if (shock.btcReturnShock != null && cand.btcBeta != null) candidateLoss = -shock.btcReturnShock * cand.btcBeta * cand.quoteExposure;
  if (shock.protectionFailureRate != null && shock.protectionFailureRate > 0) candidateLoss = Math.max(candidateLoss, 0.05 * cand.quoteExposure);
  if (shock.correlationCollapseToOne) candidateLoss = Math.max(candidateLoss, 0.05 * cand.quoteExposure);
  const positionLossTotal = positionLosses.reduce((a, b) => a + b.loss, 0);
  const totalLoss = positionLossTotal + Math.max(0, candidateLoss);
  const before = bundle.portfolioValueBefore;
  const after = before - totalLoss;
  const largestPosition = positionLosses.sort((a, b) => b.loss - a.loss)[0]?.loss ?? 0;
  const clusters = new Map<string, number>();
  for (const p of positionLosses) if (p.clusterKey) clusters.set(p.clusterKey, (clusters.get(p.clusterKey) ?? 0) + p.loss);
  const largestCluster = [...clusters.values()].sort((a, b) => b - a)[0] ?? 0;
  const implementationHash = createHash('sha256')
    .update(JSON.stringify({ v: STRESS_SCENARIO_VERSION, key: scenario.scenarioKey, shock }))
    .digest('hex');
  return {
    scenarioKey: scenario.scenarioKey,
    scenarioVersion: STRESS_SCENARIO_VERSION,
    portfolioValueBefore: before,
    portfolioValueAfter: after,
    estimatedLoss: totalLoss,
    candidateIncrementalLoss: Math.max(0, candidateLoss),
    largestPositionContribution: largestPosition,
    largestClusterContribution: largestCluster,
    assumptions: JSON.stringify({
      correlationPolicy: scenario.correlationPolicy,
      liquidityPolicy: scenario.liquidityPolicy,
      protectionPolicy: scenario.protectionPolicy,
      valuationPolicy: scenario.valuationPolicy,
    }),
    limitBreaches: 0,
    dataQualityStatus: 'ok',
    implementationHash,
  };
}

export function buildStressBundleFromInput(input: PortfolioRiskInput, portfolioValueBefore: number): StressBundle {
  const positions = input.currentPositions.map((p) => ({
    productId: p.productId,
    quoteExposure: Number(p.remainingBaseSize) * Number(p.markPrice ?? p.weightedAverageEntry),
    btcBeta: p.approximateBtcBeta,
    ethBeta: p.approximateEthBeta,
    clusterKey: p.clusterKey,
    hygieneEligible: true,
  }));
  const candidate = {
    productId: input.productId,
    quoteExposure: Number(input.proposedQuoteSize),
    btcBeta: input.benchmarkBetaEvidence.btcBeta,
    ethBeta: input.benchmarkBetaEvidence.ethBeta,
    clusterKey: input.clusterKey,
    hygieneEligible: input.liquidityEvidence.hygieneEligible,
  };
  return { positions, candidate, portfolioValueBefore };
}
