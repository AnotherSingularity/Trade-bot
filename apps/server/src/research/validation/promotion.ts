import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  challengerEvaluations,
  challengerVersions,
  kellyActivationEvaluations,
  modelPromotionDecisions,
  promotionCriteria,
  promotionEvidenceBundles,
  rollbackRecords,
  type ChallengerEvaluationRow,
  type ChallengerVersionRow,
  type KellyActivationEvaluationRow,
  type ModelPromotionDecisionRow,
  type PromotionCriteriaRow,
  type PromotionEvidenceBundleRow,
  type RollbackRecordRow,
} from '../../db/schema';

/**
 * Phase 2F §O, §P, §Q, §R — Promotion registry, criteria, rollback and
 * Kelly gate.
 *
 * Promotion is ALWAYS blocked during Phase 2F because prospective
 * evidence is unavailable and no function exposes a non-interactive
 * approval path. Every promotion attempt writes a `blocked` record
 * with the exact reasons — never `approved` unless a human actor is
 * present AND every criterion is met.
 */

export const PROMOTION_CRITERIA_VERSION = 'p2f-criteria-1';

export interface ChallengerVersionInput {
  challengerKey: string;
  challengerVersion: string;
  description: string;
  codeCommit: string;
}

export async function registerChallengerVersion(input: ChallengerVersionInput): Promise<ChallengerVersionRow> {
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const existing = await db
    .select()
    .from(challengerVersions)
    .where(and(eq(challengerVersions.challengerKey, input.challengerKey), eq(challengerVersions.challengerVersion, input.challengerVersion)))
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(challengerVersions).values({
    challengerKey: input.challengerKey,
    challengerVersion: input.challengerVersion,
    description: input.description,
    codeCommit: input.codeCommit,
    implementationHash: hash,
    status: 'observer',
  });
  const [row] = await db
    .select()
    .from(challengerVersions)
    .where(and(eq(challengerVersions.challengerKey, input.challengerKey), eq(challengerVersions.challengerVersion, input.challengerVersion)))
    .limit(1);
  return row;
}

export async function recordChallengerEvaluation(input: {
  challengerVersionId: number;
  experimentId: number;
  pboEvaluationId?: number | null;
  dsrEvaluationId?: number | null;
  netResult?: number | null;
  subgroupStability: 'stable' | 'unstable' | 'catastrophic' | 'insufficient';
  leakageIncidentsCount: number;
  notes?: string;
}): Promise<ChallengerEvaluationRow> {
  const existing = await db
    .select()
    .from(challengerEvaluations)
    .where(and(eq(challengerEvaluations.challengerVersionId, input.challengerVersionId), eq(challengerEvaluations.experimentId, input.experimentId)))
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(challengerEvaluations).values({
    challengerVersionId: input.challengerVersionId,
    experimentId: input.experimentId,
    pboEvaluationId: input.pboEvaluationId ?? null,
    dsrEvaluationId: input.dsrEvaluationId ?? null,
    netResult: input.netResult != null ? input.netResult.toFixed(10) : null,
    subgroupStability: input.subgroupStability,
    leakageIncidentsCount: input.leakageIncidentsCount,
    notes: input.notes ?? null,
  });
  const [row] = await db
    .select()
    .from(challengerEvaluations)
    .where(and(eq(challengerEvaluations.challengerVersionId, input.challengerVersionId), eq(challengerEvaluations.experimentId, input.experimentId)))
    .limit(1);
  return row;
}

export interface PromotionCriteriaInput {
  criteriaKey: string;
  criteriaVersion: string;
  description: string;
  requirements: readonly string[];
}

export async function registerPromotionCriteria(input: PromotionCriteriaInput): Promise<PromotionCriteriaRow> {
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const existing = await db
    .select()
    .from(promotionCriteria)
    .where(and(eq(promotionCriteria.criteriaKey, input.criteriaKey), eq(promotionCriteria.criteriaVersion, input.criteriaVersion)))
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(promotionCriteria).values({
    criteriaKey: input.criteriaKey,
    criteriaVersion: input.criteriaVersion,
    description: input.description,
    requirements: JSON.stringify(input.requirements),
    implementationHash: hash,
    status: 'observer',
  });
  const [row] = await db
    .select()
    .from(promotionCriteria)
    .where(and(eq(promotionCriteria.criteriaKey, input.criteriaKey), eq(promotionCriteria.criteriaVersion, input.criteriaVersion)))
    .limit(1);
  return row;
}

export const DEFAULT_PROMOTION_CRITERIA: PromotionCriteriaInput = {
  criteriaKey: 'default',
  criteriaVersion: PROMOTION_CRITERIA_VERSION,
  description: 'Phase 2F default promotion criteria bundle — requires all §P requirements.',
  requirements: [
    'registered_experiment',
    'complete_data_lineage',
    'prospective_shadow_evidence',
    'positive_net_result_after_conservative_costs',
    'acceptable_maximum_drawdown',
    'acceptable_historical_es',
    'stable_across_products_and_regimes',
    'acceptable_pbo',
    'positive_incremental_dsr',
    'no_catastrophic_subgroup',
    'no_accounting_discrepancy',
    'no_unresolved_reconciliation',
    'no_unexplained_protection_failure',
    'no_future_data_leak',
    'no_invalidated_fold',
    'human_approval',
    'versioned_deployment_plan',
    'explicit_rollback_target',
  ],
};

export interface PromotionEvidenceBundleInput {
  bundleKey: string;
  experimentId?: number | null;
  challengerEvaluationId?: number | null;
  pboEvaluationId?: number | null;
  dsrEvaluationId?: number | null;
  prospectiveEvidenceAvailable: boolean;
  contents: Record<string, unknown>;
}

export async function persistPromotionEvidenceBundle(input: PromotionEvidenceBundleInput): Promise<PromotionEvidenceBundleRow> {
  const bundleHash = createHash('sha256').update(JSON.stringify({
    k: input.bundleKey, e: input.experimentId, ce: input.challengerEvaluationId,
    p: input.pboEvaluationId, d: input.dsrEvaluationId, prospective: input.prospectiveEvidenceAvailable,
    contents: input.contents,
  })).digest('hex');
  const existing = await db.select().from(promotionEvidenceBundles).where(eq(promotionEvidenceBundles.bundleHash, bundleHash)).limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(promotionEvidenceBundles).values({
    bundleKey: input.bundleKey,
    bundleHash,
    experimentId: input.experimentId ?? null,
    challengerEvaluationId: input.challengerEvaluationId ?? null,
    pboEvaluationId: input.pboEvaluationId ?? null,
    dsrEvaluationId: input.dsrEvaluationId ?? null,
    prospectiveEvidenceAvailable: input.prospectiveEvidenceAvailable,
    contents: JSON.stringify(input.contents),
  });
  const [row] = await db.select().from(promotionEvidenceBundles).where(eq(promotionEvidenceBundles.bundleHash, bundleHash)).limit(1);
  return row;
}

export interface PromotionRequestInput {
  challengerVersionId: number;
  registeredExperimentId: number;
  promotionCriteriaId: number;
  evidenceBundleId: number;
  previousChampionVersion: string;
  rollbackVersion: string;
  humanApprovalActor?: string | null;
  humanApprovalAt?: Date | null;
  deploymentPlan?: string;
  criteriaChecks: Record<string, boolean>;
}

/**
 * The ONLY entry point for creating a promotion decision. There is no
 * non-interactive approval alternative. `humanApprovalActor` must be a
 * non-empty string. Any failed criterion produces `blocked`.
 */
export async function requestModelPromotion(input: PromotionRequestInput): Promise<ModelPromotionDecisionRow> {
  const failedChecks: string[] = [];
  for (const [k, v] of Object.entries(input.criteriaChecks)) if (!v) failedChecks.push(k);
  if (!input.humanApprovalActor || input.humanApprovalActor.trim() === '') {
    failedChecks.push('human_approval_actor_missing');
  }
  if (!input.humanApprovalAt) {
    failedChecks.push('human_approval_at_missing');
  }
  const [bundle] = await db.select().from(promotionEvidenceBundles).where(eq(promotionEvidenceBundles.id, input.evidenceBundleId)).limit(1);
  if (!bundle) throw new Error('evidence bundle not found');
  if (!bundle.prospectiveEvidenceAvailable) {
    failedChecks.push('prospective_shadow_evidence');
  }
  const decision: 'approved' | 'blocked' = failedChecks.length === 0 ? 'approved' : 'blocked';
  await db.insert(modelPromotionDecisions).values({
    challengerVersionId: input.challengerVersionId,
    registeredExperimentId: input.registeredExperimentId,
    promotionCriteriaId: input.promotionCriteriaId,
    evidenceBundleId: input.evidenceBundleId,
    previousChampionVersion: input.previousChampionVersion,
    newChampionVersion: null, // Never populated in Phase 2F.
    rollbackVersion: input.rollbackVersion,
    humanApprovalActor: input.humanApprovalActor ?? null,
    humanApprovalAt: input.humanApprovalAt ?? null,
    decision,
    blockReasons: failedChecks.join(',').slice(0, 1000),
    deploymentPlan: input.deploymentPlan ?? null,
    evidenceBundleHash: bundle.bundleHash,
  });
  const rows = await db.select().from(modelPromotionDecisions).where(eq(modelPromotionDecisions.challengerVersionId, input.challengerVersionId));
  return rows[rows.length - 1];
}

// Rollback records — immutable; created alongside every promotion decision.
export async function recordRollbackTarget(input: {
  modelPromotionDecisionId: number;
  rollbackVersion: string;
  rollbackConditions: readonly string[];
}): Promise<RollbackRecordRow> {
  const [{ insertId }] = (await db.insert(rollbackRecords).values({
    modelPromotionDecisionId: input.modelPromotionDecisionId,
    rollbackVersion: input.rollbackVersion,
    rollbackConditions: input.rollbackConditions.join(','),
    executed: false,
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(rollbackRecords).where(eq(rollbackRecords.id, insertId)).limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Kelly activation (§R) — always rejected in Phase 2F
// ---------------------------------------------------------------------------

export interface KellyActivationInput {
  challengerVersionId?: number | null;
  experimentId?: number | null;
  sampleCount: number;
  netOutcomeMean?: number | null;
  posteriorLowerBound?: number | null;
  bayesianShrinkageApplied?: boolean;
  calibrationStable?: boolean;
  regimeStable?: boolean;
  productStable?: boolean;
  quarterKellyCapEnforced?: boolean;
  minimumFloorEnforced?: boolean;
  humanApprovalActor?: string;
}

export async function evaluateKellyActivation(input: KellyActivationInput): Promise<KellyActivationEvaluationRow> {
  const reasons: string[] = [];
  // Phase 2F: always rejected. Kelly cannot be enabled without prospective evidence.
  reasons.push('rejected_prospective_evidence_unavailable');
  if (input.sampleCount < 250) reasons.push('insufficient_samples');
  if (input.bayesianShrinkageApplied !== true) reasons.push('missing_bayesian_shrinkage');
  if (input.calibrationStable !== true) reasons.push('calibration_not_stable');
  if (input.regimeStable !== true) reasons.push('regime_not_stable');
  if (input.productStable !== true) reasons.push('product_not_stable');
  if (input.quarterKellyCapEnforced === false) reasons.push('quarter_kelly_cap_not_enforced');
  if (input.minimumFloorEnforced === true) reasons.push('minimum_floor_forbidden');
  if (!input.humanApprovalActor) reasons.push('human_approval_missing');
  // Regardless of any input, outcome is always rejected_not_calibrated in Phase 2F.
  await db.insert(kellyActivationEvaluations).values({
    challengerVersionId: input.challengerVersionId ?? null,
    experimentId: input.experimentId ?? null,
    sampleCount: input.sampleCount,
    netOutcomeMean: input.netOutcomeMean != null ? input.netOutcomeMean.toFixed(10) : null,
    posteriorLowerBound: input.posteriorLowerBound != null ? input.posteriorLowerBound.toFixed(10) : null,
    bayesianShrinkageApplied: input.bayesianShrinkageApplied ?? false,
    calibrationStable: input.calibrationStable ?? false,
    regimeStable: input.regimeStable ?? false,
    productStable: input.productStable ?? false,
    quarterKellyCapEnforced: input.quarterKellyCapEnforced ?? true,
    minimumFloorEnforced: input.minimumFloorEnforced ?? false,
    humanApprovalActor: input.humanApprovalActor ?? null,
    outcome: 'rejected_not_calibrated',
    reasonCodes: reasons.join(',').slice(0, 500),
  });
  const rows = await db.select().from(kellyActivationEvaluations);
  return rows[rows.length - 1];
}
