import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  datasetDefinitions,
  datasetExclusions,
  datasetIntegrityChecks,
  datasetMemberships,
  datasetVersions,
  type DatasetDefinitionRow,
  type DatasetExclusionRow,
  type DatasetIntegrityCheckRow,
  type DatasetMembershipRow,
  type DatasetVersionRow,
} from '../../db/schema';

/**
 * Phase 2F §A — Dataset identity and provenance.
 *
 * Dataset definitions are immutable at the (datasetKey, sourceCategory)
 * level. Dataset versions are the append-only, per-run snapshot of the
 * inputs — every change of membership, exclusion, feature version,
 * cost model, fill model or label version requires a NEW version.
 *
 * Rules enforced here:
 *   - synthetic_fixture cannot be re-labeled as market evidence.
 *   - historical_replay cannot be re-labeled as prospective_shadow.
 *   - captured_live_shadow cannot be re-labeled after import.
 *   - Any membership or exclusion change requires a new version.
 *   - Availability cutoff is part of dataset identity.
 */

export type DatasetSourceCategory =
  | 'synthetic_fixture'
  | 'deterministic_replay'
  | 'historical_replay'
  | 'captured_live_shadow'
  | 'prospective_shadow';

const RELABEL_FORBIDDEN: Record<DatasetSourceCategory, readonly DatasetSourceCategory[]> = {
  synthetic_fixture: ['captured_live_shadow', 'prospective_shadow', 'historical_replay'],
  deterministic_replay: ['captured_live_shadow', 'prospective_shadow'],
  historical_replay: ['prospective_shadow'],
  captured_live_shadow: ['synthetic_fixture'],
  prospective_shadow: ['synthetic_fixture', 'historical_replay'],
};

export interface DatasetDefinitionInput {
  datasetKey: string;
  description: string;
  sourceCategory: DatasetSourceCategory;
}

export async function registerDatasetDefinition(input: DatasetDefinitionInput): Promise<DatasetDefinitionRow> {
  const existing = await db
    .select()
    .from(datasetDefinitions)
    .where(eq(datasetDefinitions.datasetKey, input.datasetKey))
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].sourceCategory !== input.sourceCategory) {
      const forbidden = RELABEL_FORBIDDEN[existing[0].sourceCategory as DatasetSourceCategory] ?? [];
      if (forbidden.includes(input.sourceCategory)) {
        throw new Error(
          `dataset ${input.datasetKey} cannot be re-labeled from ${existing[0].sourceCategory} to ${input.sourceCategory}`,
        );
      }
      throw new Error(
        `dataset ${input.datasetKey} sourceCategory ${existing[0].sourceCategory} cannot be relabeled to ${input.sourceCategory} without a new datasetKey`,
      );
    }
    return existing[0];
  }
  await db.insert(datasetDefinitions).values({
    datasetKey: input.datasetKey,
    description: input.description,
    sourceCategory: input.sourceCategory,
  });
  const [row] = await db
    .select()
    .from(datasetDefinitions)
    .where(eq(datasetDefinitions.datasetKey, input.datasetKey))
    .limit(1);
  return row;
}

export interface DatasetVersionInput {
  datasetDefinitionId: number;
  datasetVersion: string;
  sourceCategory: DatasetSourceCategory;
  sourceIdentity: string;
  productUniverseHash: string;
  startTime: Date;
  endTime: Date;
  dataAvailabilityCutoff: Date;
  featureVersions: readonly string[];
  fingerprintVersion: string;
  regimeVersion: string;
  riskPolicyVersion: string;
  microstructurePolicyVersion: string;
  contextPolicyVersion: string;
  costModelVersion: string;
  fillModelVersion: string;
  labelVersion: string;
  exclusionPolicyVersion: string;
  codeCommit: string;
}

function versionInputHash(input: DatasetVersionInput): string {
  return createHash('sha256').update(JSON.stringify({
    def: input.datasetDefinitionId,
    v: input.datasetVersion,
    src: input.sourceCategory,
    srcId: input.sourceIdentity,
    prodHash: input.productUniverseHash,
    st: input.startTime.getTime(),
    et: input.endTime.getTime(),
    cut: input.dataAvailabilityCutoff.getTime(),
    fv: [...input.featureVersions].sort(),
    fpv: input.fingerprintVersion,
    rv: input.regimeVersion,
    rpv: input.riskPolicyVersion,
    mpv: input.microstructurePolicyVersion,
    ctxv: input.contextPolicyVersion,
    cmv: input.costModelVersion,
    fmv: input.fillModelVersion,
    lv: input.labelVersion,
    epv: input.exclusionPolicyVersion,
    cc: input.codeCommit,
  })).digest('hex');
}

export async function persistDatasetVersion(input: DatasetVersionInput): Promise<DatasetVersionRow> {
  const [def] = await db.select().from(datasetDefinitions).where(eq(datasetDefinitions.id, input.datasetDefinitionId)).limit(1);
  if (!def) throw new Error(`dataset definition ${input.datasetDefinitionId} not found`);
  // Enforce §A: source category must match the parent definition — or be a
  // legally advanced classification for the same fixture run.
  if (def.sourceCategory !== input.sourceCategory) {
    const forbidden = RELABEL_FORBIDDEN[def.sourceCategory as DatasetSourceCategory] ?? [];
    if (forbidden.includes(input.sourceCategory)) {
      throw new Error(
        `dataset version ${input.datasetVersion} sourceCategory ${input.sourceCategory} conflicts with definition ${def.sourceCategory}`,
      );
    }
  }
  const inputHash = versionInputHash(input);
  const existing = await db
    .select()
    .from(datasetVersions)
    .where(and(
      eq(datasetVersions.datasetDefinitionId, input.datasetDefinitionId),
      eq(datasetVersions.datasetVersion, input.datasetVersion),
    ))
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].inputHash !== inputHash) {
      throw new Error(`dataset version ${input.datasetVersion} input hash mismatch — bump version`);
    }
    return existing[0];
  }
  await db.insert(datasetVersions).values({
    datasetDefinitionId: input.datasetDefinitionId,
    datasetVersion: input.datasetVersion,
    sourceCategory: input.sourceCategory,
    sourceIdentity: input.sourceIdentity,
    productUniverseHash: input.productUniverseHash,
    startTime: input.startTime,
    endTime: input.endTime,
    dataAvailabilityCutoff: input.dataAvailabilityCutoff,
    featureVersions: input.featureVersions.join(','),
    fingerprintVersion: input.fingerprintVersion,
    regimeVersion: input.regimeVersion,
    riskPolicyVersion: input.riskPolicyVersion,
    microstructurePolicyVersion: input.microstructurePolicyVersion,
    contextPolicyVersion: input.contextPolicyVersion,
    costModelVersion: input.costModelVersion,
    fillModelVersion: input.fillModelVersion,
    labelVersion: input.labelVersion,
    exclusionPolicyVersion: input.exclusionPolicyVersion,
    codeCommit: input.codeCommit,
    inputHash,
  });
  const [row] = await db
    .select()
    .from(datasetVersions)
    .where(and(
      eq(datasetVersions.datasetDefinitionId, input.datasetDefinitionId),
      eq(datasetVersions.datasetVersion, input.datasetVersion),
    ))
    .limit(1);
  return row;
}

export async function addDatasetMembership(
  datasetVersionId: number,
  productId: string,
  included: boolean,
  reasonCode: string,
): Promise<DatasetMembershipRow> {
  const existing = await db
    .select()
    .from(datasetMemberships)
    .where(and(eq(datasetMemberships.datasetVersionId, datasetVersionId), eq(datasetMemberships.productId, productId)))
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].included !== included) {
      throw new Error(
        `dataset ${datasetVersionId} membership for ${productId} cannot change from ${existing[0].included} to ${included} — create a new version`,
      );
    }
    return existing[0];
  }
  await db.insert(datasetMemberships).values({ datasetVersionId, productId, included, reasonCode });
  const [row] = await db
    .select()
    .from(datasetMemberships)
    .where(and(eq(datasetMemberships.datasetVersionId, datasetVersionId), eq(datasetMemberships.productId, productId)))
    .limit(1);
  return row;
}

export async function recordDatasetExclusion(input: {
  datasetVersionId: number;
  productId: string;
  exclusionReason: string;
  exclusionKind: 'a_priori' | 'structural' | 'operator_manual';
  excludedAt: Date;
}): Promise<DatasetExclusionRow> {
  const [{ insertId }] = (await db.insert(datasetExclusions).values(input)) as unknown as { insertId: number }[];
  const [row] = await db.select().from(datasetExclusions).where(eq(datasetExclusions.id, insertId)).limit(1);
  return row;
}

export async function recordDatasetIntegrityCheck(input: {
  datasetVersionId: number;
  checkName: string;
  passed: boolean;
  details?: string;
  checkedAt: Date;
}): Promise<DatasetIntegrityCheckRow> {
  const [{ insertId }] = (await db.insert(datasetIntegrityChecks).values({
    datasetVersionId: input.datasetVersionId,
    checkName: input.checkName,
    passed: input.passed,
    details: input.details ?? null,
    checkedAt: input.checkedAt,
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(datasetIntegrityChecks).where(eq(datasetIntegrityChecks.id, insertId)).limit(1);
  return row;
}
