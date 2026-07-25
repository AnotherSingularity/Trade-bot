import { eq, sql } from 'drizzle-orm';
import { db } from './index';
import { executionFences } from './schema';

/**
 * Authoritative database fencing (Phase 1.1.b §A).
 *
 * The Redis lease decides WHO holds the resource in real time (fast leader
 * election + TTL). But Redis ownership alone must NEVER authorize a database
 * commit — the network can lie in both directions. The `execution_fences`
 * table is the durable, transactional source of truth for the current
 * generation. Every acquire atomically bumps `currentGeneration`; every
 * economic mutation transaction locks the matching row (`SELECT ... FOR UPDATE`)
 * and rejects any writer whose supplied generation is older than the current.
 *
 * Ordering rules:
 *   1. Acquire → bump the DB fence, receive newGeneration.
 *   2. Persist any subsequent order_intents with fenceGeneration=newGeneration
 *      and fenceResourceKey=resourceKey.
 *   3. Every applyEntry/ExitEconomicStateTx call takes the row lock inside
 *      its transaction and throws FencingViolation if the intent's generation
 *      is older than the DB's currentGeneration.
 *
 * Because the SELECT ... FOR UPDATE is inside the same transaction as the
 * mutations, a concurrent acquire that happens AFTER our lock returns must
 * wait for our commit; a concurrent acquire that got there FIRST already
 * bumped currentGeneration past ours, so the read sees a strictly newer
 * generation and we abort.
 */

export interface ExecutionFenceAcquireResult {
  resourceKey: string;
  newGeneration: number;
  ownerId: string;
}

/**
 * Atomically bumps the fence for `resourceKey` and marks the row `active`
 * with the given `ownerId`. Returns the new generation.
 *
 * Uses MySQL's `INSERT ... ON DUPLICATE KEY UPDATE` with an expression
 * bump so the increment is a single round-trip and cannot race.
 *
 * The initial insert stamps `acquiredAt` at INSERT time; subsequent updates
 * only refresh `renewedAt` + `ownerId` + `state='active'`.
 */
export async function bumpExecutionFence(
  resourceKey: string,
  ownerId: string,
): Promise<ExecutionFenceAcquireResult> {
  // MySQL: LAST_INSERT_ID(expr) sets the session's last-insert-id to expr
  // and returns it, so we can read back the value from the same round-trip.
  await db.execute(sql`
    INSERT INTO execution_fences (resourceKey, currentGeneration, ownerId, acquiredAt, renewedAt, state)
    VALUES (${resourceKey}, LAST_INSERT_ID(1), ${ownerId}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'active')
    ON DUPLICATE KEY UPDATE
      currentGeneration = LAST_INSERT_ID(currentGeneration + 1),
      ownerId = VALUES(ownerId),
      renewedAt = CURRENT_TIMESTAMP,
      state = 'active'
  `);
  const rawResult = (await db.execute(
    sql`SELECT LAST_INSERT_ID() AS gen`,
  )) as unknown as [{ gen: number | string | bigint }[], unknown];
  const genRow = Array.isArray(rawResult[0]) ? rawResult[0][0] : (rawResult as unknown as { gen: number | string | bigint }[])[0];
  const newGeneration = Number(genRow?.gen ?? 0);
  if (!Number.isFinite(newGeneration) || newGeneration <= 0) {
    // Should never happen; safety-fallback: read the row directly.
    const rows = await db
      .select()
      .from(executionFences)
      .where(eq(executionFences.resourceKey, resourceKey))
      .limit(1);
    const gen2 = rows[0]?.currentGeneration;
    if (!gen2) throw new Error(`bumpExecutionFence: fence for ${resourceKey} missing after bump`);
    return { resourceKey, newGeneration: gen2, ownerId };
  }
  return { resourceKey, newGeneration, ownerId };
}

/**
 * Marks the fence row as released (best-effort — informational only).
 * The generation is NOT decremented — that would allow a stale worker to
 * reappear as authoritative.
 */
export async function releaseExecutionFence(resourceKey: string, ownerId: string): Promise<void> {
  await db.execute(sql`
    UPDATE execution_fences
    SET state = 'released', renewedAt = CURRENT_TIMESTAMP
    WHERE resourceKey = ${resourceKey} AND ownerId = ${ownerId} AND state = 'active'
  `);
}

/**
 * Read-only accessor for the current generation. Used by tests and
 * diagnostics. Returns 0 when no row exists yet.
 */
export async function readExecutionFenceGeneration(resourceKey: string): Promise<number> {
  const rows = await db
    .select({ gen: executionFences.currentGeneration })
    .from(executionFences)
    .where(eq(executionFences.resourceKey, resourceKey))
    .limit(1);
  return rows[0]?.gen ?? 0;
}
