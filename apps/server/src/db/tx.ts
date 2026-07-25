import { and, eq, gt, ne, or, sql } from 'drizzle-orm';
import { Money, type TradingMode } from '@horizon/shared';
import { db } from './index';
import { cashLedger, fills, orderIntents, positions, roundTrips } from './schema';
import type {
  CashLedgerInsert,
  FillInsert,
  FillRow,
  OrderIntentRow,
  PositionInsert,
  PositionRow,
  RoundTripInsert,
} from './schema';

/**
 * Atomic database primitives (Phase 1.1.a §F).
 *
 * Entry and exit are economically-inseparable multi-row operations:
 *   • ENTRY: fills insert → ledger debit → position insert → intent update
 *   • EXIT:  fills insert → ledger credit → position update → round-trip insert
 *
 * A crash BETWEEN these individual statements can produce orphaned rows —
 * position without a ledger debit, closed-but-no-round-trip, double-booked
 * ledger. This module wraps each of those sequences in a single DB
 * transaction, and provides an idempotent `insertCashLedgerEvent` that uses
 * `cash_ledger.idempotencyKey` (UNIQUE) to survive replay during startup
 * reconciliation.
 *
 * Drizzle mysql2 driver: `db.transaction(fn)` runs `fn(tx)` inside a
 * `START TRANSACTION` / `COMMIT`; any throw rolls back automatically.
 */

// ---------------------------------------------------------------------------
// Idempotency-key builders — one canonical shape per causal event
// ---------------------------------------------------------------------------

/** For fill-derived ledger entries (buy_cost, buy_fee, sell_proceeds, sell_fee). */
export function ledgerKeyForFill(
  reason: 'buy_cost' | 'buy_fee' | 'sell_proceeds' | 'sell_fee' | 'buy_slippage' | 'sell_slippage',
  intentId: number,
  fillId: number,
): string {
  return `${reason}:${intentId}:fill-${fillId}`;
}

/** For non-fill ledger entries (initial_fund, manual_adjustment). */
export function ledgerKeyForAdjustment(
  reason: 'initial_fund' | 'manual_adjustment',
  discriminator: string,
): string {
  return `${reason}:${discriminator}`;
}

// ---------------------------------------------------------------------------
// Transaction runner
// ---------------------------------------------------------------------------

/**
 * Runs `fn` inside a database transaction. Any thrown error rolls back.
 * The `tx` argument has the same shape as `db` but is scoped to the transaction.
 */
export async function withTransaction<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx as unknown as typeof db));
}

// ---------------------------------------------------------------------------
// Idempotent ledger insert
// ---------------------------------------------------------------------------

/**
 * Inserts a cash-ledger row keyed by `idempotencyKey`. On a duplicate key
 * (i.e. replay during startup reconciliation), silently no-ops.
 *
 * Callers pass Money for `deltaUsd`; we serialize at the DB boundary.
 */
export async function insertCashLedgerEvent(
  tx: typeof db,
  entry: {
    idempotencyKey: string;
    deltaUsd: Money;
    reason: CashLedgerInsert['reason'];
    orderIntentId?: number | null;
    positionId?: number | null;
    fillId?: number | null;
    dryRun: boolean;
    detail?: string | null;
  },
): Promise<{ inserted: boolean }> {
  try {
    await tx.insert(cashLedger).values({
      idempotencyKey: entry.idempotencyKey,
      deltaUsd: entry.deltaUsd.toDecimalString(),
      reason: entry.reason,
      orderIntentId: entry.orderIntentId ?? null,
      positionId: entry.positionId ?? null,
      fillId: entry.fillId ?? null,
      dryRun: entry.dryRun,
      detail: entry.detail ?? null,
    });
    return { inserted: true };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      return { inserted: false };
    }
    throw err;
  }
}

/**
 * MySQL ER_DUP_ENTRY = 1062. Recognise it whether it surfaces via mysql2's
 * `.errno` / `.code` fields directly, gets wrapped by Drizzle (with the
 * mysql2 error on `.cause`), or the caller has only the message string.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  const stack: unknown[] = [err];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    const e = current as { errno?: number; code?: string; message?: string; cause?: unknown };
    if (e.errno === 1062) return true;
    if (e.code === 'ER_DUP_ENTRY') return true;
    if (typeof e.message === 'string' && /Duplicate entry/i.test(e.message)) return true;
    if (e.cause) stack.push(e.cause);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Transactional insert primitives — use the tx handle, not the global db
// ---------------------------------------------------------------------------

export async function insertFillTx(tx: typeof db, row: FillInsert): Promise<number> {
  const result = await tx.insert(fills).values(row);
  return (result as unknown as { insertId: number }[])[0]?.insertId ?? 0;
}

export async function insertPositionTx(tx: typeof db, row: PositionInsert): Promise<number> {
  const result = await tx.insert(positions).values(row);
  return (result as unknown as { insertId: number }[])[0]?.insertId ?? 0;
}

export async function updateOrderIntentTx(
  tx: typeof db,
  id: number,
  patch: Partial<OrderIntentRow>,
): Promise<void> {
  await tx.update(orderIntents).set(patch).where(eq(orderIntents.id, id));
}

export async function markPositionClosedTx(
  tx: typeof db,
  id: number,
  closedAt: Date,
): Promise<void> {
  await tx
    .update(positions)
    .set({ status: 'closed', lifecycleState: 'closed', closedAt })
    .where(eq(positions.id, id));
}

export async function insertRoundTripTx(tx: typeof db, row: RoundTripInsert): Promise<number> {
  const result = await tx.insert(roundTrips).values(row);
  return (result as unknown as { insertId: number }[])[0]?.insertId ?? 0;
}

export async function findFillByExchangeIdTx(
  tx: typeof db,
  exchangeFillId: string,
): Promise<{ id: number } | null> {
  const rows = await tx
    .select({ id: fills.id })
    .from(fills)
    .where(eq(fills.exchangeFillId, exchangeFillId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPositionByIdTx(
  tx: typeof db,
  id: number,
): Promise<PositionRow | null> {
  const rows = await tx.select().from(positions).where(eq(positions.id, id)).limit(1);
  return rows[0] ?? null;
}

async function getOrderIntentTx(tx: typeof db, id: number): Promise<OrderIntentRow | null> {
  const rows = await tx.select().from(orderIntents).where(eq(orderIntents.id, id)).limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// §H FIX — durable fencing verification (inside the tx)
// ---------------------------------------------------------------------------

/**
 * FencingViolation is thrown when a stale worker attempts to commit under a
 * lease generation that has been superseded by a peer. The caller SHOULD NOT
 * retry — its lease is dead; only the newer worker is authoritative.
 */
export class FencingViolation extends Error {
  readonly ourGeneration: number;
  readonly latestGeneration: number;
  constructor(ourGeneration: number, latestGeneration: number, context: string) {
    super(
      `fencing violation: our generation ${ourGeneration} is older than the current max ${latestGeneration} for ${context}. Aborting stale write.`,
    );
    this.ourGeneration = ourGeneration;
    this.latestGeneration = latestGeneration;
    this.name = 'FencingViolation';
  }
}

/**
 * Inside the atomic transaction, verify that the intent's `fenceGeneration`
 * is still current for its `fenceResourceKey`. Uses the AUTHORITATIVE
 * `execution_fences` table (Phase 1.1.b §A) with `SELECT ... FOR UPDATE`
 * so a concurrent acquireLease that happens after our lock returns must
 * wait for our commit; and a concurrent acquireLease that got there first
 * has already bumped currentGeneration past ours.
 *
 * `fenceGeneration=null` OR `fenceResourceKey=null` means "no fencing
 * configured" (test paths, non-fenced entries) — treated as always valid.
 *
 * Backwards-compat: if the intent has a fenceGeneration but no resource key
 * (a pre-1.1.b row) we fall back to the old per-(token,purpose) max check
 * on order_intents. New writes always populate both.
 */
export async function verifyFencingTx(
  tx: typeof db,
  intent: Pick<
    OrderIntentRow,
    'id' | 'token' | 'purpose' | 'fenceGeneration' | 'fenceResourceKey'
  >,
): Promise<void> {
  if (intent.fenceGeneration == null) return;

  if (intent.fenceResourceKey) {
    // Authoritative path — the execution_fences table. FOR UPDATE holds a
    // row lock through the commit, blocking concurrent bumps until we finish.
    const raw = (await tx.execute(sql`
      SELECT currentGeneration FROM execution_fences
      WHERE resourceKey = ${intent.fenceResourceKey}
      FOR UPDATE
    `)) as unknown as [{ currentGeneration: number | string | bigint }[], unknown];
    const rowsA = Array.isArray(raw[0])
      ? raw[0]
      : (raw as unknown as { currentGeneration: number | string | bigint }[]);
    const row = rowsA[0];
    if (!row) {
      // No fence row exists yet for this resource — that means no acquire
      // ever recorded a generation. Treat as violation because we should
      // have INSERTed one at acquire time.
      throw new FencingViolation(
        intent.fenceGeneration,
        0,
        `${intent.fenceResourceKey} (no fence row)`,
      );
    }
    const currentGen = Number(row.currentGeneration);
    if (currentGen > intent.fenceGeneration) {
      throw new FencingViolation(intent.fenceGeneration, currentGen, intent.fenceResourceKey);
    }
    return;
  }

  // Legacy pre-1.1.b fallback: per-(token,purpose) max on order_intents.
  const maxRows = await tx
    .select({ maxGen: sql<number | null>`max(${orderIntents.fenceGeneration})` })
    .from(orderIntents)
    .where(and(eq(orderIntents.token, intent.token), eq(orderIntents.purpose, intent.purpose)));
  const maxGen = Number(maxRows[0]?.maxGen ?? intent.fenceGeneration);
  if (maxGen > intent.fenceGeneration) {
    throw new FencingViolation(intent.fenceGeneration, maxGen, `${intent.token}/${intent.purpose}`);
  }
}

// ---------------------------------------------------------------------------
// §F/§D FIX — shared atomic economic-state functions
// ---------------------------------------------------------------------------

/**
 * A fill as observed from Coinbase (or synthesized by the dry-run simulator).
 * We normalize the shape here so the apply* functions don't have to know
 * whether the fills came from a live createOrder response, a live
 * listFillsForOrder call, or a dry-run simulator.
 */
export interface NormalizedFill {
  exchangeFillId: string;
  exchangeOrderId: string;
  token: string;
  side: 'BUY' | 'SELL';
  filledSize: string; // decimal string
  fillPrice: string;
  fee: string;
  feeCurrency: string;
  tradeTime: Date;
  rawResponse: string;
}

/**
 * Idempotently inserts each fill by its unique `exchangeFillId`. Returns
 * the resulting FillRow objects (including their DB ids) in the same order.
 * A replay of the same fill during recovery is a silent no-op.
 */
async function upsertFillsTx(
  tx: typeof db,
  intentId: number,
  incoming: NormalizedFill[],
): Promise<FillRow[]> {
  const result: FillRow[] = [];
  for (const f of incoming) {
    try {
      await tx.insert(fills).values({
        exchangeFillId: f.exchangeFillId,
        orderIntentId: intentId,
        exchangeOrderId: f.exchangeOrderId,
        token: f.token,
        side: f.side,
        filledSize: f.filledSize,
        fillPrice: f.fillPrice,
        fee: f.fee,
        feeCurrency: f.feeCurrency,
        tradeTime: f.tradeTime,
        rawResponse: f.rawResponse,
      });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      // Fill already persisted — a prior attempt saw it. That's fine.
    }
    const [row] = await tx
      .select()
      .from(fills)
      .where(eq(fills.exchangeFillId, f.exchangeFillId))
      .limit(1);
    if (!row) throw new Error(`fill upsert vanished: ${f.exchangeFillId}`);
    result.push(row);
  }
  return result;
}

function aggregateFillRows(rows: FillRow[]): {
  filledSize: Money;
  weightedAvgPrice: Money;
  totalFees: Money;
  quoteValue: Money;
} {
  if (rows.length === 0) {
    return {
      filledSize: Money.zero(),
      weightedAvgPrice: Money.zero(),
      totalFees: Money.zero(),
      quoteValue: Money.zero(),
    };
  }
  let filledSize = Money.zero();
  let quoteValue = Money.zero();
  let totalFees = Money.zero();
  for (const f of rows) {
    const size = Money.fromString(f.filledSize);
    const price = Money.fromString(f.fillPrice);
    filledSize = filledSize.add(size);
    quoteValue = quoteValue.add(size.mul(price));
    totalFees = totalFees.add(Money.fromString(f.fee));
  }
  return {
    filledSize,
    weightedAvgPrice: filledSize.isZero() ? Money.zero() : quoteValue.div(filledSize),
    totalFees,
    quoteValue,
  };
}

export interface ApplyEntryInput {
  intentId: number;
  fillsToApply: NormalizedFill[];
  mode: TradingMode;
  takeProfitPct: number;
  stopLossPct: number;
  allocationPct: number;
  claudeReason: string | null;
  claudeModel: string | null;
  claudeConfidence: number | null;
  strategyVersion: string;
  protectionMode: 'exchange_bracket' | 'polling_fallback' | 'unprotected';
  dryRun: boolean;
  intentEndState: 'filled' | 'partially_filled';
  /** Phase 1.1 Gate 2: decision chain to stamp on the position. */
  entryDecisionChainId?: number | null;
  /** For rollback tests: throw right after fills / ledger / position. */
  __testHook?: (stage: 'after_fills' | 'after_ledger' | 'after_position') => void;
}

export interface ApplyEntryResult {
  kind: 'opened';
  positionId: number;
}

/**
 * Atomically applies an entry's economic state (Phase 1.1.a-FIX §F/§D).
 *
 * Inside ONE transaction:
 *   1. Verify fencing (§H) — a stale worker is rejected.
 *   2. Insert every fill (idempotent by exchangeFillId).
 *   3. Insert per-fill ledger debits (idempotent by idempotencyKey).
 *   4. Insert the position — DB-enforced one-open-per-token.
 *   5. Update the intent state + positionId link.
 *
 * A throw at any stage rolls back everything. A replay by the reconciler
 * sees the previously-inserted rows and completes idempotently: fills skip
 * on dup, ledger events skip on dup, and the position insert is guarded by
 * a pre-check for the specific `entryOrderIntentId`.
 *
 * Used by BOTH `openPosition` (normal path) and the reconciler (recovery
 * path). No duplicate economic-application code.
 */
export async function applyEntryEconomicStateTx(
  input: ApplyEntryInput,
): Promise<ApplyEntryResult> {
  return withTransaction(async (tx) => {
    const intent = await getOrderIntentTx(tx, input.intentId);
    if (!intent) throw new Error(`applyEntryEconomicStateTx: intent ${input.intentId} not found`);
    if (intent.side !== 'BUY') {
      throw new Error(`applyEntryEconomicStateTx: intent ${input.intentId} is not a BUY`);
    }

    // §H — durable fencing verification inside the tx.
    await verifyFencingTx(tx, intent);

    // Idempotent-recovery guard: if a position already exists for this intent,
    // just return it (a prior replay committed successfully).
    const existingByIntent = await tx
      .select({ id: positions.id })
      .from(positions)
      .where(eq(positions.entryOrderIntentId, input.intentId))
      .limit(1);
    if (existingByIntent[0]) {
      return { kind: 'opened', positionId: existingByIntent[0].id };
    }

    // 1. Insert missing fills.
    const rows = await upsertFillsTx(tx, input.intentId, input.fillsToApply);
    input.__testHook?.('after_fills');

    const agg = aggregateFillRows(rows);
    if (!agg.filledSize.isPositive()) {
      throw new Error(
        `applyEntryEconomicStateTx: refuse to open — zero filled size for intent ${input.intentId}`,
      );
    }
    const avgEntry = agg.weightedAvgPrice;
    const takeProfitPrice = avgEntry.mul(
      Money.fromString('1').add(Money.fromNumber(input.takeProfitPct).divInt(100)),
    );
    const stopLossPrice = avgEntry.mul(
      Money.fromString('1').sub(Money.fromNumber(input.stopLossPct).divInt(100)),
    );

    // 2. Insert per-fill ledger debits.
    for (const f of rows) {
      const size = Money.fromString(f.filledSize);
      const price = Money.fromString(f.fillPrice);
      const quote = size.mul(price);
      const fee = Money.fromString(f.fee);
      if (quote.isPositive()) {
        await insertCashLedgerEvent(tx, {
          idempotencyKey: ledgerKeyForFill('buy_cost', input.intentId, f.id),
          deltaUsd: quote.neg(),
          reason: 'buy_cost',
          orderIntentId: input.intentId,
          fillId: f.id,
          dryRun: input.dryRun,
        });
      }
      if (fee.isPositive()) {
        await insertCashLedgerEvent(tx, {
          idempotencyKey: ledgerKeyForFill('buy_fee', input.intentId, f.id),
          deltaUsd: fee.neg(),
          reason: 'buy_fee',
          orderIntentId: input.intentId,
          fillId: f.id,
          dryRun: input.dryRun,
        });
      }
    }
    input.__testHook?.('after_ledger');

    // 3. Insert position.
    const positionId = await insertPositionTx(tx, {
      token: intent.token,
      mode: input.mode,
      avgEntryPrice: avgEntry.toDecimalString(),
      filledQuantity: agg.filledSize.toDecimalString(),
      entryFees: agg.totalFees.toDecimalString(),
      entryQuoteSpent: agg.quoteValue.toDecimalString(),
      allocationPct: Money.fromNumber(input.allocationPct).toDecimalString(2),
      takeProfitPrice: takeProfitPrice.toDecimalString(),
      stopLossPrice: stopLossPrice.toDecimalString(),
      takeProfitPct: Money.fromNumber(input.takeProfitPct).toDecimalString(2),
      stopLossPct: Money.fromNumber(input.stopLossPct).toDecimalString(2),
      entryOrderIntentId: input.intentId,
      protectionMode: input.protectionMode,
      claudeReason: input.claudeReason,
      claudeModel: input.claudeModel,
      claudeConfidence:
        input.claudeConfidence !== null
          ? Money.fromNumber(input.claudeConfidence).toDecimalString(4)
          : null,
      strategyVersion: input.strategyVersion,
      lifecycleState: 'open',
      status: 'open',
      entryDecisionChainId: input.entryDecisionChainId ?? intent.decisionChainId ?? null,
    });
    input.__testHook?.('after_position');

    // 4. Update the intent state + positionId.
    await updateOrderIntentTx(tx, input.intentId, {
      state: input.intentEndState,
      positionId,
    });

    return { kind: 'opened', positionId };
  });
}

export interface ApplyExitInput {
  intentId: number;
  position: PositionRow;
  fillsToApply: NormalizedFill[];
  exitReason: 'take_profit' | 'stop_loss' | 'early_exit' | 'manual' | 'emergency' | 'reconciled';
  dryRun: boolean;
  /**
   * Gate 3A §F: dust threshold in base units. A residual quantity
   * ≤ dustThreshold at the end of an exit is treated as fully closed,
   * with dust fields populated. Default: `product.base_min_size` or the
   * caller's canonical dust threshold. Setting `0` disables dust
   * classification (residual > 0 always keeps the position open).
   */
  dustThresholdBase?: Money;
  dustPolicyVersion?: string;
  __testHook?: (stage: 'after_fills' | 'after_ledger' | 'after_position') => void;
}

/**
 * Result of applying an exit's economic state.
 *   - `partial`: some base sold, position remains open with residual.
 *   - `closed`: position is fully closed; round trip created.
 *   - `dust_closed`: residual ≤ dustThreshold; position closed with dust
 *     fields populated; round trip created.
 */
export type ApplyExitResult =
  | {
      kind: 'closed' | 'dust_closed';
      roundTripId: number;
      outcome: 'win' | 'loss' | 'flat';
      residualBaseSize: string;
    }
  | {
      kind: 'partial';
      residualBaseSize: string;
      newlyAppliedBase: string;
    };

/**
 * Atomically applies an exit's economic state, correctly handling PARTIAL
 * exits (Gate 3A §E).
 *
 * Inside ONE transaction:
 *   1. Verify fencing.
 *   2. Insert every fill (idempotent).
 *   3. Insert per-fill ledger credits (idempotent).
 *   4. Compute residualBaseSize = position.filledQuantity - Σ(all exit fills
 *      across all exit intents for this position).
 *   5. If residual > dustThreshold:
 *        - Position remains open (lifecycleState='partially_closing').
 *        - residualBaseSize is updated.
 *        - Intent state may be 'partially_filled' or 'filled' depending on
 *          how much of this specific intent's target was filled.
 *        - NO round trip yet.
 *   6. If residual ≤ dustThreshold:
 *        - Position closed. Round trip created.
 *        - When residual > 0 but ≤ dustThreshold, dust fields populated
 *          and lifecycleState='dust_residual'. `kind='dust_closed'`.
 *   7. Update the intent state.
 *
 * The round-trip aggregates ALL exit fills across ALL exit intents for
 * the position (not just this intent's fills). Multiple partial exit
 * attempts fold into ONE round trip when the position finally closes.
 *
 * Replay on the same fills is idempotent: the ledger events dedupe by
 * idempotencyKey, the fills dedupe by exchangeFillId, and the residual
 * math re-derives from the DB — so re-running produces the same result.
 */
export async function applyExitEconomicStateTx(input: ApplyExitInput): Promise<ApplyExitResult> {
  return withTransaction(async (tx) => {
    const intent = await getOrderIntentTx(tx, input.intentId);
    if (!intent) throw new Error(`applyExitEconomicStateTx: intent ${input.intentId} not found`);
    if (intent.side !== 'SELL') {
      throw new Error(`applyExitEconomicStateTx: intent ${input.intentId} is not a SELL`);
    }

    await verifyFencingTx(tx, intent);

    // Load LIVE position — Gate 3A: multiple exit attempts share one
    // position lifecycle, so we must re-read state (input.position may be
    // stale from a prior partial-close).
    const [livePosition] = await tx
      .select()
      .from(positions)
      .where(eq(positions.id, input.position.id))
      .limit(1);
    if (!livePosition) {
      throw new Error(`applyExitEconomicStateTx: position ${input.position.id} not found`);
    }

    // Idempotent guard: if a round trip already exists for this position,
    // we already fully closed — return it.
    const existingRt = await tx
      .select({ id: roundTrips.id, outcome: roundTrips.outcome })
      .from(roundTrips)
      .where(eq(roundTrips.positionId, livePosition.id))
      .limit(1);
    if (existingRt[0]) {
      return {
        kind: 'closed',
        roundTripId: existingRt[0].id,
        outcome: existingRt[0].outcome,
        residualBaseSize: '0',
      };
    }

    // 1. Insert fills (idempotent).
    const rows = await upsertFillsTx(tx, input.intentId, input.fillsToApply);
    input.__testHook?.('after_fills');

    const thisIntentAgg = aggregateFillRows(rows);
    if (!thisIntentAgg.filledSize.isPositive()) {
      throw new Error(
        `applyExitEconomicStateTx: refuse to apply — zero filled size for intent ${input.intentId}`,
      );
    }

    // 2. Ledger credits (proceeds +, fees -). Idempotent per fill.
    for (const f of rows) {
      const size = Money.fromString(f.filledSize);
      const price = Money.fromString(f.fillPrice);
      const quote = size.mul(price);
      const fee = Money.fromString(f.fee);
      if (quote.isPositive()) {
        await insertCashLedgerEvent(tx, {
          idempotencyKey: ledgerKeyForFill('sell_proceeds', input.intentId, f.id),
          deltaUsd: quote,
          reason: 'sell_proceeds',
          orderIntentId: input.intentId,
          positionId: livePosition.id,
          fillId: f.id,
          dryRun: input.dryRun,
        });
      }
      if (fee.isPositive()) {
        await insertCashLedgerEvent(tx, {
          idempotencyKey: ledgerKeyForFill('sell_fee', input.intentId, f.id),
          deltaUsd: fee.neg(),
          reason: 'sell_fee',
          orderIntentId: input.intentId,
          positionId: livePosition.id,
          fillId: f.id,
          dryRun: input.dryRun,
        });
      }
    }
    input.__testHook?.('after_ledger');

    // 3. Aggregate ALL exit fills for this position across every exit intent.
    //    We can't just sum this-intent's fills because a prior partial exit
    //    (different intent) may already have sold some of the position.
    const allExitFillRows = await tx
      .select({
        filledSize: fills.filledSize,
        fillPrice: fills.fillPrice,
        fee: fills.fee,
      })
      .from(fills)
      .innerJoin(orderIntents, eq(fills.orderIntentId, orderIntents.id))
      .where(
        and(
          eq(orderIntents.positionId, livePosition.id),
          eq(orderIntents.side, 'SELL'),
        ),
      );
    let totalExitBase = Money.zero();
    let totalExitQuote = Money.zero();
    let totalExitFees = Money.zero();
    for (const r of allExitFillRows) {
      const s = Money.fromString(r.filledSize);
      const p = Money.fromString(r.fillPrice);
      totalExitBase = totalExitBase.add(s);
      totalExitQuote = totalExitQuote.add(s.mul(p));
      totalExitFees = totalExitFees.add(Money.fromString(r.fee));
    }
    const entryBase = Money.fromString(livePosition.filledQuantity);
    const residualBase = entryBase.sub(totalExitBase);
    const dustThreshold = input.dustThresholdBase ?? Money.fromString('0.00000001');
    const dustPolicyVersion = input.dustPolicyVersion ?? 'v1';

    // 4. Update intent — this specific intent's state depends on whether
    //    THIS intent's requested baseSize was fully matched.
    const requestedBase = intent.baseSize
      ? Money.fromString(intent.baseSize)
      : thisIntentAgg.filledSize;
    const thisIntentEndState =
      thisIntentAgg.filledSize.gte(requestedBase) ? 'filled' : 'partially_filled';

    // 5. Decide: partial-close vs full close vs dust close.
    const isFullyClosedExact = residualBase.lte(Money.zero());
    const isDustClosed = !isFullyClosedExact && residualBase.lte(dustThreshold);
    const shouldClose = isFullyClosedExact || isDustClosed;

    if (!shouldClose) {
      // Partial close — position remains open with a smaller effective size.
      await tx
        .update(positions)
        .set({
          residualBaseSize: residualBase.toDecimalString(8),
          lifecycleState: 'partially_closing',
        })
        .where(eq(positions.id, livePosition.id));
      input.__testHook?.('after_position');
      await updateOrderIntentTx(tx, input.intentId, { state: thisIntentEndState });
      return {
        kind: 'partial',
        residualBaseSize: residualBase.toDecimalString(8),
        newlyAppliedBase: thisIntentAgg.filledSize.toDecimalString(8),
      };
    }

    // 6. Full/dust close — mark position closed + create round trip aggregating
    //    ALL exit fills.
    const entryFees = Money.fromString(livePosition.entryFees);
    const entryValueGross = Money.fromString(livePosition.entryQuoteSpent);
    const realizedNet = totalExitQuote.sub(entryValueGross).sub(entryFees).sub(totalExitFees);
    const realizedNetPct = entryValueGross.isZero()
      ? Money.zero()
      : realizedNet.div(entryValueGross).mul(Money.fromString('100'));
    const outcome: 'win' | 'loss' | 'flat' = realizedNet.isPositive()
      ? 'win'
      : realizedNet.isNegative()
        ? 'loss'
        : 'flat';

    const closedAt = new Date();
    const dustResidualClamped = residualBase.isPositive() ? residualBase : Money.zero();
    const positionPatch: Record<string, unknown> = {
      status: 'closed',
      lifecycleState: isDustClosed ? 'dust_residual' : 'closed',
      closedAt,
      residualBaseSize: dustResidualClamped.toDecimalString(8),
    };
    if (isDustClosed) {
      positionPatch.dustQuantity = dustResidualClamped.toDecimalString(8);
      positionPatch.dustReason = 'below_dust_threshold';
      positionPatch.dustDetectedAt = closedAt;
      positionPatch.dustPolicyVersion = dustPolicyVersion;
    }
    await tx.update(positions).set(positionPatch).where(eq(positions.id, livePosition.id));
    input.__testHook?.('after_position');

    const roundTripId = await insertRoundTripTx(tx, {
      positionId: livePosition.id,
      token: livePosition.token,
      mode: livePosition.mode,
      entryValueGross: entryValueGross.toDecimalString(),
      exitValueGross: totalExitQuote.toDecimalString(),
      entryFees: entryFees.toDecimalString(),
      exitFees: totalExitFees.toDecimalString(),
      realizedNetPnl: realizedNet.toDecimalString(),
      realizedNetPnlPct: realizedNetPct.toDecimalString(4),
      outcome,
      exitReason: input.exitReason,
      openedAt: livePosition.openedAt,
      closedAt,
      entryDecisionChainId: livePosition.entryDecisionChainId ?? null,
      finalExitDecisionChainId: intent.decisionChainId ?? null,
      entryOrderIntentId: livePosition.entryOrderIntentId ?? null,
      finalExitOrderIntentId: input.intentId,
    });

    await updateOrderIntentTx(tx, input.intentId, { state: thisIntentEndState });

    return {
      kind: isDustClosed ? 'dust_closed' : 'closed',
      roundTripId,
      outcome,
      residualBaseSize: dustResidualClamped.toDecimalString(8),
    };
  });
}

// (drizzle-orm helper re-exports so scanner/reconciler don't need to import
// from drizzle-orm directly for the fencing max lookups)
export { and, eq, gt, ne, or };
