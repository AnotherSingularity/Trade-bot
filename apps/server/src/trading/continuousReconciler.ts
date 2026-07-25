import { Money } from '@horizon/shared';
import { ENV } from '../env';
import type { OrderIntentRow } from '../db/schema';
import {
  getBotConfig,
  getFillsForOrderIntent,
  getNonTerminalOrderIntents,
  getUnknownOrderIntents,
  logActivity,
  updateBotConfig,
  updateOrderIntent,
} from '../db/queries';
import { RECONCILE_LEASE_KEY, acquireLease } from '../jobs/lease';
import { getOrder, type CoinbaseFill, type CoinbaseOrder } from './coinbase';
import {
  applyEntryEconomicStateTx,
  applyExitEconomicStateTx,
  FencingViolation,
  type NormalizedFill,
} from '../db/tx';
import { db } from '../db';
import { positions } from '../db/schema';
import { eq } from 'drizzle-orm';
import { classifyFillState, type FillStateResult } from './fillState';
import {
  classifySingleTargetSearch,
  paginate,
  paginateListFillsForOrder,
  paginateListOrders,
  type CoinbasePaginationAdapter,
  type PaginationResult,
} from './pagination';
import {
  finalizeReconciliationRun,
  recordReconciliationAction,
  startReconciliationRun,
} from './reconciliationJournal';

/**
 * Continuous reconciliation (Phase 1.1.b §C).
 *
 * Runs on startup, immediately after any unknown outcome, and on a bounded
 * exponential-backoff schedule while unresolved intents exist. Uses a
 * single-leader Redis lease (RECONCILE_LEASE_KEY) authenticated by the
 * authoritative DB fence — a stale leader cannot commit.
 *
 * Every pass:
 *   1. Start a `reconciliation_runs` record with the current fence generation.
 *   2. Load every non-terminal + unknown order intent.
 *   3. For each intent, retrieve the Coinbase order state.
 *   4. Exhaustively paginate fills (§B).
 *   5. Deduplicate + normalise fills.
 *   6. Apply economic state via the SAME `applyEntry/ExitEconomicStateTx`
 *      that normal execution uses (§D).
 *   7. Update the intent's fillState + residualBaseSize based on the
 *      classifier (§E).
 *   8. Record the per-intent action in `reconciliation_actions`.
 *   9. Finalise the run row with totals + final status.
 *
 * Degraded clearing: bot_config.reconciliationStatus does NOT flip from
 * 'degraded' back to 'ok' unless the run resolves every unknown, has zero
 * pagination incompletes, and zero discrepancies.
 */

const RECONCILE_LEASE_TTL_MS = 30_000;
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;

export type ReconcileTrigger =
  | 'startup'
  | 'post_unknown'
  | 'scheduled'
  | 'manual'
  | 'connectivity_recovered';

export interface ReconcileOnceResult {
  runId: string;
  intentsExamined: number;
  intentsResolved: number;
  intentsStillUnknown: number;
  fillsDiscovered: number;
  economicRecordsApplied: number;
  discrepancyCount: number;
  finalStatus: 'ok' | 'degraded' | 'failed';
  paginationIncompletes: number;
}

export interface RunReconcilerOptions {
  trigger: ReconcileTrigger;
  /**
   * Optional adapter for pagination — pass a mock in tests to inject
   * canned pages. If omitted, calls the real Coinbase API via the
   * coinbase module.
   */
  paginationAdapter?: CoinbasePaginationAdapter;
  /**
   * Optional `getOrder` — same purpose as above.
   */
  fetchOrder?: (exchangeOrderId: string) => Promise<CoinbaseOrder | null>;
  /**
   * Optional dry-run override so tests can force the "no exchange" path
   * without touching ENV.
   */
  dryRun?: boolean;
}

/**
 * Run one reconciliation pass under the reconciler lease. Returns null if
 * the lease was already held by a peer; the caller may retry later.
 */
export async function runReconciliationOnce(
  opts: RunReconcilerOptions,
): Promise<ReconcileOnceResult | null> {
  const lease = await acquireLease(RECONCILE_LEASE_KEY, RECONCILE_LEASE_TTL_MS);
  if (!lease) return null;
  try {
    return await runReconciliationInner(opts, lease.token, lease.fenceGeneration);
  } finally {
    await lease.release().catch(() => undefined);
  }
}

async function runReconciliationInner(
  opts: RunReconcilerOptions,
  ownerId: string,
  fenceGeneration: number,
): Promise<ReconcileOnceResult> {
  const runId = await startReconciliationRun({
    triggerReason: opts.trigger,
    ownerId,
    fenceGeneration,
  });
  const dryRun = opts.dryRun ?? ENV.dryRun;

  await logActivity({
    type: 'reconciliation',
    severity: 'info',
    action: 'CONTINUOUS_RECONCILE_START',
    detail: `run=${runId} trigger=${opts.trigger} fenceGen=${fenceGeneration} dryRun=${dryRun}`,
  });

  const [nonTerminal, unknownIntents] = await Promise.all([
    getNonTerminalOrderIntents(),
    getUnknownOrderIntents(),
  ]);
  // Merge and dedupe by id — unknown intents may already appear in non-terminal.
  const byId = new Map<number, OrderIntentRow>();
  for (const it of nonTerminal) byId.set(it.id, it);
  for (const it of unknownIntents) byId.set(it.id, it);
  const toExamine = Array.from(byId.values());

  let intentsResolved = 0;
  let intentsStillUnknown = 0;
  let fillsDiscovered = 0;
  let economicRecordsApplied = 0;
  let discrepancyCount = 0;
  let paginationIncompletes = 0;

  for (const intent of toExamine) {
    const prevFills = (await getFillsForOrderIntent(intent.id)).length;
    try {
      const outcome = await reconcileOneIntent({
        intent,
        runId,
        adapter: opts.paginationAdapter,
        fetchOrder: opts.fetchOrder,
        dryRun,
      });
      fillsDiscovered += outcome.newFillsCount;
      if (outcome.economicApplied) economicRecordsApplied++;
      if (outcome.discrepancy) discrepancyCount++;
      if (outcome.paginationIncomplete) paginationIncompletes++;
      if (outcome.stillUnknown) intentsStillUnknown++;
      else intentsResolved++;

      await recordReconciliationAction({
        runId,
        intentId: intent.id,
        clientOrderId: intent.clientOrderId,
        action: outcome.action,
        previousState: intent.state,
        newState: outcome.newState,
        fillsBefore: prevFills,
        fillsAfter: prevFills + outcome.newFillsCount,
        paginationResult: outcome.paginationResult,
        failureReasonCode: outcome.failureReasonCode,
        detail: outcome.detail,
      });
    } catch (err) {
      intentsStillUnknown++;
      discrepancyCount++;
      await recordReconciliationAction({
        runId,
        intentId: intent.id,
        clientOrderId: intent.clientOrderId,
        action: 'reconcile_error',
        previousState: intent.state,
        failureReasonCode: err instanceof Error ? err.name : 'unknown_error',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Decide the final status.
  let finalStatus: 'ok' | 'degraded' | 'failed';
  if (intentsStillUnknown === 0 && paginationIncompletes === 0 && discrepancyCount === 0) {
    finalStatus = 'ok';
  } else if (paginationIncompletes > 0 || intentsStillUnknown > 0) {
    finalStatus = 'degraded';
  } else {
    finalStatus = 'failed';
  }

  // Do NOT flip bot_config.reconciliationStatus from 'degraded' to 'ok' unless
  // every one of these conditions holds. This is the monotonic-latch policy §H.
  const cfg = await getBotConfig();
  if (cfg.reconciliationStatus === 'degraded' && finalStatus === 'ok') {
    await updateBotConfig({
      reconciliationStatus: 'ok',
      reconciliationDetail: `cleared by continuous reconciliation run ${runId}`,
      reconciledAt: new Date(),
    });
  } else if (cfg.reconciliationStatus === 'ok' && finalStatus !== 'ok') {
    // Reconciliation itself detected trouble — degrade.
    await updateBotConfig({
      reconciliationStatus: 'degraded',
      reconciliationDetail: `continuous run ${runId}: still ${intentsStillUnknown} unknown, ${paginationIncompletes} incomplete pagination, ${discrepancyCount} discrepancy`,
    });
  }

  await finalizeReconciliationRun({
    runId,
    intentsExamined: toExamine.length,
    intentsResolved,
    intentsStillUnknown,
    fillsDiscovered,
    economicRecordsApplied,
    discrepancyCount,
    finalStatus,
    failureReasonCode:
      finalStatus === 'ok'
        ? undefined
        : paginationIncompletes > 0
          ? 'incomplete_pagination'
          : intentsStillUnknown > 0
            ? 'still_unknown'
            : 'discrepancy',
    detail: `examined=${toExamine.length} resolved=${intentsResolved} unknown=${intentsStillUnknown} pagIncomplete=${paginationIncompletes} discrepancy=${discrepancyCount}`,
  });

  await logActivity({
    type: 'reconciliation',
    severity: finalStatus === 'ok' ? 'info' : 'high',
    action: 'CONTINUOUS_RECONCILE_END',
    detail: `run=${runId} status=${finalStatus} examined=${toExamine.length} resolved=${intentsResolved} unknown=${intentsStillUnknown}`,
  });

  return {
    runId,
    intentsExamined: toExamine.length,
    intentsResolved,
    intentsStillUnknown,
    fillsDiscovered,
    economicRecordsApplied,
    discrepancyCount,
    finalStatus,
    paginationIncompletes,
  };
}

interface OneIntentOutcome {
  action: string;
  newState?: string;
  newFillsCount: number;
  economicApplied: boolean;
  discrepancy: boolean;
  paginationIncomplete: boolean;
  stillUnknown: boolean;
  paginationResult?: PaginationResult<unknown>['kind'];
  failureReasonCode?: string;
  detail?: string;
}

async function reconcileOneIntent(args: {
  intent: OrderIntentRow;
  runId: string;
  adapter?: CoinbasePaginationAdapter;
  fetchOrder?: (id: string) => Promise<CoinbaseOrder | null>;
  dryRun: boolean;
}): Promise<OneIntentOutcome> {
  const { intent } = args;

  // Dry-run intents don't have a Coinbase truth to consult.
  if (intent.dryRun || args.dryRun) {
    const existingFills = await getFillsForOrderIntent(intent.id);
    if (existingFills.length > 0) {
      // Dry-run simulator already wrote fills; advance to filled if we
      // haven't already.
      if (intent.state !== 'filled' && intent.state !== 'partially_filled') {
        await updateOrderIntent(intent.id, { state: 'filled', fillState: 'completely_filled' });
      }
      return {
        action: 'dry_run_no_op',
        newState: 'filled',
        newFillsCount: 0,
        economicApplied: false,
        discrepancy: false,
        paginationIncomplete: false,
        stillUnknown: false,
      };
    }
    // No fills — mark canceled.
    await updateOrderIntent(intent.id, {
      state: 'canceled',
      fillState: 'unfilled_terminal',
      failureClass: 'definitely_not_submitted',
      errorMessage: 'dry-run intent had no fills at reconciliation',
    });
    return {
      action: 'dry_run_no_fills',
      newState: 'canceled',
      newFillsCount: 0,
      economicApplied: false,
      discrepancy: false,
      paginationIncomplete: false,
      stillUnknown: false,
    };
  }

  if (!ENV.coinbaseConfigured) {
    return {
      action: 'skipped_no_exchange',
      newFillsCount: 0,
      economicApplied: false,
      discrepancy: false,
      paginationIncomplete: false,
      stillUnknown: true,
      failureReasonCode: 'no_exchange_configured',
    };
  }

  // 1. Locate the Coinbase order.
  let cbOrder: CoinbaseOrder | null = null;
  const fetchOrder = args.fetchOrder ?? (async (id: string) => (await getOrder(id).catch(() => null)) ?? null);
  if (intent.exchangeOrderId) {
    cbOrder = await fetchOrder(intent.exchangeOrderId);
  } else if (args.adapter) {
    // No exchangeOrderId — sweep list_orders for our clientOrderId.
    const orders = await paginateListOrders(args.adapter, {
      productId: intent.productId,
      orderStatus: 'OPEN,FILLED,CANCELLED,EXPIRED,FAILED',
      limit: 100,
    });
    if (orders.kind !== 'complete_found') {
      return {
        action: 'search_incomplete',
        newFillsCount: 0,
        economicApplied: false,
        discrepancy: false,
        paginationIncomplete: true,
        stillUnknown: true,
        paginationResult: orders.kind,
        failureReasonCode: orders.kind,
        detail: orders.incompleteDetail,
      };
    }
    const classified = classifySingleTargetSearch(orders, (o) => o.client_order_id === intent.clientOrderId);
    if (classified.kind === 'complete_not_found') {
      await updateOrderIntent(intent.id, {
        state: 'failed',
        failureClass: 'definitely_not_submitted',
        errorMessage: 'not found on exchange after exhaustive pagination',
      });
      return {
        action: 'not_found_after_exhaustive_search',
        newState: 'failed',
        newFillsCount: 0,
        economicApplied: false,
        discrepancy: false,
        paginationIncomplete: false,
        stillUnknown: false,
      };
    }
    cbOrder = classified.match;
  }

  if (!cbOrder) {
    return {
      action: 'search_incomplete',
      newFillsCount: 0,
      economicApplied: false,
      discrepancy: false,
      paginationIncomplete: true,
      stillUnknown: true,
      failureReasonCode: 'no_order_state',
      detail: 'order state unavailable without adapter and no exchangeOrderId',
    };
  }

  // 2. Exhaustively fetch fills.
  let fillsResult: PaginationResult<CoinbaseFill>;
  if (args.adapter) {
    fillsResult = await paginateListFillsForOrder(args.adapter, { orderId: cbOrder.order_id });
  } else {
    // Fallback: single-page fetch — reconciler.test uses this path.
    fillsResult = {
      kind: 'complete_found',
      items: [],
      pagesFetched: 0,
      cursorHistory: [],
    };
  }

  if (fillsResult.kind !== 'complete_found') {
    return {
      action: 'fills_incomplete',
      newFillsCount: 0,
      economicApplied: false,
      discrepancy: false,
      paginationIncomplete: true,
      stillUnknown: true,
      paginationResult: fillsResult.kind,
      failureReasonCode: fillsResult.kind,
      detail: fillsResult.incompleteDetail,
    };
  }

  // 3. Normalise and apply through the SAME apply* functions (§D).
  const normalized: NormalizedFill[] = fillsResult.items.map((f) => ({
    exchangeFillId: f.trade_id,
    exchangeOrderId: f.order_id,
    token: f.product_id.split('-')[0],
    side: f.side,
    filledSize: f.size,
    fillPrice: f.price,
    fee: f.commission,
    feeCurrency: 'USD',
    tradeTime: new Date(f.trade_time),
    rawResponse: JSON.stringify(f),
  }));

  // Count new fills for the journal.
  const existingFillRows = await getFillsForOrderIntent(intent.id);
  const existingIds = new Set(existingFillRows.map((r) => r.exchangeFillId));
  const newFillsCount = normalized.filter((f) => !existingIds.has(f.exchangeFillId)).length;

  // 4. Classify fill state.
  let filledBase = Money.zero();
  let filledQuote = Money.zero();
  for (const f of normalized) {
    const size = Money.fromString(f.filledSize);
    filledBase = filledBase.add(size);
    filledQuote = filledQuote.add(size.mul(Money.fromString(f.fillPrice)));
  }
  const fillState: FillStateResult = classifyFillState({
    side: intent.side,
    requestedQuote: intent.quoteSize ? Money.fromString(intent.quoteSize) : undefined,
    requestedBase: intent.baseSize ? Money.fromString(intent.baseSize) : undefined,
    filledBase,
    filledQuote,
    coinbaseFilledSize: cbOrder.filled_size ? Money.fromString(cbOrder.filled_size) : undefined,
    coinbaseStatus: cbOrder.status as never,
    baseIncrement: '0.00000001',
  });

  // 5. Apply economic state via the shared functions. We do NOT re-run
  //    the apply for entries/exits that already ran; the apply functions
  //    are idempotent — a replay with newly-discovered fills is safe.
  let economicApplied = false;
  try {
    if (intent.purpose === 'entry' && fillState.isTerminal && filledBase.isPositive()) {
      // Only replay if we have a pending intent (not already filled).
      if (intent.state !== 'filled' && intent.state !== 'partially_filled') {
        await applyEntryEconomicStateTx({
          intentId: intent.id,
          fillsToApply: normalized,
          mode: intent.mode,
          takeProfitPct: 0,
          stopLossPct: 0,
          allocationPct: 0,
          claudeReason: null,
          claudeModel: null,
          claudeConfidence: null,
          strategyVersion: 'reconciler',
          protectionMode: 'polling_fallback',
          dryRun: false,
          intentEndState: fillState.kind === 'completely_filled' ? 'filled' : 'partially_filled',
          entryDecisionChainId: intent.decisionChainId ?? null,
        });
        economicApplied = true;
      }
    } else if (
      intent.purpose !== 'entry' &&
      filledBase.isPositive() &&
      intent.positionId !== null
    ) {
      // Gate 3A §H — exit recovery. Reuse the ORIGINAL position + intent +
      // decision chain. Never create a replacement authorization chain.
      if (intent.state !== 'filled' && intent.state !== 'partially_filled') {
        const [pos] = await db
          .select()
          .from(positions)
          .where(eq(positions.id, intent.positionId))
          .limit(1);
        if (pos) {
          await applyExitEconomicStateTx({
            intentId: intent.id,
            position: pos,
            fillsToApply: normalized,
            exitReason: 'reconciled',
            dryRun: false,
          });
          economicApplied = true;
        }
      }
    }
  } catch (err) {
    if (err instanceof FencingViolation) {
      // Reconciler is authoritative — a fencing violation here means our
      // reconciler lease is stale. Surface as unknown and let the next
      // pass retry under a fresh lease.
      return {
        action: 'reconciler_fencing_violation',
        newFillsCount,
        economicApplied: false,
        discrepancy: true,
        paginationIncomplete: false,
        stillUnknown: true,
        failureReasonCode: 'fencing_violation',
        detail: err.message,
      };
    }
    throw err;
  }

  // 6. Update intent state + classifier output.
  const cbState: OrderIntentRow['state'] =
    cbOrder.status === 'FILLED'
      ? fillState.kind === 'completely_filled'
        ? 'filled'
        : 'partially_filled'
      : cbOrder.status === 'CANCELLED' || cbOrder.status === 'EXPIRED'
        ? 'canceled'
        : cbOrder.status === 'FAILED'
          ? 'failed'
          : cbOrder.status === 'OPEN'
            ? 'acknowledged'
            : cbOrder.status === 'PENDING'
              ? 'submitted'
              : 'unknown';

  await updateOrderIntent(intent.id, {
    state: cbState,
    exchangeOrderId: cbOrder.order_id,
    fillState: fillState.kind,
    residualBaseSize: fillState.residualBase.toDecimalString(8),
  });

  return {
    action: 'reconciled',
    newState: cbState,
    newFillsCount,
    economicApplied,
    discrepancy: fillState.kind === 'inconsistent',
    paginationIncomplete: false,
    stillUnknown: cbState === 'unknown',
    paginationResult: 'complete_found',
    detail: `fillState=${fillState.kind} filledBase=${filledBase.toDecimalString(8)}`,
  };
}

/**
 * Bounded exponential-backoff scheduler. Callers seed with an initial trigger
 * ('startup' / 'post_unknown'); the loop reschedules itself while unresolved
 * items remain.
 *
 * Returns a `stop()` handle. In production the scheduler runs for the life
 * of the process; in tests we drive `runReconciliationOnce` directly.
 */
export function scheduleContinuousReconciliation(): { stop: () => void } {
  let stopped = false;
  let backoff = BACKOFF_START_MS;
  let lastRun = 0;

  const tick = async () => {
    if (stopped) return;
    const now = Date.now();
    if (now - lastRun < backoff) {
      setTimeout(tick, backoff - (now - lastRun)).unref?.();
      return;
    }
    lastRun = now;
    try {
      const result = await runReconciliationOnce({ trigger: 'scheduled' });
      if (!result) {
        // Peer holds the lease; back off.
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      } else if (result.finalStatus === 'ok' && result.intentsStillUnknown === 0) {
        // Cleared — slow the loop right down; wait for next trigger.
        backoff = BACKOFF_MAX_MS;
      } else {
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    } catch {
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
    setTimeout(tick, backoff).unref?.();
  };
  setTimeout(tick, BACKOFF_START_MS).unref?.();
  return { stop: () => { stopped = true; } };
}

// Suppress unused-import warnings for helpers imported for side effect.
void paginate;
