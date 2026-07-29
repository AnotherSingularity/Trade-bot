/**
 * Stage 5F §8 — operational validation harness.
 *
 * Pure event-collector for the seven-day operational soak. The
 * harness restricts every run to SIMULATION_MODE=STANDARD_DRY_RUN +
 * DRY_RUN=true + ORDER_SUBMISSION_ENABLED=false; the schema-level
 * enforcement lives on `SoakManifestSchema` in @horizon/shared so a
 * downstream consumer can validate any manifest a preflight
 * workflow produces without importing this file.
 *
 * This module owns:
 *
 *   1. Typed `OperationalEvent` shape — the 31 event kinds the
 *      directive names.
 *   2. `OperationalValidationHarness` — an in-process event sink
 *      with append-only counters + rollup to a `SoakDailyResult`.
 *   3. `buildDailyResult()` — pure aggregation, deterministic.
 *
 * Nothing here calls an economic writer or touches trading state.
 * The harness observes DRY_RUN telemetry; it never emits it.
 */

import { createHash } from 'node:crypto';
import {
  MANDATORY_SOAK_INVALIDATORS,
  SOAK_INCIDENT_TYPES,
  type SoakCreateOrderCounters,
  type SoakCredentialState,
  type SoakDailyResult,
  type SoakIncident,
  type SoakIncidentType,
  type SoakProviderState,
  type SoakSafetyFlags,
} from '@horizon/shared';

// ---------------------------------------------------------------------------
// Event kinds
// ---------------------------------------------------------------------------

export const OPERATIONAL_EVENT_KINDS = [
  'runtime_start',
  'runtime_ready',
  'runtime_stop',
  'server_restart',
  'container_restart',
  'mariadb_disconnect',
  'mariadb_reconnect',
  'redis_disconnect',
  'redis_reconnect',
  'readiness_transition',
  'report_job_queued',
  'report_job_running',
  'report_job_completed',
  'report_job_failed',
  'idempotency_hit',
  'duplicate_prevented',
  'artifact_verification_passed',
  'artifact_verification_failed',
  'redaction_performed',
  'redaction_failure',
  'secret_scan_failure',
  'path_rejected',
  'temporary_file_cleanup_failure',
  'orphan_reconciliation',
  'process_leak',
  'container_leak',
  'safety_observation',
  'create_order_counter_observation',
  'provider_observation',
  'credential_observation',
] as const;
export type OperationalEventKind = (typeof OPERATIONAL_EVENT_KINDS)[number];

export interface OperationalEvent {
  readonly eventId: string;
  readonly soakId: string;
  readonly timestampUtc: string; // ISO-8601 UTC
  readonly commitSha: string;    // 40-hex
  readonly installationIdHash: string;
  readonly eventKind: OperationalEventKind;
  readonly severity: 'info' | 'warn' | 'error' | 'critical';
  readonly details: string; // <=2000 chars, sanitized
  readonly invalidatesSoak: boolean;
  readonly meta?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// EventKind → SoakIncidentType mapping (for events that become
// incidents on the manifest; not every observation is an incident).
// ---------------------------------------------------------------------------

const EVENT_TO_INCIDENT_TYPE: Readonly<Partial<Record<OperationalEventKind, SoakIncidentType>>> = Object.freeze({
  runtime_stop: 'runtime_unavailable',
  mariadb_disconnect: 'database_unavailable',
  redis_disconnect: 'redis_unavailable',
  server_restart: 'server_restart',
  container_restart: 'container_restart',
  report_job_failed: 'report_generation_failed',
  artifact_verification_failed: 'artifact_verification_failed',
  redaction_failure: 'redaction_failed',
  secret_scan_failure: 'secret_scan_failed',
  path_rejected: 'path_security_failed',
  temporary_file_cleanup_failure: 'temporary_cleanup_failed',
  orphan_reconciliation: 'orphan_reconciliation_failed',
  process_leak: 'process_leak',
  container_leak: 'container_leak',
});

/** Hard-fail invalidators — subset that MUST flip the day + soak. */
export const HARD_FAIL_EVENT_KINDS: ReadonlySet<OperationalEventKind> = new Set<OperationalEventKind>([
  'secret_scan_failure',
  'path_rejected',
  'process_leak',
  'container_leak',
]);

// ---------------------------------------------------------------------------
// Harness — an in-process append-only sink.
// ---------------------------------------------------------------------------

export interface HarnessInput {
  readonly soakId: string;
  readonly commitSha: string;
  readonly installationIdHash: string;
  readonly clock: () => Date; // injected for determinism
}

export interface DailyRollupInput {
  readonly dateUtc: string; // YYYY-MM-DD
  readonly safetyFlags: SoakSafetyFlags;
  readonly createOrderCounters: SoakCreateOrderCounters;
  readonly providerState: SoakProviderState;
  readonly credentialState: SoakCredentialState;
}

export class OperationalValidationHarness {
  readonly #cfg: HarnessInput;
  readonly #events: OperationalEvent[] = [];

  constructor(cfg: HarnessInput) {
    this.#cfg = cfg;
  }

  observe(kind: OperationalEventKind, details: string, opts: { severity?: OperationalEvent['severity']; meta?: Readonly<Record<string, unknown>> } = {}): OperationalEvent {
    const now = this.#cfg.clock();
    const severity = opts.severity ?? severityForKind(kind);
    // eventId: content-addressed over (soakId, kind, timestamp,
    // details, index) so a resume in a fresh process still produces
    // stable ids.
    const eventIdInput = `${this.#cfg.soakId}|${kind}|${now.toISOString()}|${details}|${this.#events.length}`;
    const eventId = createHash('sha256').update(eventIdInput).digest('hex').slice(0, 32);
    const invalidatesSoak = HARD_FAIL_EVENT_KINDS.has(kind);
    const event: OperationalEvent = {
      eventId,
      soakId: this.#cfg.soakId,
      timestampUtc: now.toISOString(),
      commitSha: this.#cfg.commitSha,
      installationIdHash: this.#cfg.installationIdHash,
      eventKind: kind,
      severity,
      details: sanitizeDetail(details),
      invalidatesSoak,
      meta: opts.meta,
    };
    this.#events.push(event);
    return event;
  }

  events(): readonly OperationalEvent[] {
    return this.#events;
  }

  clear(): void {
    this.#events.length = 0;
  }

  incidents(): readonly SoakIncident[] {
    const out: SoakIncident[] = [];
    for (const e of this.#events) {
      const incidentType = EVENT_TO_INCIDENT_TYPE[e.eventKind];
      if (!incidentType) continue;
      const isMandatory = MANDATORY_SOAK_INVALIDATORS.has(incidentType);
      out.push({
        eventId: e.eventId,
        soakId: e.soakId,
        timestampUtc: e.timestampUtc,
        commitSha: e.commitSha,
        installationIdHash: e.installationIdHash,
        eventType: incidentType,
        severity: e.severity,
        details: e.details,
        invalidatesSoak: e.invalidatesSoak || isMandatory,
      });
    }
    return out;
  }

  buildDailyResult(input: DailyRollupInput): SoakDailyResult {
    const eventsForDay = this.#events.filter((e) => e.timestampUtc.slice(0, 10) === input.dateUtc);
    if (eventsForDay.length === 0) {
      throw new Error(`buildDailyResult: no events for ${input.dateUtc}`);
    }
    const firstObservationAt = eventsForDay[0].timestampUtc;
    const lastObservationAt = eventsForDay[eventsForDay.length - 1].timestampUtc;
    const uptimeSeconds = Math.max(0, Math.floor((new Date(lastObservationAt).getTime() - new Date(firstObservationAt).getTime()) / 1000));

    const count = (k: OperationalEventKind): number => eventsForDay.filter((e) => e.eventKind === k).length;
    const dayInvalidators = eventsForDay.some((e) => HARD_FAIL_EVENT_KINDS.has(e.eventKind))
      || input.createOrderCounters.functionInvocations !== 0
      || input.createOrderCounters.attemptCount !== 0
      || input.createOrderCounters.networkCount !== 0;

    return {
      dateUtc: input.dateUtc,
      firstObservationAt,
      lastObservationAt,
      uptimeSeconds,
      runtimeStarts: count('runtime_start'),
      runtimeStops: count('runtime_stop'),
      serverRestarts: count('server_restart'),
      containerRestarts: count('container_restart'),
      databaseDisconnects: count('mariadb_disconnect'),
      databaseReconnects: count('mariadb_reconnect'),
      redisDisconnects: count('redis_disconnect'),
      redisReconnects: count('redis_reconnect'),
      reportJobsQueued: count('report_job_queued'),
      reportJobsCompleted: count('report_job_completed'),
      reportJobsFailed: count('report_job_failed'),
      idempotencyHits: count('idempotency_hit'),
      duplicatePreventions: count('duplicate_prevented'),
      artifactVerificationPasses: count('artifact_verification_passed'),
      artifactVerificationFailures: count('artifact_verification_failed'),
      redactionsApplied: count('redaction_performed'),
      redactionFailures: count('redaction_failure'),
      secretScanFailures: count('secret_scan_failure'),
      pathRejections: count('path_rejected'),
      temporaryCleanupFailures: count('temporary_file_cleanup_failure'),
      orphanReconciliations: count('orphan_reconciliation'),
      processLeaks: count('process_leak'),
      containerLeaks: count('container_leak'),
      createOrderCounters: input.createOrderCounters,
      safetyFlags: input.safetyFlags,
      providerState: input.providerState,
      credentialState: input.credentialState,
      dayVerdict: dayInvalidators ? 'invalidated' : 'passed',
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function severityForKind(kind: OperationalEventKind): OperationalEvent['severity'] {
  if (HARD_FAIL_EVENT_KINDS.has(kind)) return 'critical';
  if (kind === 'report_job_failed' || kind === 'redaction_failure' || kind === 'artifact_verification_failed' || kind === 'temporary_file_cleanup_failure' || kind === 'orphan_reconciliation') return 'error';
  if (kind === 'server_restart' || kind === 'container_restart' || kind === 'mariadb_disconnect' || kind === 'redis_disconnect' || kind === 'runtime_stop') return 'warn';
  return 'info';
}

/**
 * Sanitize an event detail: cap length, strip credential-shaped
 * substrings. Mirrors apps/server/src/reports/worker.ts:sanitizeError
 * — kept in-file to keep the harness free of a worker import.
 */
export function sanitizeDetail(raw: string): string {
  const scrubbed = raw
    .replace(/authorization[=:]\s*(?:Bearer\s+)?\S+/gi, 'authorization=<REDACTED>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer <REDACTED>')
    .replace(/password[=:]\s*\S+/gi, 'password=<REDACTED>')
    .replace(/token[=:]\s*\S+/gi, 'token=<REDACTED>');
  return scrubbed.slice(0, 2000);
}

// Re-export for callers that want to enumerate the full 30-kind set.
export const OPERATIONAL_EVENT_KIND_COUNT = OPERATIONAL_EVENT_KINDS.length;
export const OPERATIONAL_INCIDENT_KIND_COUNT = SOAK_INCIDENT_TYPES.length;
