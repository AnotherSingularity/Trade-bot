/**
 * Stage 3C-CI-FIX10A §4 — real desktop→server auth seam.
 *
 * Guards the FIX10A regression: DesktopAuthManager.login must send
 * a login body that omits `installationId` entirely when the manager
 * was constructed with `installationId: null | undefined`. Prior to
 * FIX10A the body carried `"installationId": null` on the wire,
 * which the server's Zod schema rejected with HTTP 400
 * `invalid_body` — the FIX10 native-run failure signature.
 *
 * This test exercises the ACTUAL seam:
 *   MariaDB 10.11.6 → scratch DB → real migrations →
 *   real server (`apps/server/src/index.ts`) →
 *   real AuthenticatedApiClient → real DesktopAuthManager →
 *   HTTP POST /api/operator-auth/login →
 *   real operator_auth_sessions row.
 *
 * NOT a mocked-fetch test. NOT an Electron test — no Playwright, no
 * Xvfb, no renderer. That means it can run alongside protection-seed-regression
 * on any CI runner (or dev machine) that has MariaDB + Redis on
 * 127.0.0.1 without an X server. The full native suite still exists
 * for the Electron path.
 *
 * The test would FAIL against the pre-FIX10A DesktopAuthManager (which
 * sent `installationId: null`) and PASSES after the normalization.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { readdirSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthenticatedApiClient } from '../../src/main/authenticatedApiClient';
import { DesktopAuthManager } from '../../src/main/desktopAuthManager';
import type { AuthTokenStorage } from '../../src/main/secureStorage';
import { createScratchDb, dropScratchDb, makeScratchDbName, scratchDbUrl } from '../lib/scratchDb';

// -------------------------------------------------------------------------
// Fixed inputs (matches electronHarness.ts credentials so this seam
// test exercises the same operator identity the native suite does).
// -------------------------------------------------------------------------

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'server/drizzle/migrations');
const SERVER_CWD = join(__dirname, '..', '..', '..', 'server');
const MARIADB_ROOT = { host: '127.0.0.1', port: 3306, user: 'root', password: 'password' } as const;
const REDIS_URL = 'redis://127.0.0.1:6379';
const ADMIN_USER = 'nativeoperator';
const ADMIN_PASSWORD = 'Native-3C-passphrase-!';

// -------------------------------------------------------------------------
// In-memory AuthTokenStorage — permitted in tests per secureStorage.ts
// docstring ("In-memory storage is permitted in dev + tests only").
// -------------------------------------------------------------------------

class InMemoryAuthTokenStorage implements AuthTokenStorage {
  private token: string | null = null;
  async saveRefreshToken(token: string): Promise<void> { this.token = token; }
  async readRefreshToken(): Promise<string | null> { return this.token; }
  async clearRefreshToken(): Promise<void> { this.token = null; }
}

// -------------------------------------------------------------------------
// Isolation
// -------------------------------------------------------------------------

let servicesAvailable = false;
let dbName: string | undefined;
let dbUrl: string | undefined;
let redisNamespace: string | undefined;
let serverProc: ChildProcess | undefined;
let serverPort: number | undefined;
let serverBaseUrl: string | undefined;
let bootstrapToken: string | undefined;
let logsDir: string | undefined;

async function externalServicesAvailable(): Promise<boolean> {
  try {
    const c = await createConnection({ ...MARIADB_ROOT, connectTimeout: 2_000 });
    await c.ping();
    await c.end();
    const r = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    await r.connect();
    await r.ping();
    await r.quit();
    return true;
  } catch {
    return false;
  }
}

async function applyMigrations(url: string): Promise<void> {
  const c = await createConnection({ uri: url });
  try {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf-8')
        .replace(/-->\s*statement-breakpoint/g, '')
        .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
      for (const stmt of sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0)) {
        await c.query(stmt);
      }
    }
  } finally {
    await c.end();
  }
}

async function pickFreePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => {
        if (typeof addr === 'object' && addr) res(addr.port);
        else rej(new Error('no address'));
      });
    });
    s.on('error', rej);
  });
}

async function waitForReadiness(baseUrl: string, token: string, deadlineMs = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2_500);
      const res = await fetch(`${baseUrl}/api/system/readiness`, {
        signal: ctrl.signal,
        headers: { 'x-horizon-bootstrap-token': token },
      });
      clearTimeout(t);
      if (res.ok) {
        const body = await res.json() as { ready?: boolean };
        if (body?.ready) return true;
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function ensureLocalOperator(baseUrl: string, token: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/operator-auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-horizon-bootstrap-token': token },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD, passwordConfirmation: ADMIN_PASSWORD }),
  });
  if (!res.ok && res.status !== 409) {
    const body = await res.text();
    throw new Error(`operator setup failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

// -------------------------------------------------------------------------
// Lifecycle
// -------------------------------------------------------------------------

beforeAll(async () => {
  servicesAvailable = await externalServicesAvailable();
  if (!servicesAvailable) return;
  dbName = makeScratchDbName('authseam');
  await createScratchDb(dbName);
  dbUrl = scratchDbUrl(dbName);
  await applyMigrations(dbUrl);
  redisNamespace = `authseam_${process.pid}_${randomBytes(3).toString('hex')}`;
  serverPort = await pickFreePort();
  bootstrapToken = randomBytes(32).toString('hex');
  logsDir = join(__dirname, 'logs', `authseam_${redisNamespace}`);
  mkdirSync(logsDir, { recursive: true });
  serverProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_CWD,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(serverPort),
      DATABASE_URL: dbUrl,
      REDIS_URL,
      JWT_SECRET: 'stage3c-ci-reset-authseam-secret-please-change',
      DRY_RUN: 'true',
      ORDER_SUBMISSION_ENABLED: 'false',
      CORS_ORIGINS: '*',
      HORIZON_BOOTSTRAP_TOKEN: bootstrapToken,
      HORIZON_REDIS_NAMESPACE: redisNamespace,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Stage 3C-CI-RESET §1.3: DRAIN THE PIPES IMMEDIATELY.
  // A `pipe` stdio without a consumer fills the OS pipe buffer and
  // deadlocks the child once the buffer hits its limit (~64KB on
  // Linux). Every child line is teed into a per-run log so a
  // subsequent failure has evidence. Redaction is applied at write.
  const serverLogPath = join(logsDir!, 'server.live.log');
  const drain = (kind: 'stdout' | 'stderr', chunk: Buffer): void => {
    try {
      const sanitized = String(chunk)
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <REDACTED>')
        .replace(/[A-Fa-f0-9]{32,}/g, '<HEX_REDACTED>')
        .slice(0, 65_536);
      appendFileSync(serverLogPath, `[${kind}] ${sanitized}`);
    } catch { /* best-effort */ }
  };
  serverProc.stdout?.on('data', (c) => drain('stdout', c));
  serverProc.stderr?.on('data', (c) => drain('stderr', c));
  serverBaseUrl = `http://127.0.0.1:${serverPort}`;
  const ready = await waitForReadiness(serverBaseUrl, bootstrapToken, 60_000);
  if (!ready) throw new Error('authseam_server_readiness_timeout');
  await ensureLocalOperator(serverBaseUrl, bootstrapToken);
}, 180_000);

afterAll(async () => {
  if (serverProc && serverProc.exitCode == null) {
    serverProc.kill('SIGTERM');
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && serverProc.exitCode == null) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (serverProc.exitCode == null) serverProc.kill('SIGKILL');
  }
  if (dbName) {
    try { await dropScratchDb(dbName); } catch { /* ignore */ }
  }
  if (redisNamespace) {
    try {
      const r = new IORedis(REDIS_URL, { lazyConnect: true });
      await r.connect();
      const keys = await r.keys(`${redisNamespace}:*`);
      if (keys.length > 0) await r.del(...keys);
      await r.quit();
    } catch { /* ignore */ }
  }
}, 60_000);

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe.sequential('Stage 3C-CI-FIX10A §4 — desktop→server auth seam (installationId omission)', () => {
  it('S0: preconditions — services reachable + server ready + operator provisioned', () => {
    if (!servicesAvailable) {
      throw new Error('auth_seam_test_blocked: MariaDB or Redis not reachable at 127.0.0.1');
    }
    expect(dbUrl).toBeDefined();
    expect(serverBaseUrl).toBeDefined();
    expect(bootstrapToken).toBeDefined();
  });

  it('S1: DesktopAuthManager.login with absent installationId returns ok=true + phase=authenticated', async () => {
    // Real AuthenticatedApiClient, real DesktopAuthManager. Caller
    // boundary supplies NO installationId — this is the exact seam
    // that pre-FIX10A produced `installationId: null` on the wire.
    const client = new AuthenticatedApiClient({
      serverBaseUrl: serverBaseUrl!,
      getBootstrapToken: () => bootstrapToken!,
      getAccessToken: () => null,
      onRefreshNeeded: async () => ({ ok: false, reason: 'no_refresh_this_test' }),
      requestTimeoutMs: 10_000,
    });
    const manager = new DesktopAuthManager({
      api: client,
      tokenStorage: new InMemoryAuthTokenStorage(),
      // installationId INTENTIONALLY absent (undefined). The pre-FIX10A
      // constructor coerced this to null and the login body serialised
      // it. The FIX10A constructor normalises to undefined and the
      // helper omits it.
      clientVersion: 'stage3c-ci-fix10a-authseam',
    });

    const resp = await manager.login({ username: ADMIN_USER, password: ADMIN_PASSWORD });

    // §4.5 — AuthOperationResponse.ok === true.
    expect(resp.ok, `login rejected: reason=${resp.reason} phase=${resp.state.phase} failureReason=${resp.state.failureReason}`).toBe(true);
    // §4.6 — state.phase === 'authenticated'.
    expect(resp.state.phase).toBe('authenticated');
    // §4.6 (extra) — no failure reason leaked.
    expect(resp.reason).toBeNull();
    expect(resp.state.failureReason).toBeNull();
    // §4.9 — no token appears in the renderer-safe response.
    const respJson = JSON.stringify(resp);
    expect(respJson).not.toMatch(/refresh[_-]?token/i);
    expect(respJson).not.toMatch(/access[_-]?token/i);
    expect(respJson).not.toContain(ADMIN_PASSWORD);
  });

  it('S2: independent getState() readback also reports authenticated', async () => {
    // Fresh manager, same server, same operator — replay the login
    // then read state independently to prove the sanitized surface
    // does NOT lie about the phase.
    const client = new AuthenticatedApiClient({
      serverBaseUrl: serverBaseUrl!,
      getBootstrapToken: () => bootstrapToken!,
      getAccessToken: () => null,
      onRefreshNeeded: async () => ({ ok: false, reason: 'no_refresh_this_test' }),
      requestTimeoutMs: 10_000,
    });
    const manager = new DesktopAuthManager({
      api: client,
      tokenStorage: new InMemoryAuthTokenStorage(),
      clientVersion: 'stage3c-ci-fix10a-authseam',
    });
    const login = await manager.login({ username: ADMIN_USER, password: ADMIN_PASSWORD });
    expect(login.ok).toBe(true);
    const state = await manager.getState();
    expect(state.phase).toBe('authenticated');
    expect(state.failureReason).toBeNull();
  });

  it('S3: a session row was persisted to operator_auth_sessions (real DB verification)', async () => {
    // Every successful login creates a row in operator_auth_sessions with
    // the account we set up. Because the pre-FIX10A body was rejected
    // at Zod parse (before session creation), a green count here is
    // a positive proof of the FIX.
    // Stage 3C-CI-RESET §1.2: mysql2 RowDataPacket typing so the
    // COUNT(*) column type is checked and no `any` cast is needed.
    interface CountRow extends RowDataPacket { n: number }
    const c = await createConnection({ uri: dbUrl });
    try {
      const [rows] = await c.query<CountRow[]>(
        `SELECT COUNT(*) AS n FROM operator_auth_sessions os
           JOIN local_operator_accounts a ON a.id = os.accountId
         WHERE a.username = ?`,
        [ADMIN_USER],
      );
      const n = Number(rows[0]?.n ?? 0);
      // S1 + S2 each created one session.
      expect(n).toBeGreaterThanOrEqual(2);
    } finally {
      await c.end();
    }
  });

  it('S4: null-installationId body would have been rejected server-side (regression proof)', async () => {
    // Directly POST the pre-FIX10A body shape to demonstrate the
    // server continues to reject it. Do NOT weaken the schema — the
    // desktop side is the correct place to fix.
    const res = await fetch(`${serverBaseUrl}/api/operator-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-horizon-bootstrap-token': bootstrapToken! },
      body: JSON.stringify({
        username: ADMIN_USER,
        password: ADMIN_PASSWORD,
        installationId: null, // ← the pre-FIX10A defect on the wire
        clientVersion: 'stage3c-ci-fix10a-authseam',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string; detail?: string };
    expect(body.error).toBe('invalid_body');
  });

  it('S5: server audit log recorded a login_success event (no secrets in event row)', async () => {
    const c = await createConnection({ uri: dbUrl });
    try {
      const [rows] = await c.query(
        `SELECT eventType, source, sanitizedMetadata FROM operator_auth_events
         WHERE eventType = 'login_success' ORDER BY id DESC LIMIT 5`,
      );
      const arr = rows as Array<{ eventType: string; source: string; sanitizedMetadata: string | null }>;
      // At least one success from S1 or S2.
      expect(arr.length).toBeGreaterThan(0);
      for (const r of arr) {
        expect(r.eventType).toBe('login_success');
        // Metadata is nullable, but when present must not carry the
        // password or any bearer token.
        if (r.sanitizedMetadata != null) {
          expect(r.sanitizedMetadata).not.toContain(ADMIN_PASSWORD);
          expect(r.sanitizedMetadata).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/);
        }
      }
    } finally {
      await c.end();
    }
  });
});
