import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  statisticalAuditResults,
  statisticalAudits,
  statisticalReferenceVectors,
  type StatisticalAuditResultRow,
  type StatisticalAuditRow,
  type StatisticalReferenceVectorRow,
} from '../../db/schema';

/**
 * Phase 2F §I — Statistical implementation audit.
 *
 * Every quantitative diagnostic Horizon uses gets an explicit audit
 * record with an honest label. `audited_approximation`, `research_heuristic`
 * and `known_deviation` labels remain visible even after passing a
 * reference-vector check.
 */

export type StatisticalAuditStatus =
  | 'canonical'
  | 'audited_approximation'
  | 'research_heuristic'
  | 'known_deviation'
  | 'failed_audit'
  | 'deferred';

export interface StatisticalAuditInput {
  implementationKey: string;
  implementationVersion: string;
  referenceDefinition: string;
  implementationStatus: StatisticalAuditStatus;
  knownDeviation?: string;
  minimumSamples?: number;
  numericalLimitations?: string;
  failurePolicy: string;
  referenceSourceIdentity: string;
  auditVersion: string;
  auditedAt: Date;
}

function auditHash(input: StatisticalAuditInput): string {
  return createHash('sha256').update(JSON.stringify({
    k: input.implementationKey, v: input.implementationVersion,
    ref: input.referenceDefinition, s: input.implementationStatus,
    fp: input.failurePolicy, src: input.referenceSourceIdentity,
    av: input.auditVersion,
  })).digest('hex');
}

export async function registerStatisticalAudit(input: StatisticalAuditInput): Promise<StatisticalAuditRow> {
  const hash = auditHash(input);
  const existing = await db
    .select()
    .from(statisticalAudits)
    .where(and(eq(statisticalAudits.implementationKey, input.implementationKey), eq(statisticalAudits.implementationVersion, input.implementationVersion)))
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].inputHash !== hash) {
      throw new Error(`statistical audit ${input.implementationKey}@${input.implementationVersion} drift — bump auditVersion or implementationVersion`);
    }
    return existing[0];
  }
  await db.insert(statisticalAudits).values({
    implementationKey: input.implementationKey,
    implementationVersion: input.implementationVersion,
    referenceDefinition: input.referenceDefinition,
    implementationStatus: input.implementationStatus,
    knownDeviation: input.knownDeviation ?? null,
    minimumSamples: input.minimumSamples ?? null,
    numericalLimitations: input.numericalLimitations ?? null,
    failurePolicy: input.failurePolicy,
    referenceSourceIdentity: input.referenceSourceIdentity,
    auditVersion: input.auditVersion,
    auditedAt: input.auditedAt,
    inputHash: hash,
  });
  const [row] = await db
    .select()
    .from(statisticalAudits)
    .where(and(eq(statisticalAudits.implementationKey, input.implementationKey), eq(statisticalAudits.implementationVersion, input.implementationVersion)))
    .limit(1);
  return row;
}

export async function addStatisticalReferenceVector(input: {
  statisticalAuditId: number;
  vectorKey: string;
  inputVector: unknown;
  expectedOutput: unknown;
  tolerance?: number;
}): Promise<StatisticalReferenceVectorRow> {
  const existing = await db
    .select()
    .from(statisticalReferenceVectors)
    .where(and(eq(statisticalReferenceVectors.statisticalAuditId, input.statisticalAuditId), eq(statisticalReferenceVectors.vectorKey, input.vectorKey)))
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(statisticalReferenceVectors).values({
    statisticalAuditId: input.statisticalAuditId,
    vectorKey: input.vectorKey,
    inputVector: JSON.stringify(input.inputVector),
    expectedOutput: JSON.stringify(input.expectedOutput),
    tolerance: input.tolerance != null ? input.tolerance.toFixed(10) : null,
  });
  const [row] = await db
    .select()
    .from(statisticalReferenceVectors)
    .where(and(eq(statisticalReferenceVectors.statisticalAuditId, input.statisticalAuditId), eq(statisticalReferenceVectors.vectorKey, input.vectorKey)))
    .limit(1);
  return row;
}

export async function recordAuditResult(input: {
  statisticalAuditId: number;
  referenceVectorId?: number | null;
  observedOutput: unknown;
  deviation?: number;
  passed: boolean;
  notes?: string;
}): Promise<StatisticalAuditResultRow> {
  const [{ insertId }] = (await db.insert(statisticalAuditResults).values({
    statisticalAuditId: input.statisticalAuditId,
    referenceVectorId: input.referenceVectorId ?? null,
    observedOutput: JSON.stringify(input.observedOutput),
    deviation: input.deviation != null ? input.deviation.toFixed(10) : null,
    passed: input.passed,
    notes: input.notes ?? null,
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(statisticalAuditResults).where(eq(statisticalAuditResults.id, insertId)).limit(1);
  return row;
}

/**
 * The reference catalog Horizon audits. Each implementation must have
 * a matching audit registered before it can be used to gate promotion.
 */
export const STATISTICAL_AUDIT_CATALOG: readonly StatisticalAuditInput[] = [
  { implementationKey: 'hurst.rescaled_range', implementationVersion: 'p2a-1',
    referenceDefinition: 'R/S rescaled-range estimator', implementationStatus: 'audited_approximation',
    knownDeviation: 'small-sample bias documented', minimumSamples: 200,
    numericalLimitations: 'suffers on trend series', failurePolicy: 'fail_closed_below_minimum',
    referenceSourceIdentity: 'Mandelbrot 1972', auditVersion: 'p2f-audit-1', auditedAt: new Date(0) },
  { implementationKey: 'variance_ratio.mr', implementationVersion: 'p2a-1',
    referenceDefinition: 'Lo-MacKinlay variance ratio', implementationStatus: 'audited_approximation',
    failurePolicy: 'fail_closed_below_minimum', referenceSourceIdentity: 'Lo & MacKinlay 1988',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 100 },
  { implementationKey: 'adf_lite', implementationVersion: 'p2a-1',
    referenceDefinition: 'Simplified augmented Dickey-Fuller variant',
    implementationStatus: 'research_heuristic',
    knownDeviation: 'lite variant does not match canonical critical values',
    failurePolicy: 'never_used_to_gate_promotion', referenceSourceIdentity: 'internal-p2a',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 200 },
  { implementationKey: 'kpss_lite', implementationVersion: 'p2a-1',
    referenceDefinition: 'Simplified KPSS variant', implementationStatus: 'research_heuristic',
    knownDeviation: 'lite variant does not match canonical critical values',
    failurePolicy: 'never_used_to_gate_promotion', referenceSourceIdentity: 'internal-p2a',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 200 },
  { implementationKey: 'ou_fit', implementationVersion: 'p2a-1',
    referenceDefinition: 'OU AR(1) fit', implementationStatus: 'audited_approximation',
    failurePolicy: 'fail_closed_below_minimum', referenceSourceIdentity: 'Uhlenbeck & Ornstein 1930',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 100 },
  { implementationKey: 'ou_half_life', implementationVersion: 'p2a-1',
    referenceDefinition: 'log(0.5)/log(rho)', implementationStatus: 'canonical',
    failurePolicy: 'fail_closed_below_minimum', referenceSourceIdentity: 'internal-p2a',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 50 },
  { implementationKey: 'cusum', implementationVersion: 'p2b-1',
    referenceDefinition: 'Page 1954 cumulative sum', implementationStatus: 'canonical',
    failurePolicy: 'fail_closed_below_minimum', referenceSourceIdentity: 'Page 1954',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 100 },
  { implementationKey: 'segmented_variance_detector', implementationVersion: 'p2b-1',
    referenceDefinition: 'Segmented-variance change-point detector',
    implementationStatus: 'audited_approximation',
    failurePolicy: 'fail_closed_below_minimum', referenceSourceIdentity: 'internal-p2b',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 100 },
  { implementationKey: 'hmm_two_state', implementationVersion: 'p2b-1',
    referenceDefinition: 'Two-state Gaussian HMM Baum-Welch EM',
    implementationStatus: 'audited_approximation',
    failurePolicy: 'fail_closed_below_minimum', referenceSourceIdentity: 'Baum-Welch 1972',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 200 },
  { implementationKey: 'correlation_pearson', implementationVersion: 'p2c-1',
    referenceDefinition: 'Sample Pearson correlation', implementationStatus: 'canonical',
    failurePolicy: 'fail_closed_below_minimum', referenceSourceIdentity: 'internal-p2c',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 30 },
  { implementationKey: 'correlation_shrinkage_diagonal', implementationVersion: 'p2c-1',
    referenceDefinition: 'Diagonal shrinkage covariance', implementationStatus: 'audited_approximation',
    failurePolicy: 'fail_closed_below_minimum', referenceSourceIdentity: 'Ledoit-Wolf 2004 (fixed lambda)',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 60 },
  { implementationKey: 'var_historical', implementationVersion: 'p2c-1',
    referenceDefinition: 'Historical VaR percentile', implementationStatus: 'canonical',
    failurePolicy: 'fail_closed_below_minimum', referenceSourceIdentity: 'internal-p2c',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 100 },
  { implementationKey: 'es_historical', implementationVersion: 'p2c-1',
    referenceDefinition: 'Historical Expected Shortfall', implementationStatus: 'canonical',
    failurePolicy: 'fail_closed_below_minimum', referenceSourceIdentity: 'internal-p2c',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 100 },
  { implementationKey: 'cluster_hierarchical', implementationVersion: 'p2c-1',
    referenceDefinition: 'Hierarchical clustering', implementationStatus: 'audited_approximation',
    failurePolicy: 'fail_closed_below_minimum', referenceSourceIdentity: 'internal-p2c',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 10 },
  { implementationKey: 'impact_curve', implementationVersion: 'p2d-1',
    referenceDefinition: 'Book-walking impact curve', implementationStatus: 'audited_approximation',
    failurePolicy: 'fail_closed_below_minimum', referenceSourceIdentity: 'internal-p2d',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 1 },
  { implementationKey: 'passive_fill_model', implementationVersion: 'p2d-1',
    referenceDefinition: 'Passive fill state model (queue invisibility)',
    implementationStatus: 'research_heuristic',
    knownDeviation: 'queue position not observable', failurePolicy: 'never_used_to_gate_promotion',
    referenceSourceIdentity: 'internal-p2d', auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 1 },
  { implementationKey: 'coinbase_premium', implementationVersion: 'p2e-1',
    referenceDefinition: '(coinbasePrice - referencePrice) / referencePrice with timestamp alignment',
    implementationStatus: 'canonical',
    failurePolicy: 'fail_closed_below_minimum', referenceSourceIdentity: 'internal-p2e',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 2 },
  { implementationKey: 'funding_level', implementationVersion: 'p2e-1',
    referenceDefinition: 'Provider-reported funding rate', implementationStatus: 'canonical',
    failurePolicy: 'fail_closed_below_minimum', referenceSourceIdentity: 'internal-p2e',
    auditVersion: 'p2f-audit-1', auditedAt: new Date(0), minimumSamples: 1 },
];

export async function registerCatalogAudits(auditedAt: Date): Promise<StatisticalAuditRow[]> {
  const rows: StatisticalAuditRow[] = [];
  for (const item of STATISTICAL_AUDIT_CATALOG) {
    rows.push(await registerStatisticalAudit({ ...item, auditedAt }));
  }
  return rows;
}

export function isAuditStatusPromotionEligible(status: StatisticalAuditStatus): boolean {
  return status === 'canonical' || status === 'audited_approximation';
}
