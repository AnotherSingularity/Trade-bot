import { eq } from 'drizzle-orm';
import { db } from '../db';
import {
  soakIncidents,
  type SoakIncidentRow,
} from '../db/schema';

/**
 * Phase 1.2-OPS §F — incident policy.
 *
 * Every notable event during a soak becomes a `soak_incidents` row.
 * `soak_invalidating` classifications force the final verdict to
 * `soak_failed` regardless of other counters.
 */

export const INCIDENT_MODULE_VERSION = 'p1_2-ops-incidents-1';

export type IncidentKind = SoakIncidentRow['incidentKind'];
export type IncidentClassification = SoakIncidentRow['classification'];

const SOAK_INVALIDATING_KINDS: ReadonlySet<IncidentKind> = new Set<IncidentKind>([
  'create_order_barrier_event',
  'safe_flag_change',
  'mock_provider_active',
  'undocumented_deployment',
  'accounting_discrepancy',
  'lineage_discrepancy',
]);

const SYSTEM_DEGRADED_KINDS: ReadonlySet<IncidentKind> = new Set<IncidentKind>([
  'reconnect_storm',
  'credential_failure',
  'database_restart',
  'redis_restart',
]);

const PRODUCT_DEGRADED_KINDS: ReadonlySet<IncidentKind> = new Set<IncidentKind>([
  'websocket_outage',
  'heartbeat_loss',
  'candle_gap',
  'rest_bootstrap_failure',
  'preview_outage',
  'fee_tier_outage',
  'stale_data_rejection',
  'protection_degradation',
]);

/** Deterministic classifier — kind → severity. */
export function classifyIncident(kind: IncidentKind): IncidentClassification {
  if (SOAK_INVALIDATING_KINDS.has(kind)) return 'soak_invalidating';
  if (SYSTEM_DEGRADED_KINDS.has(kind)) return 'system_degraded';
  if (PRODUCT_DEGRADED_KINDS.has(kind)) return 'product_degraded';
  return 'informational';
}

export interface RecordIncidentInput {
  soakRunId?: string | null;
  incidentKind: IncidentKind;
  detectedAt: Date;
  productId?: string | null;
  detail?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Override the classifier when the caller has extra context. */
  overrideClassification?: IncidentClassification;
}

export async function recordIncident(
  input: RecordIncidentInput,
): Promise<SoakIncidentRow> {
  const classification =
    input.overrideClassification ?? classifyIncident(input.incidentKind);
  const [{ insertId }] = (await db.insert(soakIncidents).values({
    soakRunId: input.soakRunId ?? null,
    incidentKind: input.incidentKind,
    classification,
    detectedAt: input.detectedAt,
    productId: input.productId ?? null,
    detail: input.detail ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(soakIncidents)
    .where(eq(soakIncidents.id, insertId))
    .limit(1);
  return row!;
}

export async function resolveIncident(id: number, now: Date = new Date()): Promise<void> {
  await db.update(soakIncidents).set({ resolvedAt: now }).where(eq(soakIncidents.id, id));
}

export async function countInvalidatingIncidents(soakRunId: string): Promise<number> {
  const rows = await db
    .select()
    .from(soakIncidents)
    .where(eq(soakIncidents.soakRunId, soakRunId));
  return rows.filter((r) => r.classification === 'soak_invalidating').length;
}

export async function incidentsForRun(soakRunId: string): Promise<SoakIncidentRow[]> {
  return db
    .select()
    .from(soakIncidents)
    .where(eq(soakIncidents.soakRunId, soakRunId));
}
