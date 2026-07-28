/**
 * Stage 3C-CI-RESET Part 2 Checkpoint C.2 + C.3 — append-only native
 * execution ledger and pure reducer.
 *
 * The ledger is the ONLY source of truth for what the native run
 * actually did. Every certification requirement (from
 * nativeCertificationManifest.ts) starts in `registered` and can
 * ONLY progress through:
 *
 *   registered → started → passed
 *   registered → started → failed
 *
 * `registered → passed` and `registered → failed` are forbidden
 * (a requirement cannot skip the started transition — no invisible
 * passes). Terminal states (`passed`, `failed`) are absorbing;
 * duplicate terminal transitions fail.
 *
 * Every transition is written IMMEDIATELY to a JSONL file that is
 * opened once, appended atomically (single write call per event,
 * fsync'd), and NEVER rewritten. A SIGKILL mid-run leaves a
 * partial-but-truthful ledger, and the pure reducer can derive the
 * summary from that partial file the same way it would from a
 * complete one.
 *
 * The final summary is written atomically (temp file + rename) so a
 * consumer never observes a partial summary.
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  NATIVE_CERTIFICATION_CATEGORIES,
  computeManifestHash,
  type NativeCertificationCategory,
  type NativeCertificationRequirement,
  type NativeScreenKey,
} from './nativeCertificationManifest';

// ---------------------------------------------------------------------------
// Event model
// ---------------------------------------------------------------------------

export type NativeExecutionState = 'registered' | 'started' | 'passed' | 'failed';

export type NativeExecutionTransition = 'register' | 'start' | 'pass' | 'fail';

export interface NativeExecutionEvent {
  readonly sequence: number;
  readonly timestamp: string;
  readonly requirementId: string;
  readonly category: NativeCertificationCategory;
  readonly transition: NativeExecutionTransition;
  readonly elapsedMs?: number;
  readonly screenKey?: NativeScreenKey;
  readonly failureCode?: string;
}

// ---------------------------------------------------------------------------
// Error classes for programmatic detection
// ---------------------------------------------------------------------------

export class NativeLedgerError extends Error {
  constructor(public readonly tag: string, message: string) {
    super(`${tag}: ${message}`);
    this.name = 'NativeLedgerError';
  }
}

// ---------------------------------------------------------------------------
// Failure-code sanitizer. Bounded + redacts common secret shapes.
// ---------------------------------------------------------------------------

const MAX_FAILURE_CODE = 240;

export function sanitizeFailureCode(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <REDACTED>')
    .replace(/[A-Fa-f0-9]{32,}/g, '<HEX_REDACTED>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FAILURE_CODE);
}

// ---------------------------------------------------------------------------
// Ledger (append-only writer)
// ---------------------------------------------------------------------------

export interface NativeLedgerOpts {
  readonly runDir: string;
  readonly manifest: readonly NativeCertificationRequirement[];
  /** Injectable for tests. Defaults to Date().toISOString(). */
  readonly now?: () => string;
}

export class NativeExecutionLedger {
  private readonly manifest: readonly NativeCertificationRequirement[];
  private readonly ledgerPath: string;
  private readonly summaryPath: string;
  private readonly summaryTmpPath: string;
  private readonly requirementById: Map<string, NativeCertificationRequirement>;
  private readonly state = new Map<string, NativeExecutionState>();
  private readonly events: NativeExecutionEvent[] = [];
  private readonly nowFn: () => string;
  private fd: number | null = null;
  private nextSequence = 0;
  private closed = false;

  constructor(opts: NativeLedgerOpts) {
    this.manifest = opts.manifest;
    this.nowFn = opts.now ?? ((): string => new Date().toISOString());
    this.ledgerPath = join(opts.runDir, 'native-execution-ledger.jsonl');
    this.summaryPath = join(opts.runDir, 'native-execution-summary.json');
    this.summaryTmpPath = join(opts.runDir, 'native-execution-summary.tmp.json');
    this.requirementById = new Map(opts.manifest.map((r) => [r.id, r]));
  }

  ledgerFilePath(): string { return this.ledgerPath; }
  summaryFilePath(): string { return this.summaryPath; }

  /**
   * Register every requirement from the manifest, in manifest order.
   * Idempotent per requirement — a duplicate registration throws
   * NativeLedgerError('duplicate_register', ...). Opens the ledger
   * file descriptor on first call.
   */
  registerManifest(): void {
    if (this.closed) throw new NativeLedgerError('closed', 'ledger already closed');
    if (this.fd == null) {
      this.fd = openSync(this.ledgerPath, 'a');
    }
    for (const r of this.manifest) {
      if (this.state.has(r.id)) {
        throw new NativeLedgerError('duplicate_register', `${r.id} already registered`);
      }
      this.state.set(r.id, 'registered');
      this.append({
        sequence: this.nextSequence++,
        timestamp: this.nowFn(),
        requirementId: r.id,
        category: r.category,
        transition: 'register',
        ...(r.screenKey ? { screenKey: r.screenKey } : {}),
      });
    }
  }

  start(requirementId: string): void {
    const r = this.mustFind(requirementId);
    const cur = this.state.get(requirementId);
    if (cur !== 'registered') {
      throw new NativeLedgerError('illegal_transition', `${requirementId} start requires 'registered', is '${cur}'`);
    }
    this.state.set(requirementId, 'started');
    this.append({
      sequence: this.nextSequence++,
      timestamp: this.nowFn(),
      requirementId,
      category: r.category,
      transition: 'start',
      ...(r.screenKey ? { screenKey: r.screenKey } : {}),
    });
  }

  pass(requirementId: string, elapsedMs?: number): void {
    const r = this.mustFind(requirementId);
    const cur = this.state.get(requirementId);
    if (cur !== 'started') {
      throw new NativeLedgerError('illegal_transition', `${requirementId} pass requires 'started', is '${cur}'`);
    }
    this.state.set(requirementId, 'passed');
    this.append({
      sequence: this.nextSequence++,
      timestamp: this.nowFn(),
      requirementId,
      category: r.category,
      transition: 'pass',
      ...(elapsedMs != null ? { elapsedMs } : {}),
      ...(r.screenKey ? { screenKey: r.screenKey } : {}),
    });
  }

  fail(requirementId: string, failureCode: string, elapsedMs?: number): void {
    const r = this.mustFind(requirementId);
    const cur = this.state.get(requirementId);
    if (cur !== 'started') {
      throw new NativeLedgerError('illegal_transition', `${requirementId} fail requires 'started', is '${cur}'`);
    }
    this.state.set(requirementId, 'failed');
    this.append({
      sequence: this.nextSequence++,
      timestamp: this.nowFn(),
      requirementId,
      category: r.category,
      transition: 'fail',
      failureCode: sanitizeFailureCode(failureCode),
      ...(elapsedMs != null ? { elapsedMs } : {}),
      ...(r.screenKey ? { screenKey: r.screenKey } : {}),
    });
  }

  /**
   * Convenience for cleanup entries. The requirement is registered
   * on first invocation (registerManifest already registered it, so
   * this just runs start→pass/fail). Never throws — cleanup outcome
   * is always recorded, even if the ledger itself is in a bad state.
   */
  recordCleanup(requirementId: string, ok: boolean, failureCode?: string): void {
    try {
      const cur = this.state.get(requirementId);
      if (cur === 'passed' || cur === 'failed') return; // idempotent
      if (cur === 'registered') this.start(requirementId);
      if (ok) this.pass(requirementId);
      else this.fail(requirementId, failureCode ?? 'cleanup_failed');
    } catch { /* never throw from cleanup */ }
  }

  /** Snapshot of every appended event so far (order-preserving). */
  snapshot(): readonly NativeExecutionEvent[] {
    return [...this.events];
  }

  currentState(requirementId: string): NativeExecutionState | undefined {
    return this.state.get(requirementId);
  }

  close(): void {
    if (this.fd != null) {
      try { fsyncSync(this.fd); } catch { /* best-effort */ }
      try { closeSync(this.fd); } catch { /* best-effort */ }
      this.fd = null;
    }
    this.closed = true;
  }

  /**
   * Derive the summary from the current in-memory events + manifest,
   * then persist to the summary file atomically via tmp + rename.
   * Returns the derived summary object.
   */
  finalizeSummary(): NativeExecutionSummary {
    const summary = reduceNativeExecutionLedger(this.events, this.manifest, this.readLedgerBytesForHash());
    writeFileSync(this.summaryTmpPath, JSON.stringify(summary, null, 2));
    renameSync(this.summaryTmpPath, this.summaryPath);
    return summary;
  }

  private readLedgerBytesForHash(): Buffer {
    try { return readFileSync(this.ledgerPath); } catch { return Buffer.alloc(0); }
  }

  private mustFind(requirementId: string): NativeCertificationRequirement {
    const r = this.requirementById.get(requirementId);
    if (!r) throw new NativeLedgerError('unknown_requirement', requirementId);
    return r;
  }

  private append(evt: NativeExecutionEvent): void {
    if (this.closed) throw new NativeLedgerError('closed', 'ledger append after close');
    if (this.fd == null) throw new NativeLedgerError('not_open', 'ledger not opened (call registerManifest first)');
    const line = JSON.stringify(evt) + '\n';
    writeSync(this.fd, line);
    try { fsyncSync(this.fd); } catch { /* best-effort */ }
    this.events.push(evt);
  }
}

// ---------------------------------------------------------------------------
// Pure reducer + summary
// ---------------------------------------------------------------------------

export interface NativeExecutionScreenSummary {
  readonly navigation: NativeExecutionState;
  readonly signature: NativeExecutionState;
  readonly manifest: NativeExecutionState;
}

export interface NativeExecutionFailure {
  readonly requirementId: string;
  readonly category: NativeCertificationCategory;
  readonly failureCode: string;
  readonly sequence: number;
  readonly timestamp: string;
}

export interface NativeExecutionSummary {
  readonly contract: 'stage3c-native-execution-summary.v1';
  readonly manifestHash: string;
  readonly ledgerHash: string;
  readonly registered: number;
  readonly started: number;
  readonly passed: number;
  readonly failed: number;
  readonly unstarted: number;
  readonly incomplete: number;
  readonly firstFailure: NativeExecutionFailure | null;
  readonly secondaryFailures: readonly NativeExecutionFailure[];
  readonly byCategory: Record<NativeCertificationCategory, {
    readonly registered: number;
    readonly started: number;
    readonly passed: number;
    readonly failed: number;
    readonly unstarted: number;
    readonly incomplete: number;
  }>;
  readonly screens: Readonly<Record<string, NativeExecutionScreenSummary>>;
  readonly complete: boolean;
}

const EMPTY_BUCKET = { registered: 0, started: 0, passed: 0, failed: 0, unstarted: 0, incomplete: 0 } as const;

/**
 * Pure reducer over the event stream. Zero I/O. Given the same
 * (events, manifest) input it always returns the same summary. The
 * `ledgerBytes` parameter is hashed verbatim so tampering with the
 * on-disk file (line reorder, byte flip) changes `ledgerHash`.
 */
export function reduceNativeExecutionLedger(
  events: readonly NativeExecutionEvent[],
  manifest: readonly NativeCertificationRequirement[],
  ledgerBytes: Buffer,
): NativeExecutionSummary {
  const requirementById = new Map(manifest.map((r) => [r.id, r]));
  // Track terminal state per requirement + first-failure event.
  const stateById = new Map<string, NativeExecutionState>();
  const failureEvents: NativeExecutionFailure[] = [];

  // Sort by sequence (defensive; append order should already be
  // monotonic but we validate below).
  let lastSeq = -1;
  for (const e of events) {
    if (e.sequence <= lastSeq) {
      // Out-of-order sequences are recorded but do not abort the
      // reducer; they are visible in the `complete` calculation via
      // an `unknown_requirement` failure. Distinct decision:
      // silently ignoring would let a corrupt ledger claim success,
      // so we surface it by recording a synthetic failure entry.
      failureEvents.push({
        requirementId: '__ledger__',
        category: 'cleanup',
        failureCode: `out_of_order_sequence:${e.sequence}<=${lastSeq}`,
        sequence: e.sequence,
        timestamp: e.timestamp,
      });
    }
    lastSeq = e.sequence;
    if (!requirementById.has(e.requirementId) && e.requirementId !== '__ledger__') {
      // Unknown ID also surfaces as a failure.
      failureEvents.push({
        requirementId: e.requirementId,
        category: 'cleanup',
        failureCode: 'unknown_requirement',
        sequence: e.sequence,
        timestamp: e.timestamp,
      });
      continue;
    }
    switch (e.transition) {
      case 'register':
        stateById.set(e.requirementId, 'registered');
        break;
      case 'start':
        stateById.set(e.requirementId, 'started');
        break;
      case 'pass':
        stateById.set(e.requirementId, 'passed');
        break;
      case 'fail':
        stateById.set(e.requirementId, 'failed');
        failureEvents.push({
          requirementId: e.requirementId,
          category: e.category,
          failureCode: e.failureCode ?? 'unspecified',
          sequence: e.sequence,
          timestamp: e.timestamp,
        });
        break;
    }
  }

  const byCategory = {} as Record<NativeCertificationCategory, {
    registered: number; started: number; passed: number; failed: number; unstarted: number; incomplete: number;
  }>;
  for (const c of NATIVE_CERTIFICATION_CATEGORIES) byCategory[c] = { ...EMPTY_BUCKET };

  let registered = 0, started = 0, passed = 0, failed = 0, unstarted = 0, incomplete = 0;

  for (const r of manifest) {
    const s = stateById.get(r.id) ?? 'registered'; // if register event is missing, treat as unstarted
    const missingRegisterEvent = !stateById.has(r.id);
    // Book-keeping counters. A requirement is:
    //   - registered   → in the manifest (all of them count)
    //   - started      → progressed past register
    //   - passed       → terminal pass
    //   - failed       → terminal fail
    //   - unstarted    → registered but never started
    //   - incomplete   → started but never terminated
    registered++;
    byCategory[r.category].registered++;
    if (s === 'started') { started++; incomplete++; byCategory[r.category].started++; byCategory[r.category].incomplete++; }
    if (s === 'passed') { started++; passed++; byCategory[r.category].started++; byCategory[r.category].passed++; }
    if (s === 'failed') { started++; failed++; byCategory[r.category].started++; byCategory[r.category].failed++; }
    if (s === 'registered') {
      // If register event is missing entirely, treat as unstarted for
      // completion purposes but do NOT count it as registered when
      // even the register event is absent. (This can happen if the
      // ledger was truncated before beforeAll finished registering.)
      if (missingRegisterEvent) {
        // Not registered at all — still counts against completion.
        registered--; // undo the increment above
        byCategory[r.category].registered--;
      }
      unstarted++;
      byCategory[r.category].unstarted++;
    }
  }

  const screens: Record<string, NativeExecutionScreenSummary> = {};
  for (const r of manifest) {
    if (!r.screenKey) continue;
    if (!screens[r.screenKey]) {
      screens[r.screenKey] = { navigation: 'registered', signature: 'registered', manifest: 'registered' };
    }
    const s = (stateById.get(r.id) ?? 'registered') as NativeExecutionState;
    const cur = screens[r.screenKey];
    if (r.category === 'screen_navigation') screens[r.screenKey] = { ...cur, navigation: s };
    if (r.category === 'screen_signature') screens[r.screenKey] = { ...cur, signature: s };
    if (r.category === 'screen_manifest') screens[r.screenKey] = { ...cur, manifest: s };
  }

  const firstFailure = failureEvents.length === 0 ? null : failureEvents[0];
  const secondaryFailures = failureEvents.slice(1);

  const complete =
    registered === manifest.length
    && started === registered
    && passed === started
    && failed === 0
    && unstarted === 0
    && incomplete === 0
    && failureEvents.length === 0;

  const manifestHash = computeManifestHash(manifest);
  const ledgerHash = createHash('sha256').update(ledgerBytes).digest('hex');

  return {
    contract: 'stage3c-native-execution-summary.v1',
    manifestHash,
    ledgerHash,
    registered,
    started,
    passed,
    failed,
    unstarted,
    incomplete,
    firstFailure,
    secondaryFailures,
    byCategory,
    screens,
    complete,
  };
}

// ---------------------------------------------------------------------------
// Ledger file reader — for reconstructing a summary from disk after
// an abrupt exit. Skips malformed lines rather than throwing (a
// partial write mid-line is legitimately incomplete evidence).
// ---------------------------------------------------------------------------

export function readLedgerEvents(ledgerPath: string): { events: NativeExecutionEvent[]; bytes: Buffer } {
  let raw: Buffer;
  try { raw = readFileSync(ledgerPath); }
  catch { return { events: [], bytes: Buffer.alloc(0) }; }
  const text = raw.toString('utf8');
  const events: NativeExecutionEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as NativeExecutionEvent;
      if (typeof parsed.sequence === 'number' && typeof parsed.requirementId === 'string' && typeof parsed.transition === 'string') {
        events.push(parsed);
      }
    } catch { /* skip malformed */ }
  }
  return { events, bytes: raw };
}
