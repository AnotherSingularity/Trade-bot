/**
 * Stage 3C-CI-FIX4 — bounded native-Electron startup diagnostics.
 *
 * Replaces the opaque 45s Playwright `_electron.launch` wait with:
 *   - A synchronous startup-trace file (JSONL, one phase per line)
 *     that survives crashes/cancellations.
 *   - A `withNativeTimeout(phase, ms, promise)` helper that rejects
 *     with a deterministic `native_startup_timeout:<phase>` code
 *     and always appends a failed trace entry.
 *   - A `nativeRunStatus.transition(...)` writer for the CI-visible
 *     status file the workflow uploads even when the harness
 *     cancels mid-startup.
 *   - A `writeFailureClassification(...)` emitter for the
 *     `failure-classification.json` artefact.
 *
 * All I/O is synchronous file append/write so a SIGTERM/timeout
 * still leaves a legible artefact.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Phase catalog
// ---------------------------------------------------------------------------

export const NATIVE_STARTUP_PHASES = [
  'native_test_entered',
  'isolation_minted',
  'mariadb_ready',
  'redis_ready',
  'scratch_db_created',
  'migrations_started',
  'migrations_complete',
  'seed_started',
  'seed_complete',
  'seed_coverage_complete',
  'manifest_coverage_complete',
  'server_spawn_started',
  'server_spawn_complete',
  'server_readiness_started',
  'server_readiness_complete',
  'operator_setup_started',
  'operator_setup_complete',
  'electron_launch_started',
  'electron_launch_complete',
  'first_window_wait_started',
  'first_window_observed',
  'renderer_dom_wait_started',
  'renderer_dom_loaded',
  'renderer_ready_wait_started',
  'renderer_ready',
  'authentication_started',
  'authentication_complete',
  'screen_navigation_started',
  'screen_navigation_complete',
  'shutdown_started',
  'electron_shutdown_complete',
  'server_shutdown_complete',
  'process_leak_check_complete',
  'evidence_bundle_written',
  'cleanup_complete',
] as const;
export type NativeStartupPhase = typeof NATIVE_STARTUP_PHASES[number];

export type PhaseState = 'started' | 'completed' | 'failed';

export type FailureClassification =
  | 'electron_launch'
  | 'first_window'
  | 'renderer_dom'
  | 'renderer_ready'
  | 'authentication'
  | 'screen_contract'
  | 'security'
  | 'shutdown'
  | 'process_leak'
  | 'unknown';

// ---------------------------------------------------------------------------
// Sanitizer — shared between trace writer + failure classification.
// ---------------------------------------------------------------------------

export function sanitizeDiagnosticMessage(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <REDACTED>')
    .replace(/mysql:\/\/[^@\s]+@/g, 'mysql://<REDACTED>@')
    .replace(/(x-horizon-bootstrap-token[^:]*:\s*)[A-Fa-f0-9]{32,}/gi, '$1<REDACTED>')
    .replace(/(bootstrapToken["'\s:=]+)[A-Fa-f0-9]{16,}/g, '$1<REDACTED>')
    .replace(/(password\s*=\s*)'?[^\s',)]+/gi, '$1<REDACTED>')
    .replace(/[A-Fa-f0-9]{32,}/g, '<HEX_REDACTED>')
    .slice(0, 4096);
}

// ---------------------------------------------------------------------------
// StartupTrace — synchronous JSONL writer.
// ---------------------------------------------------------------------------

export class StartupTrace {
  private path: string;
  private pid: number;

  constructor(logsDir: string) {
    mkdirSync(logsDir, { recursive: true });
    this.path = join(logsDir, 'startup-trace.jsonl');
    this.pid = process.pid;
  }

  record(phase: NativeStartupPhase | NativeTimeoutPhase, state: PhaseState, detail: Record<string, unknown> = {}): void {
    const entry = {
      timestamp: new Date().toISOString(),
      phase,
      state,
      detail: this.sanitizeDetail(detail),
      pid: this.pid,
    };
    try {
      appendFileSync(this.path, JSON.stringify(entry) + '\n');
    } catch {
      // I/O failure at trace-writer level cannot itself abort the run;
      // the failure will surface through the parent phase's error.
    }
  }

  private sanitizeDetail(detail: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(detail)) {
      if (typeof v === 'string') out[k] = sanitizeDiagnosticMessage(v);
      else out[k] = v;
    }
    return out;
  }

  location(): string { return this.path; }
}

// ---------------------------------------------------------------------------
// Bounded timeout helper.
// ---------------------------------------------------------------------------

export interface WithNativeTimeoutOpts {
  trace?: StartupTrace;
  startPhase?: NativeStartupPhase;
  completePhase?: NativeStartupPhase;
}

// Timeout-phase name used in the error code (`native_startup_timeout:<phase>`).
// Kept as a wider `string` because callers use short classification names
// (`electron_launch`, `first_window`, `renderer_dom`, `renderer_ready`,
// `authentication`, `screen_navigation`, `shutdown`) that don't necessarily
// match the trace phase names 1:1.
export type NativeTimeoutPhase = string;

export async function withNativeTimeout<T>(
  phase: NativeTimeoutPhase,
  timeoutMs: number,
  operation: Promise<T>,
  opts: WithNativeTimeoutOpts = {},
): Promise<T> {
  if (opts.trace && opts.startPhase) opts.trace.record(opts.startPhase, 'started', { timeoutMs });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const code = `native_startup_timeout:${phase}`;
      if (opts.trace) opts.trace.record(phase, 'failed', { errorCode: code, timeoutMs });
      reject(new Error(code));
    }, timeoutMs);
  });
  try {
    const value = await Promise.race([operation, timeout]);
    if (opts.trace && opts.completePhase) opts.trace.record(opts.completePhase, 'completed', {});
    return value;
  } catch (e) {
    // Only record on non-timeout errors; the timeout branch already
    // recorded a `failed` entry.
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith('native_startup_timeout:') && opts.trace) {
      opts.trace.record(phase, 'failed', { error: sanitizeDiagnosticMessage(msg) });
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Native run status file (updates in place as phases progress).
// ---------------------------------------------------------------------------

export interface NativeRunStatusFields {
  contract: 'stage3c-native-run-status.v1';
  workflowRunId: string | null;
  gitCommit: string;
  runId: string;
  nativeTestStarted: boolean;
  startedAt: string;
  currentPhase: NativeStartupPhase | 'not_started';
  completed: boolean;
  failureClassification: FailureClassification | null;
}

export class NativeRunStatus {
  private path: string;
  private state: NativeRunStatusFields;

  constructor(logsDir: string, runId: string) {
    mkdirSync(logsDir, { recursive: true });
    this.path = join(logsDir, 'native-run-status.json');
    this.state = {
      contract: 'stage3c-native-run-status.v1',
      workflowRunId: process.env.GITHUB_RUN_ID ?? null,
      gitCommit: process.env.GITHUB_SHA ?? 'local',
      runId,
      nativeTestStarted: true,
      startedAt: new Date().toISOString(),
      currentPhase: 'not_started',
      completed: false,
      failureClassification: null,
    };
    this.flush();
  }

  setPhase(phase: NativeStartupPhase): void {
    this.state.currentPhase = phase;
    this.flush();
  }

  markCompleted(): void {
    this.state.completed = true;
    this.flush();
  }

  markFailed(classification: FailureClassification): void {
    this.state.completed = false;
    this.state.failureClassification = classification;
    this.flush();
  }

  location(): string { return this.path; }

  private flush(): void {
    try { writeFileSync(this.path, JSON.stringify(this.state, null, 2)); }
    catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Failure classification artefact.
// ---------------------------------------------------------------------------

export interface FailureArtefact {
  contract: 'stage3c-native-failure.v1';
  classification: FailureClassification;
  errorCode: string;
  message: string;
  phase: NativeStartupPhase | 'unknown';
  timestamp: string;
  electronPid: number | null;
  serverPid: number | null;
}

export function classifyFailure(err: unknown): { classification: FailureClassification; errorCode: string; phase: NativeStartupPhase | 'unknown' } {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/^native_startup_timeout:(\w+)$/);
  if (m) {
    const phaseString = m[1];
    // Map phase → classification.
    const map: Record<string, FailureClassification> = {
      electron_launch: 'electron_launch',
      first_window: 'first_window',
      renderer_dom: 'renderer_dom',
      renderer_ready: 'renderer_ready',
      authentication: 'authentication',
      screen_navigation: 'screen_contract',
      shutdown: 'shutdown',
    };
    return {
      classification: map[phaseString] ?? 'unknown',
      errorCode: msg,
      phase: (NATIVE_STARTUP_PHASES as readonly string[]).includes(phaseString)
        ? (phaseString as NativeStartupPhase)
        : 'unknown',
    };
  }
  return { classification: 'unknown', errorCode: msg.slice(0, 240), phase: 'unknown' };
}

export function writeFailureClassification(
  logsDir: string,
  err: unknown,
  extras: { electronPid?: number | null; serverPid?: number | null } = {},
): string {
  mkdirSync(logsDir, { recursive: true });
  const { classification, errorCode, phase } = classifyFailure(err);
  const bundle: FailureArtefact = {
    contract: 'stage3c-native-failure.v1',
    classification,
    errorCode,
    message: sanitizeDiagnosticMessage(err instanceof Error ? err.message : String(err)),
    phase,
    timestamp: new Date().toISOString(),
    electronPid: extras.electronPid ?? null,
    serverPid: extras.serverPid ?? null,
  };
  const path = join(logsDir, 'failure-classification.json');
  try { writeFileSync(path, JSON.stringify(bundle, null, 2)); }
  catch { /* best-effort */ }
  return path;
}

// ---------------------------------------------------------------------------
// Diagnostics-mode opt-in policy.
// ---------------------------------------------------------------------------

/**
 * Strict native-diagnostics opt-in. Packaged/production builds
 * CANNOT enable it — a stray env var in a released installer must
 * never activate the preload/renderer HORIZON_NATIVE_* markers.
 */
export function nativeDiagnosticsEnabled(input: {
  isPackaged: boolean;
  nodeEnv: string | undefined;
  optIn: string | undefined;
}): boolean {
  if (input.isPackaged) return false;
  if (input.nodeEnv !== 'test') return false;
  if (input.optIn !== 'true') return false;
  return true;
}
