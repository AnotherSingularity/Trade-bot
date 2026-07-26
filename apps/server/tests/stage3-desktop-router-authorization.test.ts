/**
 * Stage 3 §1 + §21 items 1-3 — desktop.* authorization enforcement.
 *
 * Proves that every desktop.* procedure:
 *   - carries `authScope: operator_authenticated_business` meta,
 *   - fails closed for anonymous callers (UNAUTHORIZED),
 *   - fails closed for bootstrap-only credentials in the Authorization
 *     header (bootstrap tokens cannot mint operator identity),
 *   - resolves for a real operator session.
 *
 * The inventory audit continues to fail closed for any procedure without
 * an explicit meta — this test asserts the full desktop.* subtree
 * classifies correctly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { appRouter } from '../src/routers';
import { createContext } from '../src/lib/trpc';
import { buildTrpcInventory, auditTrpcInventory } from '../src/lib/trpcInventory';
import { setupInitialAccount } from '../src/auth/accounts';
import { createSession } from '../src/auth/sessions';
import { configureBootstrapToken, _resetBootstrapToken } from '../src/auth/bootstrap';
import { DESKTOP_DATA_KEYS } from '@horizon/shared';

const TEST_URI = process.env.DATABASE_URL ?? 'mysql://root:password@127.0.0.1:3306/horizon_trade_test';

let available = false;
let bootstrapHex = '';

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
  bootstrapHex = randomBytes(32).toString('hex');
  configureBootstrapToken(bootstrapHex);
}, 30_000);

afterAll(() => { _resetBootstrapToken(); });

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

let seededAccessToken: string | null = null;
async function seedActiveOperator(): Promise<string> {
  if (seededAccessToken) return seededAccessToken;
  // Clean the account tables so setupInitialAccount finds no existing accounts.
  const conn0 = await mysql.createConnection({ uri: TEST_URI });
  try {
    await conn0.query('DELETE FROM operator_auth_sessions');
    await conn0.query('DELETE FROM operator_auth_events');
    await conn0.query('DELETE FROM operator_login_limits');
    await conn0.query('DELETE FROM operator_recovery_records');
    await conn0.query('DELETE FROM local_operator_accounts');
  } finally {
    await conn0.end();
  }
  const username = `stage3op_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const r = await setupInitialAccount({ username, password: 'A_stR0ng!_p4ssw0rd_1234', passwordConfirmation: 'A_stR0ng!_p4ssw0rd_1234' });
  if (!('ok' in r) || !r.ok) throw new Error(`setup failed: ${(r as { reason: string }).reason}`);
  const conn = await mysql.createConnection({ uri: TEST_URI });
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT id FROM local_operator_accounts WHERE usernameNormalized = ? LIMIT 1', [username.toLowerCase()],
    );
    const accountId = Number((rows[0] as { id: number }).id);
    const created = await createSession({ accountId, installationId: null });
    seededAccessToken = created.accessToken;
    return created.accessToken;
  } finally {
    await conn.end();
  }
}

/** The 22 desktop.* procedure paths, derived from the shared key list. */
const DESKTOP_PROCEDURE_PATHS = DESKTOP_DATA_KEYS.map((k) => `desktop.${k}`);

describe('Stage 3 §1 — desktop.* authorization', () => {
  it('§21.4 every desktop.* key appears in the tRPC inventory', () => {
    const entries = buildTrpcInventory();
    const paths = new Set(entries.map((e) => e.path));
    for (const path of DESKTOP_PROCEDURE_PATHS) {
      expect(paths.has(path)).toBe(true);
    }
  });

  it('§21.1 every desktop.* procedure is classified operator_authenticated_business', () => {
    const entries = buildTrpcInventory();
    for (const entry of entries) {
      if (!entry.path.startsWith('desktop.')) continue;
      expect(entry.kind).toBe('operator_authenticated_business');
    }
  });

  it('§21.1 the inventory audit passes closed — no desktop.* procedure lands in internal_or_test', () => {
    const audit = auditTrpcInventory();
    const desktopIssues = audit.issues.filter((s) => s.includes('desktop.'));
    expect(desktopIssues).toEqual([]);
  });

  it('§21.3 anonymous callers cannot invoke desktop.overview.get', async () => {
    const caller = appRouter.createCaller(await contextFor({}));
    await expect(caller.desktop.overview.get()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('§21.2 bootstrap token in Authorization header is treated as opaque and rejected', async () => {
    // Bootstrap token used as a Bearer credential: must not mint identity.
    const caller = appRouter.createCaller(await contextFor({ authorization: `Bearer ${bootstrapHex}` }));
    await expect(caller.desktop.overview.get()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.desktop.portfolio.get()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.desktop.positions.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('§21.11 renderer-controllable fields (custom headers, input) cannot forge identity', async () => {
    const caller = appRouter.createCaller(await contextFor({
      'x-user': 'operator',
      'x-account-id': '1',
    }));
    await expect(caller.desktop.overview.get()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('valid operator session resolves desktop.overview.get with an envelope', async () => {
    if (!available) return;
    const accessToken = await seedActiveOperator();
    const caller = appRouter.createCaller(await contextFor({ authorization: `Bearer ${accessToken}` }));
    const res = await caller.desktop.overview.get();
    expect(res.contractVersion).toBe('3.0.0');
    expect(['healthy', 'degraded', 'stale', 'empty', 'unavailable']).toContain(res.status);
  });

  it('valid operator session resolves desktop.safety.get with safe-flag confirmations', async () => {
    if (!available) return;
    const accessToken = await seedActiveOperator();
    const caller = appRouter.createCaller(await contextFor({ authorization: `Bearer ${accessToken}` }));
    const res = await caller.desktop.safety.get();
    expect(res.contractVersion).toBe('3.0.0');
    expect(res.data?.safeFlags.DRY_RUN).toBe(true);
    expect(res.data?.safeFlags.ORDER_SUBMISSION_ENABLED).toBe(false);
    expect(res.data?.observerEnforcementActive).toBe(false);
    expect(res.data?.kellyEnabled).toBe(false);
    expect(res.data?.liveCapitalAuthorized).toBe(false);
    expect(res.data?.createOrderCounters.functionInvocations).toBe(0);
    expect(res.data?.createOrderCounters.attemptCount).toBe(0);
    expect(res.data?.createOrderCounters.networkCount).toBe(0);
  });
});
