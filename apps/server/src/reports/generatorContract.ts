/**
 * Stage 4 §S4B — generator contract.
 *
 * Every one of the 13 report generators implements
 * `ReportGenerator<K>`. The worker constructs `GeneratorContext`
 * (snapshot connection, installationId), calls `generate`, then
 * feeds the result into the redaction wrapper, envelope composition,
 * and format-specific serializer.
 *
 * Design constraints:
 *   1. The generator MUST NOT invoke any economic-writer path.
 *      Report generation is read-only over the query surface Stage
 *      3A/3B already exposes (queries/domains.ts, queries/overview.ts,
 *      etc). Calling into scanner/executor/reconciler paths is a
 *      Stage 4 violation.
 *   2. The generator MUST snapshot its sourceHighWaterMark BEFORE
 *      reading source data, then guard subsequent reads with
 *      `WHERE id <= hwm` OR run inside a repeatable-read transaction
 *      passed via `ctx.db`. The Stage 4C worker owns the transaction;
 *      the generator only needs to be honest about which tables it
 *      consulted (record every source table's max id in
 *      sourceHighWaterMark, even if the current pass only reads a
 *      subset).
 *   3. Every string emitted anywhere in `payload` goes through the
 *      Stage 4A.1b `redact()` wrapper BEFORE assembly. The generator
 *      returns the raw payload; the worker applies redaction. This
 *      keeps generators focused on data selection.
 *   4. `csvSections` is the generator's authoritative tabular
 *      projection. Zero sections is legal (some reports are purely
 *      envelope-metadata) but discouraged; prefer at least one
 *      section per meaningful entity.
 *   5. `sourceQueryVersions` lists every query module's
 *      `sourceVersion` the generator consulted so
 *      contract-version drift in a shared query flows into the
 *      artifact's contentDigest.
 */

import type { MySql2Database } from 'drizzle-orm/mysql2';
import type { ReportKind, SourceHighWaterMark } from '@horizon/shared';
import type { CsvSection } from './serialize';

export interface GeneratorContext {
  /**
   * Read-only DB handle. In production the Stage 4C worker binds
   * this to a REPEATABLE READ transaction so every read in the
   * generator sees a consistent snapshot of the DB even if a scan
   * is running concurrently. Tests may pass a plain `db` reference
   * for simple determinism proofs.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: MySql2Database<any>;
  readonly installationId: number;
}

/**
 * Raw generator output. The worker applies redaction to `rawPayload`
 * before assembling the canonical envelope, so `redactionsApplied`
 * is filled in downstream. The generator MUST NOT redact its own
 * payload — the wrapper is the single source of the audit trail.
 */
export interface GeneratorRawOutput {
  readonly rawPayload: unknown;
  readonly sourceHighWaterMark: SourceHighWaterMark;
  readonly sourceQueryVersions: readonly string[];
  readonly csvSections: readonly CsvSection[];
  readonly humanReadableTitle: string;
}

export interface ReportGenerator<K extends ReportKind = ReportKind> {
  readonly kind: K;
  readonly specVersion: string;
  generate(ctx: GeneratorContext): Promise<GeneratorRawOutput>;
}
