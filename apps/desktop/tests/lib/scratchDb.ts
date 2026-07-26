import { createConnection } from 'mysql2/promise';

/**
 * Stage 2-FIX §1 — scratch-database discipline for integration tests.
 *
 * Every integration test that needs a real MariaDB database mints a
 * UNIQUELY-NAMED scratch database through this helper. The helper is the
 * only sanctioned path for CREATE/DROP DATABASE in the desktop test
 * suite, and it structurally refuses to touch anything that is not a
 * scratch database:
 *
 *   - Names must carry the `hzn_scratch_` prefix.
 *   - The protected databases (application DB, the server suite's shared
 *     test DB, and MariaDB system schemas) are hard-rejected even if a
 *     caller passes them explicitly.
 *   - Names embed pid + timestamp + random suffix so two concurrent runs
 *     can never collide.
 *
 * The stage2fix_db_isolation regression test asserts these guarantees.
 */

export const SCRATCH_PREFIX = 'hzn_scratch_';

export const PROTECTED_DATABASES = [
  'horizon_trade',
  'horizon_trade_test',
  'mysql',
  'information_schema',
  'performance_schema',
  'sys',
] as const;

export function makeScratchDbName(label: string): string {
  if (!/^[a-z0-9_]{1,20}$/.test(label)) {
    throw new Error(`scratch label must be short snake_case; got '${label}'`);
  }
  const unique = `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')}`;
  // MariaDB identifier limit is 64 chars; this stays well under.
  return `${SCRATCH_PREFIX}${label}_${process.pid}_${unique}`;
}

export function assertScratchDb(name: string): void {
  if ((PROTECTED_DATABASES as readonly string[]).includes(name)) {
    throw new Error(`refusing to operate on protected database '${name}'`);
  }
  if (!name.startsWith(SCRATCH_PREFIX)) {
    throw new Error(`'${name}' is not a scratch database (missing '${SCRATCH_PREFIX}' prefix)`);
  }
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`scratch database name contains invalid characters: '${name}'`);
  }
}

const DEFAULT_ROOT = { host: '127.0.0.1', port: 3306, user: 'root', password: 'password' };

export async function createScratchDb(name: string): Promise<void> {
  assertScratchDb(name);
  const c = await createConnection(DEFAULT_ROOT);
  try {
    await c.query(`CREATE DATABASE \`${name}\``);
  } finally {
    await c.end();
  }
}

export async function dropScratchDb(name: string): Promise<void> {
  assertScratchDb(name);
  const c = await createConnection(DEFAULT_ROOT);
  try {
    await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
  } finally {
    await c.end();
  }
}

export function scratchDbUrl(name: string): string {
  assertScratchDb(name);
  return `mysql://root:password@127.0.0.1:3306/${name}`;
}
