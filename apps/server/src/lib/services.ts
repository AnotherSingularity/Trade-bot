import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { STRATEGY, STRATEGY_VERSION, type BotStatus } from '@horizon/shared';
import { ENV } from '../env';
import { countOpenPositions, getBotConfig, getOpenPositions } from '../db/queries';
import { getMarketWindow } from '../trading/marketWindow';

/**
 * Shared business logic used by BOTH the tRPC routers and the REST compatibility
 * layer, so the two API surfaces never drift.
 */

/** Verifies the admin password and returns a signed JWT, or null if invalid. */
export async function authenticate(password: string): Promise<string | null> {
  if (!ENV.adminPasswordHash) {
    throw new Error('ADMIN_PASSWORD_HASH is not configured on the server');
  }
  const ok = await bcrypt.compare(password, ENV.adminPasswordHash);
  if (!ok) return null;
  return jwt.sign({ sub: 'admin' }, ENV.jwtSecret, {
    expiresIn: ENV.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

/** Builds the live BotStatus DTO — includes Phase 0 safety fields. */
export async function getBotStatusDTO(): Promise<BotStatus> {
  const cfg = await getBotConfig();
  const openPositions = await countOpenPositions();
  const cbActive = Boolean(cfg.circuitBreakerUntil && cfg.circuitBreakerUntil > new Date());

  // Worst-case protection mode across all open positions dictates what the UI
  // shows (so a single unprotected position warns the user).
  let protectionMode: BotStatus['protectionMode'] = 'exchange_bracket';
  if (openPositions > 0) {
    const rows = await getOpenPositions();
    if (rows.some((r) => r.protectionMode === 'unprotected'))
      protectionMode = 'unprotected';
    else if (rows.some((r) => r.protectionMode === 'polling_fallback'))
      protectionMode = 'polling_fallback';
  } else {
    // No positions — reflect the deployment default.
    protectionMode = 'polling_fallback';
  }

  return {
    isRunning: cfg.isRunning,
    isPaused: cfg.isPaused,
    consecutiveLosses: cfg.consecutiveLosses,
    circuitBreakerUntil: cfg.circuitBreakerUntil ? cfg.circuitBreakerUntil.toISOString() : null,
    circuitBreakerActive: cbActive,
    openPositions,
    maxPositions: STRATEGY.MAX_OPEN_POSITIONS,
    marketWindow: getMarketWindow(),
    updatedAt: cfg.updatedAt.toISOString(),
    dryRun: ENV.dryRun,
    reconciliationStatus: cfg.reconciliationStatus,
    protectionMode,
    strategyVersion: STRATEGY_VERSION,
  };
}

// ---------------------------------------------------------------------------
// In-process login rate limiter
// ---------------------------------------------------------------------------

interface Bucket {
  count: number;
  windowStart: number;
  lockedUntil: number;
}
const loginBuckets = new Map<string, Bucket>();

/**
 * Simple sliding-window rate limiter. Returns true if the attempt should be
 * ALLOWED. After 3× the limit within a window, IP is locked for 15 minutes.
 */
export function checkLoginRate(ip: string, now = Date.now()): { allowed: boolean; lockedUntil?: number } {
  const WINDOW_MS = 60_000;
  const HARD_LOCK_MS = 15 * 60_000;
  const limit = ENV.loginRateLimitPerMinute;
  const bucket = loginBuckets.get(ip) ?? { count: 0, windowStart: now, lockedUntil: 0 };

  if (bucket.lockedUntil > now) {
    return { allowed: false, lockedUntil: bucket.lockedUntil };
  }
  if (now - bucket.windowStart > WINDOW_MS) {
    bucket.count = 0;
    bucket.windowStart = now;
  }
  bucket.count++;
  if (bucket.count > limit * 3) {
    bucket.lockedUntil = now + HARD_LOCK_MS;
    loginBuckets.set(ip, bucket);
    return { allowed: false, lockedUntil: bucket.lockedUntil };
  }
  loginBuckets.set(ip, bucket);
  return { allowed: bucket.count <= limit };
}

/** Test hook to reset the rate limiter between test cases. */
export function resetLoginRateLimiter(): void {
  loginBuckets.clear();
}
