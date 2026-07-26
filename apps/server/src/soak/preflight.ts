import { eq } from 'drizzle-orm';
import { db } from '../db';
import {
  soakPreflightRuns,
  type SoakPreflightRunRow,
} from '../db/schema';
import { httpCounters } from '../lib/fetchBarrier';

/**
 * Phase 1.2-OPS §B — production preflight harness.
 *
 * Runs a minimum two-hour preflight against the selected providers.
 * The clock is injectable so tests do not need to sleep. In production
 * the operator supplies `Date.now()` and the module simply records the
 * observations.
 *
 * A preflight either PASSES (every check ok + createOrder counters all
 * 0) or FAILS (the failure reasons are persisted on the row and the
 * soak runner refuses to transition to `running`).
 *
 * The soak runner refuses to promote to `running` unless
 * `passed === true` AND the underlying providers were `isProduction`.
 */

export const PREFLIGHT_VERSION = 'p1_2-ops-preflight-1';

export const MINIMUM_PREFLIGHT_SECONDS = 2 * 60 * 60; // 2 hours

export interface PreflightCheckInput {
  startedAt: Date;
  completedAt: Date;
  connectionHealthy: boolean;
  heartbeatsContinuous: boolean;
  productsBootstrapped: number;
  productsFailed: number;
  candleHistoryOrdered: boolean;
  scannerReadsLiveState: boolean;
  scheduledManualSameSource: boolean;
  feeTierRetrievalOk: boolean;
  previewSucceededOrFailedClosed: boolean;
  productMetadataFresh: boolean;
  dataGapsPersisted: boolean;
  reconnectWorks: boolean;
  restartRestoresState: boolean;
  soakRunId?: string | null;
}

export interface PreflightResult {
  row: SoakPreflightRunRow;
  passed: boolean;
  failureReasons: string[];
}

export async function recordPreflight(input: PreflightCheckInput): Promise<PreflightResult> {
  const failures: string[] = [];
  const durationSeconds = Math.floor(
    (input.completedAt.getTime() - input.startedAt.getTime()) / 1000,
  );
  if (durationSeconds < MINIMUM_PREFLIGHT_SECONDS) {
    failures.push(
      `preflight_too_short: ${durationSeconds}s < required ${MINIMUM_PREFLIGHT_SECONDS}s`,
    );
  }
  if (!input.connectionHealthy) failures.push('connection_not_healthy');
  if (!input.heartbeatsContinuous) failures.push('heartbeats_not_continuous');
  if (input.productsBootstrapped === 0) failures.push('no_products_bootstrapped');
  if (input.productsFailed > input.productsBootstrapped) failures.push('more_products_failed_than_bootstrapped');
  if (!input.candleHistoryOrdered) failures.push('candle_history_out_of_order');
  if (!input.scannerReadsLiveState) failures.push('scanner_not_reading_live_state');
  if (!input.scheduledManualSameSource) failures.push('scheduled_and_manual_diverge');
  if (!input.feeTierRetrievalOk) failures.push('fee_tier_retrieval_failed');
  if (!input.previewSucceededOrFailedClosed) failures.push('preview_did_not_fail_closed_on_error');
  if (!input.productMetadataFresh) failures.push('product_metadata_stale');
  if (!input.dataGapsPersisted) failures.push('data_gaps_not_persisted');
  if (!input.reconnectWorks) failures.push('reconnect_did_not_recover');
  if (!input.restartRestoresState) failures.push('restart_did_not_restore_state');
  const counters = httpCounters();
  if (counters.createOrderFunctionInvocations !== 0) {
    failures.push(`createOrderFunctionInvocations=${counters.createOrderFunctionInvocations}`);
  }
  if (counters.createOrderAttemptCount !== 0) {
    failures.push(`createOrderAttemptCount=${counters.createOrderAttemptCount}`);
  }
  if (counters.createOrderNetworkCount !== 0) {
    failures.push(`createOrderNetworkCount=${counters.createOrderNetworkCount}`);
  }
  const passed = failures.length === 0;
  const [{ insertId }] = (await db.insert(soakPreflightRuns).values({
    soakRunId: input.soakRunId ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationSeconds,
    connectionHealthy: input.connectionHealthy,
    heartbeatsContinuous: input.heartbeatsContinuous,
    productsBootstrapped: input.productsBootstrapped,
    productsFailed: input.productsFailed,
    candleHistoryOrdered: input.candleHistoryOrdered,
    scannerReadsLiveState: input.scannerReadsLiveState,
    scheduledManualSameSource: input.scheduledManualSameSource,
    feeTierRetrievalOk: input.feeTierRetrievalOk,
    previewSucceededOrFailedClosed: input.previewSucceededOrFailedClosed,
    productMetadataFresh: input.productMetadataFresh,
    dataGapsPersisted: input.dataGapsPersisted,
    reconnectWorks: input.reconnectWorks,
    restartRestoresState: input.restartRestoresState,
    createOrderFunctionInvocations: counters.createOrderFunctionInvocations,
    createOrderAttemptCount: counters.createOrderAttemptCount,
    createOrderNetworkCount: counters.createOrderNetworkCount,
    passed,
    failureReasons: failures.length > 0 ? JSON.stringify(failures) : null,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(soakPreflightRuns)
    .where(eq(soakPreflightRuns.id, insertId))
    .limit(1);
  return { row: row!, passed, failureReasons: failures };
}

export async function latestPassedPreflight(): Promise<SoakPreflightRunRow | null> {
  const rows = await db
    .select()
    .from(soakPreflightRuns)
    .where(eq(soakPreflightRuns.passed, true))
    .orderBy(soakPreflightRuns.completedAt);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}
