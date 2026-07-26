/**
 * Stage 2 §14 — Composite login rate limiting.
 *
 * Keyed by:
 *   - `username` — normalized (trim + lowercase). Slows targeted
 *     credential-stuffing against a specific account.
 *   - `installation` — installationId string. Slows unattended
 *     scripts hammering from a single desktop installation.
 *   - `composite` — `${username}|${installation}` for finer-grain
 *     backoff.
 *
 * Backoff is applied whenever ANY of the three keys is currently
 * locked out. Lockout window: 5 failed attempts → 15-minute lock;
 * every subsequent 5-in-a-window doubles the lock, capped at 24 h.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { operatorLoginLimits, type OperatorLoginLimitKeyType } from '../db/schema';

export interface RateCheckResult {
  allowed: boolean;
  reason?: 'locked_username' | 'locked_installation' | 'locked_composite' | 'ok';
  lockedUntil?: string;
  failedAttempts?: number;
}

const FAIL_THRESHOLD = 5;
const BASE_LOCK_MS = 15 * 60_000;
const MAX_LOCK_MS = 24 * 60 * 60_000;
const ATTEMPT_WINDOW_MS = 30 * 60_000;

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export interface RateContextKeys {
  username: string;
  installationId: number | string | null | undefined;
}

function buildKeys(ctx: RateContextKeys): Array<{ keyType: OperatorLoginLimitKeyType; compositeKey: string }> {
  const u = normalizeUsername(ctx.username);
  const inst = ctx.installationId != null ? String(ctx.installationId) : 'none';
  return [
    { keyType: 'username', compositeKey: u },
    { keyType: 'installation', compositeKey: inst },
    { keyType: 'composite', compositeKey: `${u}|${inst}` },
  ];
}

export async function checkRate(ctx: RateContextKeys): Promise<RateCheckResult> {
  const keys = buildKeys(ctx);
  const now = new Date();
  for (const k of keys) {
    const row = await db
      .select()
      .from(operatorLoginLimits)
      .where(and(eq(operatorLoginLimits.keyType, k.keyType), eq(operatorLoginLimits.compositeKey, k.compositeKey)))
      .limit(1);
    if (row.length > 0 && row[0].lockedUntil && row[0].lockedUntil > now) {
      return {
        allowed: false,
        reason:
          k.keyType === 'username'
            ? 'locked_username'
            : k.keyType === 'installation'
              ? 'locked_installation'
              : 'locked_composite',
        lockedUntil: row[0].lockedUntil.toISOString(),
        failedAttempts: row[0].failedAttempts,
      };
    }
  }
  return { allowed: true, reason: 'ok' };
}

export async function recordFailure(ctx: RateContextKeys): Promise<void> {
  const keys = buildKeys(ctx);
  const now = new Date();
  for (const k of keys) {
    const existing = await db
      .select()
      .from(operatorLoginLimits)
      .where(and(eq(operatorLoginLimits.keyType, k.keyType), eq(operatorLoginLimits.compositeKey, k.compositeKey)))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(operatorLoginLimits).values({
        keyType: k.keyType,
        compositeKey: k.compositeKey,
        failedAttempts: 1,
        firstAttemptAt: now,
        lastAttemptAt: now,
      });
      continue;
    }
    const row = existing[0];
    const withinWindow = row.lastAttemptAt && now.getTime() - row.lastAttemptAt.getTime() < ATTEMPT_WINDOW_MS;
    const newFailed = withinWindow ? row.failedAttempts + 1 : 1;
    let lockedUntil: Date | null = null;
    if (newFailed >= FAIL_THRESHOLD) {
      const rounds = Math.max(0, Math.floor(newFailed / FAIL_THRESHOLD) - 1);
      const lockMs = Math.min(BASE_LOCK_MS * 2 ** rounds, MAX_LOCK_MS);
      lockedUntil = new Date(now.getTime() + lockMs);
    }
    await db
      .update(operatorLoginLimits)
      .set({
        failedAttempts: newFailed,
        firstAttemptAt: withinWindow ? row.firstAttemptAt : now,
        lastAttemptAt: now,
        lockedUntil,
      })
      .where(eq(operatorLoginLimits.id, row.id));
  }
}

export async function recordSuccess(ctx: RateContextKeys): Promise<void> {
  const keys = buildKeys(ctx);
  const now = new Date();
  for (const k of keys) {
    const existing = await db
      .select()
      .from(operatorLoginLimits)
      .where(and(eq(operatorLoginLimits.keyType, k.keyType), eq(operatorLoginLimits.compositeKey, k.compositeKey)))
      .limit(1);
    if (existing.length > 0) {
      await db
        .update(operatorLoginLimits)
        .set({ failedAttempts: 0, lockedUntil: null, lastAttemptAt: now })
        .where(eq(operatorLoginLimits.id, existing[0].id));
    }
  }
}

export const _internalConstants = {
  FAIL_THRESHOLD,
  BASE_LOCK_MS,
  MAX_LOCK_MS,
  ATTEMPT_WINDOW_MS,
};
