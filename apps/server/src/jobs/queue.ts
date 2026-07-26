import { Queue, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { STRATEGY } from '@horizon/shared';
import { ENV } from '../env';

/**
 * Shared BullMQ connection + scan queue.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on the ioredis connection used by
 * blocking commands (the worker), so we construct an explicit client.
 */
export const redisConnection = new IORedis(ENV.redisUrl, {
  maxRetriesPerRequest: null,
});

// BullMQ bundles its own ioredis copy; the instance is runtime-compatible but
// the duplicated type declarations don't structurally match, so we cast.
export const connectionOptions = redisConnection as unknown as ConnectionOptions;

export const SCAN_QUEUE_NAME = 'scan';
export const SCAN_JOB_NAME = 'scan-cycle';
export const SCAN_REPEAT_KEY = 'horizon-scan-repeat';

// Stage 2-FIX §1: BullMQ key prefix. Defaults to BullMQ's own 'bull';
// integration tests set HORIZON_REDIS_NAMESPACE so their keys live under
// a disposable namespace instead of colliding with any other instance.
export const BULLMQ_PREFIX = ENV.redisNamespace ? `${ENV.redisNamespace}:bull` : 'bull';

export const scanQueue = new Queue(SCAN_QUEUE_NAME, {
  connection: connectionOptions,
  prefix: BULLMQ_PREFIX,
});

/** Registers the recurring scan job (idempotent via a fixed repeat key). */
export async function scheduleRecurringScan(): Promise<void> {
  await scanQueue.add(
    SCAN_JOB_NAME,
    {},
    {
      repeat: { every: STRATEGY.SCAN_INTERVAL_MS, key: SCAN_REPEAT_KEY },
      removeOnComplete: 10,
      removeOnFail: 50,
    },
  );
}

/** Enqueues a one-off immediate scan (used by the "scan now" control). */
export async function triggerImmediateScan(): Promise<void> {
  await scanQueue.add(SCAN_JOB_NAME, {}, { removeOnComplete: 10, removeOnFail: 50 });
}
