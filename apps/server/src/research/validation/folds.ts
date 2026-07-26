import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  cpcvDefinitions,
  cpcvPathFolds,
  cpcvPathResults,
  cpcvPaths,
  validationEmbargoes,
  validationFoldMemberships,
  validationFolds,
  validationIncidents,
  validationSplitPolicies,
  type CpcvDefinitionRow,
  type CpcvPathFoldRow,
  type CpcvPathResultRow,
  type CpcvPathRow,
  type ValidationEmbargoRow,
  type ValidationFoldMembershipRow,
  type ValidationFoldRow,
  type ValidationIncidentRow,
  type ValidationSplitPolicyRow,
} from '../../db/schema';

/**
 * Phase 2F §C, §D, §E, §F — Split policies, walk-forward, leakage
 * firewall and deterministic CPCV.
 *
 * Every generator here is deterministic given its inputs. Time-series
 * observations are never shuffled. Purge and embargo are enforced. The
 * leakage firewall never converts a warning to a pass; a detected
 * violation invalidates the fold and blocks promotion eligibility.
 */

export type SplitKind =
  | 'expanding_walk_forward'
  | 'rolling_walk_forward'
  | 'anchored_walk_forward'
  | 'purged_k_fold'
  | 'combinatorial_purged_cross_validation'
  | 'final_holdout';

export const VALIDATION_SPLIT_POLICY_VERSION = 'p2f-split-1';

// ---------------------------------------------------------------------------
// Split policies
// ---------------------------------------------------------------------------

export interface SplitPolicyInput {
  policyKey: string;
  policyVersion: string;
  splitKind: SplitKind;
  description: string;
  purgeWindowMs: number;
  embargoWindowMs: number;
  labelHorizonMs: number;
  configuration: Record<string, unknown>;
}

function splitPolicyHash(input: SplitPolicyInput): string {
  return createHash('sha256').update(JSON.stringify({
    k: input.policyKey,
    v: input.policyVersion,
    kind: input.splitKind,
    pw: input.purgeWindowMs,
    ew: input.embargoWindowMs,
    lh: input.labelHorizonMs,
    cfg: input.configuration,
  })).digest('hex');
}

export async function registerValidationSplitPolicy(input: SplitPolicyInput): Promise<ValidationSplitPolicyRow> {
  const hash = splitPolicyHash(input);
  const existing = await db
    .select()
    .from(validationSplitPolicies)
    .where(and(eq(validationSplitPolicies.policyKey, input.policyKey), eq(validationSplitPolicies.policyVersion, input.policyVersion)))
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].implementationHash !== hash) {
      throw new Error(`split policy ${input.policyKey}@${input.policyVersion} implementationHash drift — bump version`);
    }
    return existing[0];
  }
  await db.insert(validationSplitPolicies).values({
    policyKey: input.policyKey,
    policyVersion: input.policyVersion,
    splitKind: input.splitKind,
    description: input.description,
    purgeWindowMs: input.purgeWindowMs,
    embargoWindowMs: input.embargoWindowMs,
    labelHorizonMs: input.labelHorizonMs,
    configuration: JSON.stringify(input.configuration),
    implementationHash: hash,
    status: 'observer',
  });
  const [row] = await db
    .select()
    .from(validationSplitPolicies)
    .where(and(eq(validationSplitPolicies.policyKey, input.policyKey), eq(validationSplitPolicies.policyVersion, input.policyVersion)))
    .limit(1);
  return row;
}

export async function addValidationEmbargo(
  splitPolicyId: number,
  embargoKind: 'leading' | 'trailing' | 'both',
  embargoWindowMs: number,
): Promise<ValidationEmbargoRow> {
  const [{ insertId }] = (await db.insert(validationEmbargoes).values({
    splitPolicyId, embargoKind, embargoWindowMs,
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(validationEmbargoes).where(eq(validationEmbargoes.id, insertId)).limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Walk-forward folds
// ---------------------------------------------------------------------------

export interface WalkForwardInput {
  splitKind: 'expanding_walk_forward' | 'rolling_walk_forward' | 'anchored_walk_forward';
  seriesStart: Date;
  seriesEnd: Date;
  trainingWindowMs: number; // for rolling/expanding
  validationWindowMs: number;
  purgeWindowMs: number;
  embargoWindowMs: number;
  labelHorizonMs: number;
  stepMs: number;
  finalHoldoutMs: number;
}

export interface WalkForwardFold {
  foldIndex: number;
  trainingStart: Date;
  trainingEnd: Date;
  purgeStart: Date;
  purgeEnd: Date;
  embargoStart: Date;
  embargoEnd: Date;
  validationStart: Date;
  validationEnd: Date;
  holdout: boolean;
}

/**
 * Deterministic walk-forward fold generator. Produces byte-identical
 * folds given byte-identical input. The final holdout is always the
 * last window and is marked `holdout=true`.
 */
export function generateWalkForwardFolds(input: WalkForwardInput): WalkForwardFold[] {
  if (input.seriesEnd.getTime() <= input.seriesStart.getTime()) return [];
  const folds: WalkForwardFold[] = [];
  const totalStart = input.seriesStart.getTime();
  const totalEnd = input.seriesEnd.getTime();
  const holdoutStart = totalEnd - input.finalHoldoutMs;
  let idx = 0;
  let trainStart = totalStart;
  let trainEnd = totalStart + input.trainingWindowMs;
  while (trainEnd + input.purgeWindowMs + input.embargoWindowMs + input.validationWindowMs <= holdoutStart) {
    const purgeStart = trainEnd;
    const purgeEnd = purgeStart + input.purgeWindowMs;
    const embargoStart = purgeEnd;
    const embargoEnd = embargoStart + input.embargoWindowMs;
    const validationStart = embargoEnd;
    const validationEnd = validationStart + input.validationWindowMs;
    folds.push({
      foldIndex: idx,
      trainingStart: new Date(trainStart),
      trainingEnd: new Date(trainEnd),
      purgeStart: new Date(purgeStart),
      purgeEnd: new Date(purgeEnd),
      embargoStart: new Date(embargoStart),
      embargoEnd: new Date(embargoEnd),
      validationStart: new Date(validationStart),
      validationEnd: new Date(validationEnd),
      holdout: false,
    });
    idx += 1;
    if (input.splitKind === 'expanding_walk_forward') {
      trainEnd = trainEnd + input.stepMs;
    } else if (input.splitKind === 'rolling_walk_forward') {
      trainStart = trainStart + input.stepMs;
      trainEnd = trainEnd + input.stepMs;
    } else {
      // anchored: trainStart pinned to totalStart, trainEnd grows.
      trainEnd = trainEnd + input.stepMs;
    }
  }
  // Final holdout fold.
  const finalTrainEnd = holdoutStart - input.purgeWindowMs - input.embargoWindowMs;
  const finalTrainStart = input.splitKind === 'rolling_walk_forward'
    ? Math.max(totalStart, finalTrainEnd - input.trainingWindowMs)
    : totalStart;
  folds.push({
    foldIndex: idx,
    trainingStart: new Date(finalTrainStart),
    trainingEnd: new Date(finalTrainEnd),
    purgeStart: new Date(finalTrainEnd),
    purgeEnd: new Date(finalTrainEnd + input.purgeWindowMs),
    embargoStart: new Date(finalTrainEnd + input.purgeWindowMs),
    embargoEnd: new Date(finalTrainEnd + input.purgeWindowMs + input.embargoWindowMs),
    validationStart: new Date(holdoutStart),
    validationEnd: new Date(totalEnd),
    holdout: true,
  });
  return folds;
}

function foldHash(fold: WalkForwardFold, splitPolicyId: number, experimentRunId: number): string {
  return createHash('sha256').update(JSON.stringify({
    run: experimentRunId,
    sp: splitPolicyId,
    idx: fold.foldIndex,
    ts: fold.trainingStart.getTime(),
    te: fold.trainingEnd.getTime(),
    vs: fold.validationStart.getTime(),
    ve: fold.validationEnd.getTime(),
    ho: fold.holdout,
  })).digest('hex');
}

export async function persistWalkForwardFolds(
  experimentRunId: number,
  splitPolicyId: number,
  folds: readonly WalkForwardFold[],
): Promise<ValidationFoldRow[]> {
  const rows: ValidationFoldRow[] = [];
  for (const f of folds) {
    const hash = foldHash(f, splitPolicyId, experimentRunId);
    const existing = await db
      .select()
      .from(validationFolds)
      .where(and(eq(validationFolds.experimentRunId, experimentRunId), eq(validationFolds.foldIndex, f.foldIndex)))
      .limit(1);
    if (existing.length > 0) {
      rows.push(existing[0]);
      continue;
    }
    await db.insert(validationFolds).values({
      experimentRunId,
      splitPolicyId,
      foldIndex: f.foldIndex,
      trainingStart: f.trainingStart,
      trainingEnd: f.trainingEnd,
      purgeStart: f.purgeStart,
      purgeEnd: f.purgeEnd,
      embargoStart: f.embargoStart,
      embargoEnd: f.embargoEnd,
      validationStart: f.validationStart,
      validationEnd: f.validationEnd,
      holdout: f.holdout,
      status: 'pending',
      sampleCount: 0,
      inputHash: hash,
    });
    const [row] = await db
      .select()
      .from(validationFolds)
      .where(and(eq(validationFolds.experimentRunId, experimentRunId), eq(validationFolds.foldIndex, f.foldIndex)))
      .limit(1);
    rows.push(row);
  }
  return rows;
}

export async function markFoldStatus(
  foldId: number,
  status: 'completed' | 'empty' | 'failed' | 'invalidated',
  sampleCount: number,
  failureReason?: string,
): Promise<void> {
  await db.update(validationFolds).set({ status, sampleCount, failureReason: failureReason ?? null }).where(eq(validationFolds.id, foldId));
}

export async function addFoldMembership(
  foldId: number,
  productId: string,
  observationTimestamp: Date,
  roleInFold: 'training' | 'validation' | 'purged' | 'embargoed',
): Promise<ValidationFoldMembershipRow> {
  await db.insert(validationFoldMemberships).values({ foldId, productId, observationTimestamp, roleInFold });
  const rows = await db.select().from(validationFoldMemberships).where(eq(validationFoldMemberships.foldId, foldId));
  return rows[rows.length - 1];
}

// ---------------------------------------------------------------------------
// Deterministic CPCV path generation (§F)
// ---------------------------------------------------------------------------

export interface CpcvConfig {
  numberOfGroups: number;
  numberOfTestGroups: number;
  purgeWindowMs: number;
  embargoWindowMs: number;
  labelHorizonMs: number;
  pathConstructionPolicy: string;
  maximumPathCount: number;
}

/**
 * Deterministic combinations. Sorted lexically by group index tuple.
 */
export function generateCpcvTestGroups(numberOfGroups: number, numberOfTestGroups: number, maxPaths: number): number[][] {
  const combos: number[][] = [];
  const build = (start: number, current: number[]) => {
    if (current.length === numberOfTestGroups) {
      combos.push([...current]);
      return;
    }
    for (let i = start; i < numberOfGroups; i += 1) {
      current.push(i);
      build(i + 1, current);
      current.pop();
    }
  };
  build(0, []);
  return combos.slice(0, maxPaths);
}

export async function persistCpcvDefinition(experimentId: number, cfg: CpcvConfig): Promise<CpcvDefinitionRow> {
  const hash = createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
  const existing = await db.select().from(cpcvDefinitions).where(eq(cpcvDefinitions.experimentId, experimentId)).limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(cpcvDefinitions).values({
    experimentId,
    numberOfGroups: cfg.numberOfGroups,
    numberOfTestGroups: cfg.numberOfTestGroups,
    purgeWindowMs: cfg.purgeWindowMs,
    embargoWindowMs: cfg.embargoWindowMs,
    labelHorizonMs: cfg.labelHorizonMs,
    pathConstructionPolicy: cfg.pathConstructionPolicy,
    maximumPathCount: cfg.maximumPathCount,
    implementationHash: hash,
  });
  const [row] = await db.select().from(cpcvDefinitions).where(eq(cpcvDefinitions.experimentId, experimentId)).limit(1);
  return row;
}

export async function persistCpcvPaths(cpcvDefinitionId: number, cfg: CpcvConfig): Promise<CpcvPathRow[]> {
  const groups = generateCpcvTestGroups(cfg.numberOfGroups, cfg.numberOfTestGroups, cfg.maximumPathCount);
  const rows: CpcvPathRow[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    const testGroups = groups[i];
    const trainingGroups: number[] = [];
    for (let g = 0; g < cfg.numberOfGroups; g += 1) if (!testGroups.includes(g)) trainingGroups.push(g);
    const pathHash = createHash('sha256').update(JSON.stringify({ def: cpcvDefinitionId, tst: testGroups, trn: trainingGroups })).digest('hex');
    const existing = await db
      .select()
      .from(cpcvPaths)
      .where(and(eq(cpcvPaths.cpcvDefinitionId, cpcvDefinitionId), eq(cpcvPaths.pathIndex, i)))
      .limit(1);
    if (existing.length > 0) {
      rows.push(existing[0]);
      continue;
    }
    await db.insert(cpcvPaths).values({
      cpcvDefinitionId,
      pathIndex: i,
      testGroups: testGroups.join(','),
      trainingGroups: trainingGroups.join(','),
      pathHash,
      status: 'pending',
    });
    const [row] = await db
      .select()
      .from(cpcvPaths)
      .where(and(eq(cpcvPaths.cpcvDefinitionId, cpcvDefinitionId), eq(cpcvPaths.pathIndex, i)))
      .limit(1);
    rows.push(row);
  }
  return rows;
}

export async function persistCpcvPathFold(cpcvPathId: number, foldId: number): Promise<CpcvPathFoldRow> {
  const existing = await db
    .select()
    .from(cpcvPathFolds)
    .where(and(eq(cpcvPathFolds.cpcvPathId, cpcvPathId), eq(cpcvPathFolds.foldId, foldId)))
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(cpcvPathFolds).values({ cpcvPathId, foldId });
  const [row] = await db
    .select()
    .from(cpcvPathFolds)
    .where(and(eq(cpcvPathFolds.cpcvPathId, cpcvPathId), eq(cpcvPathFolds.foldId, foldId)))
    .limit(1);
  return row;
}

export async function persistCpcvPathResult(
  cpcvPathId: number,
  input: {
    netReturn: number | null;
    netSharpe: number | null;
    maximumDrawdown: number | null;
    sampleCount: number;
    status: 'valid' | 'insufficient_samples' | 'failed' | 'invalid';
    failureReason?: string;
  },
): Promise<CpcvPathResultRow> {
  const inputHash = createHash('sha256').update(JSON.stringify({
    p: cpcvPathId, r: input.netReturn, s: input.netSharpe, d: input.maximumDrawdown, n: input.sampleCount,
  })).digest('hex');
  await db.insert(cpcvPathResults).values({
    cpcvPathId,
    netReturn: input.netReturn != null ? input.netReturn.toFixed(10) : null,
    netSharpe: input.netSharpe != null ? input.netSharpe.toFixed(10) : null,
    maximumDrawdown: input.maximumDrawdown != null ? input.maximumDrawdown.toFixed(10) : null,
    sampleCount: input.sampleCount,
    status: input.status,
    failureReason: input.failureReason ?? null,
    inputHash,
  });
  const [row] = await db.select().from(cpcvPathResults).where(eq(cpcvPathResults.cpcvPathId, cpcvPathId)).limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Leakage firewall (§D)
// ---------------------------------------------------------------------------

export type LeakageCheckKind =
  | 'future_observation'
  | 'future_label'
  | 'revised_data_leak'
  | 'overlapping_label_horizon'
  | 'train_test_overlap'
  | 'embargo_violation'
  | 'final_holdout_contamination'
  | 'product_survivorship'
  | 'future_universe_selection'
  | 'outcome_informed_exclusion'
  | 'cost_model_version_leak'
  | 'feature_version_mismatch'
  | 'champion_challenger_version_mismatch'
  | 'statistical_audit_failure'
  | 'other';

export interface LeakageFindings {
  passed: boolean;
  findings: Array<{ kind: LeakageCheckKind; details: string; severity: 'warning' | 'high' | 'blocking' }>;
}

export function runLeakageChecks(fold: WalkForwardFold, input: {
  observations: Array<{ productId: string; timestamp: Date; dataAvailableAt: Date }>;
  trainingProducts: readonly string[];
  validationProducts: readonly string[];
  finalHoldoutProducts: readonly string[];
  featureVersionsInTraining: readonly string[];
  featureVersionsInValidation: readonly string[];
  championVersionExpected: string;
  championVersionObserved: string;
  challengerVersionExpected: string;
  challengerVersionObserved: string;
  costModelVersionExpected: string;
  costModelVersionObserved: string;
  labelHorizonMs: number;
}): LeakageFindings {
  const findings: LeakageFindings['findings'] = [];
  // 1. Future observation: any observation timestamp after fold validationEnd is a leak.
  for (const o of input.observations) {
    if (o.timestamp.getTime() > fold.validationEnd.getTime()) {
      findings.push({ kind: 'future_observation', details: `${o.productId} ts=${o.timestamp.toISOString()}`, severity: 'blocking' });
      break;
    }
    if (o.dataAvailableAt.getTime() > fold.validationEnd.getTime()) {
      findings.push({ kind: 'revised_data_leak', details: `${o.productId} dataAvailableAt=${o.dataAvailableAt.toISOString()}`, severity: 'blocking' });
      break;
    }
  }
  // 2. Training/validation overlap by product+timestamp:
  const trainSet = new Set(input.trainingProducts);
  const validSet = new Set(input.validationProducts);
  for (const p of validSet) if (trainSet.has(p) && fold.validationStart.getTime() < fold.trainingEnd.getTime()) {
    findings.push({ kind: 'train_test_overlap', details: `${p}`, severity: 'blocking' });
    break;
  }
  // 3. Embargo violation: validationStart must be >= embargoEnd.
  if (fold.validationStart.getTime() < fold.embargoEnd.getTime()) {
    findings.push({ kind: 'embargo_violation', details: `validationStart<embargoEnd`, severity: 'blocking' });
  }
  // 4. Overlapping label horizon: purge must cover labelHorizon.
  const purgeMs = fold.purgeEnd.getTime() - fold.purgeStart.getTime();
  if (purgeMs < input.labelHorizonMs) {
    findings.push({ kind: 'overlapping_label_horizon', details: `purge<labelHorizon`, severity: 'blocking' });
  }
  // 5. Holdout contamination: any training product overlapping the final holdout set.
  const holdoutSet = new Set(input.finalHoldoutProducts);
  for (const p of trainSet) if (holdoutSet.has(p) && !fold.holdout) {
    findings.push({ kind: 'final_holdout_contamination', details: `${p}`, severity: 'blocking' });
    break;
  }
  // 6. Feature version mismatch.
  const tset = new Set(input.featureVersionsInTraining);
  for (const v of input.featureVersionsInValidation) if (!tset.has(v)) {
    findings.push({ kind: 'feature_version_mismatch', details: `${v}`, severity: 'high' });
    break;
  }
  // 7. Champion/challenger version mismatch.
  if (input.championVersionExpected !== input.championVersionObserved) {
    findings.push({ kind: 'champion_challenger_version_mismatch', details: 'champion drift', severity: 'blocking' });
  }
  if (input.challengerVersionExpected !== input.challengerVersionObserved) {
    findings.push({ kind: 'champion_challenger_version_mismatch', details: 'challenger drift', severity: 'blocking' });
  }
  // 8. Cost model leak.
  if (input.costModelVersionExpected !== input.costModelVersionObserved) {
    findings.push({ kind: 'cost_model_version_leak', details: 'cost model drift', severity: 'blocking' });
  }
  const anyBlocking = findings.some((f) => f.severity === 'blocking');
  return { passed: !anyBlocking, findings };
}

export async function recordValidationIncident(input: {
  experimentId?: number | null;
  experimentRunId?: number | null;
  foldId?: number | null;
  cpcvPathId?: number | null;
  datasetVersionId?: number | null;
  incidentType: LeakageCheckKind;
  severity: 'warning' | 'high' | 'blocking';
  reasonCode: string;
  details?: string;
  detectedAt: Date;
  dataAvailableAt: Date;
}): Promise<ValidationIncidentRow> {
  const [{ insertId }] = (await db.insert(validationIncidents).values({
    experimentId: input.experimentId ?? null,
    experimentRunId: input.experimentRunId ?? null,
    foldId: input.foldId ?? null,
    cpcvPathId: input.cpcvPathId ?? null,
    datasetVersionId: input.datasetVersionId ?? null,
    incidentType: input.incidentType,
    severity: input.severity,
    reasonCode: input.reasonCode,
    details: input.details ?? null,
    detectedAt: input.detectedAt,
    dataAvailableAt: input.dataAvailableAt,
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(validationIncidents).where(eq(validationIncidents.id, insertId)).limit(1);
  return row;
}
