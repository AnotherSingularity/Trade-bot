import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

/**
 * Stage 2-FIX §1 — deterministic test-database bootstrap.
 *
 * The server suite runs against a DEDICATED database
 * (`horizon_trade_test` unless DATABASE_URL overrides it). This global
 * setup is the ONLY code allowed to create or rebuild that database:
 *
 *   - If the database is absent → create it and apply every checked-in
 *     migration.
 *   - If the database exists but its applied-migration count does not
 *     match the checked-in migration files (stale schema from an older
 *     checkout) → rebuild it from scratch.
 *   - If it exists and matches → leave it untouched (fast path).
 *
 * Individual tests NEVER drop or recreate this database; they clean the
 * specific rows they own. Integration tests that need a disposable
 * database mint uniquely-named scratch databases instead (see the
 * desktop tests' scratchDb helper).
 *
 * The suite therefore passes from a clean checkout with only MariaDB +
 * Redis running — no manual database repair.
 */

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const migrationsDir = resolve(__dirname, '..', 'drizzle', 'migrations');

const DATABASE_URL = process.env.DATABASE_URL ?? 'mysql://root:password@127.0.0.1:3306/horizon_trade_test';

function splitStatements(sql: string): string[] {
  return sql
    .replace(/-->\s*statement-breakpoint/g, '')
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default async function globalSetup(): Promise<void> {
  const url = new URL(DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `globalSetup refuses to manage database '${dbName}' — the server test suite must target a *_test database`,
    );
  }
  const rootUri = DATABASE_URL.replace(/\/[^/]+$/, '');

  let root: mysql.Connection;
  try {
    root = await mysql.createConnection({ uri: rootUri, connectTimeout: 3_000 });
  } catch (e) {
    console.warn(`[globalSetup] MariaDB unreachable (${String(e).slice(0, 120)}) — DB-backed tests will fail/skip`);
    return;
  }

  const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  try {
    await root.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);

    const [applied] = await root.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = '__drizzle_migrations'`,
      [dbName],
    );
    let appliedCount = 0;
    if (Number(applied[0].n) > 0) {
      const [rows] = await root.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${dbName}\`.__drizzle_migrations`);
      appliedCount = Number(rows[0].n);
    }

    if (appliedCount === migrationFiles.length) {
      return; // schema current — untouched
    }

    console.log(
      `[globalSetup] rebuilding ${dbName}: applied=${appliedCount} expected=${migrationFiles.length}`,
    );
    await root.query(`DROP DATABASE \`${dbName}\``);
    await root.query(`CREATE DATABASE \`${dbName}\``);

    const conn = await mysql.createConnection({ uri: `${rootUri}/${dbName}` });
    try {
      for (const f of migrationFiles) {
        for (const stmt of splitStatements(readFileSync(join(migrationsDir, f), 'utf-8'))) {
          await conn.query(stmt);
        }
      }
      await conn.query(
        'CREATE TABLE __drizzle_migrations (id INT PRIMARY KEY AUTO_INCREMENT, hash VARCHAR(64), created_at BIGINT)',
      );
      for (let i = 0; i < migrationFiles.length; i++) {
        await conn.query('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, UNIX_TIMESTAMP()*1000)', [
          migrationFiles[i].slice(0, 64),
        ]);
      }
    } finally {
      await conn.end();
    }
    console.log(`[globalSetup] ${dbName} rebuilt with ${migrationFiles.length} migrations`);
  } finally {
    await root.end();
  }
}
