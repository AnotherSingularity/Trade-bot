import { eq } from 'drizzle-orm';
import { Money } from '@horizon/shared';
import { db } from './index';
import { cashLedger, fills, orderIntents, positions, roundTrips } from './schema';
import type {
  CashLedgerInsert,
  FillInsert,
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
