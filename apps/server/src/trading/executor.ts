import { createHash, randomBytes } from 'node:crypto';
import { Money, ONE_MONEY, STRATEGY, STRATEGY_VERSION, type TradingMode } from '@horizon/shared';
import { ENV } from '../env';
import {
  aggregateFills,
  countExitAttemptsForPosition,
  ensureInitialFund,
  findOrderIntentByClientOrderId,
  getBotConfig,
  getCashBalance as getLedgerCashBalance,
  getFillsForOrderIntent,
  getOpenPositionForToken,
  getOrderIntent,
  hasUnknownIntentForPosition,
  insertOrderIntent,
  insertFill,
  logActivity,
  recordTokenOutcome,
  updateBotConfig,
  updateOrderIntent,
  updatePositionVersioned,
  type FillAggregate,
  type NewOrderIntent,
} from '../db/queries';
import {
  insertCashLedgerEvent,
  insertPositionTx,
  insertRoundTripTx,
  isDuplicateKeyError,
  ledgerKeyForFill,
  markPositionClosedTx,
  updateOrderIntentTx,
  withTransaction,
} from '../db/tx';
import type { FillRow, OrderIntentRow, PositionRow } from '../db/schema';
import {
  CoinbaseError,
  createOrder,
  getCashBalance as getCoinbaseCashBalance,
  getProduct,
  listFillsForOrder,
  normalizeBuyQuoteSize,
  normalizeSellBaseSize,
  previewOrder,
  validateProductForTrading,
  type CoinbaseFill,
  type CoinbaseProduct,
  type MarketOrderIntent,
} from './coinbase';

/**
 * Executor — the deterministic, recoverable order-lifecycle core.
 *
 * Every economic order flows through these stages:
 *   1. INTENT: caller derives a deterministic clientOrderId, we persist an
 *      `order_intents` row (state='created', dryRun=<bool>). This commits
 *      BEFORE any exchange contact — if we crash now the retry sees the intent
 *      via its clientOrderId and reconciles.
 *   2. PREVIEW: exchange sanity-checks (size, increments, min/max, status).
 *   3. SUBMIT: pass the pre-persisted clientOrderId. On success, store the
 *      exchangeOrderId (unique). On `unknown` failure we DO NOT retry — the
 *      reconciler will look up by clientOrderId.
 *   4. RECONCILE: query fills, upsert into `fills`, compute weighted avg price
 *      and totals. The POSITION is created from actual fills — not ticker.
 *   5. CLOSE: same flow in reverse, producing a `round_trips` row (one per
 *      completed position).
 *
 * Dry-run behavior: exchange calls are simulated with a realistic-cost model
 * (spread + fee) and produce synthetic fills that flow through the SAME code
 * paths above. Cash is debited/credited through the `cash_ledger` so accounting
 * is consistent with live trading.
 */

// ---------------------------------------------------------------------------
// Deterministic clientOrderId derivation
// ---------------------------------------------------------------------------

/**
 * Deterministic clientOrderId from a *stable* economic identity (Phase 1.1.a §B).
 *
 * The old signature accepted a `seed` (scan-cycle timestamp), which meant two
 * scans of the same signal produced different clientOrderIds — a timeout
 * followed by a retry could result in TWO real orders.
 *
 * New rule:
 *   • ENTRY  → identity derives from the accepted `quantitative_decisions.id`.
 *              A retry of the same accepted decision reuses the same id.
 *   • EXIT   → identity derives from `positionId + purpose + attemptGeneration`.
 *              A timed-out exit that must be retried keeps the same generation
 *              until reconciliation resolves it; a NEW exit attempt after that
 *              bumps the generation.
 *
 * Wall-clock is never mixed in. `deriveClientOrderId` is a pure function of
 * its inputs.
 */
export function deriveClientOrderId(parts: {
  purpose: 'entry' | 'take_profit' | 'stop_loss' | 'manual_exit' | 'emergency_exit';
  token: string;
  mode: string;
  positionId?: number;
  decisionId?: number; // required for entry
  attemptGeneration?: number; // required for exits
}): string {
  const identity =
    parts.purpose === 'entry'
      ? `entry|${parts.token}|${parts.mode}|decision-${parts.decisionId ?? 'na'}`
      : `${parts.purpose}|${parts.token}|${parts.mode}|position-${parts.positionId ?? 'na'}|gen-${parts.attemptGeneration ?? 1}`;
  const hash = createHash('sha256').update(identity).digest('hex');
  // Coinbase requires <=64 chars; UUID-like format for readability.
  return `hzn-${hash.slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Dry-run cost model
// ---------------------------------------------------------------------------

/**
 * Applies a fixed spread + fee model to a market price to produce a realistic
 * simulated fill. Values match typical Coinbase Advanced Trade taker economics
 * for retail volume tiers.
 */
export const DRY_RUN_COSTS = {
  spreadBps: 5, // 0.05% assumed cost through the spread on entry
  takerFeeBps: 60, // 0.60% taker fee (upper-bound for retail volume tiers)
} as const;

/**
 * True when the executor should call the (mocked or real) Coinbase createOrder
 * path instead of the built-in dry-run simulator. In production this is only
 * true when DRY_RUN=false. In test it can also be enabled via TEST_FORCE_LIVE_PATH
 * to exercise unknown/reject/partial-fill code paths against a mocked exchange.
 */
export function useLivePath(): boolean {
  return !ENV.dryRun || ENV.testForceLivePath;
}

/**
 * Simulates a BUY market fill against `product` for the given `quoteSize`.
 * Decimal-safe: all arithmetic runs on Money — the CoinbaseFill fields are
 * decimal strings (matching the real-exchange wire format).
 */
function simulateBuyFill(product: CoinbaseProduct, quoteSize: Money): CoinbaseFill {
  const midPrice = Money.fromString(product.price);
  const priceWithSpread = midPrice.mul(
    ONE_MONEY.add(Money.fromBps(DRY_RUN_COSTS.spreadBps)),
  );
  const feeQuote = quoteSize.mul(Money.fromBps(DRY_RUN_COSTS.takerFeeBps));
  const netQuote = quoteSize.sub(feeQuote);
  const baseSize = priceWithSpread.isZero() ? Money.zero() : netQuote.div(priceWithSpread);
  return {
    entry_id: `dry-buy-${randomBytes(8).toString('hex')}`,
    trade_id: `dry-buy-${randomBytes(8).toString('hex')}`,
    order_id: 'DRY_RUN_ORDER',
    product_id: product.product_id,
    price: priceWithSpread.toDecimalString(),
    size: baseSize.toDecimalString(),
    commission: feeQuote.toDecimalString(),
    side: 'BUY',
    trade_time: new Date().toISOString(),
    size_in_quote: false,
  };
}

function simulateSellFill(product: CoinbaseProduct, baseSize: Money): CoinbaseFill {
  const midPrice = Money.fromString(product.price);
  const priceWithSpread = midPrice.mul(
    ONE_MONEY.sub(Money.fromBps(DRY_RUN_COSTS.spreadBps)),
  );
  const grossQuote = baseSize.mul(priceWithSpread);
  const feeQuote = grossQuote.mul(Money.fromBps(DRY_RUN_COSTS.takerFeeBps));
  return {
    entry_id: `dry-sell-${randomBytes(8).toString('hex')}`,
    trade_id: `dry-sell-${randomBytes(8).toString('hex')}`,
    order_id: 'DRY_RUN_ORDER',
    product_id: product.product_id,
    price: priceWithSpread.toDecimalString(),
    size: baseSize.toDecimalString(),
    commission: feeQuote.toDecimalString(),
    side: 'SELL',
    trade_time: new Date().toISOString(),
    size_in_quote: false,
  };
}

// ---------------------------------------------------------------------------
// Order state-machine primitives
// ---------------------------------------------------------------------------

async function persistIntent(intent: NewOrderIntent): Promise<OrderIntentRow> {
  // Idempotency: if this clientOrderId already exists, return the existing row
  // (this is what makes retries safe).
  const existing = await findOrderIntentByClientOrderId(intent.clientOrderId);
  if (existing) return existing;
  const id = await insertOrderIntent(intent);
  return (await getOrderIntent(id))!;
}

/**
 * Idempotently persists a Coinbase fill. `exchangeFillId` has a UNIQUE index,
 * so a replay during startup reconciliation or after a mid-flight crash is a
 * silent no-op — the caller doesn't need to check first.
 */
async function persistFillFromExchange(
  intentId: number,
  fill: CoinbaseFill,
): Promise<void> {
  try {
    await insertFill({
      exchangeFillId: fill.trade_id,
      orderIntentId: intentId,
      exchangeOrderId: fill.order_id,
      token: fill.product_id.split('-')[0],
      side: fill.side,
      filledSize: fill.size,
      fillPrice: fill.price,
      fee: fill.commission,
      feeCurrency: 'USD',
      tradeTime: new Date(fill.trade_time),
      rawResponse: JSON.stringify(fill),
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Already persisted — silent no-op (idempotent replay).
  }
}

/**
 * After submission (real or simulated), refreshes fills for the intent and
 * returns the aggregated result. In live mode this calls `listFillsForOrder`;
 * in dry-run it reads whatever was inserted by the simulator.
 *
 * All returned values are Money (Phase 1.1.a §M).
 */
async function reconcileFillsForIntent(intent: OrderIntentRow): Promise<
  FillAggregate & { fillRows: FillRow[] }
> {
  if (useLivePath() && intent.exchangeOrderId) {
    try {
      const remote = await listFillsForOrder(intent.exchangeOrderId);
      for (const f of remote) await persistFillFromExchange(intent.id, f);
    } catch (err) {
      // Non-fatal here — we'll retry in the reconciler.
      if (err instanceof CoinbaseError) {
        await logActivity({
          type: 'error',
          severity: 'warn',
          action: 'FILL_FETCH_FAILED',
          detail: `${intent.clientOrderId}: ${err.code} ${err.message}`,
        });
      }
    }
  }
  const fillRows = await getFillsForOrderIntent(intent.id);
  return { ...aggregateFills(fillRows), fillRows };
}

/**
 * Fill-derived ledger writes inside an existing transaction.
 * Each row is keyed by (reason, intentId, fillId) so a replay during startup
 * reconciliation is a silent no-op (Phase 1.1.a §F).
 *
 * A market order can produce multiple fills at different prices/fees; we emit
 * one ledger row per fill for the notional and one per fill for the fee.
 * Aggregate ledger rows would lose the per-fill lineage the reconciler needs.
 */
async function writeBuyLedgerRows(
  tx: Parameters<Parameters<typeof withTransaction>[0]>[0],
  intentId: number,
  positionId: number | null,
  fillRows: FillRow[],
): Promise<void> {
  for (const fill of fillRows) {
    const size = Money.fromString(fill.filledSize);
    const price = Money.fromString(fill.fillPrice);
    const quote = size.mul(price);
    const fee = Money.fromString(fill.fee);
    if (quote.isPositive()) {
      await insertCashLedgerEvent(tx, {
        idempotencyKey: ledgerKeyForFill('buy_cost', intentId, fill.id),
        deltaUsd: quote.neg(),
        reason: 'buy_cost',
        orderIntentId: intentId,
        positionId,
        fillId: fill.id,
        dryRun: ENV.dryRun,
      });
    }
    if (fee.isPositive()) {
      await insertCashLedgerEvent(tx, {
        idempotencyKey: ledgerKeyForFill('buy_fee', intentId, fill.id),
        deltaUsd: fee.neg(),
        reason: 'buy_fee',
        orderIntentId: intentId,
        positionId,
        fillId: fill.id,
        dryRun: ENV.dryRun,
      });
    }
  }
}

async function writeSellLedgerRows(
  tx: Parameters<Parameters<typeof withTransaction>[0]>[0],
  intentId: number,
  positionId: number | null,
  fillRows: FillRow[],
): Promise<void> {
  for (const fill of fillRows) {
    const size = Money.fromString(fill.filledSize);
    const price = Money.fromString(fill.fillPrice);
    const quote = size.mul(price);
    const fee = Money.fromString(fill.fee);
    if (quote.isPositive()) {
      await insertCashLedgerEvent(tx, {
        idempotencyKey: ledgerKeyForFill('sell_proceeds', intentId, fill.id),
        deltaUsd: quote,
        reason: 'sell_proceeds',
        orderIntentId: intentId,
        positionId,
        fillId: fill.id,
        dryRun: ENV.dryRun,
      });
    }
    if (fee.isPositive()) {
      await insertCashLedgerEvent(tx, {
        idempotencyKey: ledgerKeyForFill('sell_fee', intentId, fill.id),
        deltaUsd: fee.neg(),
        reason: 'sell_fee',
        orderIntentId: intentId,
        positionId,
        fillId: fill.id,
        dryRun: ENV.dryRun,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry (open position) — deterministic, idempotent
// ---------------------------------------------------------------------------

export interface EntryDecision {
  token: string;
  mode: TradingMode;
  scanPrice: number; // ticker at decision time — for sizing math only, NOT stored as entry
  allocationPct: number;
  claudeReason: string;
  claudeModel: string;
  claudeConfidence: number;
  /**
   * The persisted `quantitative_decisions.id` that authorized this entry.
   * REQUIRED — this is the stable economic identity that survives timeouts
   * and retries (Phase 1.1.a §B). Two scans of the same signal produce the
   * same accepted-decision id → same clientOrderId → Coinbase dedupe.
   */
  decisionId: number;
}

export interface OpenResult {
  kind: 'opened' | 'skipped' | 'unknown' | 'rejected';
  positionId?: number;
  intentId?: number;
  reason?: string;
}

/**
 * Opens a position through the full state machine. Safe to call multiple times
 * with the same `decisionId` — the derived clientOrderId ensures the exchange
 * sees exactly one order (Phase 1.1.a §B).
 */
export async function openPosition(decision: EntryDecision): Promise<OpenResult> {
  // ── 0. Sanity: only one open position per token, enforced in application
  //           since MySQL doesn't have partial unique indexes. Check + re-check
  //           inside the DB write below.
  const existing = await getOpenPositionForToken(decision.token);
  if (existing) {
    return { kind: 'skipped', reason: `already open for ${decision.token}` };
  }

  // ── 1. Sizing math — Money end-to-end (Phase 1.1.a §M).
  const cashBalance = await getPortfolioCash();
  const targetQuoteSize = cashBalance.pct(decision.allocationPct);
  if (!targetQuoteSize.isPositive()) {
    await logActivity({
      type: 'system',
      severity: 'warn',
      token: decision.token,
      action: 'SKIP_ENTRY',
      detail: `Insufficient cash: alloc ${decision.allocationPct}% of $${cashBalance.toDecimalString(
        2,
      )}`,
    });
    return { kind: 'skipped', reason: 'insufficient_cash' };
  }

  // ── 2. Product validation + increment rounding.
  let product: CoinbaseProduct;
  try {
    product = ENV.coinbaseConfigured
      ? await getProduct(decision.token)
      : mockProduct(decision.token, Money.fromNumber(decision.scanPrice));
    validateProductForTrading(product);
  } catch (err) {
    return logAndReturnOpenFailure(err, decision.token, 'PRODUCT_INVALID');
  }

  let normalizedQuote: string;
  try {
    normalizedQuote = normalizeBuyQuoteSize(product, targetQuoteSize);
  } catch (err) {
    return logAndReturnOpenFailure(err, decision.token, 'SIZE_INVALID');
  }

  // ── 3. Persist intent BEFORE submission. clientOrderId derives from the
  //           persisted accepted decision so a retry of the same signal reuses
  //           the same idempotency key (Phase 1.1.a §B).
  const clientOrderId = deriveClientOrderId({
    purpose: 'entry',
    token: decision.token,
    mode: decision.mode,
    decisionId: decision.decisionId,
  });
  const intent = await persistIntent({
    clientOrderId,
    productId: product.product_id,
    token: decision.token,
    side: 'BUY',
    orderType: 'market_ioc',
    quoteSize: normalizedQuote,
    mode: decision.mode,
    purpose: 'entry',
    state: 'created',
    dryRun: ENV.dryRun,
  });

  // Same clientOrderId returning a non-'created' state means a prior call
  // already advanced this intent — defer to reconciliation.
  if (intent.state !== 'created') {
    return { kind: 'unknown', intentId: intent.id, reason: `existing state ${intent.state}` };
  }

  // ── 4. Preview (surfaces size/status problems cheaply).
  if (ENV.coinbaseConfigured && useLivePath()) {
    try {
      await previewOrder({
        clientOrderId,
        token: decision.token,
        side: 'BUY',
        quoteSize: normalizedQuote,
      });
      await updateOrderIntent(intent.id, { state: 'previewed' });
    } catch (err) {
      const cls = err instanceof CoinbaseError ? err.class : 'non_retryable_validation';
      await updateOrderIntent(intent.id, {
        state: 'rejected',
        failureClass: cls,
        errorCode: err instanceof CoinbaseError ? err.code : 'preview_failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return logAndReturnOpenFailure(err, decision.token, 'PREVIEW_REJECTED');
    }
  }

  // ── 5. Submit (or simulate).
  const submitIntent: MarketOrderIntent = {
    clientOrderId,
    token: decision.token,
    side: 'BUY',
    quoteSize: normalizedQuote,
  };

  let exchangeOrderId: string;
  if (!useLivePath()) {
    exchangeOrderId = `DRY-${clientOrderId}`;
    await updateOrderIntent(intent.id, {
      state: 'submitted',
      exchangeOrderId,
      rawResponse: '{"dryRun":true}',
    });
    // Simulate one fill and persist it exactly like a real fill.
    const fakeFill = simulateBuyFill(product, Money.fromString(normalizedQuote));
    fakeFill.order_id = exchangeOrderId;
    await persistFillFromExchange(intent.id, fakeFill);
  } else {
    try {
      const submitResult = await createOrder(submitIntent);
      if (!submitResult.success) {
        await updateOrderIntent(intent.id, {
          state: 'rejected',
          failureClass: 'definitely_rejected',
          errorMessage: submitResult.failureReason,
          rawResponse: JSON.stringify(submitResult.raw).slice(0, 4_000),
        });
        return {
          kind: 'rejected',
          intentId: intent.id,
          reason: submitResult.failureReason,
        };
      }
      exchangeOrderId = submitResult.exchangeOrderId!;
      await updateOrderIntent(intent.id, {
        state: 'submitted',
        exchangeOrderId,
        rawResponse: JSON.stringify(submitResult.raw).slice(0, 4_000),
      });
    } catch (err) {
      if (err instanceof CoinbaseError && err.class === 'unknown') {
        // Ambiguous — mark unknown AND trip the global lock (§A).
        // New economic activity is blocked until continuous reconciliation
        // conclusively resolves the outcome.
        await updateOrderIntent(intent.id, {
          state: 'unknown',
          failureClass: 'unknown',
          errorCode: err.code,
          errorMessage: err.message,
        });
        await tripGlobalUnknownLock(
          `entry intent ${intent.id} for ${decision.token} — ${err.code}: ${err.message}`,
        );
        return { kind: 'unknown', intentId: intent.id, reason: err.message };
      }
      return logAndReturnOpenFailure(err, decision.token, 'SUBMIT_FAILED', intent.id);
    }
  }

  // ── 6. Reconcile fills → derive position from actual execution.
  const agg = await reconcileFillsForIntent((await getOrderIntent(intent.id))!);
  if (!agg.filledSize.isPositive()) {
    // Zero fill — likely IOC couldn't match. Mark canceled and stop.
    await updateOrderIntent(intent.id, { state: 'canceled' });
    await logActivity({
      type: 'trade',
      severity: 'warn',
      token: decision.token,
      action: 'ZERO_FILL',
      detail: `${clientOrderId} filled 0 — no position opened`,
    });
    return { kind: 'skipped', intentId: intent.id, reason: 'zero_fill' };
  }

  // ── 7. Compute protective levels from actual avg entry — Money-native.
  const modeCfg = STRATEGY.MODES[decision.mode];
  const avgEntry = agg.weightedAvgPrice;
  const takeProfitPrice = avgEntry.mul(ONE_MONEY.add(Money.fromNumber(modeCfg.takeProfitPct).divInt(100)));
  const stopLossPrice = avgEntry.mul(ONE_MONEY.sub(Money.fromNumber(modeCfg.stopLossPct).divInt(100)));

  // partial_filled if the total quote spent + fees is materially below what we
  // asked for; otherwise filled. (We can't compare filledSize to normalizedQuote
  // directly — one is base, one is quote.)
  const requestedQuote = Money.fromString(normalizedQuote);
  const filledQuote = agg.quoteValue.add(agg.totalFees);
  const partialCushion = requestedQuote.pct(1);
  const intentEndState: OrderIntentRow['state'] = requestedQuote
    .sub(filledQuote)
    .abs()
    .gt(partialCushion)
    ? 'partially_filled'
    : 'filled';

  // ── 8-9. ATOMIC: position insert + per-fill ledger debits + intent update.
  //         The DB-enforced unique open-token index protects against a racing
  //         peer opening a duplicate; ledger idempotency keys protect against
  //         mid-flight crash + retry (Phase 1.1.a §F).
  let positionId: number;
  try {
    positionId = await withTransaction(async (tx) => {
      const pid = await insertPositionTx(tx, {
        token: decision.token,
        mode: decision.mode,
        avgEntryPrice: avgEntry.toDecimalString(),
        filledQuantity: agg.filledSize.toDecimalString(),
        entryFees: agg.totalFees.toDecimalString(),
        entryQuoteSpent: agg.quoteValue.toDecimalString(),
        allocationPct: Money.fromNumber(decision.allocationPct).toDecimalString(2),
        takeProfitPrice: takeProfitPrice.toDecimalString(),
        stopLossPrice: stopLossPrice.toDecimalString(),
        takeProfitPct: Money.fromNumber(modeCfg.takeProfitPct).toDecimalString(2),
        stopLossPct: Money.fromNumber(modeCfg.stopLossPct).toDecimalString(2),
        entryOrderIntentId: intent.id,
        protectionMode: 'polling_fallback',
        claudeReason: decision.claudeReason,
        claudeModel: decision.claudeModel,
        claudeConfidence: Money.fromNumber(decision.claudeConfidence).toDecimalString(4),
        strategyVersion: STRATEGY_VERSION,
        lifecycleState: 'open',
        status: 'open',
      });
      await writeBuyLedgerRows(tx, intent.id, pid, agg.fillRows);
      await updateOrderIntentTx(tx, intent.id, { state: intentEndState, positionId: pid });
      return pid;
    });
  } catch (err) {
    // DB-enforced open-position uniqueness (§G) fires here as ER_DUP_ENTRY on
    // positions_open_token_uq. The transaction rolled back — no ledger writes.
    if (isDuplicateKeyError(err)) {
      await updateOrderIntent(intent.id, { state: 'canceled' });
      await logActivity({
        type: 'trade',
        severity: 'warn',
        token: decision.token,
        action: 'DUP_OPEN_POSITION',
        detail: `Refused: an open position for ${decision.token} already exists (DB invariant)`,
      });
      return { kind: 'skipped', intentId: intent.id, reason: 'already_open_db' };
    }
    throw err;
  }

  await logActivity({
    type: 'trade',
    severity: 'info',
    token: decision.token,
    action: 'OPEN_POSITION',
    detail: `${ENV.dryRun ? '[DRY RUN] ' : ''}${decision.mode} ${agg.filledSize.toDecimalString(6)} @ $${avgEntry.toDecimalString(6)} (fees $${agg.totalFees.toDecimalString(4)}) TP $${takeProfitPrice.toDecimalString(4)} SL $${stopLossPrice.toDecimalString(4)}`,
  });

  return { kind: 'opened', positionId, intentId: intent.id };
}

// ---------------------------------------------------------------------------
// Exit — same state machine in reverse; produces a round_trip row.
// ---------------------------------------------------------------------------

export type ExitReason = 'take_profit' | 'stop_loss' | 'early_exit' | 'manual' | 'emergency';

export interface ClosePositionResult {
  kind: 'closed' | 'failed' | 'pending';
  intentId?: number;
  roundTripId?: number;
  reason?: string;
}

/**
 * Closes an open position through the state machine. Returns `pending` (NOT
 * closed) if the exchange result is unknown, and `failed` on definite rejection
 * — the API layer must not report success in either case.
 */
export async function closePosition(
  position: PositionRow,
  reason: ExitReason,
): Promise<ClosePositionResult> {
  // §A: if this position already has an unresolved `unknown` exit intent,
  // refuse to create another. A prior exit may or may not have hit the
  // exchange; issuing a fresh sell here could double-close.
  if (await hasUnknownIntentForPosition(position.id)) {
    await logActivity({
      type: 'system',
      severity: 'high',
      token: position.token,
      action: 'EXIT_BLOCKED_UNKNOWN',
      detail: `Refused new exit for position ${position.id}: an existing unknown intent is unresolved`,
    });
    return { kind: 'pending', reason: 'unknown_exit_in_flight' };
  }

  // Move position into 'closing' with optimistic lock — a second concurrent
  // exit attempt will fail this CAS and skip cleanly.
  const acquired = await updatePositionVersioned(position.id, position.version, {
    lifecycleState: 'closing',
  });
  if (!acquired) {
    return { kind: 'failed', reason: 'concurrent_exit_in_progress' };
  }

  let product: CoinbaseProduct;
  try {
    product = ENV.coinbaseConfigured
      ? await getProduct(position.token)
      : mockProduct(position.token, Money.fromString(position.avgEntryPrice));
  } catch (err) {
    return logAndReturnCloseFailure(err, position.token, 'PRODUCT_FETCH_FAILED');
  }

  let baseSizeStr: string;
  try {
    baseSizeStr = normalizeSellBaseSize(product, Money.fromString(position.filledQuantity));
  } catch (err) {
    return logAndReturnCloseFailure(err, position.token, 'SELL_SIZE_INVALID');
  }

  const purpose: 'take_profit' | 'stop_loss' | 'manual_exit' | 'emergency_exit' =
    reason === 'take_profit'
      ? 'take_profit'
      : reason === 'stop_loss'
        ? 'stop_loss'
        : reason === 'emergency'
          ? 'emergency_exit'
          : 'manual_exit';

  // Attempt generation = 1 + count of prior exit intents for this position+purpose.
  // A timeout retry uses the SAME generation (persistIntent looks up the
  // existing intent by clientOrderId and returns it). A fresh exit attempt
  // after prior terminal resolution increments the generation.
  const priorAttempts = await countExitAttemptsForPosition(position.id, purpose);
  const attemptGeneration = priorAttempts + 1;
  const clientOrderId = deriveClientOrderId({
    purpose,
    token: position.token,
    mode: position.mode,
    positionId: position.id,
    attemptGeneration,
  });
  const intent = await persistIntent({
    clientOrderId,
    productId: product.product_id,
    token: position.token,
    side: 'SELL',
    orderType: 'market_ioc',
    baseSize: baseSizeStr,
    mode: position.mode,
    purpose,
    positionId: position.id,
    state: 'created',
    dryRun: ENV.dryRun,
  });

  let exchangeOrderId: string;
  if (!useLivePath()) {
    exchangeOrderId = `DRY-${clientOrderId}`;
    await updateOrderIntent(intent.id, {
      state: 'submitted',
      exchangeOrderId,
      rawResponse: '{"dryRun":true}',
    });
    const fakeFill = simulateSellFill(product, Money.fromString(baseSizeStr));
    fakeFill.order_id = exchangeOrderId;
    await persistFillFromExchange(intent.id, fakeFill);
  } else {
    try {
      const submitResult = await createOrder({
        clientOrderId,
        token: position.token,
        side: 'SELL',
        baseSize: baseSizeStr,
      });
      if (!submitResult.success) {
        await updateOrderIntent(intent.id, {
          state: 'rejected',
          failureClass: 'definitely_rejected',
          errorMessage: submitResult.failureReason,
          rawResponse: JSON.stringify(submitResult.raw).slice(0, 4_000),
        });
        return { kind: 'failed', intentId: intent.id, reason: submitResult.failureReason };
      }
      exchangeOrderId = submitResult.exchangeOrderId!;
      await updateOrderIntent(intent.id, {
        state: 'submitted',
        exchangeOrderId,
        rawResponse: JSON.stringify(submitResult.raw).slice(0, 4_000),
      });
    } catch (err) {
      if (err instanceof CoinbaseError && err.class === 'unknown') {
        // §A global lock — a lost exit response could have hit the exchange;
        // block new sells for this position until continuous reconciliation
        // resolves it.
        await updateOrderIntent(intent.id, {
          state: 'unknown',
          failureClass: 'unknown',
          errorMessage: err.message,
        });
        await tripGlobalUnknownLock(
          `exit intent ${intent.id} for position ${position.id} (${position.token}) — ${err.message}`,
        );
        return { kind: 'pending', intentId: intent.id, reason: 'unknown_exchange_state' };
      }
      return logAndReturnCloseFailure(err, position.token, 'EXIT_SUBMIT_FAILED', intent.id);
    }
  }

  const exitAgg = await reconcileFillsForIntent((await getOrderIntent(intent.id))!);
  if (!exitAgg.filledSize.isPositive()) {
    await updateOrderIntent(intent.id, { state: 'canceled' });
    return { kind: 'failed', intentId: intent.id, reason: 'exit_zero_fill' };
  }

  // Round-trip P&L (Money-native, Phase 1.1.a §M):
  //   realizedNet = (exitQuote - entryQuote) - (entryFees + exitFees)
  const entryFees = Money.fromString(position.entryFees);
  const entryValueGross = Money.fromString(position.entryQuoteSpent);
  const exitValueGross = exitAgg.quoteValue;
  const exitFees = exitAgg.totalFees;
  const realizedNet = exitValueGross.sub(entryValueGross).sub(entryFees).sub(exitFees);
  const realizedNetPct = entryValueGross.isZero()
    ? Money.zero()
    : realizedNet.div(entryValueGross).mul(Money.fromString('100'));
  const outcome: 'win' | 'loss' | 'flat' = realizedNet.isPositive()
    ? 'win'
    : realizedNet.isNegative()
      ? 'loss'
      : 'flat';

  // ATOMIC exit block: per-fill ledger credits + position close + round-trip
  // creation + intent update — all one transaction (Phase 1.1.a §F). Any
  // failure rolls back the entire economic effect.
  const closedAt = new Date();
  const roundTripId = await withTransaction(async (tx) => {
    await writeSellLedgerRows(tx, intent.id, position.id, exitAgg.fillRows);
    await markPositionClosedTx(tx, position.id, closedAt);
    const rtId = await insertRoundTripTx(tx, {
      positionId: position.id,
      token: position.token,
      mode: position.mode,
      entryValueGross: entryValueGross.toDecimalString(),
      exitValueGross: exitValueGross.toDecimalString(),
      entryFees: entryFees.toDecimalString(),
      exitFees: exitFees.toDecimalString(),
      realizedNetPnl: realizedNet.toDecimalString(),
      realizedNetPnlPct: realizedNetPct.toDecimalString(4),
      outcome,
      exitReason: reason === 'emergency' ? 'emergency' : reason,
      openedAt: position.openedAt,
      closedAt,
    });
    await updateOrderIntentTx(tx, intent.id, { state: 'filled' });
    return rtId;
  });

  // Win/loss stats + circuit breaker — flats don't move the counter.
  // Kept OUTSIDE the transaction because they touch token_stats + bot_config
  // and are not required to be atomic with the round-trip creation.
  if (outcome === 'win' || outcome === 'loss') {
    await recordTokenOutcome(position.token, outcome);
    await updateCircuitBreaker(outcome);
  }

  await logActivity({
    type: 'trade',
    severity: outcome === 'loss' ? 'warn' : 'info',
    token: position.token,
    action: 'CLOSE_POSITION',
    detail: `${ENV.dryRun ? '[DRY RUN] ' : ''}${reason} — net ${
      realizedNet.isNegative() ? '' : '+'
    }$${realizedNet.toDecimalString(4)} (${realizedNetPct.toDecimalString(2)}%)`,
  });

  return { kind: 'closed', intentId: intent.id, roundTripId };
}

// ---------------------------------------------------------------------------
// §A — global unknown-order lock
// ---------------------------------------------------------------------------

/**
 * Trips the system-wide reconciliation lock when any live intent transitions
 * to `unknown`. New entries and exit-intent creation for the same position are
 * blocked until continuous reconciliation (slice 1.1.b) conclusively resolves
 * the outcome. Silently no-ops if the config is already degraded/failed —
 * the lock is a monotonic latch, not a switch.
 */
export async function tripGlobalUnknownLock(reason: string): Promise<void> {
  const cfg = await getBotConfig();
  if (cfg.reconciliationStatus === 'degraded' || cfg.reconciliationStatus === 'failed') {
    return; // already blocked; keep the earliest reason on file
  }
  await updateBotConfig({
    reconciliationStatus: 'degraded',
    reconciliationDetail: `unknown-order lock tripped: ${reason.slice(0, 900)}`,
  });
  await logActivity({
    type: 'system',
    severity: 'critical',
    action: 'UNKNOWN_LOCK_TRIPPED',
    detail: `Global lock engaged — new entries blocked. Reason: ${reason.slice(0, 500)}`,
  });
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

async function updateCircuitBreaker(outcome: 'win' | 'loss'): Promise<void> {
  const cfg = await getBotConfig();
  if (outcome === 'win') {
    if (cfg.consecutiveLosses !== 0) await updateBotConfig({ consecutiveLosses: 0 });
    return;
  }
  const consecutiveLosses = cfg.consecutiveLosses + 1;
  if (consecutiveLosses >= STRATEGY.CONSECUTIVE_LOSS_LIMIT) {
    const until = new Date(Date.now() + STRATEGY.CIRCUIT_BREAKER_HOURS * 60 * 60 * 1000);
    await updateBotConfig({ consecutiveLosses, circuitBreakerUntil: until });
    await logActivity({
      type: 'system',
      severity: 'high',
      action: 'CIRCUIT_BREAKER',
      detail: `Circuit breaker tripped after ${consecutiveLosses} losses — paused until ${until.toISOString()}`,
    });
  } else {
    await updateBotConfig({ consecutiveLosses });
  }
}

/**
 * Evaluates exit rules for a position given its current mark price.
 * Decimal-safe: the mark price is Money, and all comparisons run on Money.
 */
export function shouldExit(
  position: PositionRow,
  currentPrice: Money,
): { exit: boolean; reason: ExitReason } {
  const tp = Money.fromString(position.takeProfitPrice);
  const sl = Money.fromString(position.stopLossPrice);
  if (currentPrice.gte(tp)) return { exit: true, reason: 'take_profit' };
  if (currentPrice.lte(sl)) return { exit: true, reason: 'stop_loss' };
  if (position.mode === 'reversion') {
    const modeCfg = STRATEGY.MODES.reversion;
    const entry = Money.fromString(position.avgEntryPrice);
    if (!entry.isZero()) {
      const gainPct = currentPrice.sub(entry).div(entry).mul(Money.fromString('100'));
      if (gainPct.gte(Money.fromNumber(modeCfg.earlyExitPct))) {
        return { exit: true, reason: 'early_exit' };
      }
    }
  }
  return { exit: false, reason: 'manual' };
}

// ---------------------------------------------------------------------------
// Portfolio cash — from the ledger, always. Money end-to-end.
// ---------------------------------------------------------------------------

const DRY_RUN_INITIAL = Money.fromString('10000');

/** Returns the account cash balance as Money (Phase 1.1.a §M). */
export async function getPortfolioCash(): Promise<Money> {
  if (ENV.dryRun) {
    await ensureInitialFund(true, DRY_RUN_INITIAL);
    return getLedgerCashBalance(true);
  }
  if (!ENV.coinbaseConfigured) return Money.zero();
  // Coinbase currently returns balance as a number (see getCashBalance); wrap
  // once at the boundary. Slice 1.1.b makes the Coinbase client Money-native.
  const raw = await getCoinbaseCashBalance();
  return Money.fromNumber(raw);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProduct(token: string, price: Money): CoinbaseProduct {
  return {
    product_id: `${token}-USD`,
    price: price.toDecimalString(),
    volume_24h: '0',
    price_percentage_change_24h: '0',
    base_increment: '0.00000001',
    quote_increment: '0.01',
    base_min_size: '0',
    quote_min_size: '1',
    status: 'online',
  };
}

async function logAndReturnOpenFailure(
  err: unknown,
  token: string,
  action: string,
  intentId?: number,
): Promise<OpenResult> {
  const msg = err instanceof Error ? err.message : String(err);
  await logActivity({ type: 'error', severity: 'high', token, action, detail: msg });
  return { kind: 'rejected', intentId, reason: msg };
}

async function logAndReturnCloseFailure(
  err: unknown,
  token: string,
  action: string,
  intentId?: number,
): Promise<ClosePositionResult> {
  const msg = err instanceof Error ? err.message : String(err);
  await logActivity({ type: 'error', severity: 'high', token, action, detail: msg });
  return { kind: 'failed', intentId, reason: msg };
}
