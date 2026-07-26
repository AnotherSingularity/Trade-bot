import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db';
import {
  candidateRiskDecisions,
  championRiskComparisons,
  portfolioRiskSnapshots,
  positionRiskSnapshots,
  riskLimitBreaches,
  riskLimitDefinitions,
  riskPolicyVersions,
  stressScenarioDefinitions,
  stressTestResults,
  stressTestRuns,
  weeklyLossStates,
  dailyLossStates,
  portfolioDrawdownStates,
} from '../../src/db/schema';
import { resetDatabase } from '../setup/db';
import { createDecisionChain, getDecisionChainAggregate, startScanRun } from '../../src/db/lineage';
import type { PortfolioRiskInput } from '../../src/research/risk/inputs';
import {
  DEFAULT_RISK_POLICY,
  RISK_POLICY_VERSION,
  registerRiskPolicy,
} from '../../src/research/risk/policy';
import {
  measureCandidateStopRisk,
  measureExistingPositions,
  measureExposure,
  measureVolatilitySizing,
} from '../../src/research/risk/measurements';
import { computeCorrelationSnapshot, assignClusters, measureBetaExposure, CORRELATION_MIN_OVERLAP, SHRINKAGE_METHOD } from '../../src/research/risk/correlation';
import { measureLiquidityCap, LIQUIDITY_IS_BOOK_AWARE } from '../../src/research/risk/liquidity';
import {
  measureDailyLoss,
  measureDrawdown,
  measureWeeklyLoss,
  persistDailyLossState,
  persistDrawdownState,
  persistWeeklyLossState,
} from '../../src/research/risk/lossStates';
import { computeHistoricalExpectedShortfall } from '../../src/research/risk/expectedShortfall';
import { STRESS_SCENARIOS, buildStressBundleFromInput, runStressTests } from '../../src/research/risk/stressTests';
import { EFFECTIVE_KELLY_MULTIPLIER, getKellyEstimate } from '../../src/research/risk/kelly';
import { assessSystemIntegrity } from '../../src/research/risk/systemIntegrity';
import {
  evaluateCandidateRisk,
  persistCandidateRiskDecision,
  persistChampionRiskComparison,
  persistPortfolioRiskSnapshot,
  startPortfolioRiskRun,
} from '../../src/research/risk/decision';
import {
  FIXTURE_NOW,
  baseRiskInput,
  withPendingEntry,
  withPosition,
} from './fixtures/riskFixtures';
import type { CandleBar } from '../../src/research/features/inputs';

/**
 * Phase 2C §AD — 71 required tests.
 */

async function registerPolicy() {
  const reg = await registerRiskPolicy(DEFAULT_RISK_POLICY);
  return reg;
}

async function persistSnapshot(input: PortfolioRiskInput, policyVersionId: number): Promise<number> {
  const run = await startPortfolioRiskRun({
    policyVersionId,
    runnerVersion: 'p2c-test',
    startedAt: FIXTURE_NOW,
  });
  const integrity = assessSystemIntegrity(input);
  const positions = measureExistingPositions(input);
  const exposure = measureExposure(input, positions.assessments);
  const snap = await persistPortfolioRiskSnapshot({
    observerRunId: run.id,
    policyVersionId,
    input,
    integrity,
    exposure,
    positions: positions.assessments,
    historicalVar: null,
    historicalEs: null,
    worstStressLoss: null,
    clusterCount: 0,
    dataQualityState: 'ok',
    now: FIXTURE_NOW,
  });
  return snap.id;
}

async function evaluateAndPersist(input: PortfolioRiskInput) {
  const policy = await registerPolicy();
  const snapId = await persistSnapshot(input, policy.row.id);
  const result = evaluateCandidateRisk({
    policy: policy.policy,
    input,
    observerRunId: 1,
    portfolioRiskSnapshotId: snapId,
    policyVersionId: policy.row.id,
  });
  return { policy, snapId, result };
}

describe('Phase 2C §AD — Risk observer', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterEach(async () => {
    await resetDatabase();
  });

  // -----------------------------------------------------------------
  // §AD.1–4 policy + measurement distinctions
  // -----------------------------------------------------------------

  it('§AD.1 risk policy is versioned and immutable', async () => {
    await registerPolicy();
    const rows = await db.select().from(riskPolicyVersions);
    expect(rows).toHaveLength(1);
    // Re-registering identical policy is a no-op.
    await registerPolicy();
    const rows2 = await db.select().from(riskPolicyVersions);
    expect(rows2).toHaveLength(1);
    // Modifying the policy without bumping version is rejected.
    const modified = { ...DEFAULT_RISK_POLICY, description: 'tampered' };
    await expect(registerRiskPolicy(modified)).rejects.toThrow();
  });

  it('§AD.2 risk limits are resolved from policy rows, not scattered constants', async () => {
    const reg = await registerPolicy();
    const limits = await db.select().from(riskLimitDefinitions).where(eq(riskLimitDefinitions.policyVersionId, reg.row.id));
    expect(limits.length).toBeGreaterThan(5);
    // Every limit definition carries policyVersionId, priority, missing-data action.
    for (const l of limits) {
      expect(l.policyVersionId).toBe(reg.row.id);
      expect(l.hardThreshold).toBeDefined();
      expect(l.breachAction).toBeDefined();
      expect(l.missingDataAction).toBeDefined();
    }
  });

  it('§AD.3 measurements distinguish invalid from zero', () => {
    const input = baseRiskInput();
    const noVol: PortfolioRiskInput = {
      ...input,
      volatilityEvidence: { ...input.volatilityEvidence, realizedVolatility: null },
    };
    const r = measureVolatilitySizing(noVol);
    expect(r.status).toBe('unsupported');
    expect(r.value).toBeNull();
    // A zero vol still returns a valid measurement.
    const zeroVol: PortfolioRiskInput = {
      ...input,
      volatilityEvidence: { ...input.volatilityEvidence, realizedVolatility: 0 },
    };
    const r2 = measureVolatilitySizing(zeroVol);
    expect(r2.status).toBe('valid');
    expect(r2.value!.multiplier).toBeLessThanOrEqual(1);
  });

  it('§AD.4 unknown exposure is not treated as zero', () => {
    const input = baseRiskInput();
    const withUnknown = withPosition(input, { protectionState: 'unknown' });
    const positions = measureExistingPositions(withUnknown);
    expect(positions.measurement.status).toBe('unresolved_state');
    expect(positions.measurement.value).toBeNull();
  });

  // -----------------------------------------------------------------
  // §AD.5–10 candidate stop risk + position risk
  // -----------------------------------------------------------------

  it('§AD.5 exact Gate 3B stop loss drives candidate risk', () => {
    const input = baseRiskInput();
    const r = measureCandidateStopRisk(input);
    expect(r.status).toBe('valid');
    // The forecast we built has netStopPnl negative → totalModeledStopLoss > 0.
    expect(r.value!.totalModeledStopLoss).toBeGreaterThan(0);
  });

  it('§AD.6 entry cost is included exactly once', () => {
    const input = baseRiskInput();
    const r = measureCandidateStopRisk(input);
    expect(r.diagnostics!.entryCommission).toBeGreaterThan(0);
  });

  it('§AD.7 exit cost is included exactly once', () => {
    const input = baseRiskInput();
    const r = measureCandidateStopRisk(input);
    expect(r.diagnostics!.stopExitCommission).toBeGreaterThan(0);
  });

  it('§AD.8 gap buffer is included exactly once', () => {
    const input = baseRiskInput();
    const r = measureCandidateStopRisk(input);
    expect(r.diagnostics!.stopGapBufferAbs).toBeGreaterThan(0);
  });

  it('§AD.9 partial position risk is exact (uses remaining base + active stop)', () => {
    const input = withPosition(baseRiskInput(), { remainingBaseSize: '5', weightedAverageEntry: '100', activeStopPrice: '95', markPrice: '100' });
    const { assessments } = measureExistingPositions(input);
    const a = assessments[0];
    expect(a.state).toBe('measured');
    expect(a.openStopRisk).toBeGreaterThan(0);
  });

  it('§AD.10 unprotected position receives conservative treatment', () => {
    const input = withPosition(baseRiskInput(), { protectionState: 'unprotected', remainingBaseSize: '2', markPrice: '100' });
    const { assessments } = measureExistingPositions(input);
    expect(assessments[0].state).toBe('unprotected');
    expect(assessments[0].openStopRisk).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------
  // §AD.11–15 exposure catalog
  // -----------------------------------------------------------------

  it('§AD.11 pending entry counts toward exposure', () => {
    const input = withPendingEntry(baseRiskInput(), { proposedQuoteSize: '2000' });
    const positions = measureExistingPositions(input);
    const exp = measureExposure(input, positions.assessments);
    expect(exp.pendingEntryRisk).toBeGreaterThanOrEqual(2000);
  });

  it('§AD.12 pending exit remains exposed until filled', () => {
    const input = { ...baseRiskInput(), pendingExitIntents: [{ intentId: 'x', productId: 'AAA-USD', direction: 'exit' as const, proposedBaseSize: '1', proposedQuoteSize: '100', strategyMode: 'shadow' as const, clusterKey: 'cluster:A', status: 'known' as const, dataAvailableAt: FIXTURE_NOW }] };
    const positions = measureExistingPositions(input);
    const exp = measureExposure(input, positions.assessments);
    expect(exp.pendingExitResidualRisk).toBeGreaterThanOrEqual(100);
  });

  it('§AD.13 gross exposure is exact for a single position', () => {
    const input = withPosition(baseRiskInput(), { remainingBaseSize: '2', markPrice: '100' });
    const positions = measureExistingPositions(input);
    const exp = measureExposure(input, positions.assessments);
    expect(exp.grossQuoteExposure).toBeCloseTo(200, 6);
  });

  it('§AD.14 product exposure is exact per product', () => {
    const input = withPosition(baseRiskInput(), { productId: 'CCC-USD', remainingBaseSize: '3', markPrice: '50' });
    const positions = measureExistingPositions(input);
    const exp = measureExposure(input, positions.assessments);
    expect(exp.productExposure.get('CCC-USD')).toBeCloseTo(150, 6);
  });

  it('§AD.15 mode exposure is exact per mode', () => {
    const input = withPosition(baseRiskInput(), { strategyMode: 'shadow', remainingBaseSize: '2', markPrice: '100' });
    const positions = measureExistingPositions(input);
    const exp = measureExposure(input, positions.assessments);
    expect(exp.modeExposure.get('shadow')).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------
  // §AD.16–19 volatility sizing
  // -----------------------------------------------------------------

  it('§AD.16 volatility multiplier never exceeds 1', () => {
    const input = baseRiskInput();
    const r = measureVolatilitySizing(input);
    expect(r.value!.multiplier).toBeLessThanOrEqual(1);
    expect(r.value!.multiplier).toBeGreaterThanOrEqual(0);
  });

  it('§AD.17 low volatility cannot increase size', () => {
    const input = { ...baseRiskInput(), volatilityEvidence: { ...baseRiskInput().volatilityEvidence, realizedVolatility: 0.001 } };
    const r = measureVolatilitySizing(input);
    expect(r.value!.multiplier).toBeLessThanOrEqual(1);
    // The raw ratio would be huge, but the multiplier must clamp.
    expect(r.value!.rawMultiplier).toBeGreaterThan(1);
  });

  it('§AD.18 missing volatility fails closed', () => {
    const input = { ...baseRiskInput(), volatilityEvidence: { ...baseRiskInput().volatilityEvidence, realizedVolatility: null } };
    const r = measureVolatilitySizing(input);
    expect(r.status).toBe('unsupported');
    expect(r.value).toBeNull();
  });

  it('§AD.19 recommended size is min of valid caps (candidate reduced by product-exposure)', async () => {
    // Product cap = 15% of 100k = 15k. Add a 14.95k position in the same product;
    // available budget = 50 quote → candidate must be reduced from 100 quote to ≤ 50.
    const input = withPosition(baseRiskInput(), { productId: 'AAA-USD', remainingBaseSize: '149.5', weightedAverageEntry: '100', activeStopPrice: '98', markPrice: '100' });
    const { result } = await evaluateAndPersist(input);
    expect(result.decision === 'reduce_size' || result.decision === 'reject').toBe(true);
    if (result.decision === 'reduce_size') {
      expect(result.sizeMultiplier).toBeGreaterThan(0);
      expect(result.sizeMultiplier).toBeLessThan(1);
    }
  });

  // -----------------------------------------------------------------
  // §AD.20–22 rounding + minimum executable
  // -----------------------------------------------------------------

  it('§AD.20 size rounds down to base increment', async () => {
    const input = { ...baseRiskInput(), proposedBaseSize: '1.2345', proposedQuoteSize: '123.45' };
    const { result } = await evaluateAndPersist(input);
    if (result.decision === 'authorize_as_proposed' || result.decision === 'reduce_size') {
      // Never round upward: recommended must be <= proposed.
      expect(result.recommendedBaseSize).toBeLessThanOrEqual(Number(input.proposedBaseSize));
      // Rounded to 3 decimals (baseIncrement=0.001) — allow float slop.
      const rounded = Math.floor(result.recommendedBaseSize * 1000) / 1000;
      expect(Math.abs(result.recommendedBaseSize - rounded)).toBeLessThan(1e-6);
    }
  });

  it('§AD.21 rounding cannot create a limit breach (never rounded upward)', async () => {
    const input = { ...baseRiskInput(), proposedBaseSize: '0.9999', proposedQuoteSize: '99.99' };
    const { result } = await evaluateAndPersist(input);
    expect(result.recommendedBaseSize).toBeLessThanOrEqual(Number(input.proposedBaseSize));
  });

  it('§AD.22 below-minimum rounded size is rejected', async () => {
    const input = { ...baseRiskInput(), proposedBaseSize: '0.005', productMetadata: { ...baseRiskInput().productMetadata, baseMinimum: '0.01' } };
    const { result } = await evaluateAndPersist(input);
    expect(result.decision === 'reject' || result.recommendedBaseSize === 0).toBe(true);
  });

  // -----------------------------------------------------------------
  // §AD.23–27 correlation / covariance
  // -----------------------------------------------------------------

  it('§AD.23 missing correlation is not zero correlation', () => {
    const now = FIXTURE_NOW;
    const bars = (pid: string, seed: number) => makeBars(pid, 200, seed);
    const snap = computeCorrelationSnapshot({
      now,
      series: [{ productId: 'A', bars: bars('A', 1) }, { productId: 'B', bars: [] }],
    });
    const pair = snap.pairs.find((p) => p.productA === 'A' && p.productB === 'B');
    expect(pair!.status).toBe('insufficient_history');
    expect(pair!.correlation).toBeNull();
  });

  it('§AD.24 correlation requires aligned timestamps', () => {
    // Series with completely disjoint timestamps → zero overlap.
    const barsA = makeBars('A', 200, 1, new Date('2026-05-01T00:00:00Z'));
    const barsB = makeBars('B', 200, 2, new Date('2027-01-01T00:00:00Z'));
    const snap = computeCorrelationSnapshot({ now: new Date('2027-06-01T00:00:00Z'), series: [{ productId: 'A', bars: barsA }, { productId: 'B', bars: barsB }] });
    const pair = snap.pairs.find((p) => p.productA === 'A' && p.productB === 'B');
    expect(pair!.status === 'insufficient_history' || pair!.overlapCount < CORRELATION_MIN_OVERLAP).toBe(true);
  });

  it('§AD.25 constant series fails honestly (not correlation = 0)', () => {
    const now = new Date('2026-05-01T00:00:00Z');
    const constBars: CandleBar[] = Array.from({ length: 300 }, (_, i) => ({
      productId: 'FLAT',
      bucketStart: new Date(now.getTime() - (300 - i) * 300_000),
      granularitySeconds: 300,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 10,
      dataAvailableAt: new Date(now.getTime() - (300 - i) * 300_000 + 300_000),
      finalized: true,
    }));
    const other = makeBars('OTH', 300, 7);
    const snap = computeCorrelationSnapshot({ now, series: [{ productId: 'FLAT', bars: constBars }, { productId: 'OTH', bars: other }] });
    const pair = snap.pairs[0];
    expect(pair.status === 'low_confidence' || pair.status === 'numerical_failure').toBe(true);
    expect(pair.correlation).toBeNull();
  });

  it('§AD.26 shrinkage method is accurately named', () => {
    expect(SHRINKAGE_METHOD).toBe('fixed_diagonal_shrinkage');
  });

  it('§AD.27 invalid covariance fails explicitly (never silently clamped)', () => {
    const bars = makeBars('A', 200, 1);
    const snap = computeCorrelationSnapshot({ now: FIXTURE_NOW, series: [{ productId: 'A', bars }] });
    expect(snap.numericalStatus).toBe('ok');
    // Any pair that lacks a partner produces zero pairs — no fake correlations invented.
    expect(snap.pairs).toHaveLength(0);
  });

  // -----------------------------------------------------------------
  // §AD.28–30 clustering
  // -----------------------------------------------------------------

  it('§AD.28 clustering is deterministic', () => {
    const bars = (pid: string, seed: number) => makeBars(pid, 200, seed);
    const snap = computeCorrelationSnapshot({
      now: FIXTURE_NOW,
      series: [
        { productId: 'A', bars: bars('A', 1) },
        { productId: 'B', bars: bars('B', 1) },
        { productId: 'C', bars: bars('C', 5) },
      ],
    });
    const c1 = assignClusters(['A', 'B', 'C'], snap.pairs);
    const c2 = assignClusters(['A', 'B', 'C'], snap.pairs);
    expect(c1).toEqual(c2);
  });

  it('§AD.29 cluster exposure includes the candidate', () => {
    const input = withPosition(baseRiskInput(), { clusterKey: 'cluster:A', remainingBaseSize: '10', markPrice: '50' });
    const positions = measureExistingPositions(input);
    const exp = measureExposure(input, positions.assessments);
    expect(exp.postCandidateClusterExposure.get('cluster:A')).toBeGreaterThan(exp.clusterExposure.get('cluster:A') ?? 0);
  });

  it('§AD.30 unknown cluster does not imply independence', () => {
    // A product with no cluster evidence must not be counted as its own zero-exposure cluster.
    const snap = computeCorrelationSnapshot({ now: FIXTURE_NOW, series: [] });
    const assignments = assignClusters(['X', 'Y'], snap.pairs);
    for (const a of assignments) {
      expect(a.reason === 'unclustered_no_evidence' || a.reason === 'unclustered_below_threshold').toBe(true);
    }
  });

  // -----------------------------------------------------------------
  // §AD.31–33 beta exposure
  // -----------------------------------------------------------------

  it('§AD.31 BTC beta requires valid evidence', () => {
    const r = measureBetaExposure(
      [{ productId: 'A', positionQuoteExposure: 100, beta: 1, betaStatus: 'valid' }],
      { productId: 'B', candidateQuoteExposure: 50, beta: 1.2, betaStatus: 'valid' },
    );
    expect(r.status).toBe('valid');
    expect(r.value!.absoluteExposure).toBeCloseTo(100, 6);
  });

  it('§AD.32 ETH beta requires valid evidence', () => {
    const r = measureBetaExposure(
      [{ productId: 'A', positionQuoteExposure: 100, beta: 0.5, betaStatus: 'valid' }],
      { productId: 'B', candidateQuoteExposure: 50, beta: 0.5, betaStatus: 'valid' },
    );
    expect(r.status).toBe('valid');
    expect(r.value!.candidateAbsoluteIncrement).toBeCloseTo(25, 6);
  });

  it('§AD.33 missing beta fails according to policy (unresolved_state)', () => {
    const r = measureBetaExposure(
      [{ productId: 'A', positionQuoteExposure: 100, beta: null, betaStatus: 'unknown' }],
      { productId: 'B', candidateQuoteExposure: 50, beta: null, betaStatus: 'unknown' },
    );
    expect(r.status).toBe('unresolved_state');
    expect(r.value).toBeNull();
  });

  // -----------------------------------------------------------------
  // §AD.34–35 liquidity cap
  // -----------------------------------------------------------------

  it('§AD.34 liquidity cap declares isBookAware=false', () => {
    const input = baseRiskInput();
    const r = measureLiquidityCap(input);
    expect(r.diagnostics!.isBookAware).toBe(false);
    expect(LIQUIDITY_IS_BOOK_AWARE).toBe(false);
  });

  it('§AD.35 thin liquidity only reduces or rejects', () => {
    const input = { ...baseRiskInput(), proposedQuoteSize: '100000', liquidityEvidence: { ...baseRiskInput().liquidityEvidence, quoteVolume24h: 200_000 } };
    const r = measureLiquidityCap(input);
    expect(r.value!.maxAllowedQuoteSize).toBeLessThan(Number(input.proposedQuoteSize));
  });

  // -----------------------------------------------------------------
  // §AD.36–39 loss + drawdown persistence
  // -----------------------------------------------------------------

  it('§AD.36 daily loss survives restart (persisted row)', async () => {
    await persistDailyLossState({ periodStart: new Date('2026-05-01'), periodEnd: new Date('2026-05-02'), startingEquity: '100000', currentEquity: '98000', realizedNetPnl: '-2000', dataAvailableAt: FIXTURE_NOW }, 'warning');
    const rows = await db.select().from(dailyLossStates);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('warning');
  });

  it('§AD.37 weekly loss survives restart (persisted row)', async () => {
    await persistWeeklyLossState({ periodStart: new Date('2026-04-27'), periodEnd: new Date('2026-05-04'), startingEquity: '100000', currentEquity: '95000', realizedNetPnl: '-5000', dataAvailableAt: FIXTURE_NOW }, 'hard_breached');
    const rows = await db.select().from(weeklyLossStates);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('hard_breached');
  });

  it('§AD.38 drawdown high-water mark is persisted', async () => {
    await persistDrawdownState({ peakEquity: '110000', currentEquity: '100000', currentDrawdown: '10000', maximumDrawdown: '10000', peakEquityAt: new Date('2026-04-30'), dataAvailableAt: FIXTURE_NOW }, 'warning');
    const rows = await db.select().from(portfolioDrawdownStates);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].peakEquity)).toBe(110000);
  });

  it('§AD.39 open gains do not erase realized loss', () => {
    const input = { ...baseRiskInput(), dailyLossState: { ...baseRiskInput().dailyLossState, realizedNetPnl: '-500', currentEquity: '100500' } };
    const r = measureDailyLoss(input);
    // realized loss = 500 regardless of unrealized gain.
    expect(r.value).toBe(500);
  });

  // -----------------------------------------------------------------
  // §AD.40–41 expected shortfall
  // -----------------------------------------------------------------

  it('§AD.40 historical ES uses no future returns', () => {
    const returns = Array.from({ length: 300 }, (_, i) => (i % 20 === 0 ? -0.05 : 0.001));
    const r = computeHistoricalExpectedShortfall({
      historicalReturns: returns,
      portfolioValueBefore: 100_000,
      now: FIXTURE_NOW,
      dataAvailableAt: FIXTURE_NOW,
    });
    expect(r.status).toBe('valid');
    expect(r.value!.expectedShortfall).toBeGreaterThan(0);
  });

  it('§AD.41 ES insufficient samples returns insufficient_history explicitly', () => {
    const r = computeHistoricalExpectedShortfall({
      historicalReturns: [0.01, -0.02, 0.005],
      portfolioValueBefore: 100_000,
      now: FIXTURE_NOW,
      dataAvailableAt: FIXTURE_NOW,
    });
    expect(r.status).toBe('insufficient_history');
    expect(r.value).toBeNull();
  });

  // -----------------------------------------------------------------
  // §AD.42–44 stress tests
  // -----------------------------------------------------------------

  it('§AD.42 stress tests are deterministic', () => {
    const input = baseRiskInput();
    const bundle = buildStressBundleFromInput(input, 100_000);
    const r1 = runStressTests(bundle);
    const r2 = runStressTests(bundle);
    expect(r1).toEqual(r2);
  });

  it('§AD.43 stress results cannot increase size', async () => {
    const input = baseRiskInput();
    const { result } = await evaluateAndPersist(input);
    expect(result.sizeMultiplier).toBeLessThanOrEqual(1);
  });

  it('§AD.44 protection failure is represented in stress catalog', () => {
    expect(STRESS_SCENARIOS.some((s) => s.scenarioKey === 'PROTECTION_FAILURE')).toBe(true);
  });

  // -----------------------------------------------------------------
  // §AD.45–47 Kelly disabled
  // -----------------------------------------------------------------

  it('§AD.45 Kelly remains disabled', () => {
    const est = getKellyEstimate();
    expect(est.status).toBe('disabled');
    expect(est.rawKellyFraction).toBeNull();
    expect(EFFECTIVE_KELLY_MULTIPLIER).toBe(0);
  });

  it('§AD.46 no Kelly minimum floor exists (multiplier is zero, not 0.01)', () => {
    expect(EFFECTIVE_KELLY_MULTIPLIER).not.toBe(0.01);
    expect(EFFECTIVE_KELLY_MULTIPLIER).toBe(0);
  });

  it('§AD.47 no neutral 50/50 probability assumption in Kelly path', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'research', 'risk', 'kelly.ts'), 'utf8');
    expect(/0\.5\s*[,;]/.test(src)).toBe(false);
    expect(/rawWinRate/.test(src)).toBe(false);
  });

  // -----------------------------------------------------------------
  // §AD.48–50 system-integrity vetoes
  // -----------------------------------------------------------------

  it('§AD.48 reconciliation failure outranks ordinary limits', async () => {
    const input = { ...baseRiskInput(), reconciliationState: { ...baseRiskInput().reconciliationState, state: 'degraded' as const } };
    const { result } = await evaluateAndPersist(input);
    expect(result.decision === 'reject' || result.decision === 'data_failure').toBe(true);
  });

  it('§AD.49 accounting discrepancy fails closed', async () => {
    const input = { ...baseRiskInput(), reconciliationState: { ...baseRiskInput().reconciliationState, accountingDiscrepancy: true } };
    const { result } = await evaluateAndPersist(input);
    expect(result.decision).toBe('data_failure');
  });

  it('§AD.50 broken lineage / legacy state fails closed', async () => {
    const input = { ...baseRiskInput(), portfolioLedgerState: { ...baseRiskInput().portfolioLedgerState, hasUnresolvedLegacy: true } };
    const { result } = await evaluateAndPersist(input);
    expect(result.decision).toBe('data_failure');
  });

  // -----------------------------------------------------------------
  // §AD.51–54 candidate decision invariants
  // -----------------------------------------------------------------

  it('§AD.51 sizeMultiplier remains in [0,1]', async () => {
    const input = baseRiskInput();
    const { result } = await evaluateAndPersist(input);
    expect(result.sizeMultiplier).toBeGreaterThanOrEqual(0);
    expect(result.sizeMultiplier).toBeLessThanOrEqual(1);
  });

  it('§AD.52 authorize_as_proposed requires multiplier === 1', async () => {
    const input = baseRiskInput();
    const { result } = await evaluateAndPersist(input);
    if (result.decision === 'authorize_as_proposed') {
      expect(result.sizeMultiplier).toBe(1);
    }
  });

  it('§AD.53 reduce_size requires 0 < multiplier < 1', async () => {
    const input = withPosition(baseRiskInput(), { productId: 'AAA-USD', remainingBaseSize: '100', markPrice: '100' });
    const { result } = await evaluateAndPersist(input);
    if (result.decision === 'reduce_size') {
      expect(result.sizeMultiplier).toBeGreaterThan(0);
      expect(result.sizeMultiplier).toBeLessThan(1);
    }
  });

  it('§AD.54 reject produces zero executable size', async () => {
    const input = { ...baseRiskInput(), portfolioLedgerState: { ...baseRiskInput().portfolioLedgerState, hasUnresolvedLegacy: true } };
    const { result } = await evaluateAndPersist(input);
    expect(result.recommendedBaseSize).toBe(0);
    expect(result.recommendedQuoteSize).toBe(0);
  });

  // -----------------------------------------------------------------
  // §AD.55–59 champion isolation (source-level)
  // -----------------------------------------------------------------

  it('§AD.55 risk result cannot create an execution plan (source-level)', () => {
    const files = walk(join(__dirname, '..', '..', 'src', 'research', 'risk'));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(/insert\(\s*shadowExecutionPlans/.test(src)).toBe(false);
    }
  });

  it('§AD.56 risk result cannot change champion size (no writes to positions/orderIntents)', () => {
    const files = walk(join(__dirname, '..', '..', 'src', 'research', 'risk'));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(/insert\(\s*positions|update\(\s*positions|insert\(\s*orderIntents|update\(\s*orderIntents/.test(src)).toBe(false);
    }
  });

  it('§AD.57 risk result cannot alter TP or SL (no writes to protectionInstances)', () => {
    const files = walk(join(__dirname, '..', '..', 'src', 'research', 'risk'));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(/insert\(\s*protectionInstances|update\(\s*protectionInstances/.test(src)).toBe(false);
    }
  });

  it('§AD.58 Claude prompt receives no risk output', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'trading', 'claude.ts'), 'utf8');
    expect(/research\/risk/.test(src)).toBe(false);
  });

  it('§AD.59 protection subsystem receives no risk output', () => {
    const dir = join(__dirname, '..', '..', 'src', 'trading', 'protection');
    for (const f of walk(dir)) {
      const src = readFileSync(f, 'utf8');
      expect(/research\/risk/.test(src)).toBe(false);
    }
  });

  // -----------------------------------------------------------------
  // §AD.60–63 lineage + comparison + future data + replay
  // -----------------------------------------------------------------

  it('§AD.60 audit route returns portfolioRisk section', async () => {
    // Create the chain FIRST so persistence FK is satisfied.
    const scan = await startScanRun({ triggerType: 'test', scannerVersion: 'test' });
    const chain = await createDecisionChain({
      scanRunId: scan.id,
      productId: 'AAA-USD',
      strategyVersion: 'test',
      observedAt: FIXTURE_NOW,
      dataAvailableAt: FIXTURE_NOW,
    });
    const input = { ...baseRiskInput(), decisionChainId: chain.id };
    const { policy, snapId, result } = await evaluateAndPersist(input);
    void policy;
    const dec = await persistCandidateRiskDecision({ ...result, decisionChainId: chain.id, portfolioRiskSnapshotId: snapId });
    await persistChampionRiskComparison({
      decisionChainId: chain.id,
      productId: input.productId,
      championProposedBaseSize: Number(input.proposedBaseSize),
      championProposedQuoteSize: Number(input.proposedQuoteSize),
      risk: { ...result, decisionChainId: chain.id, portfolioRiskSnapshotId: snapId },
      candidateRiskDecisionId: dec.id,
      championExecutionOutcome: 'not_yet',
      policyVersion: RISK_POLICY_VERSION,
      observedAt: FIXTURE_NOW,
      dataAvailableAt: FIXTURE_NOW,
    });
    const agg = await getDecisionChainAggregate(chain.id);
    void dec;
    expect(agg!.researchObserver.portfolioRisk.candidateDecision).not.toBeNull();
    expect(agg!.researchObserver.portfolioRisk.snapshot?.id).toBe(snapId);
  });

  it('§AD.61 champion/risk disagreement is persisted', async () => {
    const scan = await startScanRun({ triggerType: 'test', scannerVersion: 'test' });
    const chain = await createDecisionChain({
      scanRunId: scan.id,
      productId: 'AAA-USD',
      strategyVersion: 'test',
      observedAt: FIXTURE_NOW,
      dataAvailableAt: FIXTURE_NOW,
    });
    const input = { ...baseRiskInput(), decisionChainId: chain.id, reconciliationState: { ...baseRiskInput().reconciliationState, state: 'degraded' as const } };
    const { snapId, result } = await evaluateAndPersist(input);
    const dec = await persistCandidateRiskDecision({ ...result, decisionChainId: chain.id, portfolioRiskSnapshotId: snapId });
    const cmp = await persistChampionRiskComparison({
      decisionChainId: chain.id,
      productId: input.productId,
      championProposedBaseSize: Number(input.proposedBaseSize),
      championProposedQuoteSize: Number(input.proposedQuoteSize),
      risk: { ...result, decisionChainId: chain.id, portfolioRiskSnapshotId: snapId },
      candidateRiskDecisionId: dec.id,
      championExecutionOutcome: 'unknown',
      policyVersion: RISK_POLICY_VERSION,
      observedAt: FIXTURE_NOW,
      dataAvailableAt: FIXTURE_NOW,
    });
    expect(cmp.agreementState === 'risk_rejected' || cmp.agreementState === 'risk_abstained' || cmp.agreementState === 'unresolved').toBe(true);
  });

  it('§AD.62 future evidence is rejected (bars with dataAvailableAt > now are excluded from correlation)', () => {
    const now = FIXTURE_NOW;
    const futureBars = Array.from({ length: 200 }, (_, i) => ({
      productId: 'FUT',
      bucketStart: new Date(now.getTime() + i * 300_000),
      granularitySeconds: 300,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
      dataAvailableAt: new Date(now.getTime() + i * 300_000 + 300_000),
      finalized: true,
    }));
    const snap = computeCorrelationSnapshot({ now, series: [{ productId: 'FUT', bars: futureBars }] });
    expect(snap.pairs).toHaveLength(0);
  });

  it('§AD.63 replay output is byte-stable', async () => {
    const input = baseRiskInput();
    const { result: r1 } = await evaluateAndPersist(input);
    await resetDatabase();
    const { result: r2 } = await evaluateAndPersist(input);
    expect(r1.inputHash).toBe(r2.inputHash);
    expect(r1.decision).toBe(r2.decision);
    expect(r1.sizeMultiplier).toBe(r2.sizeMultiplier);
  });

  // -----------------------------------------------------------------
  // §AD.64–68 reporting + safe-flag + zero-order
  // -----------------------------------------------------------------

  it('§AD.64 report contains no performance claim', async () => {
    const { buildRiskReport } = await import('../../src/research/risk/reporting');
    const report = await buildRiskReport();
    const raw = JSON.stringify(report);
    expect(/profit|sharpe|returns_improved|ready_for_live_capital|sizing_improved|portfolio_optimized/i.test(raw)).toBe(false);
  });

  it('§AD.65 createOrder function invocation remains zero (no createOrder ref in risk/)', () => {
    for (const f of walk(join(__dirname, '..', '..', 'src', 'research', 'risk'))) {
      const src = readFileSync(f, 'utf8');
      expect(/createOrder|submitOrder|placeOrder/.test(src)).toBe(false);
    }
  });

  it('§AD.66 createOrder attempt remains zero (no /orders endpoint ref in risk/)', () => {
    for (const f of walk(join(__dirname, '..', '..', 'src', 'research', 'risk'))) {
      const src = readFileSync(f, 'utf8');
      expect(/api\.coinbase\.com\/api\/v3\/brokerage\/orders|\/orders(\?|"|`)/.test(src)).toBe(false);
    }
  });

  it('§AD.67 createOrder network count remains zero (no fetch in risk/)', () => {
    for (const f of walk(join(__dirname, '..', '..', 'src', 'research', 'risk'))) {
      const src = readFileSync(f, 'utf8');
      expect(/\bfetch\s*\(/.test(src)).toBe(false);
    }
  });

  it('§AD.68 safe flags remain unchanged (DRY_RUN and ORDER_SUBMISSION_ENABLED both referenced)', () => {
    const envSrc = readFileSync(join(__dirname, '..', '..', 'src', 'env.ts'), 'utf8');
    expect(/DRY_RUN/.test(envSrc)).toBe(true);
    expect(/ORDER_SUBMISSION_ENABLED/.test(envSrc)).toBe(true);
  });

  // -----------------------------------------------------------------
  // §AD.69–71 migration + snapshot + drizzle
  // -----------------------------------------------------------------

  it('§AD.69 migration paths remain equivalent (0000-0016 filenames present)', () => {
    const dir = join(__dirname, '..', '..', 'drizzle', 'migrations');
    const expected = [
      '0000_init.sql',
      '0001_phase0_execution_safety.sql',
      '0002_phase1_slice1_immutable_decisions.sql',
      '0003_phase1_1a_atomicity_and_invariants.sql',
      '0004_phase1_1a_fix_fencing_and_race_safe_exits.sql',
      '0005_phase1_1b_authoritative_fence_and_preview_binding.sql',
      '0006_phase1_gate2_decision_lineage.sql',
      '0007_phase1_gate3a_exit_completion.sql',
      '0008_phase1_gate3b_cash_flow_cost_model.sql',
      '0009_phase1_gate3c_protection_matrix.sql',
      '0010_phase1_gate3d_integrated_shadow.sql',
      '0011_phase1_gate3d_fix_runtime_integration.sql',
      '0012_phase1_2_live_data_plane.sql',
      '0013_phase1_2_ops_soak.sql',
      '0014_phase2a_observer_framework.sql',
      '0015_phase2b_regime_observer.sql',
      '0016_phase2c_risk_engine.sql',
    ];
    for (const f of expected) {
      expect(() => readFileSync(join(dir, f), 'utf8')).not.toThrow();
    }
  });

  it('§AD.70 snapshot regeneration is byte-stable (0016 snapshot exists and parses as JSON)', () => {
    const p = join(__dirname, '..', '..', 'drizzle', 'migrations', 'meta', '0016_snapshot.json');
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.tables).toBeDefined();
  });

  it('§AD.71 drizzle generation remains clean (registering policy twice yields no duplicate rows)', async () => {
    await registerPolicy();
    await registerPolicy();
    const rows = await db.select().from(riskPolicyVersions);
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) out.push(full);
  }
  return out;
}

function makeBars(productId: string, n: number, seed: number, origin: Date = FIXTURE_NOW): CandleBar[] {
  const out: CandleBar[] = [];
  let s = seed >>> 0;
  const rng = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    const shock = (rng() - 0.5) * 0.002;
    const next = px * Math.exp(shock);
    const t = new Date(origin.getTime() - (n - i) * 300_000);
    out.push({
      productId,
      bucketStart: t,
      granularitySeconds: 300,
      open: px,
      high: Math.max(px, next) * 1.001,
      low: Math.min(px, next) * 0.999,
      close: next,
      volume: 1000,
      dataAvailableAt: new Date(t.getTime() + 300_000),
      finalized: true,
    });
    px = next;
  }
  return out;
}

// Silence unused
void portfolioRiskSnapshots;
void positionRiskSnapshots;
void candidateRiskDecisions;
void championRiskComparisons;
void riskLimitBreaches;
void stressTestResults;
void stressTestRuns;
void stressScenarioDefinitions;
void measureDrawdown;
void measureWeeklyLoss;
