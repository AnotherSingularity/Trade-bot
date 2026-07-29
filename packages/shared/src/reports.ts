/**
 * Stage 4 §S4.1 — shared report contracts.
 *
 * The report system produces deterministic, content-addressable
 * artifacts. Two callers share the surface: the server (canonical
 * payload construction + tRPC procs) and the desktop main-process
 * (path validation + envelope handling). The renderer never touches
 * this file directly — it consumes the tRPC schemas that reference it.
 *
 * The module is intentionally environment-agnostic (no Node built-ins,
 * no browser globals). SHA256 wrapping is delegated to the server
 * (apps/server/src/reports/digest.ts) so this file stays importable
 * from the desktop renderer bundle. Every function here is pure,
 * synchronous, and deterministic — same input, same output, forever.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Report kinds + formats
// ---------------------------------------------------------------------------

/**
 * The 13 report kinds. MUST match `DESKTOP_EXPORT_REPORT_KINDS` in
 * apps/server/src/db/schema.ts and the `EXPORT_REPORT_KINDS` array
 * in apps/desktop/src/shared/ipcContract.ts (both pre-existed from
 * Stage 3A). A generator exists for each entry.
 */
export const REPORT_KINDS = [
  'decision_chain',
  'daily_shadow',
  'portfolio_risk',
  'universe_and_hygiene',
  'fingerprints',
  'regimes',
  'microstructure',
  'context',
  'cost_attribution',
  'validation',
  'incidents',
  'safety_status',
  'system_manifest',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const ReportKindSchema = z.enum(REPORT_KINDS);

export const REPORT_FORMATS = ['json', 'csv', 'html'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export const ReportFormatSchema = z.enum(REPORT_FORMATS);

/**
 * Per-kind spec version. Change the suffix (v1 → v2) whenever a
 * generator's canonical payload shape changes so old + new artifacts
 * are structurally distinguishable and the DB record's
 * reportSpecVersion pins the exact contract that produced it.
 *
 * MUST be kept in sync with the generator implementations. Every
 * kind MUST have an entry — the runtime enqueue check enforces it.
 */
export const REPORT_SPEC_VERSIONS: Readonly<Record<ReportKind, string>> = Object.freeze({
  decision_chain: 'decision_chain.v1',
  daily_shadow: 'daily_shadow.v1',
  portfolio_risk: 'portfolio_risk.v1',
  universe_and_hygiene: 'universe_and_hygiene.v1',
  fingerprints: 'fingerprints.v1',
  regimes: 'regimes.v1',
  microstructure: 'microstructure.v1',
  context: 'context.v1',
  cost_attribution: 'cost_attribution.v1',
  validation: 'validation.v1',
  incidents: 'incidents.v1',
  safety_status: 'safety_status.v1',
  system_manifest: 'system_manifest.v1',
});

// ---------------------------------------------------------------------------
// Source high-water-mark
// ---------------------------------------------------------------------------

/**
 * Snapshot of the max primary-key values the generator consumed. Two
 * runs of the same kind against the same DB state MUST produce the
 * same high-water-mark and therefore the same contentDigest. Every
 * generator picks its own set of source counters and MUST include
 * every table it reads from — omitting one means downstream inserts
 * to that table could change the artifact without changing the key,
 * silently breaking idempotency.
 *
 * `null` inside the record means "table exists but has no rows" —
 * a legitimate snapshot value distinct from "table not consulted"
 * (which would omit the key entirely).
 */
export const SourceHighWaterMarkSchema = z.record(z.string(), z.union([z.number().int(), z.null()])).readonly();
export type SourceHighWaterMark = z.infer<typeof SourceHighWaterMarkSchema>;

// ---------------------------------------------------------------------------
// Idempotency key input
// ---------------------------------------------------------------------------

/**
 * The exact tuple that participates in idempotency. Callers assemble
 * this from validated request data — never from timestamps, job ids,
 * artifact paths, or temporary filenames. `referenceId` MUST be the
 * post-validation form (trimmed, lowercased if applicable, rejected
 * if it fails the schema) so equivalent user inputs collapse to the
 * same key.
 *
 * `requestOptions` is the caller-supplied normalisation surface —
 * fields the generator legitimately branches on that are not
 * captured by the other tuple members. Callers MUST canonicalise
 * options (sort keys, coerce omitted booleans to their default)
 * before passing them in so `{filter:'a'}` and `{filter:'a',
 * expand:false}` map to the same key when `expand` defaults to
 * false. An empty object is the correct value for "no options."
 */
export const IdempotencyKeyInputSchema = z.object({
  installationId: z.number().int().positive(),
  reportKind: ReportKindSchema,
  reportSpecVersion: z.string().min(1).max(32),
  referenceId: z.string().min(1).max(128).nullable(),
  sourceHighWaterMark: SourceHighWaterMarkSchema,
  requestOptions: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type IdempotencyKeyInput = z.infer<typeof IdempotencyKeyInputSchema>;

// ---------------------------------------------------------------------------
// Canonical stringify (RFC-8785-compatible for our value subset)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialisation for the value subset we actually
 * emit (strings, finite numbers, booleans, null, arrays, plain
 * objects). Object keys are emitted in lexicographic order. NaN,
 * Infinity, and non-finite numbers are refused (throw). Undefined
 * values in objects are dropped; undefined in arrays becomes null
 * (matches standard JSON.stringify semantics). Non-plain objects
 * (Date, Map, Set, class instances) are refused — pass their
 * canonical form explicitly.
 *
 * This is NOT full RFC-8785 (which requires ES6 number canonical
 * form via NumberFormat.toShortestSubnormal etc). We use JavaScript's
 * native `String(n)` for numbers because every value we emit is
 * either an integer, a fixed-decimal string via Money, or a bounded
 * float that fits inside 2^53. If a generator ever needs to emit an
 * arbitrary IEEE754 float, add an assertion + normaliser here first.
 */
export function canonicalStringify(value: unknown): string {
  const out: string[] = [];
  emit(value, out);
  return out.join('');
}

function emit(v: unknown, out: string[]): void {
  if (v === null) { out.push('null'); return; }
  if (typeof v === 'boolean') { out.push(v ? 'true' : 'false'); return; }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error(`canonicalStringify: non-finite number rejected (${String(v)})`);
    }
    out.push(String(v));
    return;
  }
  if (typeof v === 'string') {
    emitString(v, out);
    return;
  }
  if (Array.isArray(v)) {
    out.push('[');
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(',');
      const item = v[i];
      if (item === undefined) out.push('null');
      else emit(item, out);
    }
    out.push(']');
    return;
  }
  if (typeof v === 'object') {
    // Refuse anything that's not a plain object.
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`canonicalStringify: non-plain object rejected (${v?.constructor?.name ?? typeof v})`);
    }
    const rec = v as Record<string, unknown>;
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
    out.push('{');
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out.push(',');
      const k = keys[i];
      emitString(k, out);
      out.push(':');
      emit(rec[k], out);
    }
    out.push('}');
    return;
  }
  throw new Error(`canonicalStringify: unsupported type ${typeof v}`);
}

function emitString(s: string, out: string[]): void {
  out.push('"');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out.push('\\"');
    else if (c === 0x5c) out.push('\\\\');
    else if (c === 0x08) out.push('\\b');
    else if (c === 0x09) out.push('\\t');
    else if (c === 0x0a) out.push('\\n');
    else if (c === 0x0c) out.push('\\f');
    else if (c === 0x0d) out.push('\\r');
    else if (c < 0x20) out.push('\\u' + c.toString(16).padStart(4, '0'));
    else out.push(s[i]);
  }
  out.push('"');
}

// ---------------------------------------------------------------------------
// Idempotency key derivation (pure — SHA256 lives in the server module)
// ---------------------------------------------------------------------------

/**
 * Compose the canonical byte-string that the SHA256 hash is taken
 * over. The `buildIdempotencyKey` wrapper in
 * apps/server/src/reports/digest.ts feeds this through sha256 and
 * prefixes 'idem_' to yield the stored key.
 *
 * Excluded by construction (matches the Stage 4 correction: "must
 * not participate"):
 *   - generatedAt / requestedAt / any timestamp
 *   - jobId / any auto-increment id
 *   - targetFolder / any file-system path
 *   - temporary filenames
 * Included (matches the correction list):
 *   - installationId
 *   - reportKind
 *   - reportSpecVersion (pins the generator contract)
 *   - referenceId (post-validation form)
 *   - sourceHighWaterMark
 *   - requestOptions (normalised)
 *
 * Same input → same output byte-for-byte, forever. Two callers on
 * different machines with clocks skewed by an hour but identical
 * inputs compute the same key.
 */
export function composeIdempotencyKeyCanonicalPayload(input: IdempotencyKeyInput): string {
  const parsed = IdempotencyKeyInputSchema.parse(input);
  // Emit as a single canonical object with the sanctioned key set.
  return canonicalStringify({
    installationId: parsed.installationId,
    reportKind: parsed.reportKind,
    reportSpecVersion: parsed.reportSpecVersion,
    referenceId: parsed.referenceId,
    sourceHighWaterMark: parsed.sourceHighWaterMark,
    requestOptions: parsed.requestOptions,
  });
}

// ---------------------------------------------------------------------------
// Canonical report envelope — what contentDigest is taken over
// ---------------------------------------------------------------------------

/**
 * The subset of the report that participates in contentDigest. Every
 * generator emits this shape. Fields that MUST NOT affect the digest
 * (generatedAt, jobId, requestedAt, targetFolder, artifactPath, any
 * temp filename) are deliberately absent. Adding a new field here
 * changes every downstream digest — do that only when a report
 * contract changes and bump `reportSpecVersion` at the same time.
 */
export interface CanonicalReportEnvelope<K extends ReportKind = ReportKind> {
  readonly reportKind: K;
  readonly reportSpecVersion: string;
  readonly sourceHighWaterMark: SourceHighWaterMark;
  readonly sourceQueryVersions: readonly string[];
  readonly redactionsApplied: readonly string[];
  readonly payload: unknown;
}

/**
 * Deterministic byte-string for contentDigest. The wrapping SHA256
 * call lives in the server digest module.
 */
export function composeContentCanonicalPayload<K extends ReportKind>(
  env: CanonicalReportEnvelope<K>,
): string {
  return canonicalStringify({
    reportKind: env.reportKind,
    reportSpecVersion: env.reportSpecVersion,
    sourceHighWaterMark: env.sourceHighWaterMark,
    sourceQueryVersions: [...env.sourceQueryVersions].sort(),
    redactionsApplied: [...env.redactionsApplied].sort(),
    payload: env.payload,
  });
}
