/**
 * Stage 5C — Managed-Docker readiness evidence emitter.
 *
 * Turns a completed orchestration run into a machine-readable
 * readiness report. Pure — takes the orchestrator's result + event
 * log, adds environment stamps, and returns a plain object suitable
 * for JSON serialization.
 *
 * The report is intentionally minimal: enough for a reviewer to
 * reconstruct which phase reached which state and why, but nothing
 * that could carry credentials or private paths. Container hostnames
 * are collapsed to `{project}_{service}` — never the ephemeral CID.
 */

import type {
  OrchestrationEvent,
  OrchestrationResult,
} from './managedDockerOrchestrator';

export interface ManagedRuntimeEnvironmentStamp {
  readonly runtimeMode: 'external_test_server' | 'managed_docker' | 'packaged_managed_docker';
  readonly packaged: boolean;
  readonly nodeEnv: string | null;
  readonly desktopVersion: string;
  readonly installationIdHash: string;
  readonly hostOs: 'win32' | 'darwin' | 'linux';
  readonly hostArch: string;
}

export interface ManagedRuntimeReadinessReport {
  readonly tool: 'managed-docker-evidence';
  readonly version: '1.0';
  readonly generatedAt: string;
  readonly project: string;
  readonly composeFile: string;
  readonly environment: ManagedRuntimeEnvironmentStamp;
  readonly outcome: {
    readonly ok: boolean;
    readonly finalPhase: string | null;
    readonly failureCode: string | null;
    readonly detail: string | null;
    readonly provisionedContainers: readonly string[];
  };
  readonly timeline: readonly {
    readonly ordinal: number;
    readonly relativeMs: number;
    readonly phase: string;
    readonly code: string;
    readonly detail: string;
  }[];
  readonly totals: {
    readonly phasesEntered: number;
    readonly phasesCompleted: number;
    readonly phasesFailed: number;
    readonly firstEventMs: number | null;
    readonly lastEventMs: number | null;
    readonly totalDurationMs: number;
  };
}

export interface BuildReadinessReportInput {
  readonly project: string;
  readonly composeFile: string;
  readonly result: OrchestrationResult;
  readonly environment: ManagedRuntimeEnvironmentStamp;
  readonly generatedAtIso: string;
}

export function buildManagedRuntimeReadinessReport(
  input: BuildReadinessReportInput,
): ManagedRuntimeReadinessReport {
  const { result, project, composeFile, environment, generatedAtIso } = input;
  const events = result.events;

  const firstEventMs = events.length > 0 ? events[0].timestampMs : null;
  const lastEventMs = events.length > 0 ? events[events.length - 1].timestampMs : null;

  const timeline = events.map((e, i) => ({
    ordinal: i,
    relativeMs: firstEventMs === null ? 0 : e.timestampMs - firstEventMs,
    phase: e.phase,
    code: e.code,
    detail: sanitizeDetail(e.detail),
  }));

  const phasesEntered = countUnique(events, (e) => e.code === 'phase_start', (e) => e.phase);
  const phasesCompleted = countUnique(events, (e) => e.code === 'phase_ok', (e) => e.phase);
  const phasesFailed = countUnique(events, (e) => e.code === 'phase_fail', (e) => e.phase);

  return {
    tool: 'managed-docker-evidence',
    version: '1.0',
    generatedAt: generatedAtIso,
    project,
    composeFile,
    environment,
    outcome: {
      ok: result.ok,
      finalPhase: result.phase,
      failureCode: result.failureCode,
      detail: result.detail === null ? null : sanitizeDetail(result.detail),
      provisionedContainers: result.provisionedContainers,
    },
    timeline,
    totals: {
      phasesEntered,
      phasesCompleted,
      phasesFailed,
      firstEventMs,
      lastEventMs,
      totalDurationMs: firstEventMs === null || lastEventMs === null ? 0 : lastEventMs - firstEventMs,
    },
  };
}

function countUnique<T>(items: readonly T[], predicate: (x: T) => boolean, key: (x: T) => string): number {
  const s = new Set<string>();
  for (const it of items) if (predicate(it)) s.add(key(it));
  return s.size;
}

/**
 * Strip any obvious secret shape before a detail line reaches the
 * evidence report. Same intent as the operational-validation
 * sanitizer but scoped to the shorter details the orchestrator
 * emits.
 */
export function sanitizeDetail(raw: string): string {
  if (typeof raw !== 'string') return String(raw);
  let s = raw;
  s = s.replace(/Bearer\s+[A-Za-z0-9_.-]{12,}/gi, 'Bearer <REDACTED>');
  s = s.replace(/authorization\s*[:=]\s*(?:Bearer\s+)?\S+/gi, 'authorization=<REDACTED>');
  s = s.replace(/password\s*[:=]\s*\S+/gi, 'password=<REDACTED>');
  s = s.replace(/token\s*[:=]\s*[A-Za-z0-9_.-]{8,}/gi, 'token=<REDACTED>');
  return s.slice(0, 500);
}

/** Convenience: JSON stringify with stable key ordering (top-level keys as declared above). */
export function serializeReadinessReport(report: ManagedRuntimeReadinessReport): string {
  return JSON.stringify(report, null, 2);
}

export interface EventOnly {
  readonly events: readonly OrchestrationEvent[];
}

/** Small helper for tests: pull the phases in the order they were entered. */
export function phasesEnteredInOrder(input: EventOnly | OrchestrationResult): string[] {
  const events: readonly OrchestrationEvent[] = 'events' in input ? input.events : [];
  const seen = new Set<string>();
  const order: string[] = [];
  for (const e of events) {
    if (e.code !== 'phase_start') continue;
    if (seen.has(e.phase)) continue;
    seen.add(e.phase);
    order.push(e.phase);
  }
  return order;
}
