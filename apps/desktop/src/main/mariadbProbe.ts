/**
 * Stage 1 §5 — Real MariaDB probe.
 *
 * Verifies reachability, authentication, supported server version,
 * expected database, migration table, and transaction capability.
 * Uses mysql2/promise; connection strings come from the operator's
 * environment or keytar-backed secrets — never inlined.
 */

import { createConnection, type Connection, type ConnectionOptions } from 'mysql2/promise';

export type MariadbFailureReason =
  | 'unreachable'
  | 'auth_failed'
  | 'unsupported_version'
  | 'database_missing'
  | 'migration_table_missing'
  | 'transaction_unsupported'
  | 'probe_threw';

export interface MariadbProbeResult {
  ok: boolean;
  reason?: MariadbFailureReason;
  detail?: string;
  serverVersion?: string;
  currentDatabase?: string;
  migrationCount?: number;
}

const MIN_MAJOR = 8;   // MySQL 8+
const MIN_MARIADB_MAJOR = 10;

export interface MariadbProbeInput {
  connection: ConnectionOptions;
  expectedDatabase: string;
  migrationTable?: string;
  timeoutMs?: number;
}

const DEFAULT_MIGRATION_TABLE = '__drizzle_migrations';

export class MariadbProbe {
  async probe(input: MariadbProbeInput): Promise<MariadbProbeResult> {
    let conn: Connection | undefined;
    try {
      conn = await createConnection({
        ...input.connection,
        connectTimeout: input.timeoutMs ?? 4_000,
        // Never hold long connections open for a probe.
        multipleStatements: false,
      });
    } catch (e) {
      const msg = String(e).slice(0, 200);
      if (/access denied|ER_ACCESS_DENIED_ERROR/i.test(msg)) {
        return { ok: false, reason: 'auth_failed', detail: 'authentication rejected' };
      }
      if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/.test(msg)) {
        return { ok: false, reason: 'unreachable', detail: 'connection refused/timeout' };
      }
      if (/Unknown database|ER_BAD_DB_ERROR/i.test(msg)) {
        return { ok: false, reason: 'database_missing', detail: input.expectedDatabase };
      }
      return { ok: false, reason: 'probe_threw', detail: msg };
    }

    try {
      const [verRows] = await conn.query('SELECT VERSION() AS v');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = String((verRows as any[])[0]?.v ?? '');
      const versionOk = supportsVersion(v);
      if (!versionOk.ok) return { ok: false, reason: 'unsupported_version', detail: v, serverVersion: v };

      const [dbRows] = await conn.query('SELECT DATABASE() AS db');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const currentDb = String((dbRows as any[])[0]?.db ?? '');
      if (!currentDb) {
        return { ok: false, reason: 'database_missing', detail: input.expectedDatabase, serverVersion: v };
      }
      if (currentDb !== input.expectedDatabase) {
        return {
          ok: false, reason: 'database_missing',
          detail: `expected=${input.expectedDatabase}; connected=${currentDb}`,
          serverVersion: v,
        };
      }

      const migrationTable = input.migrationTable ?? DEFAULT_MIGRATION_TABLE;
      // The migration table might not exist yet on a fresh install.
      const [tableRows] = await conn.query(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
        [currentDb, migrationTable],
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tablePresent = Number((tableRows as any[])[0]?.n ?? 0) > 0;
      let migrationCount = 0;
      if (tablePresent) {
        const [cntRows] = await conn.query(`SELECT COUNT(*) AS n FROM \`${migrationTable}\``);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        migrationCount = Number((cntRows as any[])[0]?.n ?? 0);
      }

      // Transaction capability check.
      try {
        await conn.beginTransaction();
        await conn.rollback();
      } catch {
        return { ok: false, reason: 'transaction_unsupported', detail: 'begin/rollback failed', serverVersion: v, currentDatabase: currentDb, migrationCount };
      }

      return { ok: true, serverVersion: v, currentDatabase: currentDb, migrationCount };
    } catch (e) {
      return { ok: false, reason: 'probe_threw', detail: String(e).slice(0, 200) };
    } finally {
      try { await conn?.end(); } catch { /* connection already closed */ }
    }
  }
}

export function supportsVersion(version: string): { ok: boolean; reason?: string } {
  // Accept MySQL 8.x or MariaDB 10.x/11.x.
  const m = version.match(/^(\d+)\.(\d+)/);
  if (!m) return { ok: false, reason: 'unparseable_version' };
  const major = Number(m[1]);
  if (/mariadb/i.test(version)) {
    if (major >= MIN_MARIADB_MAJOR) return { ok: true };
    return { ok: false, reason: `mariadb<${MIN_MARIADB_MAJOR}` };
  }
  if (major >= MIN_MAJOR) return { ok: true };
  return { ok: false, reason: `mysql<${MIN_MAJOR}` };
}
