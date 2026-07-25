import { createHash, randomBytes } from 'node:crypto';
import { STRATEGY, STRATEGY_VERSION, type TradingMode } from '@horizon/shared';
import { ENV } from '../env';
import {
  aggregateFills,
  ensureInitialFund,
  findOrderIntentByClientOrderId,
  getBotConfig,
  getCashBalance as getLedgerCashBalance,
  getFillsForOrderIntent,
  getOpenPositionForToken,
  getOrderIntent,
  insertOrderIntent,
  insertPosition,
  insertRoundTrip,
  insertFill,
  logActivity,
  markPositionClosed,
  recordCash,
  recordTokenOutcome,
  updateBotConfig,
  updateOrderIntent,
  updatePositionVersioned,
  type NewOrderIntent,
} from '../db/queries';
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
 * Deterministic clientOrderId from (purpose, positionId, sequence). Two
 * concurrent attempts to open a position for the same (token, mode, cycle) will
 * collide on the DB unique constraint — that's the point.
 */
export function deriveClientOrderId(parts: {
  purpose: string;
  token: string;
  mode: string;
  positionId?: number;
  seed?: string; // scan-cycle timestamp, position lifecycle event, etc.
}): string {
  const raw = [parts.purpose, parts.token, parts.mode, parts.positionId ?? 'new', parts.seed ?? '']
    .join('|');
  const hash = createHash('sha256').update(raw).digest('hex');
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

function simulateBuyFill(product: CoinbaseProduct, quoteSize: number): CoinbaseFill {
  const midPrice = Number(product.price);
  const priceWithSpread = midPrice * (1 + DRY_RUN_COSTS.spreadBps / 10_000);
  const feeQuote = quoteSize * (DRY_RUN_COSTS.takerFeeBps / 10_000);
  const netQuote = quoteSize - feeQuote;
  const baseSize = netQuote / priceWithSpread;
  return {
    entry_id: `dry-buy-${randomBytes(8).toString('hex')}`,
    trade_id: `dry-buy-${randomBytes(8).toString('hex')}`,
    order_id: 'DRY_RUN_ORDER',
    product_id: product.product_id,
    price: priceWithSpread.toString(),
    size: baseSize.toString(),
    commission: feeQuote.toString(),
    side: 'BUY',
    trade_time: new Date().toISOString(),
    size_in_quote: false,
  };
}

function simulateSellFill(product: CoinbaseProduct, baseSize: number): CoinbaseFill {
  const midPrice = Number(product.price);
  const priceWithSpread = midPrice * (1 - DRY_RUN_COSTS.spreadBps / 10_000);
  const grossQuote = baseSize * priceWithSpread;
  const feeQuote = grossQuote * (DRY_RUN_COSTS.takerFeeBps / 10_000);
  return {
    entry_id: `dry-sell-${randomBytes(8).toString('hex')}`,
    trade_id: `dry-sell-${randomBytes(8).toString('hex')}`,
    order_id: 'DRY_RUN_ORDER',
    product_id: product.product_id,
    price: priceWithSpread.toString(),
    size: baseSize.toString(),
    commission: feeQuote.toString(),
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

async function persistFillFromExchange(
  intentId: number,
  fill: CoinbaseFill,
): Promise<void> {
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
}

/**
 * After submission (real or simulated), refreshes fills for the intent and
 * returns the aggregated result. In live mode this calls `listFillsForOrder`;
 * in dry-run it reads whatever was inserted by the simulator.
 */
async function reconcileFillsForIntent(intent: OrderIntentRow): Promise<{
  filledSize: number;
  weightedAvgPrice: number;
  totalFees: number;
  quoteValue: number;
  fillRows: FillRow[];
}> {
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

/** Cash-ledger helpers that debit/credit consistently with fills. */
async function debitBuyToLedger(
  intentId: number,
  positionId: number | null,
  agg: { quoteValue: number; totalFees: number },
): Promise<void> {
  if (agg.quoteValue > 0) {
    await recordCash({
      deltaUsd: (-agg.quoteValue).toFixed(8),
      reason: 'buy_cost',
      orderIntentId: intentId,
      positionId: positionId ?? undefined,
      dryRun: ENV.dryRun,
    });
  }
  if (agg.totalFees > 0) {
    await recordCash({
      deltaUsd: (-agg.totalFees).toFixed(8),
      reason: 'buy_fee',
      orderIntentId: intentId,
      positionId: positionId ?? undefined,
      dryRun: ENV.dryRun,
    });
  }
}

async function creditSellToLedger(
  intentId: number,
  positionId: number | null,
  agg: { quoteValue: number; totalFees: number },
): Promise<void> {
  if (agg.quoteValue > 0) {
    await recordCash({
      deltaUsd: agg.quoteValue.toFixed(8),
      reason: 'sell_proceeds',
      orderIntentId: intentId,
      positionId: positionId ?? undefined,
      dryRun: ENV.dryRun,
    });
  }
  if (agg.totalFees > 0) {
    await recordCash({
      deltaUsd: (-agg.totalFees).toFixed(8),
      reason: 'sell_fee',
      orderIntentId: intentId,
      positionId: positionId ?? undefined,
      dryRun: ENV.dryRun,
    });
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
  scanSeed: string; // e.g. scan-cycle start timestamp — makes clientOrderId unique per cycle
}

export interface OpenResult {
  kind: 'opened' | 'skipped' | 'unknown' | 'rejected';
  positionId?: number;
  intentId?: number;
  reason?: string;
}

/**
 * Opens a position through the full state machine. Safe to call multiple times
 * with the same `scanSeed` — the derived clientOrderId ensures the exchange
 * sees exactly one order.
 */
export async function openPosition(decision: EntryDecision): Promise<OpenResult> {
  // ── 0. Sanity: only one open position per token, enforced in application
  //           since MySQL doesn't have partial unique indexes. Check + re-check
  //           inside the DB write below.
  const existing = await getOpenPositionForToken(decision.token);
  if (existing) {
    return { kind: 'skipped', reason: `already open for ${decision.token}` };
  }

  // ── 1. Sizing math (using scan-time ticker for the QUOTE size only).
  const cashBalance = await getPortfolioCash();
  const targetQuoteSize = (cashBalance * decision.allocationPct) / 100;
  if (targetQuoteSize <= 0) {
    await logActivity({
      type: 'system',
      severity: 'warn',
      token: decision.token,
      action: 'SKIP_ENTRY',
      detail: `Insufficient cash: alloc ${decision.allocationPct}% of $${cashBalance.toFixed(2)}`,
    });
    return { kind: 'skipped', reason: 'insufficient_cash' };
  }

  // ── 2. Product validation + increment rounding.
  let product: CoinbaseProduct;
  try {
    product = ENV.coinbaseConfigured
      ? await getProduct(decision.token)
      : mockProduct(decision.token, decision.scanPrice);
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

  // ── 3. Persist intent BEFORE submission.
  const clientOrderId = deriveClientOrderId({
    purpose: 'entry',
    token: decision.token,
    mode: decision.mode,
    seed: decision.scanSeed,
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
    const fakeFill = simulateBuyFill(product, Number(normalizedQuote));
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
        // Ambiguous — mark unknown; startup reconciler will resolve.
        await updateOrderIntent(intent.id, {
          state: 'unknown',
          failureClass: 'unknown',
          errorCode: err.code,
          errorMessage: err.message,
        });
        return { kind: 'unknown', intentId: intent.id, reason: err.message };
      }
      return logAndReturnOpenFailure(err, decision.token, 'SUBMIT_FAILED', intent.id);
    }
  }

  // ── 6. Reconcile fills → derive position from actual execution.
  const agg = await reconcileFillsForIntent((await getOrderIntent(intent.id))!);
  if (agg.filledSize <= 0) {
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
  await updateOrderIntent(intent.id, {
    state: agg.filledSize > 0 && agg.filledSize.toString() !== normalizedQuote ? 'partially_filled' : 'filled',
  });

  // ── 7. Compute protective levels from actual avg entry.
  const modeCfg = STRATEGY.MODES[decision.mode];
  const avgEntry = agg.weightedAvgPrice;
  const takeProfitPrice = avgEntry * (1 + modeCfg.takeProfitPct / 100);
  const stopLossPrice = avgEntry * (1 - modeCfg.stopLossPct / 100);

  // ── 8. Insert position — from actual fills only. Recheck-and-insert to
  //           defend against a racing peer that opened a position in the same
  //           token between our earlier check and here.
  const positionId = await insertPosition({
    token: decision.token,
    mode: decision.mode,
    avgEntryPrice: avgEntry.toFixed(8),
    filledQuantity: agg.filledSize.toFixed(8),
    entryFees: agg.totalFees.toFixed(8),
    entryQuoteSpent: agg.quoteValue.toFixed(8),
    allocationPct: decision.allocationPct.toFixed(2),
    takeProfitPrice: takeProfitPrice.toFixed(8),
    stopLossPrice: stopLossPrice.toFixed(8),
    takeProfitPct: modeCfg.takeProfitPct.toFixed(2),
    stopLossPct: modeCfg.stopLossPct.toFixed(2),
    entryOrderIntentId: intent.id,
    // Protective orders: exchange-native brackets are not universally supported
    // on Coinbase Advanced Trade spot markets; default to polling_fallback and
    // require the safety policy to permit it before going live.
    protectionMode: 'polling_fallback',
    claudeReason: decision.claudeReason,
    claudeModel: decision.claudeModel,
    claudeConfidence: decision.claudeConfidence.toFixed(4),
    strategyVersion: STRATEGY_VERSION,
    lifecycleState: 'open',
    status: 'open',
  });
  await updateOrderIntent(intent.id, { positionId });

  // ── 9. Cash ledger.
  await debitBuyToLedger(intent.id, positionId, agg);

  await logActivity({
    type: 'trade',
    severity: 'info',
    token: decision.token,
    action: 'OPEN_POSITION',
    detail: `${ENV.dryRun ? '[DRY RUN] ' : ''}${decision.mode} ${agg.filledSize.toFixed(
      6,
    )} @ $${avgEntry.toFixed(6)} (fees $${agg.totalFees.toFixed(4)}) TP $${takeProfitPrice.toFixed(
      4,
    )} SL $${stopLossPrice.toFixed(4)}`,
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
  scanSeed = new Date().toISOString(),
): Promise<ClosePositionResult> {
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
      : mockProduct(position.token, Number(position.avgEntryPrice));
  } catch (err) {
    return logAndReturnCloseFailure(err, position.token, 'PRODUCT_FETCH_FAILED');
  }

  let baseSizeStr: string;
  try {
    baseSizeStr = normalizeSellBaseSize(product, Number(position.filledQuantity));
  } catch (err) {
    return logAndReturnCloseFailure(err, position.token, 'SELL_SIZE_INVALID');
  }

  const clientOrderId = deriveClientOrderId({
    purpose: reason === 'emergency' ? 'emergency_exit' : 'manual_exit',
    token: position.token,
    mode: position.mode,
    positionId: position.id,
    seed: scanSeed,
  });
  const purpose =
    reason === 'take_profit'
      ? 'take_profit'
      : reason === 'stop_loss'
        ? 'stop_loss'
        : reason === 'emergency'
          ? 'emergency_exit'
          : 'manual_exit';
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
    const fakeFill = simulateSellFill(product, Number(baseSizeStr));
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
        await updateOrderIntent(intent.id, {
          state: 'unknown',
          failureClass: 'unknown',
          errorMessage: err.message,
        });
        return { kind: 'pending', intentId: intent.id, reason: 'unknown_exchange_state' };
      }
      return logAndReturnCloseFailure(err, position.token, 'EXIT_SUBMIT_FAILED', intent.id);
    }
  }

  const exitAgg = await reconcileFillsForIntent((await getOrderIntent(intent.id))!);
  if (exitAgg.filledSize <= 0) {
    await updateOrderIntent(intent.id, { state: 'canceled' });
    return { kind: 'failed', intentId: intent.id, reason: 'exit_zero_fill' };
  }
  await updateOrderIntent(intent.id, { state: 'filled' });

  // Round-trip P&L: (exitQuote - entryQuote) - (entryFees + exitFees)
  const entryFees = Number(position.entryFees);
  const entryValueGross = Number(position.entryQuoteSpent);
  const exitValueGross = exitAgg.quoteValue;
  const exitFees = exitAgg.totalFees;
  const realizedNet = exitValueGross - entryValueGross - entryFees - exitFees;
  const realizedNetPct = entryValueGross === 0 ? 0 : (realizedNet / entryValueGross) * 100;
  const outcome: 'win' | 'loss' | 'flat' =
    realizedNet > 0 ? 'win' : realizedNet < 0 ? 'loss' : 'flat';

  // Cash + accounting.
  await creditSellToLedger(intent.id, position.id, exitAgg);

  const closedAt = new Date();
  await markPositionClosed(position.id, closedAt);
  const roundTripId = await insertRoundTrip({
    positionId: position.id,
    token: position.token,
    mode: position.mode,
    entryValueGross: entryValueGross.toFixed(8),
    exitValueGross: exitValueGross.toFixed(8),
    entryFees: entryFees.toFixed(8),
    exitFees: exitFees.toFixed(8),
    realizedNetPnl: realizedNet.toFixed(8),
    realizedNetPnlPct: realizedNetPct.toFixed(4),
    outcome,
    exitReason: reason === 'emergency' ? 'emergency' : reason,
    openedAt: position.openedAt,
    closedAt,
  });

  // Win/loss stats + circuit breaker — flats don't move the counter.
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
      realizedNet >= 0 ? '+' : ''
    }$${realizedNet.toFixed(4)} (${realizedNetPct.toFixed(2)}%)`,
  });

  return { kind: 'closed', intentId: intent.id, roundTripId };
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

/** Evaluates exit rules for a position given its current mark price. */
export function shouldExit(
  position: PositionRow,
  currentPrice: number,
): { exit: boolean; reason: ExitReason } {
  const tp = Number(position.takeProfitPrice);
  const sl = Number(position.stopLossPrice);
  if (currentPrice >= tp) return { exit: true, reason: 'take_profit' };
  if (currentPrice <= sl) return { exit: true, reason: 'stop_loss' };
  if (position.mode === 'reversion') {
    const modeCfg = STRATEGY.MODES.reversion;
    const gainPct =
      ((currentPrice - Number(position.avgEntryPrice)) / Number(position.avgEntryPrice)) * 100;
    if (gainPct >= modeCfg.earlyExitPct) return { exit: true, reason: 'early_exit' };
  }
  return { exit: false, reason: 'manual' };
}

// ---------------------------------------------------------------------------
// Portfolio cash — from the ledger, always
// ---------------------------------------------------------------------------

const DRY_RUN_INITIAL = 10_000;

export async function getPortfolioCash(): Promise<number> {
  if (ENV.dryRun) {
    await ensureInitialFund(true, DRY_RUN_INITIAL);
    return getLedgerCashBalance(true);
  }
  if (!ENV.coinbaseConfigured) return 0;
  return getCoinbaseCashBalance();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProduct(token: string, price: number): CoinbaseProduct {
  return {
    product_id: `${token}-USD`,
    price: price.toString(),
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
