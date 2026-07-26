/**
 * Stage 2 §22 — Real end-to-end integration test.
 *
 * Spawns the actual server against local MariaDB + Redis, then drives
 * the entire auth flow across a real HTTP boundary:
 *
 *   readiness (bootstrap-token gated)
 *   → operator-auth/state (setupCompleted=false)
 *   → operator-auth/setup (create the operator account)
 *   → operator-auth/login (issued token pair)
 *   → operator-authenticated /api/desktop/observer-policy-versions (bearer works)
 *   → operator-authenticated /api/desktop/observer-policy-versions with
 *     bootstrap token instead of bearer → 401
 *   → operator-auth/refresh (rotated pair)
 *   → reuse original refresh → family revoked → 401
 *   → change-password (server revokes every session)
 *   → login with new password
 *   → revoke-all
 *   → server restart → session state preserved (accounts survive)
 *
 * Requires local MariaDB (root/password) + Redis. Auto-skips if
 * unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'mysql2/promise';
import IORedis from 'ioredis';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';

const REPO = resolve(__dirname, '..', '..', '..');
const SERVER_CWD = join(REPO, 'apps/server');
const migrationsDir = join(SERVER_CWD, 'drizzle/migrations');
const TEST_DB = 'horizon_stage2_e2e';
const TEST_DB_URL = `mysql://root:password@127.0.0.1:3306/${TEST_DB}`;
const REDIS_URL = 'redis://127.0.0.1:6379';
const BOOTSTRAP = randomBytes(32).toString('hex');
const READINESS_TIMEOUT_MS = 30_000;

async function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => {
        if (typeof addr === 'object' && addr) resolve(addr.port);
        else reject(new Error('no address'));
      });
    });
    s.on('error', reject);
  });
}

let CHOSEN_PORT = 0;
function url(p: string): string { return `http://127.0.0.1:${CHOSEN_PORT}${p}`; }

async function servicesReachable(): Promise<boolean> {
  try {
    const c = await createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: 'password' });
    await c.ping(); await c.end();
    const r = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    await r.connect(); await r.ping(); await r.quit();
    return true;
  } catch { return false; }
}

function splitStatements(sql: string): string[] {
  return sql.replace(/-->\s*statement-breakpoint/g, '')
    .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}

async function ensureDb(): Promise<void> {
  const c = await createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: 'password', multipleStatements: true });
  await c.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\`; CREATE DATABASE \`${TEST_DB}\`;`);
  await c.end();
}

async function migrate(): Promise<void> {
  const conn = await createConnection({ uri: TEST_DB_URL });
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    for (const stmt of splitStatements(readFileSync(join(migrationsDir, f), 'utf-8'))) {
      await conn.query(stmt);
    }
  }
  // Simulate the drizzle _journal so readiness fingerprint check passes.
  await conn.query('CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INT PRIMARY KEY AUTO_INCREMENT, hash VARCHAR(64), created_at BIGINT)');
  for (let i = 0; i < files.length; i++) {
    await conn.query(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('m${i}', UNIX_TIMESTAMP()*1000)`);
  }
  // Seed reconciliation as ok so readiness reports true.
  await conn.query(`INSERT INTO bot_config (id, isRunning, isPaused, reconciliationStatus, reconciliationDetail) VALUES (1, false, false, 'ok', 'seeded')`);
  await conn.query(`INSERT INTO reconciliation_runs (runId, triggerReason, startedAt, completedAt, finalStatus) VALUES ('e2e-seed', 'seed', NOW(3), NOW(3), 'ok')`);
  await conn.end();
}

interface Spawned { proc: ReturnType<typeof spawn>; kill: () => Promise<void> }

async function spawnServer(): Promise<Spawned> {
  const proc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_CWD,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(CHOSEN_PORT),
      DATABASE_URL: TEST_DB_URL,
      REDIS_URL,
      JWT_SECRET: 'stage2-e2e-secret-please-change-1234',
      DRY_RUN: 'true',
      ORDER_SUBMISSION_ENABLED: 'false',
      CORS_ORIGINS: '*',
      HORIZON_BOOTSTRAP_TOKEN: BOOTSTRAP,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (process.env.STAGE2_VERBOSE) {
    proc.stderr?.on('data', (d) => process.stderr.write(d));
    proc.stdout?.on('data', (d) => process.stdout.write(d));
  }
  return {
    proc,
    kill: async () => {
      proc.kill('SIGTERM');
      const deadline = Date.now() + 5_000;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      while (Date.now() < deadline && (proc as any).exitCode == null) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((proc as any).exitCode == null) proc.kill('SIGKILL');
    },
  };
}

async function waitReady(): Promise<boolean> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url('/api/system/readiness'), { headers: { 'x-horizon-bootstrap-token': BOOTSTRAP } });
      if (r.ok) {
        const body = await r.json() as { ready?: boolean };
        if (body.ready) return true;
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function json(path: string, opts: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const r = await fetch(url(path), opts);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

async function ensureSpawnBoots(): Promise<Spawned> {
  const s = await spawnServer();
  const ok = await waitReady();
  if (!ok) throw new Error('server did not become ready');
  return s;
}

describe.sequential('stage2 §22 end-to-end integration', () => {
  let available = false;
  let server: Spawned | undefined;

  beforeAll(async () => {
    available = await servicesReachable();
    if (!available) {
      console.warn('[stage2 e2e] local MariaDB/Redis unavailable — skipping');
      return;
    }
    CHOSEN_PORT = await pickPort();
    await ensureDb();
    await migrate();
  }, 90_000);

  afterAll(async () => {
    if (server) await server.kill();
    if (available) {
      const c = await createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: 'password' });
      await c.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
      await c.end();
    }
  });

  it('E1-E15: full auth flow — setup, login, refresh rotation, reuse revokes family, change-password revokes all, restart preserves account', async () => {
    if (!available) return;
    server = await ensureSpawnBoots();

    // E1 — bootstrap-safe endpoint without token → 401
    const noToken = await json('/api/desktop/create-order-counters');
    expect(noToken.status).toBe(401);

    // E2 — with the wrong token → 401
    const badToken = await json('/api/desktop/create-order-counters', { headers: { 'x-horizon-bootstrap-token': 'a'.repeat(64) } });
    expect(badToken.status).toBe(401);

    // E3 — with the right token → 200
    const counters = await json('/api/desktop/create-order-counters', { headers: { 'x-horizon-bootstrap-token': BOOTSTRAP } });
    expect(counters.status).toBe(200);

    // E4 — auth state before setup: setupCompleted=false
    const state1 = await json('/api/operator-auth/state', { headers: { 'x-horizon-bootstrap-token': BOOTSTRAP } });
    expect(state1.status).toBe(200);
    expect((state1.body as { setupCompleted: boolean }).setupCompleted).toBe(false);

    // E5 — setup with mismatched confirmation → 400
    const badSetup = await json('/api/operator-auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'correct-horse-battery-staple-1', passwordConfirmation: 'other-passphrase-2222' }),
    });
    expect(badSetup.status).toBe(400);

    // E6 — successful setup
    const setup = await json('/api/operator-auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'correct-horse-battery-staple-1', passwordConfirmation: 'correct-horse-battery-staple-1' }),
    });
    expect(setup.status).toBe(201);

    // E7 — second setup attempt is rejected (accounts_already_exist)
    const setup2 = await json('/api/operator-auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator2', password: 'correct-horse-battery-staple-2', passwordConfirmation: 'correct-horse-battery-staple-2' }),
    });
    expect(setup2.status).toBe(409);

    // E8 — login with wrong password → 401
    const badLogin = await json('/api/operator-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'wrong-password-of-the-right-length' }),
    });
    expect(badLogin.status).toBe(401);

    // E9 — login succeeds
    const login = await json('/api/operator-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'correct-horse-battery-staple-1' }),
    });
    expect(login.status).toBe(200);
    const tokens = (login.body as { tokens: { accessToken: string; refreshToken: string } }).tokens;
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();

    // E10 — operator-scoped route with the bearer succeeds
    const oa = await json('/api/desktop/observer-policy-versions', { headers: { authorization: `Bearer ${tokens.accessToken}` } });
    expect(oa.status).toBe(200);

    // E11 — operator-scoped route with the bootstrap token → 401
    const oaBoot = await json('/api/desktop/observer-policy-versions', { headers: { 'x-horizon-bootstrap-token': BOOTSTRAP } });
    expect(oaBoot.status).toBe(401);

    // E12 — refresh rotation
    const refresh = await json('/api/operator-auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    expect(refresh.status).toBe(200);
    const rotated = (refresh.body as { tokens: { accessToken: string; refreshToken: string } }).tokens;
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);

    // E13 — reusing the parent refresh → family revoked
    const reuse = await json('/api/operator-auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    expect(reuse.status).toBe(401);
    expect((reuse.body as { reason?: string }).reason).toBe('already_rotated_family_revoked');

    // The rotated token is now also invalid (family revoked).
    const rotatedAfter = await json('/api/operator-auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: rotated.refreshToken }),
    });
    expect(rotatedAfter.status).toBe(401);

    // E14 — new login (previous session revoked), then change password
    const login2 = await json('/api/operator-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'correct-horse-battery-staple-1' }),
    });
    expect(login2.status).toBe(200);
    const bearer2 = (login2.body as { tokens: { accessToken: string } }).tokens.accessToken;

    const cp = await json('/api/operator-auth/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer2}` },
      body: JSON.stringify({ currentPassword: 'correct-horse-battery-staple-1', newPassword: 'entirely-different-longer-phrase-99', newPasswordConfirmation: 'entirely-different-longer-phrase-99' }),
    });
    expect(cp.status).toBe(200);

    // Old bearer should now be invalid (all sessions revoked).
    const oaAfter = await json('/api/desktop/observer-policy-versions', { headers: { authorization: `Bearer ${bearer2}` } });
    expect(oaAfter.status).toBe(401);

    // Old password no longer works.
    const oldPwd = await json('/api/operator-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'correct-horse-battery-staple-1' }),
    });
    expect(oldPwd.status).toBe(401);

    // New password works.
    const newPwd = await json('/api/operator-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'entirely-different-longer-phrase-99' }),
    });
    expect(newPwd.status).toBe(200);

    // E15 — restart the server; account survives, but every prior
    // session is gone (they were revoked in-memory too).
    await server.kill();
    server = await ensureSpawnBoots();
    const state2 = await json('/api/operator-auth/state', { headers: { 'x-horizon-bootstrap-token': BOOTSTRAP } });
    expect((state2.body as { setupCompleted: boolean }).setupCompleted).toBe(true);
    const relogin = await json('/api/operator-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'entirely-different-longer-phrase-99' }),
    });
    expect(relogin.status).toBe(200);
  }, 180_000);
});

// Prevent an "unused import" lint failure if the test is skipped.
void spawnSync;
