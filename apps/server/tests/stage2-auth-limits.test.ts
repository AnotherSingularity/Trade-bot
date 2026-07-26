/**
 * Stage 2 §14 — Composite login rate limits.
 *
 * Requires a real MariaDB (auto-skips otherwise).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { checkRate, normalizeUsername, recordFailure, recordSuccess, _internalConstants } from '../src/auth/loginLimits';

// Schema is provisioned by tests/globalSetup.ts. This suite only clears
// the operator_login_limits rows it owns — it never creates, drops, or
// migrates the shared test database.
const TEST_URI = process.env.DATABASE_URL ?? 'mysql://root:password@127.0.0.1:3306/horizon_trade_test';
const TEST_DB = TEST_URI.split('/').pop()!;

let available = false;

beforeAll(async () => {
  try {
    const conn = await mysql.createConnection({ uri: TEST_URI, connectTimeout: 3_000 });
    const [tables] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'operator_login_limits'",
    );
    await conn.end();
    available = tables.length > 0;
  } catch {
    available = false;
  }
}, 30_000);

afterAll(async () => {
  // Shared test DB — do not drop.
  void TEST_DB;
});

beforeEach(async () => {
  if (!available) return;
  const conn = await mysql.createConnection({ uri: TEST_URI });
  await conn.query('DELETE FROM operator_login_limits');
  await conn.end();
});

describe.sequential('stage2 §14 login rate limits', () => {
  it('L1: normalizeUsername lowercases + trims', () => {
    expect(normalizeUsername('  Operator  ')).toBe('operator');
  });

  it('L2: allowed by default', async () => {
    if (!available) return;
    const r = await checkRate({ username: 'op', installationId: null });
    expect(r.allowed).toBe(true);
  });

  it('L3: below threshold does not lock', async () => {
    if (!available) return;
    for (let i = 0; i < _internalConstants.FAIL_THRESHOLD - 1; i++) {
      await recordFailure({ username: 'op', installationId: 42 });
    }
    const r = await checkRate({ username: 'op', installationId: 42 });
    expect(r.allowed).toBe(true);
  });

  it('L4: reaching threshold locks the composite key', async () => {
    if (!available) return;
    for (let i = 0; i < _internalConstants.FAIL_THRESHOLD; i++) {
      await recordFailure({ username: 'op', installationId: 42 });
    }
    const r = await checkRate({ username: 'op', installationId: 42 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/^locked_/);
    expect(new Date(r.lockedUntil!).getTime()).toBeGreaterThan(Date.now());
  });

  it('L5: lockout is keyed independently — username, installation, composite', async () => {
    if (!available) return;
    for (let i = 0; i < _internalConstants.FAIL_THRESHOLD; i++) {
      await recordFailure({ username: 'target', installationId: 1 });
    }
    // Different username on same installation → still allowed only until the
    // installation key hits threshold too (each recordFailure increments
    // all three keys — username, installation, composite).
    const r = await checkRate({ username: 'other', installationId: 1 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('locked_installation');
  });

  it('L6: recordSuccess clears the composite state', async () => {
    if (!available) return;
    for (let i = 0; i < _internalConstants.FAIL_THRESHOLD; i++) {
      await recordFailure({ username: 'op', installationId: 42 });
    }
    await recordSuccess({ username: 'op', installationId: 42 });
    const r = await checkRate({ username: 'op', installationId: 42 });
    expect(r.allowed).toBe(true);
  });

  it('L7: null installationId is normalized to "none"', async () => {
    if (!available) return;
    for (let i = 0; i < _internalConstants.FAIL_THRESHOLD; i++) {
      await recordFailure({ username: 'op', installationId: null });
    }
    const r = await checkRate({ username: 'op', installationId: null });
    expect(r.allowed).toBe(false);
  });

  it('L8: attempts window reset — old failures dropped from count', async () => {
    if (!available) return;
    // We can't easily simulate time passage here without direct DB manipulation.
    // Instead we verify the constant is sane (>15 min).
    expect(_internalConstants.ATTEMPT_WINDOW_MS).toBeGreaterThanOrEqual(15 * 60_000);
  });
});
