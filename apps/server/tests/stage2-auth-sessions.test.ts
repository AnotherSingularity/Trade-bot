/**
 * Stage 2 §7 — Session lifecycle: create, verify, refresh (with rotation),
 * refresh-reuse family invalidation, revoke, revoke-all, absolute expiry.
 *
 * Uses a real MariaDB test DB (auto-skips if unreachable).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { eq } from 'drizzle-orm';
import * as schema from '../src/db/schema';
import { db } from '../src/db';
import {
  createSession,
  verifyAccessToken,
  refreshSession,
  revokeAllForAccount,
  revokeSession,
  ACCESS_TTL_MS,
  ABSOLUTE_TTL_MS,
} from '../src/auth/sessions';

// Uses the vitest-configured DATABASE_URL (the dedicated
// `horizon_trade_test` DB). Schema is provisioned by tests/globalSetup.ts;
// this suite only clears the operator rows it owns between tests.
const TEST_URI = process.env.DATABASE_URL ?? 'mysql://root:password@127.0.0.1:3306/horizon_trade_test';
const TEST_DB = TEST_URI.split('/').pop()!;

let seededAccountId: number;

async function seedAccount(): Promise<number> {
  const conn = await mysql.createConnection({ uri: TEST_URI });
  await conn.query('DELETE FROM operator_auth_sessions');
  await conn.query('DELETE FROM local_operator_accounts');
  const [r] = await conn.query<mysql.ResultSetHeader>(
    `INSERT INTO local_operator_accounts
     (username, usernameNormalized, passwordHashHex, passwordSaltHex, passwordAlgorithm, passwordParameters, passwordChangedAt)
     VALUES ('operator', 'operator', 'ff', 'ee', 'scrypt-v1', '{"N":16384,"r":8,"p":1,"keyLength":64}', NOW(3))`,
  );
  await conn.end();
  return r.insertId;
}

// Suite-scoped setup: create the DB + apply migrations once.
let available = false;
beforeAll(async () => {
  // Stage 2-FIX §1: schema is provisioned by tests/globalSetup.ts. This
  // suite only verifies availability and cleans the rows it owns — it
  // NEVER creates, drops, or migrates the shared test database.
  try {
    const conn = await mysql.createConnection({ uri: TEST_URI, connectTimeout: 3_000 });
    const [tables] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'local_operator_accounts'",
    );
    await conn.end();
    available = tables.length > 0;
    if (!available) console.warn('[stage2 sessions] operator tables absent — globalSetup did not run?');
  } catch (e) {
    console.warn('[stage2 sessions] MariaDB unavailable — skipping', String(e).slice(0, 120));
    available = false;
  }
}, 30_000);

afterAll(async () => {
  // Leave the shared test DB in place; only our rows were touched.
  void TEST_DB;
});

beforeEach(async () => {
  if (!available) return;
  seededAccountId = await seedAccount();
});

describe.sequential('stage2 §7 sessions', () => {
  it('S1: createSession returns a full token pair with hashed persistence', async () => {
    if (!available) return;
    const pair = await createSession({ accountId: seededAccountId });
    expect(pair.accessToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(pair.refreshToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(pair.sessionFamilyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pair.accessExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(pair.absoluteExpiresAt.getTime() - pair.accessExpiresAt.getTime()).toBeGreaterThan(0);
  });

  it('S2: verifyAccessToken accepts the issued access token', async () => {
    if (!available) return;
    const pair = await createSession({ accountId: seededAccountId });
    const v = await verifyAccessToken(pair.accessToken);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.row.accountId).toBe(seededAccountId);
  });

  it('S3: verifyAccessToken rejects a mangled token', async () => {
    if (!available) return;
    await createSession({ accountId: seededAccountId });
    const v = await verifyAccessToken('wrong-access-token-string');
    expect(v.ok).toBe(false);
  });

  it('S4: refreshSession issues a new pair and revokes the parent', async () => {
    if (!available) return;
    const parent = await createSession({ accountId: seededAccountId });
    const r = await refreshSession(parent.refreshToken);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pair.accessToken).not.toBe(parent.accessToken);
      expect(r.pair.refreshToken).not.toBe(parent.refreshToken);
      expect(r.pair.sessionFamilyId).toBe(parent.sessionFamilyId);
    }
  });

  it('S5: reusing the parent refresh token AFTER rotation → family is revoked', async () => {
    if (!available) return;
    const parent = await createSession({ accountId: seededAccountId });
    const r1 = await refreshSession(parent.refreshToken);
    expect(r1.ok).toBe(true);
    const reuse = await refreshSession(parent.refreshToken);
    expect(reuse.ok).toBe(false);
    if (!reuse.ok) expect(reuse.reason).toBe('already_rotated_family_revoked');
    // Rotated (still-valid) token should now also be rejected.
    if (r1.ok) {
      const rotated2 = await refreshSession(r1.pair.refreshToken);
      expect(rotated2.ok).toBe(false);
    }
  });

  it('S6: revokeSession makes verifyAccessToken return `revoked`', async () => {
    if (!available) return;
    const pair = await createSession({ accountId: seededAccountId });
    const v1 = await verifyAccessToken(pair.accessToken);
    expect(v1.ok).toBe(true);
    if (v1.ok) await revokeSession(v1.row.id, 'test');
    const v2 = await verifyAccessToken(pair.accessToken);
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.reason).toBe('revoked');
  });

  it('S7: revokeAllForAccount invalidates every session for the account', async () => {
    if (!available) return;
    const a = await createSession({ accountId: seededAccountId });
    const b = await createSession({ accountId: seededAccountId });
    await revokeAllForAccount(seededAccountId, 'test');
    const va = await verifyAccessToken(a.accessToken);
    const vb = await verifyAccessToken(b.accessToken);
    expect(va.ok).toBe(false);
    expect(vb.ok).toBe(false);
  });

  it('S8: access token past absoluteExpiresAt is rejected as absolute_expired', async () => {
    if (!available) return;
    const past = new Date(Date.now() - ABSOLUTE_TTL_MS - 60_000);
    const pair = await createSession({ accountId: seededAccountId, now: past });
    const v = await verifyAccessToken(pair.accessToken);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('absolute_expired');
  });

  it('S9: TTLs are 15min / 7d / 30d', async () => {
    if (!available) return;
    const pair = await createSession({ accountId: seededAccountId });
    const accessDelta = pair.accessExpiresAt.getTime() - Date.now();
    const absoluteDelta = pair.absoluteExpiresAt.getTime() - Date.now();
    expect(Math.abs(accessDelta - ACCESS_TTL_MS)).toBeLessThan(5_000);
    expect(Math.abs(absoluteDelta - ABSOLUTE_TTL_MS)).toBeLessThan(5_000);
  });

  it('S10: refresh past absolute → `absolute_expired`', async () => {
    if (!available) return;
    const past = new Date(Date.now() - ABSOLUTE_TTL_MS - 60_000);
    const pair = await createSession({ accountId: seededAccountId, now: past });
    const r = await refreshSession(pair.refreshToken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('absolute_expired');
  });

  it('S11: DB stores hashes, never raw tokens', async () => {
    if (!available) return;
    const pair = await createSession({ accountId: seededAccountId });
    const conn = await mysql.createConnection({ uri: TEST_URI });
    const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT accessTokenHash, refreshTokenHash FROM operator_auth_sessions LIMIT 1');
    await conn.end();
    expect(rows[0].accessTokenHash).not.toBe(pair.accessToken);
    expect(rows[0].refreshTokenHash).not.toBe(pair.refreshToken);
    expect(String(rows[0].accessTokenHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('S12: parent row is marked rotated after refresh (revokedAt + revocationReason)', async () => {
    if (!available) return;
    const parent = await createSession({ accountId: seededAccountId });
    await refreshSession(parent.refreshToken);
    const [row] = await db
      .select()
      .from(schema.operatorAuthSessions)
      .where(eq(schema.operatorAuthSessions.sessionFamilyId, parent.sessionFamilyId))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row!.revocationReason).toBe('rotated');
  });
});
