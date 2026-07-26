import { Worker } from 'bullmq';
import { runScanCycle } from '../trading/scanner';
import { logActivity } from '../db/queries';
import { BULLMQ_PREFIX, SCAN_QUEUE_NAME, connectionOptions } from './queue';

/**
 * BullMQ worker that executes the scan cycle. Running the bot loop through a
 * durable queue means it survives server restarts and never overlaps with itself
 * (concurrency: 1).
 */
export function createScanWorker(): Worker {
  const worker = new Worker(
    SCAN_QUEUE_NAME,
    async () => {
      await runScanCycle();
    },
    {
      connection: connectionOptions,
      concurrency: 1,
      prefix: BULLMQ_PREFIX,
    },
  );

  worker.on('failed', async (job, err) => {
    try {
      await logActivity({
        type: 'error',
        action: 'SCAN_JOB_FAILED',
        detail: `Job ${job?.id ?? '?'} failed: ${err.message}`,
      });
    } catch {
      console.error('[scanWorker] failed to log job error', err);
    }
  });

  return worker;
}
