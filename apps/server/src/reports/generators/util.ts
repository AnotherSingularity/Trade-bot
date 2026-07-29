/**
 * Stage 4 §S4B — shared generator helpers.
 *
 * Small utilities every generator needs. Kept intentionally narrow so
 * the per-kind generator files stay focused on the projection they
 * emit rather than on plumbing.
 */

import { sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import type { CsvSection } from '../serialize';

/**
 * Snapshot MAX(id) for a list of source tables in one round-trip and
 * return the map shape SourceHighWaterMark expects. `null` means the
 * table exists but has no rows (a legitimate snapshot value —
 * distinct from the field being absent, which would mean "not
 * consulted"). Every generator MUST record every table it consulted
 * even if the current call didn't read from it — omission would
 * leave silent idempotency drift.
 */
export async function snapshotMaxIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: MySql2Database<any>,
  tables: readonly string[],
): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  for (const t of tables) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(t)) {
      throw new Error(`snapshotMaxIds: refusing unsafe table name ${t}`);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await db.execute(sql.raw(`SELECT MAX(id) AS m FROM \`${t}\``)) as any;
      const rows = extractRows(res);
      const row = rows[0] as { m: number | string | null } | undefined;
      const v = row?.m;
      out[t] = v === null || v === undefined ? null : Number(v);
    } catch {
      // Table missing / query failure → treat as "consulted, empty".
      // The generator still records the key so subsequent runs are
      // structurally comparable.
      out[t] = null;
    }
  }
  return out;
}

/**
 * Drizzle's mysql2 driver returns [rows, fields] tuples; older
 * paths return `{ rows: [...] }`. Normalise to a flat array of
 * plain objects so callers don't have to remember which shape they got.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractRows(res: any): Array<Record<string, unknown>> {
  if (res == null) return [];
  if (Array.isArray(res) && Array.isArray(res[0])) return res[0] as Array<Record<string, unknown>>;
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  if (Array.isArray(res.rows)) return res.rows as Array<Record<string, unknown>>;
  return [];
}

/**
 * Render a KV-style CSV section from a flat record. Values are
 * stringified via canonical rules — booleans → 'true'/'false',
 * numbers left as-is, nested objects → canonical JSON string.
 */
export function kvSection(title: string, record: Record<string, unknown>): CsvSection {
  const rows: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(record).sort(([a], [b]) => a.localeCompare(b))) {
    rows.push([k, formatCell(v)]);
  }
  return { title, columns: ['field', 'value'], rows };
}

/**
 * Table CSV section — one column set, one row per input record.
 * The generator picks the column order; unmatched keys are ignored.
 */
export function tableSection<T extends Record<string, unknown>>(
  title: string,
  columns: readonly (keyof T & string)[],
  items: readonly T[],
): CsvSection {
  return {
    title,
    columns: [...columns],
    rows: items.map((r) => columns.map((c) => formatCell(r[c]))),
  };
}

export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
