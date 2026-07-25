import { and, eq, sql } from 'drizzle-orm';
import { orderIntents } from '../db/schema';
import type { OrderIntentRow } from '../db/schema';
import { withTransaction, isDuplicateKeyError } from '../db/tx';

/**
 * Transactional exit-attempt allocation (Phase 1.1.b §F).
 *
 * The UNIQUE (positionId, purpose, attemptGeneration) constraint added in
 * 0004 is the LAST line of defence. The allocator here is the first: it
 * decides — under a row lock on the position — whether the caller should
 * reuse an existing unresolved exit intent for this (position, purpose) or
 * start a new attempt generation.
 *
 * Rules:
 *   1. Lock the position row (SELECT ... FOR UPDATE).
 *   2. Look for the newest exit intent for (positionId, purpose).
 *   3. If it exists AND is in a non-terminal state → REUSE it.
 *      A caller retrying after a timeout must reuse the same clientOrderId.
 *   4. If it exists but is terminal → allocate the next generation.
 *   5. If no prior attempt → generation 1.
 *
 * `TERMINAL_STATES` mirrors the intent state machine's terminal set.
 * `unknown` is intentionally NOT terminal — a lost response is still
 * ambiguous; we must not start a new attempt on top.
 *
 * The row-lock on positions ensures two concurrent workers serialize:
 *   • Worker B waits for Worker A to COMMIT.
 *   • Whichever committed first defines the current generation.
 *   • The other worker's re-read reflects the new state and either
 *     REUSEs A's intent (if A is still non-terminal) or bumps to gen+1.
 */

const TERMINAL_STATES: readonly OrderIntentRow['state'][] = [
  'filled',
  'rejected',
  'canceled',
  'failed',
];

export type ExitPurpose = Extract<
  OrderIntentRow['purpose'],
  'take_profit' | 'stop_loss' | 'manual_exit' | 'emergency_exit'
>;

export interface ExitAllocation {
  action: 'reuse' | 'new';
  attemptGeneration: number;
  /** When reusing: the existing intent's id. When new: undefined until persisted. */
  reusedIntentId?: number;
  reusedIntent?: OrderIntentRow;
}

/**
 * Allocate the next exit attempt for a position + purpose. Transactional.
 *
 * Returns `{ action: 'reuse', reusedIntent }` when a non-terminal exit intent
 * already exists — callers must call the exchange (or replay reconciliation)
 * with the reused intent's clientOrderId; DO NOT create a new order.
 *
 * Returns `{ action: 'new', attemptGeneration }` when no prior attempt is
 * outstanding — callers should proceed to persist a new intent under
 * that generation.
 */
export async function allocateExitAttempt(
  positionId: number,
  purpose: ExitPurpose,
): Promise<ExitAllocation> {
  return withTransaction(async (tx) => {
    // 1. Lock the position row. We only need the id, but the FOR UPDATE is
    //    what serializes concurrent allocators.
    const posRows = (await tx.execute(sql`
      SELECT id FROM positions WHERE id = ${positionId} FOR UPDATE
    `)) as unknown as [{ id: number }[], unknown];
    const posArr = Array.isArray(posRows[0]) ? posRows[0] : (posRows as unknown as { id: number }[]);
    if (!posArr[0]) {
      throw new Error(`allocateExitAttempt: position ${positionId} not found`);
    }

    // 2. Find the highest-generation existing exit intent for this (pos, purpose).
    const existingRows = await tx
      .select()
      .from(orderIntents)
      .where(and(eq(orderIntents.positionId, positionId), eq(orderIntents.purpose, purpose)))
      .orderBy(sql`${orderIntents.attemptGeneration} DESC`)
      .limit(1);
    const existing = existingRows[0];

    if (existing) {
      // Non-terminal → REUSE. Same clientOrderId will be reused by the caller.
      if (!TERMINAL_STATES.includes(existing.state)) {
        return {
          action: 'reuse',
          attemptGeneration: existing.attemptGeneration ?? 1,
          reusedIntentId: existing.id,
          reusedIntent: existing,
        };
      }
      // Prior attempt terminal → allocate n+1.
      return {
        action: 'new',
        attemptGeneration: (existing.attemptGeneration ?? 1) + 1,
      };
    }

    // No prior attempt.
    return { action: 'new', attemptGeneration: 1 };
  });
}

/**
 * Guards `insertOrderIntent` for exit intents against the UNIQUE
 * (positionId, purpose, attemptGeneration) constraint. The allocator above
 * pre-checks; this is defence-in-depth for the case where two workers slipped
 * past the position lock (e.g. against different DB replicas). Callers pass a
 * function that does the actual insert and re-lookup logic.
 */
export function isExitAttemptCollision(err: unknown): boolean {
  return isDuplicateKeyError(err);
}
