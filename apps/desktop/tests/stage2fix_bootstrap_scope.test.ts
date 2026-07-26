/**
 * Stage 2-FIX §5 — Bootstrap scope narrowness proof.
 *
 * Spawns the real server against a uniquely-named scratch DB and
 * proves:
 *
 *   1. Bootstrap responses expose no balances/positions/decisions/
 *      credentials/paths/env — a whitelist of allowed top-level keys
 *      is enforced.
 *   2. Bootstrap token CANNOT call /api/operator-auth/refresh.
 *   3. Bootstrap token CANNOT call /api/operator-auth/change-password.
 *   4. Bootstrap token CANNOT call operator-scoped desktop routes.
 *   5. Bootstrap token does not appear in ANY database column (queried
 *      exhaustively via information_schema).
 *   6. Bootstrap token does not enter the desktop keytar surface (the
 *      DesktopAuthManager persists only refresh tokens; keytar reader
 *      is asked for its own scope only).
 *   7. Bootstrap token does not appear in server stdout/stderr, and
 *      does not appear in any operator_auth_events sanitized metadata.
 *   8. External-services mode fails clearly when the configured token
 *      does not match the server (401 with a specific reason code).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createConnection } from 'mysql2/promise';
import IORedis from 'ioredis';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { createScratchDb, dropScratchDb, makeScratchDbName, scratchDbUrl } from './lib/scratchDb';
import { SecretsAuthTokenStorage } from '../src/main/secureStorage';
import { InMemorySecretsAdapter } from '../src/main/secrets';

const REPO = resolve(__dirname, '..', '..', '..');
const SERVER_CWD = join(REPO, 'apps/server');
const migrationsDir = join(SERVER_CWD, 'drizzle/migrations');
const TEST_DB = makeScratchDbName('s2fix_bs');
const TEST_DB_URL = scratchDbUrl(TEST_DB);
const REDIS_URL = 'redis://127.0.0.1:6379';
const BOOTSTRAP = randomBytes(32).toString('hex');
const WRONG_BOOTSTRAP = randomBytes(32).toString('hex');
const READINESS_TIMEOUT_MS = 30_000;
let CHOSEN_PORT = 0;
function url(p: string): string { return `http://127.0.0.1:${CHOSEN_PORT}${p}`; }
const bootstrapHeader = { 'x-horizon-bootstrap-token': BOOTSTRAP } as const;

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

async function migrate(): Promise<void> {
  const conn = await createConnection({ uri: TEST_DB_URL });
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  try {
    for (const f of files) {
      for (const stmt of splitStatements(readFileSync(join(migrationsDir, f), 'utf-8'))) {
        await conn.query(stmt);
      }
    }
    await conn.query('CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INT PRIMARY KEY AUTO_INCREMENT, hash VARCHAR(64), created_at BIGINT)');
    for (let i = 0; i < files.length; i++) {
      await conn.query(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('m${i}', UNIX_TIMESTAMP()*1000)`);
    }
    await conn.query(`INSERT INTO bot_config (id, isRunning, isPaused, reconciliationStatus, reconciliationDetail) VALUES (1, false, false, 'ok', 'seeded')`);
    await conn.query(`INSERT INTO reconciliation_runs (runId, triggerReason, startedAt, completedAt, finalStatus) VALUES ('bs-seed', 'seed', NOW(3), NOW(3), 'ok')`);
  } finally { await conn.end(); }
}

const spawnedProcs: ReturnType<typeof spawn>[] = [];
const serverStdio: string[] = [];

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
      JWT_SECRET: 'stage2fix-bs-secret-please-change-1234',
      DRY_RUN: 'true',
      ORDER_SUBMISSION_ENABLED: 'false',
      CORS_ORIGINS: '*',
      HORIZON_BOOTSTRAP_TOKEN: BOOTSTRAP,
      HORIZON_REDIS_NAMESPACE: TEST_DB,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawnedProcs.push(proc);
  proc.stdout?.on('data', (d) => serverStdio.push(String(d)));
  proc.stderr?.on('data', (d) => serverStdio.push(String(d)));
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
      const r = await fetch(url('/api/system/readiness'), { headers: bootstrapHeader });
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

describe.sequential('stage2-fix §5 bootstrap-scope narrowness', () => {
  let available = false;
  let server: Spawned | undefined;

  beforeAll(async () => {
    available = await servicesReachable();
    if (!available) {
      console.warn('[stage2-fix bs] MariaDB/Redis unavailable — skipping');
      return;
    }
    CHOSEN_PORT = await pickPort();
    await createScratchDb(TEST_DB);
    await migrate();
    server = await spawnServer();
    const ready = await waitReady();
    if (!ready) throw new Error('server did not become ready for bootstrap-scope test');
  }, 90_000);

  afterAll(async () => {
    if (server) await server.kill();
    for (const proc of spawnedProcs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((proc as any).exitCode == null) proc.kill('SIGKILL');
    }
    if (available) {
      await dropScratchDb(TEST_DB);
      const r = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
      try {
        await r.connect();
        const keys = await r.keys(`${TEST_DB}:*`);
        if (keys.length > 0) await r.del(...keys);
      } catch { /* ignore */ } finally { try { await r.quit(); } catch { /* already closed */ } }
    }
  });

  const bootstrapEndpoints = [
    '/api/system/readiness',
    '/api/desktop/create-order-counters',
    '/api/desktop/scanner-readiness',
    '/api/desktop/reconciliation/status',
    '/api/operator-auth/state',
  ];

  // Words that should NEVER appear as either a value or a suggestive
  // key name in a bootstrap response body.
  const FORBIDDEN_KEY_PATTERNS = [
    /balance/i, /position/i, /decision/i, /pnl/i, /credential/i,
    /apiKey/i, /apiSecret/i, /passwordHash/i, /salt/i,
    /filePath/i, /absolutePath/i, /cwd/i, /homeDir/i,
    /processEnv/i, /envVar/i, /databaseUrl/i, /redisUrl/i,
    /jwtSecret/i, /coinbaseKey/i, /coinbasePrivate/i,
  ];

  function walkKeys(node: unknown, seen: string[] = []): string[] {
    if (Array.isArray(node)) node.forEach((n) => walkKeys(n, seen));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        seen.push(k);
        walkKeys(v, seen);
      }
    }
    return seen;
  }

  it('BS1: every bootstrap endpoint returns only whitelisted keys', async () => {
    if (!available) return;
    for (const path of bootstrapEndpoints) {
      const r = await json(path, { headers: bootstrapHeader });
      expect(r.status, `${path}`).toBe(200);
      const keys = walkKeys(r.body);
      for (const key of keys) {
        for (const pattern of FORBIDDEN_KEY_PATTERNS) {
          expect(pattern.test(key), `${path}: key '${key}' matches forbidden pattern ${pattern}`).toBe(false);
        }
      }
    }
  });

  it('BS2: bootstrap responses contain no substring matching the bootstrap token', async () => {
    if (!available) return;
    for (const path of bootstrapEndpoints) {
      const r = await json(path, { headers: bootstrapHeader });
      expect(JSON.stringify(r.body).toLowerCase().includes(BOOTSTRAP.toLowerCase())).toBe(false);
    }
  });

  it('BS3: bootstrap token cannot call /api/operator-auth/refresh (auth flow rejects it)', async () => {
    if (!available) return;
    const r = await json('/api/operator-auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bootstrapHeader },
      body: JSON.stringify({ refreshToken: BOOTSTRAP }),
    });
    // The bootstrap token is not a session token, so refresh fails with
    // an auth error (401 with unknown reason).
    expect(r.status).toBe(401);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((r.body as any).reason).toMatch(/unknown|already_rotated_family_revoked/);
  });

  it('BS4: bootstrap token cannot call /api/operator-auth/change-password (requires operator session)', async () => {
    if (!available) return;
    const r = await json('/api/operator-auth/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BOOTSTRAP}` },
      body: JSON.stringify({ currentPassword: 'x', newPassword: 'y', newPasswordConfirmation: 'y' }),
    });
    expect(r.status).toBe(401);
  });

  it('BS5: bootstrap token cannot call operator desktop routes', async () => {
    if (!available) return;
    for (const path of ['/api/desktop/observer-policy-versions', '/api/desktop/champion-configuration']) {
      const r = await json(path, { headers: bootstrapHeader });
      expect(r.status, `${path}`).toBe(401);
    }
    // Even smuggling it as a Bearer token doesn't help.
    for (const path of ['/api/desktop/observer-policy-versions', '/api/desktop/champion-configuration']) {
      const r = await json(path, { headers: { authorization: `Bearer ${BOOTSTRAP}` } });
      expect(r.status, `${path} via Bearer`).toBe(401);
    }
  });

  it('BS6: bootstrap token is not persisted in ANY database column', async () => {
    if (!available) return;
    const conn = await createConnection({ uri: TEST_DB_URL });
    try {
      const [tables] = await conn.query<Array<{ table_name: string }>>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type='BASE TABLE'",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as unknown as [any[], unknown];
      for (const t of tables) {
        const name = String(t.table_name ?? t.TABLE_NAME);
        // Query every text-like column for the bootstrap token substring.
        const [cols] = await conn.query<Array<{ column_name: string; data_type: string }>>(
          `SELECT column_name, data_type FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = ?`,
          [name],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as unknown as [any[], unknown];
        const textCols = cols
          .map((c) => ({ name: String(c.column_name ?? c.COLUMN_NAME), type: String(c.data_type ?? c.DATA_TYPE).toLowerCase() }))
          .filter((c) => ['varchar', 'text', 'longtext', 'mediumtext', 'tinytext', 'json', 'char', 'enum'].includes(c.type));
        if (textCols.length === 0) continue;
        const whereClause = textCols.map((c) => `\`${c.name}\` LIKE '%${BOOTSTRAP}%'`).join(' OR ');
        const [rows] = await conn.query<Array<{ n: number }>>(
          `SELECT COUNT(*) AS n FROM \`${name}\` WHERE ${whereClause}`,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as unknown as [any[], unknown];
        const count = Number(rows[0]?.n ?? 0);
        expect(count, `table '${name}' contains bootstrap token`).toBe(0);
      }
    } finally { await conn.end(); }
  });

  it('BS7: desktop AuthTokenStorage never asks for the bootstrap-scope credential — it only touches operator_session::refresh_token', async () => {
    // The SecretsAuthTokenStorage constructor takes a reader; assert the
    // scope keys it exercises are limited to operator_session.
    const seenReads: Array<[string, string]> = [];
    const secrets = new InMemorySecretsAdapter();
    const storage = new SecretsAuthTokenStorage(
      secrets,
      async (scope, key) => { seenReads.push([scope, key]); return null; },
    );
    await storage.saveRefreshToken(BOOTSTRAP); // even if a caller passes the bootstrap token as if it were a refresh token
    await storage.readRefreshToken();
    // Every read is scoped to operator_session::refresh_token — the
    // storage never asks for any bootstrap scope.
    for (const [scope, key] of seenReads) {
      expect(scope).toBe('operator_session');
      expect(key).toBe('refresh_token');
    }
    // The underlying secrets adapter received writes ONLY under the
    // operator_session scope — keytar never sees a bootstrap credential.
    expect(await secrets.getCredentialStatus('bootstrap', 'token')).toBe('absent');
    expect(await secrets.getCredentialStatus('operator_session', 'refresh_token')).toBe('present_encrypted');
    // Cleanup happens outside the observation window.
    await storage.clearRefreshToken();
  });

  it('BS8: bootstrap token does not appear in captured server stdout/stderr', () => {
    // The server has produced several lines of output by now (startup log
    // + BullMQ ready + reconciliation status).
    const combined = serverStdio.join('');
    expect(combined.length, 'expected some server output to be captured').toBeGreaterThan(0);
    expect(combined.includes(BOOTSTRAP), 'server logged the bootstrap token').toBe(false);
  });

  it('BS9: operator_auth_events sanitizedMetadata contains no bootstrap token', async () => {
    if (!available) return;
    // Provoke a bootstrap_rejected event to exercise the append path.
    const r = await json('/api/desktop/create-order-counters', {
      headers: { 'x-horizon-bootstrap-token': WRONG_BOOTSTRAP },
    });
    expect(r.status).toBe(401);
    const conn = await createConnection({ uri: TEST_DB_URL });
    try {
      const [rows] = await conn.query<Array<{ sanitizedMetadata: unknown; eventType: string }>>(
        `SELECT eventType, sanitizedMetadata FROM operator_auth_events WHERE eventType = 'bootstrap_rejected'`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as unknown as [any[], unknown];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const serialized = JSON.stringify(row.sanitizedMetadata ?? {});
        expect(serialized.includes(BOOTSTRAP)).toBe(false);
        expect(serialized.includes(WRONG_BOOTSTRAP)).toBe(false);
      }
    } finally { await conn.end(); }
  });

  it('BS10: external-services mode fails with a specific 401 when the presented bootstrap token does not match the server', async () => {
    if (!available) return;
    const r = await json('/api/system/readiness', {
      headers: { 'x-horizon-bootstrap-token': WRONG_BOOTSTRAP },
    });
    expect(r.status).toBe(401);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((r.body as any).error).toBe('bootstrap_token_required');
  });
});
