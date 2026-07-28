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

import { join } from 'node:path';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthenticatedApiClient } from '../../src/main/authenticatedApiClient';
import { DesktopAuthManager } from '../../src/main/desktopAuthManager';
import type { AuthTokenStorage } from '../../src/main/secureStorage';
import {
  authSeamOutcomeToShortReason,
  startAuthSeamServer,
  stopAuthSeamServer,
  type AuthSeamServerHandle,
} from '../lib/authSeamServer';

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
const LOGS_BASE_DIR = join(__dirname, 'logs');

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
// Isolation — the server + scratch DB + Redis namespace lifecycle is
// owned by apps/desktop/tests/lib/authSeamServer.ts (Checkpoint A.2).
// This test file only owns the OPERATOR-scope assertions.
// -------------------------------------------------------------------------

let servicesAvailable = false;
let serverHandle: AuthSeamServerHandle | undefined;
let serverBaseUrl: string | undefined;
let bootstrapToken: string | undefined;
let dbUrl: string | undefined;

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
  // Wrap boot in try/catch so teardown ALWAYS runs on failure —
  // Checkpoint A.2 fixed the pre-RESET behaviour where a
  // beforeAll throw left the scratch DB + Redis namespace + child
  // process behind.
  try {
    serverHandle = await startAuthSeamServer({
      serverCwd: SERVER_CWD,
      migrationsDir: MIGRATIONS_DIR,
      logsBaseDir: LOGS_BASE_DIR,
      redisUrl: REDIS_URL,
      deadlineMs: 60_000,
      pollIntervalMs: 400,
      perProbeTimeoutMs: 2_500,
    });
    const outcome = serverHandle.readinessOutcome;
    if (outcome == null || outcome.kind !== 'ready') {
      // Compose the exact classification tag PLUS a bounded slice
      // of the child's stderr so a CI failure has evidence
      // pointing at the actual server-side cause.
      const tag = outcome ? authSeamOutcomeToShortReason(outcome) : 'authseam_no_outcome';
      const tail = serverHandle.stderrTail().slice(-1_024);
      throw new Error(`${tag}\n---stderr(last 1KB)---\n${tail}`);
    }
    serverBaseUrl = serverHandle.baseUrl ?? undefined;
    bootstrapToken = serverHandle.bootstrapToken ?? undefined;
    dbUrl = serverHandle.dbUrl ?? undefined;
    await ensureLocalOperator(serverBaseUrl!, bootstrapToken!);
  } catch (e) {
    // Fail-closed teardown: SIGTERM the child, drop the scratch DB,
    // clear the Redis namespace. Any of these can be a no-op if
    // startAuthSeamServer failed BEFORE it created that resource.
    try { await stopAuthSeamServer(serverHandle); } catch { /* ignore */ }
    serverHandle = undefined;
    throw e;
  }
}, 180_000);

afterAll(async () => {
  await stopAuthSeamServer(serverHandle);
  serverHandle = undefined;
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
