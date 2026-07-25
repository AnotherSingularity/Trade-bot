import { randomBytes } from 'node:crypto';
import IORedis from 'ioredis';
import { ENV } from '../env';
import { bumpExecutionFence, releaseExecutionFence } from '../db/executionFence';

/**
 * Redis-backed leader lease with periodic renewal + AUTHORITATIVE DB fencing.
 *
 * Prevents overlapping scan cycles across replicas — a single-writer invariant
 * for the entry pipeline.
 *
 * Renewal: `withRenewingLease` refreshes the TTL every `ttlMs / 3` while the
 * caller runs. If a renewal ever fails (Redis returns 0 = the key vanished, or
 * a peer stole it), the lease is marked invalid; callers may check via
 * `lease.isValid()` before committing an economic mutation.
 *
 * Fencing (Phase 1.1.b §A): each successful acquire also atomically bumps
 * `execution_fences.currentGeneration` for the same resource key via
 * `bumpExecutionFence`. The generation returned by the DB — NOT by Redis —
 * is authoritative and is what verifyFencingTx compares against inside the
 * atomic economic transaction. Redis's local INCR is retained as a
 * best-effort observation channel (getFenceGeneration), not for authorization.
 *
 * Release: CAS via Lua — DEL only if the token still matches, plus mark the
 * DB fence row 'released' (informational only; the generation is NEVER
 * decremented).
 */

let sharedRedis: IORedis | null = null;

function getRedis(): IORedis {
  if (!sharedRedis) {
    sharedRedis = new IORedis(ENV.redisUrl, { maxRetriesPerRequest: null });
  }
  return sharedRedis;
}

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/**
 * PEXPIRE only if the token still matches the current owner. Returns 1 on
 * success, 0 if the key vanished or a peer stole it (lease is dead).
 */
const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

export interface Lease {
  key: string;
  token: string;
  fenceGeneration: number;
  isValid: () => boolean;
  renew: () => Promise<boolean>;
  release: () => Promise<boolean>;
}

async function bumpRedisGenerationObservation(key: string): Promise<void> {
  // Best-effort observation channel — NOT authoritative. If this fails we
  // still proceed; the DB fence is the source of truth.
  try {
    await getRedis().incr(`${key}:generation`);
  } catch {
    /* swallow */
  }
}

/**
 * Attempts to acquire the lease. Returns null if another holder has it.
 * TTL guards against a crashed holder never releasing.
 *
 * The returned `fenceGeneration` comes from the AUTHORITATIVE DB fence
 * (`execution_fences.currentGeneration`), not from Redis. This is the
 * value callers must persist on order_intents.
 */
export async function acquireLease(key: string, ttlMs: number): Promise<Lease | null> {
  const token = randomBytes(16).toString('hex');
  const res = await getRedis().set(key, token, 'PX', ttlMs, 'NX');
  if (res !== 'OK') return null;

  // Authoritative fence bump — DB source of truth.
  const acquired = await bumpExecutionFence(key, token);
  const fenceGeneration = acquired.newGeneration;
  await bumpRedisGenerationObservation(key); // best-effort observation

  let valid = true;

  return {
    key,
    token,
    fenceGeneration,
    isValid: () => valid,
    async renew() {
      if (!valid) return false;
      const result = (await getRedis().eval(RENEW_SCRIPT, 1, key, token, String(ttlMs))) as number;
      if (result !== 1) valid = false;
      return result === 1;
    },
    async release() {
      valid = false;
      const result = (await getRedis().eval(RELEASE_SCRIPT, 1, key, token)) as number;
      // Informational: mark DB fence row released. Never decrement the generation.
      await releaseExecutionFence(key, token).catch(() => undefined);
      return result === 1;
    },
  };
}

/**
 * Runs `fn` under the named lease WITH periodic renewal. Renewal fires every
 * `ttlMs / 3` while `fn` is executing. If any renewal fails the lease is
 * marked invalid and `fn` can bail via `lease.isValid()`.
 *
 * Returns `{ran:false}` if the lease was already held.
 */
export async function withRenewingLease<T>(
  key: string,
  ttlMs: number,
  fn: (lease: Lease) => Promise<T>,
): Promise<{ ran: true; result: T; lease: Lease } | { ran: false }> {
  const lease = await acquireLease(key, ttlMs);
  if (!lease) return { ran: false };

  const renewIntervalMs = Math.max(100, Math.floor(ttlMs / 3));
  const timer = setInterval(() => {
    // Best-effort; renew() flips isValid() when it fails.
    lease.renew().catch(() => undefined);
  }, renewIntervalMs);
  timer.unref?.();

  try {
    const result = await fn(lease);
    return { ran: true, result, lease };
  } finally {
    clearInterval(timer);
    await lease.release().catch(() => undefined);
  }
}

/**
 * Non-renewing lease (Phase 0 semantics — retained for short-lived callers
 * like manual scan triggers that finish well inside the TTL).
 */
export async function withLease<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
  const lease = await acquireLease(key, ttlMs);
  if (!lease) return { ran: false };
  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    await lease.release().catch(() => undefined);
  }
}

/**
 * Fetches the current fence generation for `key` without acquiring the lease.
 * Reads the AUTHORITATIVE DB fence table (Phase 1.1.b §A). Returns 0 if no
 * row exists yet (no acquire has ever recorded a generation).
 */
export async function getFenceGeneration(key: string): Promise<number> {
  const { readExecutionFenceGeneration } = await import('../db/executionFence');
  return readExecutionFenceGeneration(key);
}

export const SCAN_LEASE_KEY = 'horizon:lease:scan';
export const RECONCILE_LEASE_KEY = 'horizon:lease:reconcile';
