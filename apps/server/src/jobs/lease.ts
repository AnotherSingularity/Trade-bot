import { randomBytes } from 'node:crypto';
import IORedis from 'ioredis';
import { ENV } from '../env';

/**
 * Redis-backed leader lease.
 *
 * Prevents overlapping scan cycles across replicas (a single-writer invariant
 * for the entry pipeline). Each lease is held with a UUID and released only if
 * the current holder still owns it (checked via a Lua CAS script).
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

export interface Lease {
  key: string;
  token: string;
  release: () => Promise<boolean>;
}

/**
 * Attempts to acquire the lease. Returns null if another holder has it.
 * TTL guards against a crashed holder never releasing.
 */
export async function acquireLease(key: string, ttlMs: number): Promise<Lease | null> {
  const token = randomBytes(16).toString('hex');
  const res = await getRedis().set(key, token, 'PX', ttlMs, 'NX');
  if (res !== 'OK') return null;
  return {
    key,
    token,
    async release() {
      const result = (await getRedis().eval(RELEASE_SCRIPT, 1, key, token)) as number;
      return result === 1;
    },
  };
}

/**
 * Runs `fn` under the named lease. Returns null if the lease is unavailable
 * (callers should treat this as "another replica is already handling it").
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

export const SCAN_LEASE_KEY = 'horizon:lease:scan';
export const RECONCILE_LEASE_KEY = 'horizon:lease:reconcile';
