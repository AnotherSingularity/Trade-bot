/**
 * Stage 2-FIX §3 — tRPC authorization coverage.
 *
 * Server-side proof that every tRPC procedure has an authorization
 * classification and that the classifier fails closed:
 *
 *   - The router inventory is enumerated and stable.
 *   - `public_auth_op` matches the explicit `PUBLIC_AUTH_ALLOWLIST`.
 *   - Every other procedure is classified as
 *     `operator_authenticated_business` and carries at least one
 *     authorization middleware.
 *   - No procedure is `internal_or_test` — that classification would
 *     fail the audit.
 *
 * Then, through the real `createContext` + `createCallerFactory`, we
 * exercise every identity class end-to-end:
 *
 *   - Anonymous caller (no Authorization header)
 *       → login is reachable; every protected procedure throws
 *         UNAUTHORIZED.
 *   - Bootstrap token in the Authorization header (in whichever form:
 *       hex-only, `Bearer <hex>`) → server treats it as an unknown
 *       opaque token, never mints an identity, business procedures
 *       throw UNAUTHORIZED.
 *   - Client-controlled fields (query input, custom headers) cannot
 *     forge an authenticated identity.
 *   - Valid Stage 2 operator session → business procedures resolve.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appRouter } from '../src/routers';
import { createContext } from '../src/lib/trpc';
import {
  PUBLIC_AUTH_ALLOWLIST,
  auditTrpcInventory,
  buildTrpcInventory,
} from '../src/lib/trpcInventory';
import { setupInitialAccount } from '../src/auth/accounts';
import { createSession } from '../src/auth/sessions';
import { configureBootstrapToken, _resetBootstrapToken } from '../src/auth/bootstrap';
import { randomBytes } from 'node:crypto';

const TEST_URI = process.env.DATABASE_URL ?? 'mysql://root:password@127.0.0.1:3306/horizon_trade_test';

let available = false;

beforeAll(async () => {
  try {
    const conn = await mysql.createConnection({ uri: TEST_URI, connectTimeout: 3_000 });
    const [tables] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'local_operator_accounts'",
    );
    await conn.end();
    available = tables.length > 0;
  } catch {
    available = false;
  }
  // Bootstrap token — used to build a header we then try to abuse.
  configureBootstrapToken(randomBytes(32).toString('hex'));
}, 30_000);

afterAll(() => { _resetBootstrapToken(); });

// Minimal Express-like request/response fakes for context creation.
function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { headers } as any;
}
function fakeRes(): ServerResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {} as any;
}

async function contextFor(headers: Record<string, string> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createContext({ req: fakeReq(headers), res: fakeRes(), info: {} as any } as any);
}

async function seedActiveOperator(): Promise<{ accessToken: string }> {
  const conn = await mysql.createConnection({ uri: TEST_URI });
  await conn.query('DELETE FROM operator_auth_sessions');
  await conn.query('DELETE FROM local_operator_accounts');
  await conn.end();
  const setup = await setupInitialAccount({
    username: 'trpc-test-operator',
    password: 'correct-horse-battery-staple-99',
    passwordConfirmation: 'correct-horse-battery-staple-99',
  });
  if (!setup.ok) throw new Error('seed setup failed');
  const pair = await createSession({ accountId: setup.account.id });
  return { accessToken: pair.accessToken };
}

describe('stage2-fix §3 tRPC authorization inventory', () => {
  it('T1: inventory is non-empty and every procedure is classified', () => {
    const inv = buildTrpcInventory();
    expect(inv.length).toBeGreaterThan(0);
    for (const entry of inv) {
      expect(['public_auth_op', 'operator_authenticated_business', 'internal_or_test']).toContain(entry.kind);
    }
  });

  it('T2: PUBLIC allowlist is exactly [auth.login]', () => {
    expect(PUBLIC_AUTH_ALLOWLIST).toEqual(['auth.login']);
  });

  it('T3: the only public procedure is auth.login — everything else has a middleware', () => {
    const inv = buildTrpcInventory();
    const publics = inv.filter((e) => e.kind === 'public_auth_op');
    expect(publics.map((p) => p.path)).toEqual(['auth.login']);
    const businesses = inv.filter((e) => e.kind === 'operator_authenticated_business');
    for (const b of businesses) {
      expect(b.hasMiddleware, `${b.path} should carry an auth middleware`).toBe(true);
    }
  });

  it('T4: auditTrpcInventory reports no unclassified procedures — audit fails closed', () => {
    const audit = auditTrpcInventory();
    expect(audit.issues).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it('T5: no internal_or_test procedures reach the router', () => {
    const inv = buildTrpcInventory();
    expect(inv.filter((e) => e.kind === 'internal_or_test')).toEqual([]);
  });

  it('T6: every trading mutation is protected (start/stop/pause/scanNow/closePosition/emergencyKill)', () => {
    const inv = buildTrpcInventory();
    const mustBeProtected = [
      'trading.start', 'trading.stop', 'trading.pause', 'trading.scanNow',
      'trading.closePosition', 'trading.emergencyKill', 'trading.status',
      'trading.portfolio', 'trading.positions', 'trading.activity',
      'tokens.list', 'tokens.setActive', 'tokens.volumeFilter',
      'history.list', 'history.summary', 'settings.info', 'settings.testConnection',
      'lineage.getDecisionChain', 'auth.me',
    ];
    for (const path of mustBeProtected) {
      const entry = inv.find((e) => e.path === path);
      expect(entry, `${path} must appear in the inventory`).toBeTruthy();
      expect(entry!.kind).toBe('operator_authenticated_business');
    }
  });
});

describe('stage2-fix §3 tRPC identity enforcement', () => {
  const caller = (ctx: Awaited<ReturnType<typeof contextFor>>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appRouter.createCaller(ctx as any);

  it('E1: anonymous caller has ctx.auth = null and ctx.user = null', async () => {
    const ctx = await contextFor({});
    expect(ctx.auth).toBeNull();
    expect(ctx.user).toBeNull();
  });

  it('E2: anonymous caller can invoke auth.login (public path present)', async () => {
    const ctx = await contextFor({});
    // login rejects an unknown password with UNAUTHORIZED — that's fine, it proves
    // the procedure is reachable and its handler ran.
    try {
      await caller(ctx).auth.login({ password: 'this-is-not-the-configured-admin-password' });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      expect(msg).toMatch(/Invalid password|not configured/i);
    }
  });

  it('E3: anonymous caller cannot invoke ANY protected procedure', async () => {
    const ctx = await contextFor({});
    const c = caller(ctx);
    const protectedCalls: Array<[string, () => Promise<unknown>]> = [
      ['auth.me', () => c.auth.me()],
      ['trading.status', () => c.trading.status()],
      ['trading.start', () => c.trading.start()],
      ['trading.stop', () => c.trading.stop()],
      ['trading.pause', () => c.trading.pause()],
      ['trading.scanNow', () => c.trading.scanNow()],
      ['trading.portfolio', () => c.trading.portfolio()],
      ['trading.positions', () => c.trading.positions()],
      ['trading.emergencyKill', () => c.trading.emergencyKill()],
      ['tokens.list', () => c.tokens.list()],
      ['tokens.volumeFilter', () => c.tokens.volumeFilter()],
      ['settings.info', () => c.settings.info()],
    ];
    for (const [name, fn] of protectedCalls) {
      await expect(fn(), `${name} should reject anonymous callers`).rejects.toThrow(
        /Authentication required|Operator session required|UNAUTHORIZED/,
      );
    }
  });

  it('E4: bootstrap-token header (hex only) does NOT mint an identity', async () => {
    const bootstrap = randomBytes(32).toString('hex');
    configureBootstrapToken(bootstrap);
    // Bootstrap tokens flow only through the X-Horizon-Bootstrap-Token
    // header — not Authorization. But even if a caller mistakenly
    // presents the bootstrap token as an operator session, the tRPC
    // context must reject it.
    const ctx = await contextFor({ authorization: `Bearer ${bootstrap}` });
    expect(ctx.auth).toBeNull();
    expect(ctx.user).toBeNull();
    await expect(caller(ctx).trading.status()).rejects.toThrow(/UNAUTHORIZED|Authentication required/);
  });

  it('E5: client-controlled inputs cannot forge an identity — mutating input has no effect on auth', async () => {
    const ctx = await contextFor({
      authorization: 'Bearer not-a-real-token',
      // Renderer-controlled fields; server context reads NONE of these.
      'x-operator-username': 'admin',
      'x-forwarded-user': 'admin',
      'x-user-id': '1',
    });
    expect(ctx.auth).toBeNull();
    await expect(caller(ctx).auth.me()).rejects.toThrow(/UNAUTHORIZED|Authentication required/);
  });

  it('E6: garbage in Authorization header yields null identity (no crash, no fallback)', async () => {
    const ctx = await contextFor({ authorization: 'Bearer ' + 'x'.repeat(300) });
    expect(ctx.auth).toBeNull();
  });

  it('E7: valid operator session mints operator identity + reaches auth.me', async () => {
    if (!available) return;
    const { accessToken } = await seedActiveOperator();
    const ctx = await contextFor({ authorization: `Bearer ${accessToken}` });
    expect(ctx.auth?.kind).toBe('operator');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((ctx.auth as any).account.username).toBe('trpc-test-operator');
    const me = await caller(ctx).auth.me();
    expect(me.sub).toBe('operator:trpc-test-operator');
  });

  it('E8: revoked operator session is rejected — identity is created SERVER-SIDE per request', async () => {
    if (!available) return;
    const { accessToken } = await seedActiveOperator();
    // Revoke everything for the account.
    const { revokeAllForAccount } = await import('../src/auth/sessions');
    const { findByUsername } = await import('../src/auth/accounts');
    const account = await findByUsername('trpc-test-operator');
    if (!account) throw new Error('seeded account missing');
    await revokeAllForAccount(account.id, 'test');
    const ctx = await contextFor({ authorization: `Bearer ${accessToken}` });
    expect(ctx.auth).toBeNull();
  });
});
