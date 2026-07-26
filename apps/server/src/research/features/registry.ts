import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import {
  featureCalculationRuns,
  featureDefinitions,
  featureValues,
  type FeatureCalculationRunRow,
  type FeatureDefinitionRow,
  type FeatureValueRow,
} from '../../db/schema';
import type { FeatureDefinition, FeatureResult, FeatureStatus } from './contract';
import type { FeatureInputBundle } from './inputs';
import type { Stage1Feature } from './stage1';

/**
 * Phase 2A §E — Feature registry.
 *
 * The registry is intentionally minimal: it upserts an
 * (featureKey,featureVersion) row into `feature_definitions` and then
 * treats that pair as IMMUTABLE. Bumping a calculator's semantics
 * requires bumping `version`; the DB uniqueness rejects any silent
 * behavior change.
 */

export interface RegisteredFeature {
  definition: FeatureDefinition;
  row: FeatureDefinitionRow;
}

/** Ensure a definition exists — returns the persisted row. */
export async function registerFeatureDefinition(
  def: FeatureDefinition,
): Promise<RegisteredFeature> {
  const existing = await db
    .select()
    .from(featureDefinitions)
    .where(
      and(
        eq(featureDefinitions.featureKey, def.key),
        eq(featureDefinitions.featureVersion, def.version),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return { definition: def, row: existing[0] };
  }
  await db.insert(featureDefinitions).values({
    featureKey: def.key,
    featureVersion: def.version,
    description: def.description,
    inputRequirements: def.inputRequirements,
    lookbackRequirement: Math.max(0, def.lookbackMs),
    minimumSampleCount: def.minimumSampleCount,
    outputType: def.outputType,
    unit: def.unit,
    validRangeMin: def.validRangeMin != null ? def.validRangeMin.toFixed(12) : null,
    validRangeMax: def.validRangeMax != null ? def.validRangeMax.toFixed(12) : null,
    missingDataPolicy: def.missingDataPolicy,
    stalenessPolicy: def.stalenessPolicy,
    calculationHash: hashDefinition(def),
    implementationVersion: def.implementationVersion,
    status: def.status,
    stage: def.stage,
  });
  const [row] = await db
    .select()
    .from(featureDefinitions)
    .where(
      and(
        eq(featureDefinitions.featureKey, def.key),
        eq(featureDefinitions.featureVersion, def.version),
      ),
    )
    .limit(1);
  return { definition: def, row: row! };
}

/**
 * The registry rejects any attempt to register a definition whose
 * calculation hash differs from a previously-registered version.
 */
export async function assertDefinitionImmutability(
  def: FeatureDefinition,
): Promise<void> {
  const existing = await db
    .select()
    .from(featureDefinitions)
    .where(
      and(
        eq(featureDefinitions.featureKey, def.key),
        eq(featureDefinitions.featureVersion, def.version),
      ),
    )
    .limit(1);
  if (existing.length === 0) return;
  const expected = hashDefinition(def);
  if (existing[0].calculationHash !== expected) {
    throw new Error(
      `feature definition ${def.key}@${def.version} calculationHash mismatch — bump the version`,
    );
  }
}

function hashDefinition(def: FeatureDefinition): string {
  const parts = JSON.stringify({
    key: def.key,
    version: def.version,
    lookbackMs: def.lookbackMs,
    minimumSampleCount: def.minimumSampleCount,
    outputType: def.outputType,
    unit: def.unit,
    missing: def.missingDataPolicy,
    stale: def.stalenessPolicy,
    stage: def.stage,
    impl: def.implementationVersion,
  });
  // Cheap deterministic hash — the immutability check uses this value
  // ONLY to spot silent semantic changes across sessions.
  let h = 0;
  for (let i = 0; i < parts.length; i += 1) {
    h = ((h << 5) - h + parts.charCodeAt(i)) | 0;
  }
  return `def-${(h >>> 0).toString(16)}`;
}

// ---------------------------------------------------------------------------
// Calculation runs + value persistence
// ---------------------------------------------------------------------------

export interface StartRunInput {
  snapshotId: number;
  stage: 'stage_1' | 'stage_2';
  now: Date;
  runVersion: string;
  productCount: number;
}

export async function startFeatureRun(input: StartRunInput): Promise<FeatureCalculationRunRow> {
  const [{ insertId }] = (await db.insert(featureCalculationRuns).values({
    snapshotId: input.snapshotId,
    stage: input.stage,
    startedAt: input.now,
    productCount: input.productCount,
    runVersion: input.runVersion,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(featureCalculationRuns)
    .where(eq(featureCalculationRuns.id, insertId))
    .limit(1);
  return row!;
}

export async function completeFeatureRun(
  runId: number,
  completedAt: Date,
  counts: { computed: number; failed: number },
): Promise<void> {
  await db
    .update(featureCalculationRuns)
    .set({
      completedAt,
      computedValues: counts.computed,
      failedValues: counts.failed,
    })
    .where(eq(featureCalculationRuns.id, runId));
}

export interface PersistValueInput {
  runId: number;
  productId: string;
  featureKey: string;
  featureVersion: string;
  result: FeatureResult<number>;
}

/**
 * Persist a single FeatureResult. Uniqueness on (runId, productId,
 * featureKey, featureVersion) prevents duplicate writes within a run.
 */
export async function persistFeatureValue(input: PersistValueInput): Promise<FeatureValueRow> {
  const r = input.result;
  await db.insert(featureValues).values({
    runId: input.runId,
    productId: input.productId,
    featureKey: input.featureKey,
    featureVersion: input.featureVersion,
    status: r.status,
    value: r.value != null && Number.isFinite(r.value) ? r.value.toFixed(12) : null,
    confidence: r.confidence.toFixed(4),
    sampleCount: r.sampleCount,
    lookbackStart: r.lookbackStart,
    lookbackEnd: r.lookbackEnd,
    dataAvailableAt: r.dataAvailableAt,
    inputHash: r.inputHash,
    failureReason: r.failureReason,
    diagnostics: r.diagnostics ? JSON.stringify(r.diagnostics) : null,
  });
  const [row] = await db
    .select()
    .from(featureValues)
    .where(
      and(
        eq(featureValues.runId, input.runId),
        eq(featureValues.productId, input.productId),
        eq(featureValues.featureKey, input.featureKey),
        eq(featureValues.featureVersion, input.featureVersion),
      ),
    )
    .limit(1);
  return row!;
}

// ---------------------------------------------------------------------------
// Orchestrator — runs a full feature catalog against a product bundle
// ---------------------------------------------------------------------------

export interface ComputeCatalogResult {
  featureKey: string;
  featureVersion: string;
  result: FeatureResult<number>;
}

export function computeCatalog(
  features: readonly Stage1Feature[],
  bundle: FeatureInputBundle,
): ComputeCatalogResult[] {
  return features.map((f) => ({
    featureKey: f.def.key,
    featureVersion: f.def.version,
    result: f.compute(bundle),
  }));
}

/**
 * Convenience: register all definitions, immutability-check them, then
 * return the mapping keyed by featureKey — the composer uses this to
 * look up definitions when writing evidence rows.
 */
export async function ensureCatalogRegistered(
  features: readonly Stage1Feature[],
): Promise<Map<string, RegisteredFeature>> {
  const map = new Map<string, RegisteredFeature>();
  for (const f of features) {
    await assertDefinitionImmutability(f.def);
    const reg = await registerFeatureDefinition(f.def);
    map.set(f.def.key, reg);
  }
  return map;
}

/**
 * Persist a catalog of results under a run row. Returns the counts
 * suitable for `completeFeatureRun`.
 */
export async function persistCatalogResults(
  runId: number,
  productId: string,
  results: readonly ComputeCatalogResult[],
): Promise<{ computed: number; failed: number; rows: FeatureValueRow[] }> {
  let computed = 0;
  let failed = 0;
  const rows: FeatureValueRow[] = [];
  for (const item of results) {
    const row = await persistFeatureValue({
      runId,
      productId,
      featureKey: item.featureKey,
      featureVersion: item.featureVersion,
      result: item.result,
    });
    rows.push(row);
    if (item.result.status === 'valid' || item.result.status === 'low_confidence') computed += 1;
    else failed += 1;
  }
  return { computed, failed, rows };
}

export type { FeatureResult, FeatureStatus, FeatureDefinition };
