import { createHash, randomBytes } from 'node:crypto';
import { Money, ONE_MONEY, STRATEGY, STRATEGY_VERSION, type TradingMode } from '@horizon/shared';
import { ENV } from '../env';
import { allocateExitAttempt } from './exitAttemptAllocator';
import {
  ensureInitialFund,
  findOrderIntentByClientOrderId,
  getBotConfig,
  getCashBalance as getLedgerCashBalance,
  getOpenPositionForToken,
  getOrderIntent,
  hasUnknownIntentForPosition,
  insertOrderIntent,
  logActivity,
  recordTokenOutcome,
  updateBotConfig,
  updateOrderIntent,
  updatePositionVersioned,
  type NewOrderIntent,
} from '../db/queries';
import {
  applyEntryEconomicStateTx,
  applyExitEconomicStateTx,
  FencingViolation,
  isDuplicateKeyError,
  type NormalizedFill,
} from '../db/tx';
import type { OrderIntentRow, PositionRow } from '../db/schema';
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

/**
 * Idempotent intent persistence. Two safety layers:
 *   1. Fast path: lookup by clientOrderId — a retry of the same economic
 *      order sees the existing row and skips the insert.
 *   2. Race-safe path: if the lookup misses but a concurrent worker inserts
 *      between the lookup and our insert, ER_DUP_ENTRY on the clientOrderId
 *      or exit-attempt UNIQUE index throws — we catch and re-read.
 */
async function persistIntent(intent: NewOrderIntent): Promise<OrderIntentRow> {
  const existing = await findOrderIntentByClientOrderId(intent.clientOrderId);
  if (existing) return existing;
  try {
    const id = await insertOrderIntent(intent);
    return (await getOrderIntent(id))!;
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Concurrent insert won — re-read via the deterministic key.
    const found = await findOrderIntentByClientOrderId(intent.clientOrderId);
    if (!found) {
      // The dup might have been on (positionId,purpose,attemptGeneration) —
      // meaning a peer allocated the same attempt for a different clientOrderId.
      // That indicates a genuine race we can't resolve here; the caller must
      // recompute attemptGeneration.
      throw new Error(
        `persistIntent race: duplicate exit attempt for position ${intent.positionId ?? 'n/a'} purpose ${intent.purpose}; caller must retry with a fresh generation`,
      );
    }
    return found;
  }
}

/** Converts a CoinbaseFill into the NormalizedFill shape apply* functions accept. */
function normalizeCoinbaseFill(fill: CoinbaseFill): NormalizedFill {
  return {
    exchangeFillId: fill.trade_id,
    exchangeOrderId: fill.order_id,
    token: fill.product_id.split('-')[0],
    side: fill.side,
    filledSize: fill.size,
    fillPrice: fill.price,
    fee: fill.commission,
    feeCurrency: 'USD',
    tradeTime: new Date(fill.trade_time),
    rawResponse: JSON.stringify(fill),
  };
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
  /**
   * Phase 1.1.a-FIX §H: the current scan lease's fenceGeneration. Persisted
   * on the intent + verified inside the atomic economic transaction so a
   * stale worker whose lease was silently taken cannot commit an entry.
   * Undefined only in tests / non-fenced entry paths.
   */
  fenceGeneration?: number;
  /**
   * Phase 1.1.b §A: the lease's resource key (e.g. SCAN_LEASE_KEY). Combined
   * with `fenceGeneration` these two fields tie the intent to a specific
   * execution_fences row — verifyFencingTx does `SELECT ... FOR UPDATE` on
   * that row to authoritatively reject stale workers.
   */
  fenceResourceKey?: string;
  /**
   * Phase 1.1 Gate 2: the decision chain that authorized this entry. Stamped
   * on the order intent + on the position at creation so lineage from
   * observation → intent → fill → position is directly queryable.
   */
  decisionChainId?: number;
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
 *
 * Phase 1.1 Gate 3D-FIX §F — under SIMULATION_MODE=SHADOW_LIVE, the
 * legacy path is BLOCKED. Callers must use
 * `runtimeShadowScan` + `runtimeShadowExecute` instead. The guard runs
 * before any economic write so a scan cannot slip through.
 */
export async function openPosition(decision: EntryDecision): Promise<OpenResult> {
  // Phase 1.1 Gate 3D-FIX §F — legacy-bypass barrier.
  const { assertRuntimeShadowOrLegacyBypass } = await import('./shadow/runtimeService');
  assertRuntimeShadowOrLegacyBypass('openPosition');

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
    fenceGeneration: decision.fenceGeneration ?? null,
    fenceResourceKey: decision.fenceResourceKey ?? null,
    decisionChainId: decision.decisionChainId ?? null,
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
  const collectedFills: CoinbaseFill[] = [];
  if (!useLivePath()) {
    exchangeOrderId = `DRY-${clientOrderId}`;
    await updateOrderIntent(intent.id, {
      state: 'submitted',
      exchangeOrderId,
      rawResponse: '{"dryRun":true}',
    });
    // FIX §F/§D: do NOT persist fills here. Collect them in memory and hand
    // the whole set to applyEntryEconomicStateTx so fill insertion happens
    // INSIDE the atomic economic transaction.
    const fakeFill = simulateBuyFill(product, Money.fromString(normalizedQuote));
    fakeFill.order_id = exchangeOrderId;
    collectedFills.push(fakeFill);
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

  // ── 6. Live path: fetch fills from Coinbase now that we know the order id.
  if (useLivePath()) {
    try {
      const liveFills = await listFillsForOrder(exchangeOrderId);
      for (const lf of liveFills) collectedFills.push(lf);
    } catch (err) {
      // Non-fatal here — reconciler can retry later. The intent stays in
      // 'submitted' state so the recovery path picks it up.
      await logActivity({
        type: 'error',
        severity: 'warn',
        token: decision.token,
        action: 'FILL_FETCH_FAILED',
        detail: `${clientOrderId}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return { kind: 'unknown', intentId: intent.id, reason: 'fill_fetch_failed' };
    }
  }

  if (collectedFills.length === 0) {
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

  const modeCfg = STRATEGY.MODES[decision.mode];
  const normalizedFills = collectedFills.map(normalizeCoinbaseFill);

  // Partial-fill classification: compare requested quote to actual (fills * price + fees).
  // (This is a heuristic slice-1.1.b replaces with Coinbase order.status + completion_percentage.)
  const requestedQuote = Money.fromString(normalizedQuote);
  let filledQuoteSum = Money.zero();
  let filledSizeSum = Money.zero();
  for (const nf of normalizedFills) {
    const size = Money.fromString(nf.filledSize);
    filledSizeSum = filledSizeSum.add(size);
    filledQuoteSum = filledQuoteSum.add(size.mul(Money.fromString(nf.fillPrice))).add(
      Money.fromString(nf.fee),
    );
  }
  if (!filledSizeSum.isPositive()) {
    await updateOrderIntent(intent.id, { state: 'canceled' });
    return { kind: 'skipped', intentId: intent.id, reason: 'zero_fill' };
  }
  const partialCushion = requestedQuote.pct(1);
  const intentEndState: 'filled' | 'partially_filled' = requestedQuote
    .sub(filledQuoteSum)
    .abs()
    .gt(partialCushion)
    ? 'partially_filled'
    : 'filled';

  // ── 7. ATOMIC: fills + ledger + position + intent, all inside ONE transaction
  //           via the shared applyEntryEconomicStateTx (FIX §F/§D). Same function
  //           is called by the reconciler's recovery path — no duplicate
  //           economic-application code.
  let positionId: number;
  try {
    const result = await applyEntryEconomicStateTx({
      intentId: intent.id,
      fillsToApply: normalizedFills,
      mode: decision.mode,
      takeProfitPct: modeCfg.takeProfitPct,
      stopLossPct: modeCfg.stopLossPct,
      allocationPct: decision.allocationPct,
      claudeReason: decision.claudeReason,
      claudeModel: decision.claudeModel,
      claudeConfidence: decision.claudeConfidence,
      strategyVersion: STRATEGY_VERSION,
      protectionMode: 'polling_fallback',
      dryRun: ENV.dryRun,
      intentEndState,
      entryDecisionChainId: decision.decisionChainId ?? null,
    });
    positionId = result.positionId;
  } catch (err) {
    if (err instanceof FencingViolation) {
      // §H FIX: a stale worker was outrun by a newer generation. Abort cleanly
      // — the newer worker is authoritative. Mark our intent failed.
      await updateOrderIntent(intent.id, {
        state: 'failed',
        failureClass: 'non_retryable_validation',
        errorCode: 'fencing_violation',
        errorMessage: err.message,
      });
      await logActivity({
        type: 'system',
        severity: 'high',
        token: decision.token,
        action: 'FENCING_VIOLATION',
        detail: err.message,
      });
      return { kind: 'rejected', intentId: intent.id, reason: 'fencing_violation' };
    }
    if (isDuplicateKeyError(err)) {
      // §G — DB-enforced open-position uniqueness.
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
    detail: `${ENV.dryRun ? '[DRY RUN] ' : ''}${decision.mode} filled ${filledSizeSum.toDecimalString(6)} into position ${positionId} (${normalizedFills.length} fill${normalizedFills.length === 1 ? '' : 's'})`,
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
 *
 * Phase 1.1 Gate 3D-FIX §F — SHADOW_LIVE routes exits through
 * `runtimeShadowExit`. This legacy path is blocked in SHADOW_LIVE.
 */
export async function closePosition(
  position: PositionRow,
  reason: ExitReason,
): Promise<ClosePositionResult> {
  // Phase 1.1 Gate 3D-FIX §F — legacy-bypass barrier.
  const { assertRuntimeShadowOrLegacyBypass } = await import('./shadow/runtimeService');
  assertRuntimeShadowOrLegacyBypass('closePosition');

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

  // Phase 1.1.b §F: transactional exit-attempt allocation.
  //
  // The old `countExitAttemptsForPosition + 1` was racy — two workers
  // reading the same count would derive the same clientOrderId. The
  // allocator locks the position row (SELECT ... FOR UPDATE), inspects
  // the newest exit intent for (positionId, purpose), and either REUSES
  // the existing non-terminal intent or ALLOCATES the next generation.
  const allocation = await allocateExitAttempt(position.id, purpose);
  let intent: OrderIntentRow;
  if (allocation.action === 'reuse' && allocation.reusedIntent) {
    // Same clientOrderId as before — the caller (or a peer) is retrying an
    // in-flight attempt; NEVER submit a fresh Coinbase order under a new
    // clientOrderId. Fall through to the fills-fetch/apply path below.
    intent = allocation.reusedIntent;
  } else {
    const attemptGeneration = allocation.attemptGeneration;
    const clientOrderId = deriveClientOrderId({
      purpose,
      token: position.token,
      mode: position.mode,
      positionId: position.id,
      attemptGeneration,
    });
    intent = await persistIntent({
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
      attemptGeneration,
    });
  }
  const clientOrderId = intent.clientOrderId;

  let exchangeOrderId: string;
  const exitFills: CoinbaseFill[] = [];
  if (!useLivePath()) {
    exchangeOrderId = `DRY-${clientOrderId}`;
    await updateOrderIntent(intent.id, {
      state: 'submitted',
      exchangeOrderId,
      rawResponse: '{"dryRun":true}',
    });
    // FIX §F/§D: collect the simulated fill; do NOT persist here. The atomic
    // exit apply function inserts fills inside the same transaction as the
    // ledger credit, position close, and round-trip creation.
    const fakeFill = simulateSellFill(product, Money.fromString(baseSizeStr));
    fakeFill.order_id = exchangeOrderId;
    exitFills.push(fakeFill);
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

  // Live path: fetch exit fills now that we have the order id.
  if (useLivePath()) {
    try {
      const liveFills = await listFillsForOrder(exchangeOrderId);
      for (const lf of liveFills) exitFills.push(lf);
    } catch (err) {
      await logActivity({
        type: 'error',
        severity: 'warn',
        token: position.token,
        action: 'EXIT_FILL_FETCH_FAILED',
        detail: `${clientOrderId}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return { kind: 'pending', intentId: intent.id, reason: 'fill_fetch_failed' };
    }
  }

  if (exitFills.length === 0) {
    await updateOrderIntent(intent.id, { state: 'canceled' });
    return { kind: 'failed', intentId: intent.id, reason: 'exit_zero_fill' };
  }

  const normalizedExit = exitFills.map(normalizeCoinbaseFill);

  // ATOMIC EXIT: fills + ledger + close + round-trip + intent, all inside ONE
  // transaction via the shared applyExitEconomicStateTx (FIX §F/§D).
  let result: Awaited<ReturnType<typeof applyExitEconomicStateTx>>;
  try {
    result = await applyExitEconomicStateTx({
      intentId: intent.id,
      position,
      fillsToApply: normalizedExit,
      exitReason: reason === 'emergency' ? 'emergency' : reason,
      dryRun: ENV.dryRun,
    });
  } catch (err) {
    if (err instanceof FencingViolation) {
      await updateOrderIntent(intent.id, {
        state: 'failed',
        failureClass: 'non_retryable_validation',
        errorCode: 'fencing_violation',
        errorMessage: err.message,
      });
      return { kind: 'failed', intentId: intent.id, reason: 'fencing_violation' };
    }
    throw err;
  }

  // Gate 3A: `result` may be 'partial' (partial exit, position remains open),
  // 'closed' (fully closed), or 'dust_closed' (closed with dust remainder).
  // Only closure paths update win/loss stats + circuit breaker.
  if (result.kind === 'partial') {
    await logActivity({
      type: 'trade',
      severity: 'info',
      token: position.token,
      action: 'PARTIAL_EXIT',
      detail: `${ENV.dryRun ? '[DRY RUN] ' : ''}${reason} — sold ${result.newlyAppliedBase} base; residual ${result.residualBaseSize} remains open`,
    });
    return { kind: 'pending', intentId: intent.id, reason: 'partial_exit_residual_remains' };
  }

  // Win/loss stats + circuit breaker — flats don't move the counter.
  // Kept OUTSIDE the transaction because they touch token_stats + bot_config
  // and are not required to be atomic with the round-trip creation.
  if (result.outcome === 'win' || result.outcome === 'loss') {
    await recordTokenOutcome(position.token, result.outcome);
    await updateCircuitBreaker(result.outcome);
  }

  await logActivity({
    type: 'trade',
    severity: result.outcome === 'loss' ? 'warn' : 'info',
    token: position.token,
    action: result.kind === 'dust_closed' ? 'CLOSE_POSITION_DUST' : 'CLOSE_POSITION',
    detail: `${ENV.dryRun ? '[DRY RUN] ' : ''}${reason} — outcome ${result.outcome} (round-trip ${result.roundTripId})${result.kind === 'dust_closed' ? ` [dust residual ${result.residualBaseSize}]` : ''}`,
  });

  return { kind: 'closed', intentId: intent.id, roundTripId: result.roundTripId };
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
