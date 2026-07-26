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
  | 'engine_not_mariadb'
  | 'database_missing'
  | 'migration_table_missing'
  | 'transaction_unsupported'
  | 'probe_threw';

export interface MariadbProbeResult {
  ok: boolean;
  reason?: MariadbFailureReason;
  detail?: string;
  serverVersion?: string;
  serverEngine?: 'mariadb' | 'mysql' | 'unknown';
  currentDatabase?: string;
  migrationCount?: number;
}

const MIN_MARIADB_MAJOR = 10;

export type EngineEnforcement = 'strict_mariadb' | 'accept_both';

export interface MariadbProbeInput {
  connection: ConnectionOptions;
  expectedDatabase: string;
  migrationTable?: string;
  timeoutMs?: number;
  // Stage 1-FIX §A: production rejects MySQL because migrations +
  // fingerprints were produced against MariaDB. Only the fixture /
  // test harness may opt into accept_both.
  engineEnforcement?: EngineEnforcement;
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
      const engine: MariadbProbeResult['serverEngine'] = /mariadb/i.test(v)
        ? 'mariadb' : /^\d+\./.test(v) ? 'mysql' : 'unknown';
      const enforcement: EngineEnforcement = input.engineEnforcement ?? 'strict_mariadb';
      if (enforcement === 'strict_mariadb' && engine !== 'mariadb') {
        return { ok: false, reason: 'engine_not_mariadb', detail: `engine=${engine}; version=${v}`, serverVersion: v, serverEngine: engine };
      }
      const versionOk = supportsVersion(v);
      if (!versionOk.ok) return { ok: false, reason: 'unsupported_version', detail: v, serverVersion: v, serverEngine: engine };

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

      return { ok: true, serverVersion: v, serverEngine: engine, currentDatabase: currentDb, migrationCount };
    } catch (e) {
      return { ok: false, reason: 'probe_threw', detail: String(e).slice(0, 200) };
    } finally {
      try { await conn?.end(); } catch { /* connection already closed */ }
    }
  }
}

export function supportsVersion(version: string): { ok: boolean; reason?: string } {
  // Canonical engine: MariaDB 10+. MySQL is only accepted when the
  // caller explicitly asks for accept_both engine enforcement — a
  // separate database-portability certification would be required
  // to make that the production default.
  const m = version.match(/^(\d+)\.(\d+)/);
  if (!m) return { ok: false, reason: 'unparseable_version' };
  const major = Number(m[1]);
  if (/mariadb/i.test(version)) {
    if (major >= MIN_MARIADB_MAJOR) return { ok: true };
    return { ok: false, reason: `mariadb<${MIN_MARIADB_MAJOR}` };
  }
  // Non-MariaDB engine. supportsVersion returns ok for MySQL 8+
  // ONLY when the caller has already relaxed engineEnforcement to
  // accept_both. The strict path in `probe()` catches this earlier.
  if (major >= 8) return { ok: true };
  return { ok: false, reason: `mysql<8` };
}
