import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  championChallengerOutcomeComparisons,
  claudeAttributionSnapshots,
  observerIncrementalAttribution,
  unifiedChallengerDecisions,
  unifiedChallengerEvidence,
  validationMetricSlices,
  validationMetrics,
  validationSliceFailures,
  type ChampionChallengerOutcomeComparisonRow,
  type ClaudeAttributionSnapshotRow,
  type ObserverIncrementalAttributionRow,
  type UnifiedChallengerDecisionRow,
  type UnifiedChallengerEvidenceRow,
  type ValidationMetricRow,
  type ValidationMetricSliceRow,
  type ValidationSliceFailureRow,
} from '../../db/schema';

/**
 * Phase 2F §J–§N — Net metrics, subgroup analysis, unified challenger,
 * incremental observer attribution and Claude attribution framework.
 *
 * The unified challenger cannot mutate champion state, cannot increase
 * size, cannot rescue a hard rejection, and cannot create a plan.
 * Incremental attribution uses only evidence available at decision time.
 * Claude attribution stays in `prospective_evidence_unavailable` until
 * a future prospective run exists.
 */

// ---------------------------------------------------------------------------
// Net metrics (§J)
// ---------------------------------------------------------------------------

export type ValidationMetricKey =
  | 'netPnl' | 'netReturn' | 'costAdjustedSortino' | 'costAdjustedCalmar'
  | 'maximumDrawdown' | 'historicalExpectedShortfall'
  | 'hitRate' | 'payoffRatio' | 'turnover' | 'timeInMarket'
  | 'grossExposure' | 'netExposure' | 'forecastCostError'
  | 'fillConfidence' | 'rejectionRate' | 'abstentionRate'
  | 'protectionDegradationRate' | 'lineageCompletenessRate'
  | 'grossPnl' | 'grossReturn' | 'sharpe' | 'sortino';

export interface MetricInput {
  experimentRunId: number;
  metricKey: ValidationMetricKey;
  metricScope: 'aggregate' | 'per_fold' | 'per_path' | 'per_product' | 'per_regime';
  value: number | null;
  unit: string;
  netOfCosts: boolean;
  sampleCount: number;
  status: 'valid' | 'insufficient_samples' | 'failed' | 'invalid';
  failureReason?: string;
}

function metricHash(input: MetricInput): string {
  return createHash('sha256').update(JSON.stringify({
    run: input.experimentRunId, k: input.metricKey, s: input.metricScope,
    v: input.value, n: input.sampleCount,
  })).digest('hex');
}

export async function persistValidationMetric(input: MetricInput): Promise<ValidationMetricRow> {
  const inputHash = metricHash(input);
  await db.insert(validationMetrics).values({
    experimentRunId: input.experimentRunId,
    metricKey: input.metricKey,
    metricScope: input.metricScope,
    value: input.value != null ? input.value.toFixed(12) : null,
    unit: input.unit,
    netOfCosts: input.netOfCosts,
    status: input.status,
    sampleCount: input.sampleCount,
    failureReason: input.failureReason ?? null,
    inputHash,
  });
  const [row] = await db
    .select()
    .from(validationMetrics)
    .where(and(
      eq(validationMetrics.experimentRunId, input.experimentRunId),
      eq(validationMetrics.metricKey, input.metricKey),
      eq(validationMetrics.metricScope, input.metricScope),
    ))
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Subgroup slicing (§K)
// ---------------------------------------------------------------------------

export type SliceKey =
  | 'product' | 'strategy_mode' | 'fingerprint_class' | 'raw_regime' | 'smoothed_regime'
  | 'liquidity_class' | 'volatility_class' | 'correlation_cluster' | 'btc_beta_band'
  | 'eth_beta_band' | 'microstructure_confidence_state' | 'context_state'
  | 'data_quality_state' | 'time_period' | 'provider_health_state' | 'protection_state';

export const SUBGROUP_SLICE_KEYS: readonly SliceKey[] = [
  'product', 'strategy_mode', 'fingerprint_class', 'raw_regime', 'smoothed_regime',
  'liquidity_class', 'volatility_class', 'correlation_cluster', 'btc_beta_band',
  'eth_beta_band', 'microstructure_confidence_state', 'context_state',
  'data_quality_state', 'time_period', 'provider_health_state', 'protection_state',
];

export interface SliceInput {
  experimentRunId: number;
  sliceKey: SliceKey;
  sliceValue: string;
  metricKey: ValidationMetricKey;
  value: number | null;
  sampleCount: number;
  status: 'valid' | 'insufficient_samples' | 'catastrophic' | 'failed';
  failureReason?: string;
}

export async function persistValidationMetricSlice(input: SliceInput): Promise<ValidationMetricSliceRow> {
  await db.insert(validationMetricSlices).values({
    experimentRunId: input.experimentRunId,
    sliceKey: input.sliceKey,
    sliceValue: input.sliceValue,
    metricKey: input.metricKey,
    value: input.value != null ? input.value.toFixed(12) : null,
    sampleCount: input.sampleCount,
    status: input.status,
    failureReason: input.failureReason ?? null,
  });
  const [row] = await db
    .select()
    .from(validationMetricSlices)
    .where(and(
      eq(validationMetricSlices.experimentRunId, input.experimentRunId),
      eq(validationMetricSlices.sliceKey, input.sliceKey),
      eq(validationMetricSlices.sliceValue, input.sliceValue),
      eq(validationMetricSlices.metricKey, input.metricKey),
    ))
    .limit(1);
  return row;
}

export async function recordSliceFailure(input: {
  experimentRunId: number;
  sliceKey: SliceKey;
  sliceValue: string;
  failureReason: string;
  severity: 'warning' | 'high' | 'catastrophic';
}): Promise<ValidationSliceFailureRow> {
  const [{ insertId }] = (await db.insert(validationSliceFailures).values(input)) as unknown as { insertId: number }[];
  const [row] = await db.select().from(validationSliceFailures).where(eq(validationSliceFailures.id, insertId)).limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Unified challenger (§L)
// ---------------------------------------------------------------------------

export type UnifiedChallengerDecision =
  | 'agree_with_champion' | 'reduce' | 'reject' | 'abstain' | 'conflict' | 'data_failure';

export interface UnifiedChallengerInput {
  decisionChainId: number;
  productId: string;
  fingerprintSnapshotId?: number | null;
  productRegimeSnapshotId?: number | null;
  challengerRoutingDecisionId?: number | null;
  candidateRiskDecisionId?: number | null;
  microstructureExecutionDecisionId?: number | null;
  candidateContextDecisionId?: number | null;
  championDecisionId?: number | null;
  routeRecommendation: string;
  riskMultiplier: number;
  microstructureMultiplier: number;
  contextMultiplier: number;
  executionPreference?: string | null;
  hardRejections: readonly string[];
  conflicts: readonly string[];
  missingEvidence: readonly string[];
  confidence: number;
  observedAt: Date;
  dataAvailableAt: Date;
  expiresAt?: Date | null;
}

export interface UnifiedChallengerResult {
  decision: UnifiedChallengerDecision;
  finalObserverMultiplier: number;
  reasonCodes: string[];
  inputHash: string;
}

export function evaluateUnifiedChallenger(input: UnifiedChallengerInput): UnifiedChallengerResult {
  const reasons: string[] = [];
  const clamp = (m: number) => Math.max(0, Math.min(1, m));
  const rm = clamp(input.riskMultiplier);
  const mm = clamp(input.microstructureMultiplier);
  const cm = clamp(input.contextMultiplier);
  let final = Math.min(rm, mm, cm);
  let decision: UnifiedChallengerDecision;

  if (input.hardRejections.length > 0) {
    decision = 'reject';
    final = 0;
    for (const r of input.hardRejections) reasons.push(`veto:${r}`);
  } else if (input.conflicts.length > 0) {
    decision = 'conflict';
    final = 0;
    for (const c of input.conflicts) reasons.push(`conflict:${c}`);
  } else if (input.missingEvidence.length > 0) {
    decision = final === 0 ? 'data_failure' : 'abstain';
    final = 0;
    for (const m of input.missingEvidence) reasons.push(`missing:${m}`);
  } else if (final >= 1) {
    decision = 'agree_with_champion';
    reasons.push('agree');
  } else if (final > 0) {
    decision = 'reduce';
    reasons.push(`reduce:multiplier=${final.toFixed(4)}`);
  } else {
    decision = 'reject';
    reasons.push('multiplier_zero');
  }

  final = Math.max(0, Math.min(1, final));
  const inputHash = createHash('sha256').update(JSON.stringify({
    chain: input.decisionChainId, pid: input.productId,
    rm, mm, cm, final, d: decision, hr: input.hardRejections,
    c: input.conflicts, m: input.missingEvidence,
  })).digest('hex');
  return { decision, finalObserverMultiplier: final, reasonCodes: reasons, inputHash };
}

export async function persistUnifiedChallengerDecision(
  input: UnifiedChallengerInput,
  result: UnifiedChallengerResult,
): Promise<UnifiedChallengerDecisionRow> {
  await db.insert(unifiedChallengerDecisions).values({
    decisionChainId: input.decisionChainId,
    productId: input.productId,
    fingerprintSnapshotId: input.fingerprintSnapshotId ?? null,
    productRegimeSnapshotId: input.productRegimeSnapshotId ?? null,
    challengerRoutingDecisionId: input.challengerRoutingDecisionId ?? null,
    candidateRiskDecisionId: input.candidateRiskDecisionId ?? null,
    microstructureExecutionDecisionId: input.microstructureExecutionDecisionId ?? null,
    candidateContextDecisionId: input.candidateContextDecisionId ?? null,
    championDecisionId: input.championDecisionId ?? null,
    routeRecommendation: input.routeRecommendation,
    riskMultiplier: Math.max(0, Math.min(1, input.riskMultiplier)).toFixed(4),
    microstructureMultiplier: Math.max(0, Math.min(1, input.microstructureMultiplier)).toFixed(4),
    contextMultiplier: Math.max(0, Math.min(1, input.contextMultiplier)).toFixed(4),
    finalObserverMultiplier: result.finalObserverMultiplier.toFixed(4),
    executionPreference: input.executionPreference ?? null,
    decision: result.decision,
    confidence: Math.max(0, Math.min(1, input.confidence)).toFixed(4),
    hardRejections: input.hardRejections.join(',').slice(0, 500),
    conflicts: input.conflicts.join(',').slice(0, 500),
    missingEvidence: input.missingEvidence.join(',').slice(0, 500),
    reasonCodes: result.reasonCodes.join(',').slice(0, 500),
    observedAt: input.observedAt,
    dataAvailableAt: input.dataAvailableAt,
    expiresAt: input.expiresAt ?? null,
    inputHash: result.inputHash,
  });
  const [row] = await db
    .select()
    .from(unifiedChallengerDecisions)
    .where(eq(unifiedChallengerDecisions.decisionChainId, input.decisionChainId))
    .limit(1);
  return row;
}

export async function persistUnifiedChallengerEvidence(input: {
  unifiedChallengerDecisionId: number;
  evidenceKey: string;
  evidenceKind: string;
  contributionMultiplier?: number | null;
  reasonCode: string;
  details?: string;
}): Promise<UnifiedChallengerEvidenceRow> {
  await db.insert(unifiedChallengerEvidence).values({
    unifiedChallengerDecisionId: input.unifiedChallengerDecisionId,
    evidenceKey: input.evidenceKey,
    evidenceKind: input.evidenceKind,
    contributionMultiplier: input.contributionMultiplier != null ? input.contributionMultiplier.toFixed(4) : null,
    reasonCode: input.reasonCode,
    details: input.details ?? null,
  });
  const rows = await db.select().from(unifiedChallengerEvidence).where(eq(unifiedChallengerEvidence.unifiedChallengerDecisionId, input.unifiedChallengerDecisionId));
  return rows[rows.length - 1];
}

// ---------------------------------------------------------------------------
// Incremental observer attribution (§M)
// ---------------------------------------------------------------------------

export type AttributionSourceCategory =
  | 'synthetic_fixture' | 'deterministic_replay' | 'historical_replay'
  | 'captured_live_shadow' | 'prospective_shadow';

export async function persistObserverAttribution(input: {
  decisionChainId: number;
  observerKey: string;
  wouldHaveDecision: string;
  wouldHaveMultiplier: number;
  informationCutoff: Date;
  sourceCategory: AttributionSourceCategory;
  reasonCode: string;
}): Promise<ObserverIncrementalAttributionRow> {
  const existing = await db
    .select()
    .from(observerIncrementalAttribution)
    .where(and(eq(observerIncrementalAttribution.decisionChainId, input.decisionChainId), eq(observerIncrementalAttribution.observerKey, input.observerKey)))
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(observerIncrementalAttribution).values({
    decisionChainId: input.decisionChainId,
    observerKey: input.observerKey,
    wouldHaveDecision: input.wouldHaveDecision,
    wouldHaveMultiplier: Math.max(0, Math.min(1, input.wouldHaveMultiplier)).toFixed(4),
    informationCutoff: input.informationCutoff,
    sourceCategory: input.sourceCategory,
    reasonCode: input.reasonCode,
  });
  const [row] = await db
    .select()
    .from(observerIncrementalAttribution)
    .where(and(eq(observerIncrementalAttribution.decisionChainId, input.decisionChainId), eq(observerIncrementalAttribution.observerKey, input.observerKey)))
    .limit(1);
  return row;
}

export async function persistChampionChallengerOutcomeComparison(input: {
  decisionChainId: number;
  championOutcome: string;
  challengerOutcome: string;
  championNetPnl?: number | null;
  challengerNetPnl?: number | null;
  attributionMode: 'construction_only' | 'deterministic_replay' | 'historical_replay' | 'captured_live_shadow' | 'prospective_shadow';
  notes?: string;
}): Promise<ChampionChallengerOutcomeComparisonRow> {
  await db.insert(championChallengerOutcomeComparisons).values({
    decisionChainId: input.decisionChainId,
    championOutcome: input.championOutcome,
    challengerOutcome: input.challengerOutcome,
    championNetPnl: input.championNetPnl != null ? input.championNetPnl.toFixed(10) : null,
    challengerNetPnl: input.challengerNetPnl != null ? input.challengerNetPnl.toFixed(10) : null,
    attributionMode: input.attributionMode,
    notes: input.notes ?? null,
  });
  const [row] = await db.select().from(championChallengerOutcomeComparisons).where(eq(championChallengerOutcomeComparisons.decisionChainId, input.decisionChainId)).limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Claude attribution (§N)
// ---------------------------------------------------------------------------

export async function persistClaudeAttributionSnapshot(input: {
  snapshotAt: Date;
  datasetVersionId?: number | null;
  approvalRate?: number | null;
  rejectionRate?: number | null;
  abstentionRate?: number | null;
  netOutcomeConditional?: number | null;
  falseApprovalRate?: number | null;
  falseRejectionRate?: number | null;
  incrementalNetContribution?: number | null;
  status?: 'prospective_evidence_unavailable' | 'insufficient_samples' | 'pending' | 'ready';
  notes?: string;
}): Promise<ClaudeAttributionSnapshotRow> {
  const [{ insertId }] = (await db.insert(claudeAttributionSnapshots).values({
    snapshotAt: input.snapshotAt,
    datasetVersionId: input.datasetVersionId ?? null,
    approvalRate: input.approvalRate != null ? input.approvalRate.toFixed(6) : null,
    rejectionRate: input.rejectionRate != null ? input.rejectionRate.toFixed(6) : null,
    abstentionRate: input.abstentionRate != null ? input.abstentionRate.toFixed(6) : null,
    netOutcomeConditional: input.netOutcomeConditional != null ? input.netOutcomeConditional.toFixed(10) : null,
    falseApprovalRate: input.falseApprovalRate != null ? input.falseApprovalRate.toFixed(6) : null,
    falseRejectionRate: input.falseRejectionRate != null ? input.falseRejectionRate.toFixed(6) : null,
    incrementalNetContribution: input.incrementalNetContribution != null ? input.incrementalNetContribution.toFixed(10) : null,
    status: input.status ?? 'prospective_evidence_unavailable',
    notes: input.notes ?? null,
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(claudeAttributionSnapshots).where(eq(claudeAttributionSnapshots.id, insertId)).limit(1);
  return row;
}
