import { beforeEach, describe, expect, it } from 'vitest';
import { Money } from '@horizon/shared';
import { and, eq } from 'drizzle-orm';
import { resetDatabase } from './setup/db';

import { db } from '../src/db';
import {
  cashLedger,
  fills as fillsTable,
  orderIntents,
  positions,
  roundTrips,
} from '../src/db/schema';
import {
  applyEntryEconomicStateTx,
  applyExitEconomicStateTx,
  FencingViolation,
  type ApplyEntryInput,
  type ApplyExitInput,
  type NormalizedFill,
} from '../src/db/tx';
import {
  ensureInitialFund,
  findOrderIntentByClientOrderId,
  insertOrderIntent,
  updateBotConfig,
  type NewOrderIntent,
} from '../src/db/queries';
import type { PositionRow } from '../src/db/schema';

/**
 * Phase 1.1.a-FIX §F + §H — direct tests for the atomic economic-state
 * transaction boundary. These exercise the internals rather than going through
 * the executor so we can:
 *   • force a throw at any stage via `__testHook` and verify the FULL
 *     transaction rolls back (no partial writes anywhere).
 *   • replay the SAME atomic function after a rollback and confirm it
 *     completes exactly-once (fill dedupe by exchangeFillId, ledger dedupe by
 *     idempotencyKey, position/round-trip guarded by existing-check).
 *   • drive fencing violations directly by seeding a newer generation and
 *     confirming the stale worker's commit throws FencingViolation.
 *
 * No exchange contact: these tests never call createOrder / listFillsForOrder.
 * DRY_RUN and ORDER_SUBMISSION_ENABLED remain at their env defaults.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let __seq = 900_000;
const nextIdSuffix = () => (__seq++).toString();

async function makeEntryIntent(overrides: Partial<NewOrderIntent> = {}): Promise<number> {
  const clientOrderId = `test-entry-${nextIdSuffix()}`;
  return insertOrderIntent({
    clientOrderId,
    productId: 'AAVE-USD',
    token: 'AAVE',
    side: 'BUY',
    orderType: 'market_ioc',
    quoteSize: '100.00000000',
    mode: 'macro',
    purpose: 'entry',
    state: 'submitted',
    dryRun: true,
    ...overrides,
  });
}

async function makeExitIntent(
  positionId: number,
  overrides: Partial<NewOrderIntent> = {},
): Promise<number> {
  const clientOrderId = `test-exit-${nextIdSuffix()}`;
  return insertOrderIntent({
    clientOrderId,
    productId: 'AAVE-USD',
    token: 'AAVE',
    side: 'SELL',
    orderType: 'market_ioc',
    baseSize: '1.00000000',
    mode: 'macro',
    purpose: 'manual_exit',
    positionId,
    attemptGeneration: 1,
    state: 'submitted',
    dryRun: true,
    ...overrides,
  });
}

async function insertRawPosition(overrides: Partial<PositionRow> = {}): Promise<PositionRow> {
  const [{ insertId }] = (await db
    .insert(positions)
    .values({
      token: overrides.token ?? 'AAVE',
      mode: overrides.mode ?? 'macro',
      avgEntryPrice: overrides.avgEntryPrice ?? '100.00000000',
      filledQuantity: overrides.filledQuantity ?? '1.00000000',
      entryFees: overrides.entryFees ?? '0.60000000',
      entryQuoteSpent: overrides.entryQuoteSpent ?? '100.00000000',
      allocationPct: overrides.allocationPct ?? '5.00',
      takeProfitPrice: overrides.takeProfitPrice ?? '108.00000000',
      stopLossPrice: overrides.stopLossPrice ?? '97.00000000',
      takeProfitPct: overrides.takeProfitPct ?? '8.00',
      stopLossPct: overrides.stopLossPct ?? '3.00',
      entryOrderIntentId: overrides.entryOrderIntentId ?? 1,
      protectionMode: overrides.protectionMode ?? 'polling_fallback',
      lifecycleState: overrides.lifecycleState ?? 'open',
      status: overrides.status ?? 'open',
    })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(positions).where(eq(positions.id, insertId)).limit(1);
  return row!;
}

function synthFill(index: number, side: 'BUY' | 'SELL', price = '100'): NormalizedFill {
  return {
    exchangeFillId: `synth-${side.toLowerCase()}-${nextIdSuffix()}-${index}`,
    exchangeOrderId: `synth-order-${side.toLowerCase()}-${nextIdSuffix()}`,
    token: 'AAVE',
    side,
    filledSize: '0.50000000',
    fillPrice: price,
    fee: '0.30000000',
    feeCurrency: 'USD',
    tradeTime: new Date('2026-01-15T00:00:00Z'),
    rawResponse: '{"test":true}',
  };
}

function entryInput(intentId: number, hook?: ApplyEntryInput['__testHook']): ApplyEntryInput {
  return {
    intentId,
    fillsToApply: [synthFill(1, 'BUY'), synthFill(2, 'BUY')],
    mode: 'macro',
    takeProfitPct: 8,
    stopLossPct: 3,
    allocationPct: 5,
    claudeReason: 'test',
    claudeModel: 'test-model',
    claudeConfidence: 0.8,
    strategyVersion: 'test',
    protectionMode: 'polling_fallback',
    dryRun: true,
    intentEndState: 'filled',
    __testHook: hook,
  };
}

function exitInput(
  intentId: number,
  position: PositionRow,
  hook?: ApplyExitInput['__testHook'],
): ApplyExitInput {
  return {
    intentId,
    position,
    fillsToApply: [synthFill(1, 'SELL', '105'), synthFill(2, 'SELL', '105')],
    exitReason: 'manual',
    dryRun: true,
    __testHook: hook,
  };
}

async function ledgerRowsForIntent(intentId: number) {
  return db.select().from(cashLedger).where(eq(cashLedger.orderIntentId, intentId));
}

async function fillRowsForIntent(intentId: number) {
  return db.select().from(fillsTable).where(eq(fillsTable.orderIntentId, intentId));
}

async function positionsForIntent(intentId: number) {
  return db.select().from(positions).where(eq(positions.entryOrderIntentId, intentId));
}

async function roundTripsForPosition(positionId: number) {
  return db.select().from(roundTrips).where(eq(roundTrips.positionId, positionId));
}

async function reloadPosition(id: number): Promise<PositionRow> {
  const [row] = await db.select().from(positions).where(eq(positions.id, id)).limit(1);
  return row!;
}

beforeEach(async () => {
  await resetDatabase();
  await ensureInitialFund(true, 10_000);
  await updateBotConfig({ reconciliationStatus: 'ok' });
});

// ---------------------------------------------------------------------------
// §F/§D — ATOMIC ENTRY rollback tests
// ---------------------------------------------------------------------------

describe('§F applyEntryEconomicStateTx — rollback leaves ZERO partial state', () => {
  it('throws after_fills → no fills, no ledger, no position persist', async () => {
    const intentId = await makeEntryIntent();
    await expect(
      applyEntryEconomicStateTx(
        entryInput(intentId, (stage) => {
          if (stage === 'after_fills') throw new Error('injected: after_fills');
        }),
      ),
    ).rejects.toThrow(/after_fills/);

    // 1. no fills committed
    expect(await fillRowsForIntent(intentId)).toHaveLength(0);
    // 2. no ledger events committed
    expect(await ledgerRowsForIntent(intentId)).toHaveLength(0);
    // 3. no position row committed
    expect(await positionsForIntent(intentId)).toHaveLength(0);
    // 4. the intent itself did NOT advance to 'filled'
    const intent = (await db.select().from(orderIntents).where(eq(orderIntents.id, intentId)))[0]!;
    expect(intent.state).toBe('submitted');
    expect(intent.positionId).toBeNull();
  });

  it('throws after_ledger → no fills, no ledger, no position persist', async () => {
    const intentId = await makeEntryIntent();
    await expect(
      applyEntryEconomicStateTx(
        entryInput(intentId, (stage) => {
          if (stage === 'after_ledger') throw new Error('injected: after_ledger');
        }),
      ),
    ).rejects.toThrow(/after_ledger/);

    expect(await fillRowsForIntent(intentId)).toHaveLength(0);
    expect(await ledgerRowsForIntent(intentId)).toHaveLength(0);
    expect(await positionsForIntent(intentId)).toHaveLength(0);
    const intent = (await db.select().from(orderIntents).where(eq(orderIntents.id, intentId)))[0]!;
    expect(intent.state).toBe('submitted');
  });

  it('throws after_position → no fills, no ledger, no position persist', async () => {
    const intentId = await makeEntryIntent();
    await expect(
      applyEntryEconomicStateTx(
        entryInput(intentId, (stage) => {
          if (stage === 'after_position') throw new Error('injected: after_position');
        }),
      ),
    ).rejects.toThrow(/after_position/);

    // Because the transaction rolls back everything, even the position that
    // was successfully INSERTed inside the tx is gone.
    expect(await fillRowsForIntent(intentId)).toHaveLength(0);
    expect(await ledgerRowsForIntent(intentId)).toHaveLength(0);
    expect(await positionsForIntent(intentId)).toHaveLength(0);
    const intent = (await db.select().from(orderIntents).where(eq(orderIntents.id, intentId)))[0]!;
    expect(intent.state).toBe('submitted');
  });

  it('replay after rollback applies economic state EXACTLY ONCE', async () => {
    const intentId = await makeEntryIntent();
    const inputWithHook = entryInput(intentId, (stage) => {
      if (stage === 'after_ledger') throw new Error('injected: after_ledger');
    });

    // First attempt aborts mid-tx.
    await expect(applyEntryEconomicStateTx(inputWithHook)).rejects.toThrow();
    expect(await fillRowsForIntent(intentId)).toHaveLength(0);
    expect(await ledgerRowsForIntent(intentId)).toHaveLength(0);
    expect(await positionsForIntent(intentId)).toHaveLength(0);

    // Second attempt succeeds — same normalized fills (same exchangeFillId).
    const inputRetry = { ...inputWithHook, __testHook: undefined };
    const result = await applyEntryEconomicStateTx(inputRetry);
    expect(result.kind).toBe('opened');
    const [pos] = await positionsForIntent(intentId);
    expect(pos.id).toBe(result.positionId);

    const fills1 = await fillRowsForIntent(intentId);
    expect(fills1).toHaveLength(2);
    const ledger1 = await ledgerRowsForIntent(intentId);
    // 2 fills × (buy_cost + buy_fee) = 4 ledger rows
    expect(ledger1).toHaveLength(4);

    // Third attempt: replay AGAIN — must be a no-op (guarded by existing
    // position-by-intent check). No duplicated fills/ledger/position.
    const replay = await applyEntryEconomicStateTx(inputRetry);
    expect(replay.positionId).toBe(result.positionId);
    expect(await fillRowsForIntent(intentId)).toHaveLength(2);
    expect(await ledgerRowsForIntent(intentId)).toHaveLength(4);
    expect(await positionsForIntent(intentId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §F/§D — ATOMIC EXIT rollback tests
// ---------------------------------------------------------------------------

describe('§F applyExitEconomicStateTx — rollback leaves ZERO partial state', () => {
  it('throws after_fills → no exit fills, no sell ledger, no round-trip, position stays open', async () => {
    const position = await insertRawPosition();
    const intentId = await makeExitIntent(position.id);

    await expect(
      applyExitEconomicStateTx(
        exitInput(intentId, position, (stage) => {
          if (stage === 'after_fills') throw new Error('injected: after_fills');
        }),
      ),
    ).rejects.toThrow(/after_fills/);

    expect(await fillRowsForIntent(intentId)).toHaveLength(0);
    expect(await ledgerRowsForIntent(intentId)).toHaveLength(0);
    expect(await roundTripsForPosition(position.id)).toHaveLength(0);
    const afterPos = await reloadPosition(position.id);
    expect(afterPos.status).toBe('open');
    expect(afterPos.lifecycleState).toBe('open');
    expect(afterPos.closedAt).toBeNull();
  });

  it('throws after_ledger → no fills, no ledger, no round-trip, position open', async () => {
    const position = await insertRawPosition();
    const intentId = await makeExitIntent(position.id);

    await expect(
      applyExitEconomicStateTx(
        exitInput(intentId, position, (stage) => {
          if (stage === 'after_ledger') throw new Error('injected: after_ledger');
        }),
      ),
    ).rejects.toThrow(/after_ledger/);

    expect(await fillRowsForIntent(intentId)).toHaveLength(0);
    expect(await ledgerRowsForIntent(intentId)).toHaveLength(0);
    expect(await roundTripsForPosition(position.id)).toHaveLength(0);
    const afterPos = await reloadPosition(position.id);
    expect(afterPos.status).toBe('open');
  });

  it('throws after_position (markPositionClosed done) → all rolled back, position open', async () => {
    const position = await insertRawPosition();
    const intentId = await makeExitIntent(position.id);

    await expect(
      applyExitEconomicStateTx(
        exitInput(intentId, position, (stage) => {
          if (stage === 'after_position') throw new Error('injected: after_position');
        }),
      ),
    ).rejects.toThrow(/after_position/);

    // Even though markPositionClosedTx ran BEFORE the hook, the throw rolls
    // back the whole tx. The position must still be open.
    expect(await fillRowsForIntent(intentId)).toHaveLength(0);
    expect(await ledgerRowsForIntent(intentId)).toHaveLength(0);
    expect(await roundTripsForPosition(position.id)).toHaveLength(0);
    const afterPos = await reloadPosition(position.id);
    expect(afterPos.status).toBe('open');
    expect(afterPos.lifecycleState).toBe('open');
    expect(afterPos.closedAt).toBeNull();
  });

  it('replay after rollback closes exactly once (round_trips.positionId unique)', async () => {
    const position = await insertRawPosition();
    const intentId = await makeExitIntent(position.id);

    // First attempt aborts.
    await expect(
      applyExitEconomicStateTx(
        exitInput(intentId, position, (stage) => {
          if (stage === 'after_ledger') throw new Error('injected: after_ledger');
        }),
      ),
    ).rejects.toThrow();
    expect(await roundTripsForPosition(position.id)).toHaveLength(0);
    const stillOpen = await reloadPosition(position.id);
    expect(stillOpen.status).toBe('open');

    // Second attempt with the same fills succeeds.
    const clean = exitInput(intentId, position);
    const result = await applyExitEconomicStateTx(clean);
    expect(result.kind).toBe('closed');
    const closed = await reloadPosition(position.id);
    expect(closed.status).toBe('closed');
    const rts = await roundTripsForPosition(position.id);
    expect(rts).toHaveLength(1);
    expect(rts[0].id).toBe(result.roundTripId);

    // Third attempt — replay after successful close. Idempotent no-op.
    const replay = await applyExitEconomicStateTx(clean);
    expect(replay.roundTripId).toBe(result.roundTripId);
    expect(await roundTripsForPosition(position.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §H — DURABLE fencing verified INSIDE the tx
// ---------------------------------------------------------------------------

describe('§H fencing enforced inside the atomic economic transaction', () => {
  it('null fenceGeneration on intent is treated as always-valid (test path)', async () => {
    const intentId = await makeEntryIntent({ fenceGeneration: null });
    const result = await applyEntryEconomicStateTx(entryInput(intentId));
    expect(result.kind).toBe('opened');
  });

  it('stale worker (older fenceGeneration than peer) is REJECTED with FencingViolation', async () => {
    // Peer already inserted a NEWER intent for this same token+purpose.
    await makeEntryIntent({
      fenceGeneration: 7,
      clientOrderId: `peer-newer-${nextIdSuffix()}`,
    });
    // Our stale worker's intent carries an OLDER generation.
    const staleIntentId = await makeEntryIntent({ fenceGeneration: 3 });

    await expect(applyEntryEconomicStateTx(entryInput(staleIntentId))).rejects.toBeInstanceOf(
      FencingViolation,
    );

    // Nothing partial persists.
    expect(await fillRowsForIntent(staleIntentId)).toHaveLength(0);
    expect(await ledgerRowsForIntent(staleIntentId)).toHaveLength(0);
    expect(await positionsForIntent(staleIntentId)).toHaveLength(0);
  });

  it('equal-generation intents are permitted (only STRICTLY newer triggers the fence)', async () => {
    // Two intents at the same generation — the current worker is authoritative
    // for its own generation.
    const intentId = await makeEntryIntent({ fenceGeneration: 5 });
    const result = await applyEntryEconomicStateTx(entryInput(intentId));
    expect(result.kind).toBe('opened');
  });

  it('lease valid at precheck but peer commits a newer intent BEFORE our tx runs → we abort', async () => {
    // This is the exact race the durable fencing is meant to catch.
    // Timeline:
    //   t0  worker A acquires lease with fenceGeneration=5, checks isValid() → true
    //   t1  worker B acquires the SAME lease after A's TTL, fenceGeneration=9
    //   t2  worker B commits an intent with fenceGeneration=9
    //   t3  worker A (still holding stale in-memory lease state) tries to apply
    //       the entry economic transaction with fenceGeneration=5
    //   t4  verifyFencingTx sees a newer generation exists → FencingViolation
    const workerAIntent = await makeEntryIntent({ fenceGeneration: 5 });

    // Simulate worker B winning the race and creating its own intent first.
    await makeEntryIntent({
      fenceGeneration: 9,
      clientOrderId: `worker-b-${nextIdSuffix()}`,
    });

    // Worker A's atomic commit must be rejected — its lease is dead.
    let caught: unknown;
    try {
      await applyEntryEconomicStateTx(entryInput(workerAIntent));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FencingViolation);
    const fv = caught as FencingViolation;
    expect(fv.ourGeneration).toBe(5);
    expect(fv.latestGeneration).toBeGreaterThanOrEqual(9);
  });

  it('exit intent: stale worker with older generation is also rejected', async () => {
    const position = await insertRawPosition();

    // Peer has already committed a NEWER exit intent at gen=12 for a different
    // attempt generation (so the exit-attempt uniqueness doesn't fire first).
    await makeExitIntent(position.id, {
      fenceGeneration: 12,
      attemptGeneration: 2,
      clientOrderId: `peer-exit-${nextIdSuffix()}`,
    });

    const staleExitId = await makeExitIntent(position.id, {
      fenceGeneration: 4,
      attemptGeneration: 1,
    });

    await expect(
      applyExitEconomicStateTx(exitInput(staleExitId, position)),
    ).rejects.toBeInstanceOf(FencingViolation);

    // Position stayed open. No exit fills. No round-trip.
    expect(await fillRowsForIntent(staleExitId)).toHaveLength(0);
    expect(await ledgerRowsForIntent(staleExitId)).toHaveLength(0);
    expect(await roundTripsForPosition(position.id)).toHaveLength(0);
    const stillOpen = await reloadPosition(position.id);
    expect(stillOpen.status).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// §B — race-safe exit attempt generation (UNIQUE (positionId, purpose, gen))
// ---------------------------------------------------------------------------

describe('§B UNIQUE (positionId, purpose, attemptGeneration) prevents double allocation', () => {
  it('two workers picking the same generation for the same position+purpose collide at the DB', async () => {
    const position = await insertRawPosition();
    // Worker A allocates gen=1 for manual_exit.
    await makeExitIntent(position.id, {
      attemptGeneration: 1,
      clientOrderId: `worker-a-gen1-${nextIdSuffix()}`,
    });
    // Worker B tries to allocate the same gen=1 — must fail on the UNIQUE.
    let dupErr: unknown;
    try {
      await makeExitIntent(position.id, {
        attemptGeneration: 1,
        clientOrderId: `worker-b-gen1-${nextIdSuffix()}`,
      });
    } catch (err) {
      dupErr = err;
    }
    const { isDuplicateKeyError } = await import('../src/db/tx');
    expect(isDuplicateKeyError(dupErr)).toBe(true);
  });

  it('a fresh generation (n+1) after a prior attempt is accepted', async () => {
    const position = await insertRawPosition();
    await makeExitIntent(position.id, { attemptGeneration: 1 });
    // n+1 must work.
    const secondId = await makeExitIntent(position.id, { attemptGeneration: 2 });
    expect(secondId).toBeGreaterThan(0);
  });
});

// Suppress unused-import warnings.
void and;
void findOrderIntentByClientOrderId;
void Money;
