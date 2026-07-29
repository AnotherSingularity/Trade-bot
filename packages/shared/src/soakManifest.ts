/**
 * Stage 5G §9 — soak-manifest contract + incident policy.
 *
 * Every operational soak (managed-runtime soak, live-data shadow
 * soak, Coinbase read-only preflight soak) writes ONE append-only
 * manifest of this exact shape. Consumers verify the shape via
 * `SoakManifestSchema.parse(...)` and never accept anything else.
 *
 * The manifest is UTC-only (server clocks are trusted for wall
 * time; synthetic-time acceleration is forbidden). Duplicate,
 * missing, or out-of-order UTC dates each produce a distinct
 * validation error. Append-only: nothing removes past days or
 * past incidents; correction is by appending a subsequent day
 * (and, if the incident is invalidating, resetting `finalVerdict`
 * to `invalidated`).
 *
 * Every INVALIDATING incident (the `MANDATORY_SOAK_INVALIDATORS`
 * set) MUST flip `finalVerdict` to `invalidated`. Downstream
 * gates (release audit, live-canary authorization) MUST refuse
 * to accept a manifest whose invalidator list is non-empty and
 * verdict is not `invalidated`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Simulation mode — soak requires STANDARD_DRY_RUN.
// ---------------------------------------------------------------------------

export const SoakSimulationModeSchema = z.literal('STANDARD_DRY_RUN');
export type SoakSimulationMode = z.infer<typeof SoakSimulationModeSchema>;

// ---------------------------------------------------------------------------
// Runtime mode — the packaged + owned-services mode the soak was
// executed under. Ties the manifest to the runtime-mode policy.
// ---------------------------------------------------------------------------

export const SoakRuntimeModeSchema = z.enum([
  'external_test_server',
  'managed_docker',
  'packaged_managed_docker',
]);
export type SoakRuntimeMode = z.infer<typeof SoakRuntimeModeSchema>;

// ---------------------------------------------------------------------------
// Typed incident classifications (repeats the directive §9 list verbatim).
// ---------------------------------------------------------------------------

export const SOAK_INCIDENT_TYPES = [
  'runtime_unavailable',
  'database_unavailable',
  'redis_unavailable',
  'migration_mismatch',
  'fingerprint_mismatch',
  'server_restart',
  'container_restart',
  'report_generation_failed',
  'artifact_verification_failed',
  'redaction_failed',
  'secret_scan_failed',
  'path_security_failed',
  'temporary_cleanup_failed',
  'orphan_reconciliation_failed',
  'process_leak',
  'container_leak',
  'safety_flag_violation',
  'create_order_counter_nonzero',
  'production_provider_detected',
  'production_credential_detected',
  'commit_changed',
  'report_spec_changed',
  'migration_chain_changed',
] as const;
export type SoakIncidentType = (typeof SOAK_INCIDENT_TYPES)[number];
export const SoakIncidentTypeSchema = z.enum(SOAK_INCIDENT_TYPES);

/**
 * Incidents that MUST invalidate the soak. Any incident of one of
 * these types is fatal: the soak's `finalVerdict` MUST be
 * `invalidated`, and the release audit MUST refuse to close.
 */
export const MANDATORY_SOAK_INVALIDATORS: ReadonlySet<SoakIncidentType> = new Set<SoakIncidentType>([
  'migration_mismatch',
  'fingerprint_mismatch',
  'secret_scan_failed',
  'path_security_failed',
  'process_leak',
  'container_leak',
  'safety_flag_violation',
  'create_order_counter_nonzero',
  'production_provider_detected',
  'production_credential_detected',
  'commit_changed',
  'report_spec_changed',
  'migration_chain_changed',
]);

export function isMandatorySoakInvalidator(type: SoakIncidentType): boolean {
  return MANDATORY_SOAK_INVALIDATORS.has(type);
}

// ---------------------------------------------------------------------------
// Primitive schemas.
// ---------------------------------------------------------------------------

const NonNegInt = z.number().int().nonnegative();

const UtcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/, 'iso8601_utc_required');

const UtcDateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'utc_date_required');

const IncidentSeveritySchema = z.enum(['info', 'warn', 'error', 'critical']);

// ---------------------------------------------------------------------------
// Incident.
// ---------------------------------------------------------------------------

export const SoakIncidentSchema = z.object({
  eventId: z.string().min(1).max(128),
  soakId: z.string().min(1).max(128),
  timestampUtc: UtcTimestampSchema,
  commitSha: z.string().length(40),
  installationIdHash: z.string().min(1).max(128),
  eventType: SoakIncidentTypeSchema,
  severity: IncidentSeveritySchema,
  details: z.string().max(2000),
  invalidatesSoak: z.boolean(),
}).strict();
export type SoakIncident = z.infer<typeof SoakIncidentSchema>;

// ---------------------------------------------------------------------------
// Safety-flag / counter / provider / credential state (per day).
// ---------------------------------------------------------------------------

export const SoakSafetyFlagsSchema = z.object({
  DRY_RUN: z.literal(true),
  ORDER_SUBMISSION_ENABLED: z.literal(false),
  liveCapitalAuthorized: z.literal(false),
  promotionEnabled: z.literal(false),
  kellyEnabled: z.literal(false),
}).strict();
export type SoakSafetyFlags = z.infer<typeof SoakSafetyFlagsSchema>;

export const SoakCreateOrderCountersSchema = z.object({
  functionInvocations: z.literal(0),
  attemptCount: z.literal(0),
  networkCount: z.literal(0),
}).strict();
export type SoakCreateOrderCounters = z.infer<typeof SoakCreateOrderCountersSchema>;

export const SoakProviderStateSchema = z.object({
  marketDataProvider: z.string().min(1).max(64),
  exchangeProvider: z.string().min(1).max(64),
  productionLevel2Active: z.boolean(),
  orderCapableProviderActive: z.boolean(),
}).strict();
export type SoakProviderState = z.infer<typeof SoakProviderStateSchema>;

export const SoakCredentialStateSchema = z.object({
  coinbaseCredentialsLoaded: z.boolean(),
  anthropicCredentialsLoaded: z.boolean(),
  productionCredentialsDetected: z.boolean(),
}).strict();
export type SoakCredentialState = z.infer<typeof SoakCredentialStateSchema>;

// ---------------------------------------------------------------------------
// Daily result.
// ---------------------------------------------------------------------------

export const SoakDailyResultSchema = z.object({
  dateUtc: UtcDateOnlySchema,
  firstObservationAt: UtcTimestampSchema,
  lastObservationAt: UtcTimestampSchema,
  uptimeSeconds: NonNegInt,
  runtimeStarts: NonNegInt,
  runtimeStops: NonNegInt,
  serverRestarts: NonNegInt,
  containerRestarts: NonNegInt,
  databaseDisconnects: NonNegInt,
  databaseReconnects: NonNegInt,
  redisDisconnects: NonNegInt,
  redisReconnects: NonNegInt,
  reportJobsQueued: NonNegInt,
  reportJobsCompleted: NonNegInt,
  reportJobsFailed: NonNegInt,
  idempotencyHits: NonNegInt,
  duplicatePreventions: NonNegInt,
  artifactVerificationPasses: NonNegInt,
  artifactVerificationFailures: NonNegInt,
  redactionsApplied: NonNegInt,
  redactionFailures: NonNegInt,
  secretScanFailures: NonNegInt,
  pathRejections: NonNegInt,
  temporaryCleanupFailures: NonNegInt,
  orphanReconciliations: NonNegInt,
  processLeaks: NonNegInt,
  containerLeaks: NonNegInt,
  createOrderCounters: SoakCreateOrderCountersSchema,
  safetyFlags: SoakSafetyFlagsSchema,
  providerState: SoakProviderStateSchema,
  credentialState: SoakCredentialStateSchema,
  dayVerdict: z.enum(['passed', 'invalidated']),
}).strict();
export type SoakDailyResult = z.infer<typeof SoakDailyResultSchema>;

// ---------------------------------------------------------------------------
// Manifest.
// ---------------------------------------------------------------------------

export const SoakFinalVerdictSchema = z.enum([
  'in_progress',
  'passed',
  'invalidated',
  'incomplete',
]);
export type SoakFinalVerdict = z.infer<typeof SoakFinalVerdictSchema>;

export const SoakManifestSchema = z.object({
  soakId: z.string().min(1).max(128),
  commitSha: z.string().length(40),
  startedAt: UtcTimestampSchema,
  expectedEndAt: UtcTimestampSchema,
  actualEndAt: UtcTimestampSchema.nullable(),
  simulationMode: SoakSimulationModeSchema,
  migrationHead: z.string().min(1).max(64),
  migrationChainDigest: z.string().length(64),
  reportSpecVersions: z.record(z.string(), z.string().min(1).max(64)),
  runtimeMode: SoakRuntimeModeSchema,
  installationIdHash: z.string().min(1).max(128),
  dayResults: z.array(SoakDailyResultSchema),
  incidents: z.array(SoakIncidentSchema),
  safetyViolations: NonNegInt,
  codeChangesDetected: z.boolean(),
  finalVerdict: SoakFinalVerdictSchema,
}).strict();
export type SoakManifest = z.infer<typeof SoakManifestSchema>;

// ---------------------------------------------------------------------------
// Validation — beyond schema shape, enforce append-only + UTC-continuity
// + invalidator consistency rules the directive requires.
// ---------------------------------------------------------------------------

export type SoakValidationErrorCode =
  | 'schema_invalid'
  | 'day_count_wrong'
  | 'utc_date_out_of_order'
  | 'utc_date_duplicate'
  | 'utc_date_missing'
  | 'invalidator_present_but_verdict_not_invalidated'
  | 'no_invalidator_but_verdict_invalidated'
  | 'code_change_not_reflected_in_verdict'
  | 'incident_count_and_verdict_inconsistent';

export interface SoakValidationOk {
  readonly ok: true;
  readonly manifest: SoakManifest;
  readonly invalidatingIncidents: readonly SoakIncident[];
}
export interface SoakValidationErr {
  readonly ok: false;
  readonly code: SoakValidationErrorCode;
  readonly detail: string;
}
export type SoakValidationResult = SoakValidationOk | SoakValidationErr;

/** Required minimum number of consecutive UTC days for a valid soak. */
export const DEFAULT_SOAK_DAY_COUNT = 7 as const;

export function validateSoakManifest(
  raw: unknown,
  opts: { minDayCount?: number; requireDayCountExact?: boolean } = {},
): SoakValidationResult {
  const parsed = SoakManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: 'schema_invalid', detail: parsed.error.issues.map((i) => i.path.join('.') + ':' + i.message).join('; ').slice(0, 500) };
  }
  const m = parsed.data;
  const minDays = opts.minDayCount ?? DEFAULT_SOAK_DAY_COUNT;

  // UTC-continuity checks.
  if (opts.requireDayCountExact === true && m.dayResults.length !== minDays) {
    return { ok: false, code: 'day_count_wrong', detail: `expected ${minDays} days, saw ${m.dayResults.length}` };
  }
  if (m.finalVerdict === 'passed' && m.dayResults.length < minDays) {
    return { ok: false, code: 'day_count_wrong', detail: `passed verdict requires >= ${minDays} days, saw ${m.dayResults.length}` };
  }
  const dates = m.dayResults.map((d) => d.dateUtc);
  const seen = new Set<string>();
  for (const d of dates) {
    if (seen.has(d)) return { ok: false, code: 'utc_date_duplicate', detail: `${d} appears twice` };
    seen.add(d);
  }
  const sorted = [...dates].sort();
  if (sorted.join(',') !== dates.join(',')) {
    return { ok: false, code: 'utc_date_out_of_order', detail: `dates not in ascending order: ${dates.join(',')}` };
  }
  // Missing-day check (only when we have >= 2 dates).
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + 'T00:00:00Z').getTime();
    const cur = new Date(sorted[i] + 'T00:00:00Z').getTime();
    const gap = (cur - prev) / 86_400_000;
    if (gap !== 1) return { ok: false, code: 'utc_date_missing', detail: `gap between ${sorted[i - 1]} and ${sorted[i]} is ${gap} day(s)` };
  }

  // Invalidator ↔ verdict consistency.
  const invalidators = m.incidents.filter((inc) => inc.invalidatesSoak || MANDATORY_SOAK_INVALIDATORS.has(inc.eventType));
  if (invalidators.length > 0 && m.finalVerdict !== 'invalidated' && m.finalVerdict !== 'in_progress') {
    return {
      ok: false,
      code: 'invalidator_present_but_verdict_not_invalidated',
      detail: `${invalidators.length} invalidating incidents but verdict=${m.finalVerdict}`,
    };
  }
  if (invalidators.length === 0 && m.finalVerdict === 'invalidated') {
    return {
      ok: false,
      code: 'no_invalidator_but_verdict_invalidated',
      detail: 'verdict=invalidated but no invalidating incident recorded',
    };
  }
  if (m.codeChangesDetected && m.finalVerdict === 'passed') {
    return {
      ok: false,
      code: 'code_change_not_reflected_in_verdict',
      detail: 'codeChangesDetected=true but finalVerdict=passed',
    };
  }
  // Cross-check per-day dayVerdict with global invalidators.
  const invalidatedDays = m.dayResults.filter((d) => d.dayVerdict === 'invalidated').length;
  if (invalidatedDays > 0 && m.finalVerdict === 'passed') {
    return {
      ok: false,
      code: 'incident_count_and_verdict_inconsistent',
      detail: `${invalidatedDays} invalidated days but finalVerdict=passed`,
    };
  }

  return { ok: true, manifest: m, invalidatingIncidents: invalidators };
}
