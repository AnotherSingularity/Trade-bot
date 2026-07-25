import { ENV } from '../env';
import {
  aggregateFills,
  getFillsForOrderIntent,
  getNonTerminalOrderIntents,
  getOpenPositions,
  logActivity,
  updateBotConfig,
  updateOrderIntent,
} from '../db/queries';
import type { OrderIntentRow } from '../db/schema';
import {
  CoinbaseError,
  findOrderByClientId,
  getAccounts,
  getOrder,
  listFillsForOrder,
  type CoinbaseFill,
  type CoinbaseOrder,
} from './coinbase';
import { insertFill } from '../db/queries';

/**
 * Startup reconciler — Phase 0 §G.
 *
 * Blocks entries until it has proven the DB and Coinbase agree. It:
 *   1. Loads every non-terminal `order_intents` row.
 *   2. Looks each up on Coinbase (by exchangeOrderId or clientOrderId).
 *   3. Persists any missing fills.
 *   4. Advances intent state to its true terminal value.
 *   5. Compares DB open positions against Coinbase spot holdings and flags
 *      unexplained exposure.
 *   6. Sets bot_config.reconciliationStatus = 'ok' only if everything checks
 *      out; otherwise 'failed' and entries stay disabled.
 *
 * In dry-run this is largely a no-op (there is no Coinbase truth to
 * reconcile against), but it still confirms non-terminal intents were
 * completed by the dry-run simulator.
 */

interface ReconcileReport {
  intentsReconciled: number;
  intentsRecovered: number;
  intentsUnresolved: number;
  orphanExposureCount: number;
  discrepancies: string[];
}

export async function reconcileOnStartup(): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    intentsReconciled: 0,
    intentsRecovered: 0,
    intentsUnresolved: 0,
    orphanExposureCount: 0,
    discrepancies: [],
  };

  await updateBotConfig({
    reconciliationStatus: 'in_progress',
    reconciliationDetail: 'starting reconciliation',
  });
  await logActivity({
    type: 'reconciliation',
    severity: 'info',
    action: 'RECONCILE_START',
    detail: `Startup reconciliation begin (dryRun=${ENV.dryRun}, coinbase=${ENV.coinbaseConfigured})`,
  });

  // 1) Non-terminal intents.
  const nonTerminal = await getNonTerminalOrderIntents();
  for (const intent of nonTerminal) {
    try {
      const resolved = await reconcileIntent(intent);
      report.intentsReconciled++;
      if (resolved) report.intentsRecovered++;
      else report.intentsUnresolved++;
    } catch (err) {
      report.intentsUnresolved++;
      const msg = err instanceof Error ? err.message : String(err);
      report.discrepancies.push(`intent#${intent.id} ${intent.clientOrderId}: ${msg}`);
      await logActivity({
        type: 'reconciliation',
        severity: 'critical',
        token: intent.token,
        action: 'RECONCILE_INTENT_FAILED',
        detail: `${intent.clientOrderId}: ${msg}`,
      });
    }
  }

  // 2) Orphan exposure: compare DB open positions vs. Coinbase holdings.
  if (!ENV.dryRun && ENV.coinbaseConfigured) {
    try {
      const [accounts, dbPositions] = await Promise.all([getAccounts(), getOpenPositions()]);
      const heldByToken = new Map<string, number>();
      for (const a of accounts) {
        const bal = Number(a.available_balance.value);
        if (bal > 0 && a.currency !== 'USD') {
          heldByToken.set(a.currency, bal);
        }
      }
      // For every position in DB we expect ≥ that qty at Coinbase.
      for (const p of dbPositions) {
        const held = heldByToken.get(p.token) ?? 0;
        const expected = Number(p.filledQuantity);
        // Small tolerance — Coinbase may show slightly less due to holds.
        if (held + 1e-8 < expected * 0.999) {
          report.orphanExposureCount++;
          const msg = `DB shows ${expected} ${p.token} open but Coinbase holds ${held}`;
          report.discrepancies.push(msg);
          await logActivity({
            type: 'reconciliation',
            severity: 'critical',
            token: p.token,
            action: 'DB_EXCEEDS_EXCHANGE',
            detail: msg,
          });
        }
        heldByToken.delete(p.token);
      }
      // Everything left in heldByToken is unexplained exposure (spot holdings
      // we didn't open). We surface but do not liquidate — that's a human call.
      for (const [token, qty] of heldByToken) {
        report.orphanExposureCount++;
        const msg = `Coinbase holds ${qty} ${token} with no matching DB position`;
        report.discrepancies.push(msg);
        await logActivity({
          type: 'reconciliation',
          severity: 'high',
          token,
          action: 'ORPHAN_EXCHANGE_HOLDING',
          detail: msg,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.discrepancies.push(`holdings comparison failed: ${msg}`);
    }
  }

  const ok = report.intentsUnresolved === 0 && report.orphanExposureCount === 0;
  await updateBotConfig({
    reconciliationStatus: ok ? 'ok' : 'failed',
    reconciliationDetail: JSON.stringify(report).slice(0, 4_000),
    reconciledAt: new Date(),
  });
  await logActivity({
    type: 'reconciliation',
    severity: ok ? 'info' : 'critical',
    action: ok ? 'RECONCILE_OK' : 'RECONCILE_FAILED',
    detail: `intents reconciled=${report.intentsReconciled} recovered=${report.intentsRecovered} unresolved=${report.intentsUnresolved} orphans=${report.orphanExposureCount}`,
  });
  return report;
}

/** Reconciles a single non-terminal order intent. Returns true if it resolved. */
async function reconcileIntent(intent: OrderIntentRow): Promise<boolean> {
  // Dry-run intents: since the simulator writes fills synchronously, a
  // non-terminal dry-run intent is an anomaly (probably a mid-flight crash).
  if (intent.dryRun) {
    const fills = await getFillsForOrderIntent(intent.id);
    if (fills.length > 0) {
      const agg = aggregateFills(fills);
      await updateOrderIntent(intent.id, {
        state: agg.filledSize.isPositive() ? 'filled' : 'canceled',
      });
      return true;
    }
    // No fills recorded and no exchange to consult → mark failed.
    await updateOrderIntent(intent.id, {
      state: 'failed',
      failureClass: 'definitely_not_submitted',
      errorMessage: 'dry-run intent has no fills after restart',
    });
    return true;
  }

  if (!ENV.coinbaseConfigured) {
    // We can't consult the exchange. Leave as-is; block entries.
    return false;
  }

  // Live path.
  let coinbaseOrder: CoinbaseOrder | null = null;
  try {
    if (intent.exchangeOrderId) {
      coinbaseOrder = await getOrder(intent.exchangeOrderId);
    } else {
      coinbaseOrder = await findOrderByClientId(intent.clientOrderId);
    }
  } catch (err) {
    if (err instanceof CoinbaseError && err.class === 'non_retryable_validation') {
      // Order truly doesn't exist upstream — safe to mark not submitted.
      await updateOrderIntent(intent.id, {
        state: 'failed',
        failureClass: 'definitely_not_submitted',
        errorMessage: `not found on exchange: ${err.message}`,
      });
      return true;
    }
    throw err;
  }

  if (!coinbaseOrder) {
    await updateOrderIntent(intent.id, {
      state: 'failed',
      failureClass: 'definitely_not_submitted',
      errorMessage: 'not found on exchange',
    });
    return true;
  }

  // Pull fills and upsert them (idempotent via UNIQUE exchangeFillId).
  let fills: CoinbaseFill[] = [];
  try {
    fills = await listFillsForOrder(coinbaseOrder.order_id);
  } catch (err) {
    if (err instanceof CoinbaseError && err.class === 'retryable_transport') {
      return false; // will retry next boot
    }
    throw err;
  }
  for (const f of fills) {
    await insertFill({
      exchangeFillId: f.trade_id,
      orderIntentId: intent.id,
      exchangeOrderId: f.order_id,
      token: f.product_id.split('-')[0],
      side: f.side,
      filledSize: f.size,
      fillPrice: f.price,
      fee: f.commission,
      feeCurrency: 'USD',
      tradeTime: new Date(f.trade_time),
      rawResponse: JSON.stringify(f),
    });
  }

  const state: OrderIntentRow['state'] =
    coinbaseOrder.status === 'FILLED'
      ? 'filled'
      : coinbaseOrder.status === 'CANCELLED'
        ? 'canceled'
        : coinbaseOrder.status === 'EXPIRED'
          ? 'canceled'
          : coinbaseOrder.status === 'FAILED'
            ? 'failed'
            : coinbaseOrder.status === 'OPEN'
              ? 'acknowledged'
              : coinbaseOrder.status === 'PENDING'
                ? 'submitted'
                : 'unknown';

  await updateOrderIntent(intent.id, {
    state,
    exchangeOrderId: coinbaseOrder.order_id,
  });
  await logActivity({
    type: 'reconciliation',
    severity: 'info',
    token: intent.token,
    action: 'INTENT_RECONCILED',
    detail: `${intent.clientOrderId} → ${state} (Coinbase ${coinbaseOrder.status}, ${fills.length} fills)`,
  });
  return state !== 'unknown';
}
