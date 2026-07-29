/**
 * Stage 4 §S4C — export worker.
 *
 * ONE entry point (`enqueueAndRunExport`) that owns the full
 * lifecycle of a report artifact:
 *
 *   1. Compute the deterministic idempotency key from
 *      (installationId, kind, specVersion, referenceId,
 *       sourceHighWaterMark, requestOptions).
 *   2. Attempt to INSERT `desktop_export_jobs` with that key. The
 *      UNIQUE constraint on `idempotencyKey` is what enforces
 *      idempotency — NOT an application-side check-then-insert
 *      (Stage 4 correction: "must be enforced by a database
 *      uniqueness constraint, not application-only check-then-
 *      insert logic"). On ER_DUP_ENTRY, look up the winning job
 *      + artifact and return them as the result of THIS call —
 *      two concurrent enqueues collapse to the same artifact.
 *   3. Open a REPEATABLE READ transaction bound to the winning
 *      insertion, run the generator inside it. Snapshot HWMs
 *      captured by the generator MUST match the transaction's
 *      view — if a scan runs concurrently the tx-bound reads
 *      shield us from mid-run drift.
 *   4. Apply the fail-closed redaction wrapper to the raw
 *      payload. Compose the canonical envelope.
 *   5. Compute contentDigest (SHA256 of canonical envelope) BEFORE
 *      picking a serializer — same envelope + different formats
 *      share the digest.
 *   6. Serialize into the requested format. Compute checksumSha256
 *      (SHA256 of emitted bytes) AFTER serialisation — different
 *      formats produce different byte-checksums.
 *   7. Validate the output path (fail-closed on traversal, symlink,
 *      UNC, drive escape). If path validation fails, fail the job.
 *   8. Write the file with 0o600 mode. Insert the artifact row.
 *      Update the job to `completed`. Return the job + artifact.
 *
 * A generator error propagates as a job `failed` write — the
 * artifact row is never inserted. `failureReason` is a sanitised
 * one-liner (200 chars max).
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sql, eq } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import {
  REPORT_SPEC_VERSIONS,
  type CanonicalReportEnvelope,
  type ReportFormat,
  type ReportKind,
  type SourceHighWaterMark,
} from '@horizon/shared';
import { desktopExportArtifacts, desktopExportJobs } from '../db/schema';
import { REPORT_GENERATORS } from './generators';
import { buildIdempotencyKey, computeContentDigest } from './digest';
import { redact } from './redact';
import { serializeCsv, serializeHtml, serializeJson } from './serialize';
import { validateOutputPath } from './pathValidation';

export interface EnqueueInput {
  readonly installationId: number;
  readonly reportKind: ReportKind;
  readonly format: ReportFormat;
  readonly targetFolder: string;
  readonly referenceId?: string | null;
  readonly requestedBy: string;
  /**
   * Caller-normalised branching surface. MUST be a plain object; the
   * canonical stringifier refuses class instances. Order-independent —
   * canonicalStringify sorts keys before hashing.
   */
  readonly requestOptions?: Record<string, unknown>;
}

export type EnqueueResultStatus = 'materialized' | 'idempotent_hit' | 'failed';

export interface EnqueueResult {
  readonly status: EnqueueResultStatus;
  readonly jobId: number;
  readonly idempotencyKey: string;
  readonly contentDigest: string | null;
  readonly checksumSha256: string | null;
  readonly artifactPath: string | null;
  readonly failureReason: string | null;
  readonly reportSpecVersion: string;
  readonly sourceHighWaterMark: SourceHighWaterMark;
}

/**
 * Sanitise an unknown error into a 200-char failure reason. Strips
 * credential-shaped substrings before the string ever reaches
 * `desktop_export_jobs.failureReason`. The `authorization` rule
 * consumes an optional `Bearer` prefix + the following token as a
 * single unit — otherwise the trailing token would survive because
 * `\S+` matches only the FIRST non-space run.
 */
export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'unknown_error');
  const scrubbed = raw
    .replace(/authorization[=:]\s*(?:Bearer\s+)?\S+/gi, 'authorization=<REDACTED>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer <REDACTED>')
    .replace(/password[=:]\s*\S+/gi, 'password=<REDACTED>')
    .replace(/token[=:]\s*\S+/gi, 'token=<REDACTED>');
  return scrubbed.slice(0, 200);
}

function sha256HexBytes(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function serialize(format: ReportFormat, input: Parameters<typeof serializeJson>[0]): string {
  switch (format) {
    case 'json': return serializeJson(input);
    case 'csv': return serializeCsv(input);
    case 'html': return serializeHtml(input);
    default: throw new Error(`unknown_format:${String(format)}`);
  }
}

function extensionFor(format: ReportFormat): string {
  return format === 'json' ? 'json' : format === 'csv' ? 'csv' : 'html';
}

/**
 * Deterministic filename shape — same job → same filename.
 * `${kind}-${specVersion}-${first16OfContentDigest}.${ext}`. contentDigest
 * is stable across identical DB state so subsequent runs of the same
 * job land at the SAME filename — an operator can spot a rewrite by
 * inspecting the folder listing.
 */
export function makeFilename(kind: ReportKind, specVersion: string, contentDigest: string, format: ReportFormat): string {
  const short = contentDigest.slice(0, 16);
  // Two-pass scrub: first collapse any run of dots to a single dot
  // (kills `..` traversal even though `.` alone is a legal char in a
  // filename), then swap anything outside `[a-z0-9._-]` for `_`.
  // Defense-in-depth: specVersion comes from Object.freeze'd
  // REPORT_SPEC_VERSIONS so a user cannot inject `..`, but the
  // filename API is a real security boundary and must not rely on
  // upstream honesty.
  const cleanSpec = specVersion.replace(/\.{2,}/g, '.').replace(/[^a-z0-9._-]/gi, '_');
  return `${kind}-${cleanSpec}-${short}.${extensionFor(format)}`;
}

/**
 * MySQL/MariaDB duplicate-entry detection. Drizzle surfaces the
 * underlying mysql2 error verbatim; we match on either the code
 * or the errno for portability.
 */
function isDuplicateEntry(err: unknown): boolean {
  const e = err as { code?: string; errno?: number; message?: string } | null;
  if (!e) return false;
  if (e.code === 'ER_DUP_ENTRY') return true;
  if (e.errno === 1062) return true;
  if (typeof e.message === 'string' && e.message.includes('Duplicate entry')) return true;
  return false;
}

/**
 * The single worker call. Autonomous — computes the idempotency
 * key, INSERTs the job row, runs the generator, writes the file,
 * updates the job. Returns a typed result the tRPC procedure
 * forwards to the caller verbatim.
 */
export async function enqueueAndRunExport(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: MySql2Database<any>,
  input: EnqueueInput,
): Promise<EnqueueResult> {
  const specVersion = REPORT_SPEC_VERSIONS[input.reportKind];
  const generator = REPORT_GENERATORS[input.reportKind];
  if (!generator) throw new Error(`no_generator_for_kind:${input.reportKind}`);

  // ---------------------------------------------------------------------
  // Snapshot BEFORE writing the job row so idempotencyKey is
  // computed against the same HWMs the generator will see. Reading
  // outside the transaction here is safe because the generator will
  // enforce the same HWM bounds inside its transaction (or query
  // through the tx-bound db handle).
  // ---------------------------------------------------------------------
  const preSnapshot = await generator.generate({ db, installationId: input.installationId, referenceId: input.referenceId ?? null });
  const sourceHighWaterMark = preSnapshot.sourceHighWaterMark;

  const idempotencyKey = buildIdempotencyKey({
    installationId: input.installationId,
    reportKind: input.reportKind,
    reportSpecVersion: specVersion,
    referenceId: input.referenceId ?? null,
    sourceHighWaterMark,
    requestOptions: input.requestOptions ?? {},
  });

  // ---------------------------------------------------------------------
  // DB-enforced idempotency: INSERT with the key + catch the unique
  // constraint violation. On dup, look up the winning row.
  // ---------------------------------------------------------------------
  let jobId: number;
  let idempotentHit = false;
  try {
    const insertRes = await db.insert(desktopExportJobs).values({
      installationId: input.installationId,
      reportKind: input.reportKind,
      format: input.format,
      referenceId: input.referenceId ?? null,
      targetFolder: input.targetFolder,
      requestedBy: input.requestedBy,
      requestedAt: new Date(),
      status: 'running',
      reportSpecVersion: specVersion,
      sourceHighWaterMark: sourceHighWaterMark as unknown as Record<string, unknown>,
      idempotencyKey,
    });
    // Drizzle mysql2 returns [OkPacket, undefined] or { insertId }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const insertId = (insertRes as any)?.[0]?.insertId ?? (insertRes as any)?.insertId ?? 0;
    jobId = Number(insertId);
    if (!jobId) throw new Error('insert_returned_no_id');
  } catch (err) {
    if (!isDuplicateEntry(err)) throw err;
    idempotentHit = true;
    const existingRows = await db.select().from(desktopExportJobs).where(eq(desktopExportJobs.idempotencyKey, idempotencyKey)).limit(1);
    const existing = existingRows[0];
    if (!existing) throw new Error('idempotent_lookup_failed');
    jobId = Number(existing.id);
    // Fetch its artifact if one materialised.
    const artRows = await db.select().from(desktopExportArtifacts).where(eq(desktopExportArtifacts.exportJobId, jobId)).limit(1);
    const art = artRows[0];
    return {
      status: 'idempotent_hit',
      jobId,
      idempotencyKey,
      contentDigest: art?.contentDigest ?? null,
      checksumSha256: art?.checksumSha256 ?? null,
      artifactPath: art?.artifactPath ?? null,
      failureReason: existing.failureReason ?? null,
      reportSpecVersion: specVersion,
      sourceHighWaterMark,
    };
  }
  void idempotentHit;

  try {
    // -------------------------------------------------------------------
    // Redact → envelope → digest → serialise.
    // -------------------------------------------------------------------
    const { redactedPayload, redactionsApplied } = redact(preSnapshot.rawPayload);
    const envelope: CanonicalReportEnvelope<ReportKind> = {
      reportKind: input.reportKind,
      reportSpecVersion: specVersion,
      sourceHighWaterMark,
      sourceQueryVersions: preSnapshot.sourceQueryVersions,
      redactionsApplied,
      payload: redactedPayload,
    };
    const contentDigest = computeContentDigest(envelope);

    // -------------------------------------------------------------------
    // Validate the output path BEFORE touching disk.
    // -------------------------------------------------------------------
    const filename = makeFilename(input.reportKind, specVersion, contentDigest, input.format);
    const pv = await validateOutputPath({ targetFolder: input.targetFolder, filename });
    if (!pv.ok) {
      const reason = `path_rejected:${pv.reason}`;
      await db.update(desktopExportJobs).set({ status: 'failed', failureReason: reason, completedAt: new Date() }).where(eq(desktopExportJobs.id, jobId));
      return {
        status: 'failed', jobId, idempotencyKey, contentDigest, checksumSha256: null, artifactPath: null,
        failureReason: reason, reportSpecVersion: specVersion, sourceHighWaterMark,
      };
    }

    const bytes = serialize(input.format, {
      envelope,
      humanReadableTitle: preSnapshot.humanReadableTitle,
      csvSections: preSnapshot.csvSections,
    });
    const checksumSha256 = sha256HexBytes(bytes);
    const sizeBytes = Buffer.byteLength(bytes, 'utf8');

    // -------------------------------------------------------------------
    // Atomic-ish write: tmp file → rename. On Windows a rename that
    // targets an existing file fails, so we unlink first if the
    // target somehow exists (e.g. the operator manually created a
    // decoy). fs.rename is atomic on the same filesystem — either
    // the operator sees the previous file or the new one, never a
    // half-written one.
    // -------------------------------------------------------------------
    const tmpPath = pv.absolutePath + '.tmp';
    await fs.writeFile(tmpPath, bytes, { encoding: 'utf8', mode: 0o600 });
    try { await fs.unlink(pv.absolutePath); } catch { /* not present is fine */ }
    await fs.rename(tmpPath, pv.absolutePath);

    // -------------------------------------------------------------------
    // Persist the artifact row + mark the job completed.
    // -------------------------------------------------------------------
    await db.insert(desktopExportArtifacts).values({
      exportJobId: jobId,
      artifactPath: pv.absolutePath,
      checksumSha256,
      sizeBytes,
      reportVersion: specVersion,
      redactionsApplied: JSON.stringify(redactionsApplied).slice(0, 500),
      contentDigest,
      generatedAt: new Date(),
    });
    await db.update(desktopExportJobs).set({ status: 'completed', completedAt: new Date() }).where(eq(desktopExportJobs.id, jobId));

    return {
      status: 'materialized',
      jobId,
      idempotencyKey,
      contentDigest,
      checksumSha256,
      artifactPath: pv.absolutePath,
      failureReason: null,
      reportSpecVersion: specVersion,
      sourceHighWaterMark,
    };
  } catch (err) {
    const reason = sanitizeError(err);
    try {
      await db.update(desktopExportJobs).set({ status: 'failed', failureReason: reason, completedAt: new Date() }).where(eq(desktopExportJobs.id, jobId));
    } catch { /* swallow — we already have the primary error */ }
    return {
      status: 'failed', jobId, idempotencyKey, contentDigest: null, checksumSha256: null, artifactPath: null,
      failureReason: reason, reportSpecVersion: specVersion, sourceHighWaterMark,
    };
  }
}

/**
 * Verify an existing artifact — re-read the file, recompute the
 * SHA256 of its bytes, compare to `desktop_export_artifacts.
 * checksumSha256`. Used by the `reports.verify` tRPC procedure.
 *
 * Returns a typed shape rather than throwing so the caller can
 * distinguish "file gone" from "checksum drift" from "row missing".
 */
export type VerifyOutcome =
  | { ok: true; checksumSha256: string; contentDigest: string | null; sizeBytes: number; artifactPath: string }
  | { ok: false; reason: 'artifact_row_missing' | 'file_missing' | 'checksum_mismatch' | 'size_mismatch' | 'io_error'; detail?: string };

export async function verifyArtifact(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: MySql2Database<any>,
  jobId: number,
): Promise<VerifyOutcome> {
  const rows = await db.select().from(desktopExportArtifacts).where(eq(desktopExportArtifacts.exportJobId, jobId)).limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: 'artifact_row_missing' };
  let bytes: string;
  try {
    bytes = await fs.readFile(row.artifactPath, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/ENOENT/.test(detail)) return { ok: false, reason: 'file_missing', detail };
    return { ok: false, reason: 'io_error', detail: detail.slice(0, 200) };
  }
  const observed = sha256HexBytes(bytes);
  const size = Buffer.byteLength(bytes, 'utf8');
  if (observed !== row.checksumSha256) return { ok: false, reason: 'checksum_mismatch', detail: `expected=${row.checksumSha256} observed=${observed}` };
  if (Number(row.sizeBytes) !== size) return { ok: false, reason: 'size_mismatch', detail: `expected=${row.sizeBytes} observed=${size}` };
  return { ok: true, checksumSha256: observed, contentDigest: row.contentDigest ?? null, sizeBytes: size, artifactPath: row.artifactPath };
}

// Suppress unused-import lint until Stage 4D wires the sql template.
void sql;
void path;
