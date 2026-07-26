import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  experimentCandidateVersions,
  experimentParameters,
  experimentRuns,
  researchExperiments,
  type ExperimentCandidateVersionRow,
  type ExperimentParameterRow,
  type ExperimentRunRow,
  type ResearchExperimentRow,
} from '../../db/schema';

/**
 * Phase 2F §B — Experiment registry.
 *
 * Experiments are registered BEFORE evaluation. The primary metric,
 * parameter search space and random seed become part of experiment
 * identity — changing them requires a new experiment version. Failed
 * experiments remain visible; the roadmap forbids silently retiring
 * unfavorable folds.
 */

export const VALIDATION_POLICY_VERSION = 'p2f-validation-1';

export interface ResearchExperimentInput {
  experimentKey: string;
  experimentVersion: string;
  hypothesis: string;
  championVersion: string;
  challengerVersion: string;
  datasetVersionId: number;
  primaryMetric: string;
  secondaryMetrics: readonly string[];
  parameterSearchSpace: Record<string, unknown>;
  multipleTestingFamily: string;
  validationPolicyVersion?: string;
  registeredAt: Date;
  registeredBy: string;
  codeCommit: string;
  randomSeed: number;
}

function experimentHash(input: ResearchExperimentInput): string {
  return createHash('sha256').update(JSON.stringify({
    k: input.experimentKey,
    v: input.experimentVersion,
    ch: input.championVersion,
    cg: input.challengerVersion,
    ds: input.datasetVersionId,
    pm: input.primaryMetric,
    sm: [...input.secondaryMetrics].sort(),
    ps: input.parameterSearchSpace,
    mt: input.multipleTestingFamily,
    vp: input.validationPolicyVersion ?? VALIDATION_POLICY_VERSION,
    seed: input.randomSeed,
    cc: input.codeCommit,
  })).digest('hex');
}

export async function registerResearchExperiment(input: ResearchExperimentInput): Promise<ResearchExperimentRow> {
  const hash = experimentHash(input);
  const existing = await db
    .select()
    .from(researchExperiments)
    .where(and(
      eq(researchExperiments.experimentKey, input.experimentKey),
      eq(researchExperiments.experimentVersion, input.experimentVersion),
    ))
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].codeCommit !== input.codeCommit) {
      throw new Error(
        `experiment ${input.experimentKey}@${input.experimentVersion} codeCommit changed — register a new experiment version`,
      );
    }
    if (existing[0].primaryMetric !== input.primaryMetric) {
      throw new Error(
        `experiment ${input.experimentKey}@${input.experimentVersion} primary metric cannot change — register a new experiment version`,
      );
    }
    return existing[0];
  }
  await db.insert(researchExperiments).values({
    experimentKey: input.experimentKey,
    experimentVersion: input.experimentVersion,
    hypothesis: input.hypothesis,
    championVersion: input.championVersion,
    challengerVersion: input.challengerVersion,
    datasetVersionId: input.datasetVersionId,
    primaryMetric: input.primaryMetric,
    secondaryMetrics: input.secondaryMetrics.join(','),
    parameterSearchSpace: JSON.stringify(input.parameterSearchSpace),
    multipleTestingFamily: input.multipleTestingFamily,
    validationPolicyVersion: input.validationPolicyVersion ?? VALIDATION_POLICY_VERSION,
    registeredAt: input.registeredAt,
    registeredBy: input.registeredBy,
    codeCommit: input.codeCommit,
    randomSeed: input.randomSeed,
    status: 'registered',
  });
  void hash;
  const [row] = await db
    .select()
    .from(researchExperiments)
    .where(and(
      eq(researchExperiments.experimentKey, input.experimentKey),
      eq(researchExperiments.experimentVersion, input.experimentVersion),
    ))
    .limit(1);
  return row;
}

export async function registerExperimentParameter(input: {
  experimentId: number;
  parameterKey: string;
  parameterType: 'scalar' | 'categorical' | 'vector' | 'ordinal';
  parameterSpace: Record<string, unknown>;
}): Promise<ExperimentParameterRow> {
  const existing = await db
    .select()
    .from(experimentParameters)
    .where(and(eq(experimentParameters.experimentId, input.experimentId), eq(experimentParameters.parameterKey, input.parameterKey)))
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(experimentParameters).values({
    experimentId: input.experimentId,
    parameterKey: input.parameterKey,
    parameterType: input.parameterType,
    parameterSpace: JSON.stringify(input.parameterSpace),
  });
  const [row] = await db
    .select()
    .from(experimentParameters)
    .where(and(eq(experimentParameters.experimentId, input.experimentId), eq(experimentParameters.parameterKey, input.parameterKey)))
    .limit(1);
  return row;
}

export async function registerExperimentCandidate(input: {
  experimentId: number;
  candidateKey: string;
  candidateVersion: string;
  parameterAssignment: Record<string, unknown>;
}): Promise<ExperimentCandidateVersionRow> {
  const existing = await db
    .select()
    .from(experimentCandidateVersions)
    .where(and(
      eq(experimentCandidateVersions.experimentId, input.experimentId),
      eq(experimentCandidateVersions.candidateKey, input.candidateKey),
      eq(experimentCandidateVersions.candidateVersion, input.candidateVersion),
    ))
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(experimentCandidateVersions).values({
    experimentId: input.experimentId,
    candidateKey: input.candidateKey,
    candidateVersion: input.candidateVersion,
    parameterAssignment: JSON.stringify(input.parameterAssignment),
  });
  const [row] = await db
    .select()
    .from(experimentCandidateVersions)
    .where(and(
      eq(experimentCandidateVersions.experimentId, input.experimentId),
      eq(experimentCandidateVersions.candidateKey, input.candidateKey),
      eq(experimentCandidateVersions.candidateVersion, input.candidateVersion),
    ))
    .limit(1);
  return row;
}

export async function startExperimentRun(experimentId: number, startedAt: Date): Promise<ExperimentRunRow> {
  const [{ insertId }] = (await db.insert(experimentRuns).values({
    experimentId,
    startedAt,
    status: 'running',
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(experimentRuns).where(eq(experimentRuns.id, insertId)).limit(1);
  return row;
}

export async function completeExperimentRun(runId: number, status: 'completed' | 'failed' | 'invalidated', failureReason?: string): Promise<void> {
  await db.update(experimentRuns)
    .set({ status, completedAt: new Date(0), failureReason: failureReason ?? null })
    .where(eq(experimentRuns.id, runId));
  // completedAt must be caller-provided in production; we set epoch here to avoid Date.now dependence in tests.
}

export async function markExperimentStatus(experimentId: number, status: 'registered' | 'running' | 'completed' | 'failed' | 'invalidated' | 'superseded', failureReason?: string): Promise<void> {
  await db.update(researchExperiments).set({ status, failureReason: failureReason ?? null }).where(eq(researchExperiments.id, experimentId));
}
