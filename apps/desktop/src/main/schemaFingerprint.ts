/**
 * Stage 1 §8 — Real schema fingerprint verification.
 *
 * Computes a fingerprint of the live database's INFORMATION_SCHEMA
 * (tables + columns + primary keys + foreign keys) and compares it
 * against a canonical fingerprint file shipped with the release.
 *
 * States: verified | migration_required | fingerprint_mismatch |
 *         unsupported_schema | verification_failed
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection, type ConnectionOptions } from 'mysql2/promise';

export type FingerprintState =
  | 'verified'
  | 'migration_required'
  | 'fingerprint_mismatch'
  | 'unsupported_schema'
  | 'verification_failed';

export interface FingerprintResult {
  state: FingerprintState;
  detail?: string;
  expectedFingerprint?: string;
  actualFingerprint?: string;
  migrationJournalHead?: number;
}

export interface FingerprintInput {
  connection: ConnectionOptions;
  expectedFingerprintPath: string;
  migrationTable?: string;
  timeoutMs?: number;
}

export interface CanonicalFingerprint {
  fingerprint: string;
  migrationJournalHead: number;
  schemaName: string;
}

const DEFAULT_MIGRATION_TABLE = '__drizzle_migrations';

export class SchemaFingerprintVerifier {
  async verify(input: FingerprintInput): Promise<FingerprintResult> {
    let canonical: CanonicalFingerprint;
    try {
      canonical = readCanonical(input.expectedFingerprintPath);
    } catch (e) {
      return { state: 'verification_failed', detail: `expected fingerprint missing: ${String(e).slice(0, 200)}` };
    }

    const conn = await createConnection({ ...input.connection, connectTimeout: input.timeoutMs ?? 4_000, multipleStatements: false });
    try {
      const migTable = input.migrationTable ?? DEFAULT_MIGRATION_TABLE;
      const [presenceRows] = await conn.query(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?',
        [migTable],
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const migTableExists = Number((presenceRows as any[])[0]?.n ?? 0) > 0;
      if (!migTableExists) {
        return { state: 'migration_required', detail: 'migration table absent', expectedFingerprint: canonical.fingerprint, migrationJournalHead: canonical.migrationJournalHead };
      }

      const [cntRows] = await conn.query(`SELECT COUNT(*) AS n FROM \`${migTable}\``);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const migCount = Number((cntRows as any[])[0]?.n ?? 0);
      if (migCount < canonical.migrationJournalHead) {
        return { state: 'migration_required', detail: `migrations applied=${migCount}, expected=${canonical.migrationJournalHead}`, expectedFingerprint: canonical.fingerprint, migrationJournalHead: canonical.migrationJournalHead };
      }
      if (migCount > canonical.migrationJournalHead) {
        return { state: 'unsupported_schema', detail: `migrations applied=${migCount} exceeds canonical head=${canonical.migrationJournalHead}`, expectedFingerprint: canonical.fingerprint, migrationJournalHead: canonical.migrationJournalHead };
      }

      const actual = await computeLiveFingerprint(conn);
      if (actual === canonical.fingerprint) {
        return { state: 'verified', expectedFingerprint: canonical.fingerprint, actualFingerprint: actual, migrationJournalHead: migCount };
      }
      return {
        state: 'fingerprint_mismatch',
        detail: 'canonical fingerprint differs from live INFORMATION_SCHEMA hash',
        expectedFingerprint: canonical.fingerprint,
        actualFingerprint: actual,
        migrationJournalHead: migCount,
      };
    } catch (e) {
      return { state: 'verification_failed', detail: String(e).slice(0, 200) };
    } finally {
      try { await conn.end(); } catch { /* connection already closed */ }
    }
  }
}

function readCanonical(path: string): CanonicalFingerprint {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = parsed as any;
  if (typeof p?.fingerprint === 'string' && typeof p?.migrationJournalHead === 'number' && typeof p?.schemaName === 'string') {
    return { fingerprint: p.fingerprint, migrationJournalHead: p.migrationJournalHead, schemaName: p.schemaName };
  }
  // Legacy Drizzle fingerprints: hash the whole file to a canonical value.
  const fp = createHash('sha256').update(raw).digest('hex');
  const journalMatch = raw.match(/"version"\s*:\s*"(\d+)"/);
  return {
    fingerprint: fp,
    migrationJournalHead: journalMatch ? Number(journalMatch[1]) : 0,
    schemaName: 'horizon_trade',
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function computeLiveFingerprint(conn: any): Promise<string> {
  const [tables] = await conn.query(
    "SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME",
  );
  const h = createHash('sha256');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const t of tables as any[]) {
    const name = String(t.TABLE_NAME);
    h.update('T:');
    h.update(name);
    h.update('\n');
    const [cols] = await conn.query(
      'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',
      [name],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const c of cols as any[]) {
      h.update(`C:${c.COLUMN_NAME}|${c.COLUMN_TYPE}|${c.IS_NULLABLE}|${c.COLUMN_KEY}|${c.COLUMN_DEFAULT ?? ''}|${c.EXTRA ?? ''}\n`);
    }
    const [pks] = await conn.query(
      "SELECT COLUMN_NAME FROM information_schema.key_column_usage WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME='PRIMARY' ORDER BY ORDINAL_POSITION",
      [name],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const p of pks as any[]) h.update(`P:${p.COLUMN_NAME}\n`);
    const [fks] = await conn.query(
      "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.key_column_usage WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION",
      [name],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const f of fks as any[]) {
      h.update(`F:${f.CONSTRAINT_NAME}|${f.COLUMN_NAME}|${f.REFERENCED_TABLE_NAME}|${f.REFERENCED_COLUMN_NAME}\n`);
    }
  }
  return h.digest('hex');
}
