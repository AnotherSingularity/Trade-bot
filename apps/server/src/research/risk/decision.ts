import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  candidateRiskDecisions,
  championRiskComparisons,
  portfolioRiskRuns,
  portfolioRiskSnapshots,
  positionRiskSnapshots,
  riskLimitBreaches,
  riskLimitDefinitions,
  stressTestResults,
  stressTestRuns,
  stressScenarioDefinitions,
  type CandidateRiskDecisionRow,
  type ChampionRiskComparisonRow,
  type PortfolioRiskRunRow,
  type PortfolioRiskSnapshotRow,
  type StressScenarioDefinitionRow,
} from '../../db/schema';
import type { RiskMeasurement } from './contract';
import type { PortfolioRiskInput } from './inputs';
import { hashRiskInput } from './inputs';
import type { RiskPolicy } from './policy';
import { findLimit, registerRiskPolicy } from './policy';
import type { ExposureBreakdown } from './measurements';
import { measureCandidateStopRisk, measureExposure, measureExistingPositions, measureVolatilitySizing, type PositionRiskAssessment } from './measurements';
import { measureBetaExposure } from './correlation';
import { measureLiquidityCap } from './liquidity';
import { measureDailyLoss, measureDrawdown, measureWeeklyLoss } from './lossStates';
import type { EsResult } from './expectedShortfall';
import { computeHistoricalExpectedShortfall } from './expectedShortfall';
import { buildStressBundleFromInput, STRESS_SCENARIOS, STRESS_SCENARIO_VERSION, runStressTests, type StressResult } from './stressTests';
import { assessSystemIntegrity, type SystemIntegrityAssessment } from './systemIntegrity';
import { composeCaps, type CapCompositionResult } from './sizeCap';
import { EFFECTIVE_KELLY_MULTIPLIER } from './kelly';

/**
 * Phase 2C §U — Candidate risk decision.
 *
 * The immutable per-candidate result. Decisions:
 *   authorize_as_proposed | reduce_size | reject | abstain | data_failure
 *
 * Rules:
 *   - sizeMultiplier ∈ [0,1]
 *   - authorize_as_proposed requires multiplier === 1
 *   - reduce_size requires 0 < multiplier < 1
 *   - zero executable size → reject
 *   - missing critical evidence → abstain or data_failure
 *   - hard system-integrity failure → reject or data_failure
 */

export const RISK_ENGINE_VERSION = 'p2c-engine-1';

export type RiskDecisionKind =
  | 'authorize_as_proposed'
  | 'reduce_size'
  | 'reject'
  | 'abstain'
  | 'data_failure';

export interface RiskDecisionResult {
  decisionChainId: number;
  candidateId: string;
  policyVersionId: number;
  portfolioRiskSnapshotId: number;
  proposedBaseSize: number;
  proposedQuoteSize: number;
  recommendedBaseSize: number;
  recommendedQuoteSize: number;
  sizeMultiplier: number;
  decision: RiskDecisionKind;
  bindingLimit: string | null;
  warningBreaches: number;
  hardBreaches: number;
  systemIntegrity: SystemIntegrityAssessment;
  confidence: number;
  observedAt: Date;
  dataAvailableAt: Date;
  inputHash: string;
  reasonCodes: string[];
  diagnostics: Record<string, unknown>;
  breaches: BreachRecord[];
}

export interface BreachRecord {
  limitKey: string;
  scope: string;
  measuredValue: number;
  warningThreshold: number | null;
  hardThreshold: number;
  severity: 'warning' | 'hard' | 'system_integrity';
  breachAction: string;
}

export interface EvaluateInput {
  policy: RiskPolicy;
  input: PortfolioRiskInput;
  observerRunId: number;
  portfolioRiskSnapshotId: number;
  policyVersionId: number;
  historicalReturns?: readonly number[];
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

export function evaluateCandidateRisk(inp: EvaluateInput): RiskDecisionResult {
  const integrity = assessSystemIntegrity(inp.input);
  const stopRisk = measureCandidateStopRisk(inp.input);
  const positions = measureExistingPositions(inp.input);
  const exposure = measureExposure(inp.input, positions.assessments);
  const volatility = measureVolatilitySizing(inp.input);
  const liquidity = measureLiquidityCap(inp.input);
  const btcBeta = measureBetaExposure(
    inp.input.currentPositions.map((p) => ({
      productId: p.productId,
      positionQuoteExposure: Number(p.remainingBaseSize) * Number(p.markPrice ?? p.weightedAverageEntry),
      beta: p.approximateBtcBeta,
      betaStatus: p.approximateBtcBeta == null ? 'unknown' : 'valid',
    })),
    {
      productId: inp.input.productId,
      candidateQuoteExposure: Number(inp.input.proposedQuoteSize),
      beta: inp.input.benchmarkBetaEvidence.btcBeta,
      betaStatus:
        inp.input.benchmarkBetaEvidence.btcBeta == null || !inp.input.benchmarkBetaEvidence.alignmentProven
          ? 'unknown'
          : (inp.input.benchmarkBetaEvidence.btcBetaConfidence ?? 0) < 0.7
            ? 'low_confidence'
            : 'valid',
    },
  );
  const ethBeta = measureBetaExposure(
    inp.input.currentPositions.map((p) => ({
      productId: p.productId,
      positionQuoteExposure: Number(p.remainingBaseSize) * Number(p.markPrice ?? p.weightedAverageEntry),
      beta: p.approximateEthBeta,
      betaStatus: p.approximateEthBeta == null ? 'unknown' : 'valid',
    })),
    {
      productId: inp.input.productId,
      candidateQuoteExposure: Number(inp.input.proposedQuoteSize),
      beta: inp.input.benchmarkBetaEvidence.ethBeta,
      betaStatus:
        inp.input.benchmarkBetaEvidence.ethBeta == null || !inp.input.benchmarkBetaEvidence.alignmentProven
          ? 'unknown'
          : (inp.input.benchmarkBetaEvidence.ethBetaConfidence ?? 0) < 0.7
            ? 'low_confidence'
            : 'valid',
    },
  );
  const dailyLoss = measureDailyLoss(inp.input);
  const weeklyLoss = measureWeeklyLoss(inp.input);
  const drawdown = measureDrawdown(inp.input);
  const equity = Number(inp.input.portfolioLedgerState.totalEquity);

  // Historical ES + stress (if returns provided).
  let es: RiskMeasurement<EsResult> | null = null;
  if (inp.historicalReturns && inp.historicalReturns.length > 0) {
    es = computeHistoricalExpectedShortfall({
      historicalReturns: inp.historicalReturns,
      portfolioValueBefore: equity,
      now: inp.input.observedAt,
      dataAvailableAt: inp.input.dataAvailableAt,
    });
  }
  const stressBundle = buildStressBundleFromInput(inp.input, equity);
  const stressResults = runStressTests(stressBundle);
  const worstStress = stressResults.reduce((a, b) => (a.estimatedLoss >= b.estimatedLoss ? a : b));

  const compose = composeCaps({
    policy: inp.policy,
    input: inp.input,
    candidateStopRisk: stopRisk,
    exposure,
    volatility,
    liquidity,
    beta: { btc: btcBeta, eth: ethBeta },
    expectedShortfall: es ?? undefined,
    stressResults,
  });

  const breaches = collectBreaches(inp.policy, inp.input, dailyLoss, weeklyLoss, drawdown, worstStress, exposure, equity);

  const inputHash = hashRiskInput(inp.input);
  const observedAt = inp.input.observedAt;
  const dataAvailableAt = inp.input.dataAvailableAt;

  // Decision hierarchy
  //   1. system-integrity invalid → data_failure
  //   2. system-integrity reconciliation_required / block_all_new_entries → reject
  //   3. daily/weekly/drawdown hard breach → reject
  //   4. any critical measurement failure (abstain missingData) → abstain
  //   5. minimum executable failed → reject
  //   6. binding cap reduces size to 0 → reject
  //   7. binding cap reduces size below proposal → reduce_size
  //   8. otherwise → authorize_as_proposed

  const proposedBase = Number(inp.input.proposedBaseSize);

  if (integrity.state === 'invalid') {
    return buildResult(inp, integrity, {
      recommendedBase: 0,
      recommendedQuote: 0,
      multiplier: 0,
      decision: 'data_failure',
      bindingLimit: 'system.integrity_healthy',
      reasons: ['system_integrity_invalid', ...integrity.reasons],
      compose,
      breaches,
      diagnostics: { integrity, worstStress },
      inputHash,
      observedAt,
      dataAvailableAt,
    });
  }
  if (integrity.state === 'block_all_new_entries_recommended' || integrity.state === 'reconciliation_required') {
    return buildResult(inp, integrity, {
      recommendedBase: 0,
      recommendedQuote: 0,
      multiplier: 0,
      decision: 'reject',
      bindingLimit: 'system.integrity_healthy',
      reasons: [`system_integrity_${integrity.state}`, ...integrity.reasons],
      compose,
      breaches,
      diagnostics: { integrity },
      inputHash,
      observedAt,
      dataAvailableAt,
    });
  }
  const hardLossBreach = breaches.find((b) => b.severity === 'hard' && (b.scope === 'daily' || b.scope === 'weekly' || b.scope === 'drawdown'));
  if (hardLossBreach) {
    return buildResult(inp, integrity, {
      recommendedBase: 0,
      recommendedQuote: 0,
      multiplier: 0,
      decision: 'reject',
      bindingLimit: hardLossBreach.limitKey,
      reasons: [`hard_breach:${hardLossBreach.limitKey}`],
      compose,
      breaches,
      diagnostics: { integrity, hardLossBreach },
      inputHash,
      observedAt,
      dataAvailableAt,
    });
  }

  // Missing-data caps → abstain when policy says so.
  const abstainReason = compose.reasons.find((r) => r.startsWith('betaBtcCap:') || r.startsWith('betaEthCap:') || r.startsWith('volatilityCap:') || r.startsWith('stopRiskCap:'));
  if (abstainReason) {
    return buildResult(inp, integrity, {
      recommendedBase: 0,
      recommendedQuote: 0,
      multiplier: 0,
      decision: 'abstain',
      bindingLimit: abstainReason,
      reasons: ['missing_evidence', ...compose.reasons],
      compose,
      breaches,
      diagnostics: { integrity, worstStress },
      inputHash,
      observedAt,
      dataAvailableAt,
    });
  }
  if (compose.reasons.some((r) => r.startsWith('liquidityCap:'))) {
    return buildResult(inp, integrity, {
      recommendedBase: 0,
      recommendedQuote: 0,
      multiplier: 0,
      decision: 'data_failure',
      bindingLimit: 'liquidity.turnover_participation',
      reasons: ['liquidity_missing_data'],
      compose,
      breaches,
      diagnostics: { integrity, worstStress },
      inputHash,
      observedAt,
      dataAvailableAt,
    });
  }
  if (!compose.minimumViable) {
    return buildResult(inp, integrity, {
      recommendedBase: 0,
      recommendedQuote: 0,
      multiplier: 0,
      decision: 'reject',
      bindingLimit: compose.bindingCap?.key ?? 'minimumExecutableCap',
      reasons: ['minimum_not_executable', ...compose.reasons],
      compose,
      breaches,
      diagnostics: { integrity, worstStress, compose },
      inputHash,
      observedAt,
      dataAvailableAt,
    });
  }

  // The composer returned a valid, executable size.
  const multiplier = proposedBase > 0 ? Math.min(1, compose.recommendedBaseSize / proposedBase) : 0;
  if (multiplier <= 0) {
    return buildResult(inp, integrity, {
      recommendedBase: 0,
      recommendedQuote: 0,
      multiplier: 0,
      decision: 'reject',
      bindingLimit: compose.bindingCap?.key ?? null,
      reasons: ['zero_size', ...compose.reasons],
      compose,
      breaches,
      diagnostics: { integrity, worstStress, compose },
      inputHash,
      observedAt,
      dataAvailableAt,
    });
  }
  const isReduced = compose.recommendedBaseSize < proposedBase;
  return buildResult(inp, integrity, {
    recommendedBase: compose.recommendedBaseSize,
    recommendedQuote: compose.recommendedQuoteSize,
    multiplier,
    decision: isReduced ? 'reduce_size' : 'authorize_as_proposed',
    bindingLimit: compose.bindingCap?.key ?? null,
    reasons: isReduced ? ['size_reduced', compose.bindingCap?.key ?? 'binding'] : ['proposed_within_all_caps'],
    compose,
    breaches,
    diagnostics: { integrity, worstStress, compose, kellyMultiplier: EFFECTIVE_KELLY_MULTIPLIER },
    inputHash,
    observedAt,
    dataAvailableAt,
  });
}

function buildResult(
  inp: EvaluateInput,
  integrity: SystemIntegrityAssessment,
  meta: {
    recommendedBase: number;
    recommendedQuote: number;
    multiplier: number;
    decision: RiskDecisionKind;
    bindingLimit: string | null;
    reasons: string[];
    compose: CapCompositionResult;
    breaches: BreachRecord[];
    diagnostics: Record<string, unknown>;
    inputHash: string;
    observedAt: Date;
    dataAvailableAt: Date;
  },
): RiskDecisionResult {
  const warningBreaches = meta.breaches.filter((b) => b.severity === 'warning').length;
  const hardBreaches = meta.breaches.filter((b) => b.severity === 'hard' || b.severity === 'system_integrity').length;
  return {
    decisionChainId: inp.input.decisionChainId,
    candidateId: inp.input.candidateId,
    policyVersionId: inp.policyVersionId,
    portfolioRiskSnapshotId: inp.portfolioRiskSnapshotId,
    proposedBaseSize: Number(inp.input.proposedBaseSize),
    proposedQuoteSize: Number(inp.input.proposedQuoteSize),
    recommendedBaseSize: meta.recommendedBase,
    recommendedQuoteSize: meta.recommendedQuote,
    sizeMultiplier: Math.max(0, Math.min(1, meta.multiplier)),
    decision: meta.decision,
    bindingLimit: meta.bindingLimit,
    warningBreaches,
    hardBreaches,
    systemIntegrity: integrity,
    confidence: meta.decision === 'data_failure' || meta.decision === 'abstain' ? 0 : 1,
    observedAt: meta.observedAt,
    dataAvailableAt: meta.dataAvailableAt,
    inputHash: meta.inputHash,
    reasonCodes: meta.reasons,
    diagnostics: meta.diagnostics,
    breaches: meta.breaches,
  };
}

function collectBreaches(
  policy: RiskPolicy,
  input: PortfolioRiskInput,
  dailyLoss: RiskMeasurement<number>,
  weeklyLoss: RiskMeasurement<number>,
  drawdown: RiskMeasurement<number>,
  worstStress: StressResult,
  exposure: ExposureBreakdown,
  equity: number,
): BreachRecord[] {
  const out: BreachRecord[] = [];
  const check = (
    limitKey: string,
    measured: number | null,
    unit: 'ratio_of_equity' | 'ratio_of_peak' | 'quote',
  ) => {
    if (measured == null) return;
    const limit = findLimit(policy, limitKey);
    if (!limit) return;
    let normalized = measured;
    if (unit === 'ratio_of_equity' && equity > 0) normalized = measured / equity;
    else if (unit === 'ratio_of_peak') {
      const peak = Number(input.drawdownState.peakEquity);
      normalized = peak > 0 ? measured / peak : 0;
    }
    const isHard = normalized > limit.hardThreshold;
    const isWarning = !isHard && limit.warningThreshold != null && normalized > limit.warningThreshold;
    if (isHard) {
      out.push({
        limitKey,
        scope: limit.scope,
        measuredValue: normalized,
        warningThreshold: limit.warningThreshold,
        hardThreshold: limit.hardThreshold,
        severity: 'hard',
        breachAction: limit.breachAction,
      });
    } else if (isWarning) {
      out.push({
        limitKey,
        scope: limit.scope,
        measuredValue: normalized,
        warningThreshold: limit.warningThreshold,
        hardThreshold: limit.hardThreshold,
        severity: 'warning',
        breachAction: limit.breachAction,
      });
    }
  };
  check('daily.max_loss_pct', dailyLoss.status === 'valid' ? dailyLoss.value : null, 'ratio_of_equity');
  check('weekly.max_loss_pct', weeklyLoss.status === 'valid' ? weeklyLoss.value : null, 'ratio_of_equity');
  check('drawdown.max_current_pct', drawdown.status === 'valid' ? drawdown.value : null, 'ratio_of_peak');
  // Product / mode / cluster caps
  for (const [pid, exposureVal] of exposure.postCandidateProductExposure) {
    if (pid !== input.productId) continue;
    check('product.max_quote_exposure_pct', exposureVal, 'ratio_of_equity');
  }
  const modeExp = exposure.postCandidateModeExposure.get(input.championMode);
  if (modeExp != null) check('mode.max_quote_exposure_pct', modeExp, 'ratio_of_equity');
  if (input.clusterKey) {
    const cx = exposure.postCandidateClusterExposure.get(input.clusterKey);
    if (cx != null) check('cluster.max_quote_exposure_pct', cx, 'ratio_of_equity');
  }
  // Worst-stress advisory (surfaced but not a hard cap by itself in observer mode).
  void worstStress;
  return out;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface StartRunInput {
  policyVersionId: number;
  runnerVersion: string;
  startedAt: Date;
}

export async function startPortfolioRiskRun(input: StartRunInput): Promise<PortfolioRiskRunRow> {
  const [{ insertId }] = (await db.insert(portfolioRiskRuns).values({
    policyVersionId: input.policyVersionId,
    startedAt: input.startedAt,
    runnerVersion: input.runnerVersion,
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(portfolioRiskRuns).where(eq(portfolioRiskRuns.id, insertId)).limit(1);
  return row;
}

export async function completePortfolioRiskRun(
  runId: number,
  completedAt: Date,
  counts: {
    candidates: number;
    authorize: number;
    reduce: number;
    reject: number;
    abstain: number;
    dataFailure: number;
  },
  notes?: string,
): Promise<void> {
  await db
    .update(portfolioRiskRuns)
    .set({
      completedAt,
      candidatesEvaluated: counts.candidates,
      authorizeAsProposed: counts.authorize,
      reduceSize: counts.reduce,
      rejects: counts.reject,
      abstains: counts.abstain,
      dataFailures: counts.dataFailure,
      notes: notes ?? null,
    })
    .where(eq(portfolioRiskRuns.id, runId));
}

export interface PersistSnapshotInput {
  observerRunId: number;
  policyVersionId: number;
  input: PortfolioRiskInput;
  integrity: SystemIntegrityAssessment;
  exposure: ExposureBreakdown;
  positions: PositionRiskAssessment[];
  historicalVar: number | null;
  historicalEs: number | null;
  worstStressLoss: number | null;
  clusterCount: number;
  dataQualityState: string;
  now: Date;
}

export async function persistPortfolioRiskSnapshot(
  input: PersistSnapshotInput,
): Promise<PortfolioRiskSnapshotRow> {
  const inHash = hashRiskInput(input.input);
  const [{ insertId }] = (await db.insert(portfolioRiskSnapshots).values({
    observerRunId: input.observerRunId,
    policyVersionId: input.policyVersionId,
    cash: Number(input.input.cashAvailable).toFixed(10),
    reservedCash: Number(input.input.cashReserved).toFixed(10),
    grossExposure: input.exposure.grossQuoteExposure.toFixed(10),
    netExposure: input.exposure.netDirectionalExposure.toFixed(10),
    totalOpenStopRisk: input.exposure.totalOpenStopRisk.toFixed(10),
    pendingEntryRisk: input.exposure.pendingEntryRisk.toFixed(10),
    unprotectedExposure: input.exposure.unprotectedExposure.toFixed(10),
    btcBetaExposure: null,
    ethBetaExposure: null,
    dailyLoss: '0',
    weeklyLoss: '0',
    currentDrawdown: Number(input.input.drawdownState.currentDrawdown).toFixed(10),
    historicalVaR: input.historicalVar != null ? input.historicalVar.toFixed(10) : null,
    historicalExpectedShortfall: input.historicalEs != null ? input.historicalEs.toFixed(10) : null,
    worstStressLoss: input.worstStressLoss != null ? input.worstStressLoss.toFixed(10) : null,
    positionCount: input.positions.length,
    clusterCount: input.clusterCount,
    dataQualityState: input.dataQualityState,
    systemIntegrityState: input.integrity.state,
    observedAt: input.now,
    dataAvailableAt: input.now,
    inputHash: inHash,
  })) as unknown as { insertId: number }[];
  const [snapshot] = await db.select().from(portfolioRiskSnapshots).where(eq(portfolioRiskSnapshots.id, insertId)).limit(1);
  for (const p of input.positions) {
    await db.insert(positionRiskSnapshots).values({
      portfolioRiskSnapshotId: insertId,
      productId: p.productId,
      entryDecisionChainId: p.entryDecisionChainId,
      remainingBaseSize: p.remainingBaseSize.toFixed(10),
      weightedAverageEntry: p.weightedAverageEntry.toFixed(10),
      openStopRisk: p.openStopRisk != null ? p.openStopRisk.toFixed(10) : null,
      grossQuoteExposure: p.grossQuoteExposure.toFixed(10),
      protectionState: p.protectionState,
      state: p.state,
      dataAvailableAt: p.dataAvailableAt,
    });
  }
  return snapshot;
}

export async function persistCandidateRiskDecision(
  result: RiskDecisionResult,
): Promise<CandidateRiskDecisionRow> {
  const [{ insertId }] = (await db.insert(candidateRiskDecisions).values({
    decisionChainId: result.decisionChainId,
    candidateId: result.candidateId,
    policyVersionId: result.policyVersionId,
    portfolioRiskSnapshotId: result.portfolioRiskSnapshotId,
    proposedBaseSize: result.proposedBaseSize.toFixed(10),
    proposedQuoteSize: result.proposedQuoteSize.toFixed(10),
    recommendedBaseSize: result.recommendedBaseSize.toFixed(10),
    recommendedQuoteSize: result.recommendedQuoteSize.toFixed(10),
    sizeMultiplier: result.sizeMultiplier.toFixed(8),
    decision: result.decision,
    bindingLimit: result.bindingLimit,
    warningBreaches: result.warningBreaches,
    hardBreaches: result.hardBreaches,
    systemIntegrityState: result.systemIntegrity.state,
    confidence: result.confidence.toFixed(4),
    observedAt: result.observedAt,
    dataAvailableAt: result.dataAvailableAt,
    inputHash: result.inputHash,
    reasonCodes: result.reasonCodes.join(','),
    diagnostics: JSON.stringify(result.diagnostics),
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(candidateRiskDecisions).where(eq(candidateRiskDecisions.id, insertId)).limit(1);
  for (const b of result.breaches) {
    const [limitRow] = await db
      .select()
      .from(riskLimitDefinitions)
      .where(and(eq(riskLimitDefinitions.policyVersionId, result.policyVersionId), eq(riskLimitDefinitions.limitKey, b.limitKey)))
      .limit(1);
    if (!limitRow) continue;
    await db.insert(riskLimitBreaches).values({
      portfolioRiskSnapshotId: result.portfolioRiskSnapshotId,
      candidateRiskDecisionId: insertId,
      limitDefinitionId: limitRow.id,
      scope: b.scope,
      measuredValue: b.measuredValue.toFixed(12),
      warningThreshold: b.warningThreshold != null ? b.warningThreshold.toFixed(12) : null,
      hardThreshold: b.hardThreshold.toFixed(12),
      severity: b.severity,
      breachAction: b.breachAction,
      observedAt: result.observedAt,
      dataAvailableAt: result.dataAvailableAt,
    });
  }
  return row;
}

// ---------------------------------------------------------------------------
// Champion / risk comparison
// ---------------------------------------------------------------------------

export type AgreementState =
  | 'agree'
  | 'risk_reduced'
  | 'risk_rejected'
  | 'risk_abstained'
  | 'unresolved';

export function classifyAgreement(
  _championProposedBase: number,
  risk: RiskDecisionResult,
): AgreementState {
  if (risk.decision === 'authorize_as_proposed') return 'agree';
  if (risk.decision === 'reduce_size') return 'risk_reduced';
  if (risk.decision === 'reject') return 'risk_rejected';
  if (risk.decision === 'abstain') return 'risk_abstained';
  return 'unresolved';
}

export async function persistChampionRiskComparison(input: {
  decisionChainId: number;
  productId: string;
  championProposedBaseSize: number;
  championProposedQuoteSize: number;
  risk: RiskDecisionResult;
  candidateRiskDecisionId: number | null;
  championExecutionOutcome?: string | null;
  policyVersion: string;
  observedAt: Date;
  dataAvailableAt: Date;
}): Promise<ChampionRiskComparisonRow> {
  const agreementState = classifyAgreement(input.championProposedBaseSize, input.risk);
  await db.insert(championRiskComparisons).values({
    decisionChainId: input.decisionChainId,
    candidateRiskDecisionId: input.candidateRiskDecisionId,
    productId: input.productId,
    championProposedBaseSize: input.championProposedBaseSize.toFixed(10),
    championProposedQuoteSize: input.championProposedQuoteSize.toFixed(10),
    riskRecommendedBaseSize: input.risk.recommendedBaseSize.toFixed(10),
    riskRecommendedQuoteSize: input.risk.recommendedQuoteSize.toFixed(10),
    riskDecision: input.risk.decision,
    bindingLimit: input.risk.bindingLimit,
    championExecutionOutcome: input.championExecutionOutcome ?? null,
    agreementState,
    policyVersion: input.policyVersion,
    observedAt: input.observedAt,
    dataAvailableAt: input.dataAvailableAt,
  });
  const [row] = await db
    .select()
    .from(championRiskComparisons)
    .where(eq(championRiskComparisons.decisionChainId, input.decisionChainId))
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Stress scenario registration (one-time)
// ---------------------------------------------------------------------------

export async function ensureStressScenariosRegistered(): Promise<StressScenarioDefinitionRow[]> {
  const results: StressScenarioDefinitionRow[] = [];
  for (const s of STRESS_SCENARIOS) {
    const existing = await db
      .select()
      .from(stressScenarioDefinitions)
      .where(and(eq(stressScenarioDefinitions.scenarioKey, s.scenarioKey), eq(stressScenarioDefinitions.scenarioVersion, STRESS_SCENARIO_VERSION)))
      .limit(1);
    if (existing.length > 0) {
      results.push(existing[0]);
      continue;
    }
    await db.insert(stressScenarioDefinitions).values({
      scenarioKey: s.scenarioKey,
      scenarioVersion: STRESS_SCENARIO_VERSION,
      description: s.description,
      shockDefinitions: JSON.stringify(s.shock),
      correlationPolicy: s.correlationPolicy,
      liquidityPolicy: s.liquidityPolicy,
      protectionPolicy: s.protectionPolicy,
      valuationPolicy: s.valuationPolicy,
      implementationHash: `p2c-stress-${s.scenarioKey}`,
    });
    const [row] = await db
      .select()
      .from(stressScenarioDefinitions)
      .where(and(eq(stressScenarioDefinitions.scenarioKey, s.scenarioKey), eq(stressScenarioDefinitions.scenarioVersion, STRESS_SCENARIO_VERSION)))
      .limit(1);
    results.push(row);
  }
  return results;
}

export async function persistStressRun(input: {
  portfolioRiskSnapshotId: number;
  results: readonly StressResult[];
  now: Date;
}): Promise<void> {
  const scenarios = await ensureStressScenariosRegistered();
  const scenarioMap = new Map(scenarios.map((s) => [s.scenarioKey, s]));
  const worst = [...input.results].sort((a, b) => b.estimatedLoss - a.estimatedLoss)[0];
  const [{ insertId }] = (await db.insert(stressTestRuns).values({
    portfolioRiskSnapshotId: input.portfolioRiskSnapshotId,
    scenarioCount: input.results.length,
    worstScenarioKey: worst?.scenarioKey ?? null,
    worstLoss: worst != null ? worst.estimatedLoss.toFixed(10) : null,
    startedAt: input.now,
    completedAt: input.now,
  })) as unknown as { insertId: number }[];
  for (const r of input.results) {
    const scen = scenarioMap.get(r.scenarioKey);
    if (!scen) continue;
    await db.insert(stressTestResults).values({
      stressTestRunId: insertId,
      scenarioDefinitionId: scen.id,
      portfolioValueBefore: r.portfolioValueBefore.toFixed(10),
      portfolioValueAfter: r.portfolioValueAfter.toFixed(10),
      estimatedLoss: r.estimatedLoss.toFixed(10),
      candidateIncrementalLoss: r.candidateIncrementalLoss.toFixed(10),
      largestPositionContribution: r.largestPositionContribution.toFixed(10),
      largestClusterContribution: r.largestClusterContribution.toFixed(10),
      assumptions: r.assumptions,
      limitBreaches: r.limitBreaches,
      dataQualityStatus: r.dataQualityStatus,
    });
  }
}

// Convenience high-level entry point.
export async function registerDefaultRiskPolicy(policy: RiskPolicy): Promise<number> {
  const reg = await registerRiskPolicy(policy);
  return reg.row.id;
}

// Silence lint
void RISK_ENGINE_VERSION;
