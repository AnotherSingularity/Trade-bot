import { randomBytes } from 'node:crypto';
import IORedis from 'ioredis';
import { ENV } from '../env';

/**
 * Redis-backed leader lease with periodic renewal + fencing token
 * (Phase 1.1.a §H).
 *
 * Prevents overlapping scan cycles across replicas — a single-writer invariant
 * for the entry pipeline.
 *
 * Renewal: `withRenewingLease` refreshes the TTL every `ttlMs / 3` while the
 * caller runs. If a renewal ever fails (Redis returns 0 = the key vanished, or
 * a peer stole it), the lease is marked invalid; callers may check via
 * `lease.isValid()` before committing an economic mutation.
 *
 * Fencing: each acquire also bumps a per-key monotonic counter
 * (`<key>:generation`) via INCR. The generation number is attached to the
 * lease object as `fenceGeneration`. Slice 1.1.b will thread this generation
 * through the DB writes so a stale worker whose renewal failed cannot commit
 * an update that a fresher holder has already made.
 *
 * Release: CAS via Lua — DEL only if the token still matches.
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

async function bumpGeneration(key: string): Promise<number> {
  const n = await getRedis().incr(`${key}:generation`);
  return Number(n);
}

/**
 * Attempts to acquire the lease. Returns null if another holder has it.
 * TTL guards against a crashed holder never releasing.
 */
export async function acquireLease(key: string, ttlMs: number): Promise<Lease | null> {
  const token = randomBytes(16).toString('hex');
  const res = await getRedis().set(key, token, 'PX', ttlMs, 'NX');
  if (res !== 'OK') return null;
  const fenceGeneration = await bumpGeneration(key);

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

/** Fetches the current fence generation for `key` without acquiring the lease. */
export async function getFenceGeneration(key: string): Promise<number> {
  const raw = await getRedis().get(`${key}:generation`);
  return raw ? Number(raw) : 0;
}

export const SCAN_LEASE_KEY = 'horizon:lease:scan';
export const RECONCILE_LEASE_KEY = 'horizon:lease:reconcile';
