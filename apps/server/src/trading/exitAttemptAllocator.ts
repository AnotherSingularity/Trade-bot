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

// ---------------------------------------------------------------------------
// Gate 3A §G — configuration verification on reuse
// ---------------------------------------------------------------------------

/**
 * When a duplicate-key error is raised on the (positionId, purpose,
 * attemptGeneration) UNIQUE index, the caller may re-read the "winning"
 * intent — but MUST NOT blindly adopt it as its own. The winner may have
 * been created with a different baseSize / purpose / positionId, in which
 * case it is not the same economic action and the caller must fail.
 *
 * Returns a verdict:
 *   - `{ ok: true }` — the persisted intent matches the intended config.
 *   - `{ ok: false, mismatches }` — the persisted intent describes a
 *     DIFFERENT economic action. The caller must abort and let a fresh
 *     allocation happen.
 */
export interface IntendedExitConfig {
  positionId: number;
  purpose: ExitPurpose;
  side: 'SELL';
  baseSize?: string; // decimal string
  orderType: OrderIntentRow['orderType'];
  mode: OrderIntentRow['mode'];
}

export type ConfigMatchVerdict =
  | { ok: true }
  | { ok: false; mismatches: string[] };

export function verifyExitConfigMatches(
  intent: OrderIntentRow,
  intended: IntendedExitConfig,
): ConfigMatchVerdict {
  const mismatches: string[] = [];
  if (intent.positionId !== intended.positionId) {
    mismatches.push(`positionId: intent=${intent.positionId} intended=${intended.positionId}`);
  }
  if (intent.purpose !== intended.purpose) {
    mismatches.push(`purpose: intent=${intent.purpose} intended=${intended.purpose}`);
  }
  if (intent.side !== 'SELL') {
    mismatches.push(`side: intent=${intent.side} intended=SELL`);
  }
  if (intent.orderType !== intended.orderType) {
    mismatches.push(`orderType: intent=${intent.orderType} intended=${intended.orderType}`);
  }
  if (intent.mode !== intended.mode) {
    mismatches.push(`mode: intent=${intent.mode} intended=${intended.mode}`);
  }
  if (intended.baseSize && intent.baseSize && intent.baseSize !== intended.baseSize) {
    // Allow small rounding drift equivalent to one base_increment; strict
    // comparison here matches the exit-attempt UNIQUE contract that says
    // "same generation → same economic action".
    mismatches.push(`baseSize: intent=${intent.baseSize} intended=${intended.baseSize}`);
  }
  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
}
