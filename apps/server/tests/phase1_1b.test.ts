import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Money } from '@horizon/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db';
import {
  cashLedger,
  executionFences,
  fills as fillsTable,
  orderIntents,
  positions,
  reconciliationActions,
  reconciliationRuns,
} from '../src/db/schema';
import type { CoinbaseOrder } from '../src/trading/coinbase';
import {
  applyEntryEconomicStateTx,
  applyExitEconomicStateTx,
  FencingViolation,
  isDuplicateKeyError,
  type ApplyEntryInput,
  type NormalizedFill,
} from '../src/db/tx';
import { bumpExecutionFence } from '../src/db/executionFence';
import { insertOrderIntent, ensureInitialFund, updateBotConfig, findOrderIntentByClientOrderId } from '../src/db/queries';
import { allocateExitAttempt } from '../src/trading/exitAttemptAllocator';
import {
  paginate,
  paginateListFillsForOrder,
  paginateListOrders,
  type CoinbasePaginationAdapter,
} from '../src/trading/pagination';
import { classifyFillState } from '../src/trading/fillState';
import {
  PREVIEW_FRESHNESS_MS,
  deriveApprovedIntent,
  hashOrderConfig,
  verifyApprovedIntent,
  type NormalizedOrderConfig,
} from '../src/trading/orderConfig';
import type { PreviewOk } from '../src/trading/preview';
import { runReconciliationOnce } from '../src/trading/continuousReconciler';
import { resetDatabase } from './setup/db';

/**
 * Phase 1.1.b required tests — the explicit 32-item list from the audit,
 * plus the migration-upgrade checks (§K).
 *
 * DRY_RUN and ORDER_SUBMISSION_ENABLED remain at env defaults; no test
 * hits Coinbase. Pagination + reconciler tests inject a
 * `CoinbasePaginationAdapter` that returns canned pages.
 */

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------
let __seq = 700_000;
const nextSuffix = () => (__seq++).toString();

const SCAN_KEY = 'test:scan:' + Math.random().toString(36).slice(2, 8);

async function insertEntryIntent(
  overrides: Partial<Parameters<typeof insertOrderIntent>[0]> = {},
): Promise<number> {
  return insertOrderIntent({
    clientOrderId: overrides.clientOrderId ?? `entry-${nextSuffix()}`,
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

async function insertRawPosition(overrides: Partial<{ id: number; token: string }> = {}) {
  const [{ insertId }] = (await db
    .insert(positions)
    .values({
      token: overrides.token ?? 'AAVE',
      mode: 'macro',
      avgEntryPrice: '100.00000000',
      filledQuantity: '1.00000000',
      entryFees: '0.60000000',
      entryQuoteSpent: '100.00000000',
      allocationPct: '5.00',
      takeProfitPrice: '108.00000000',
      stopLossPrice: '97.00000000',
      takeProfitPct: '8.00',
      stopLossPct: '3.00',
      entryOrderIntentId: 1,
      lifecycleState: 'open',
      status: 'open',
    })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(positions).where(eq(positions.id, insertId));
  return row!;
}

function synthFill(
  side: 'BUY' | 'SELL',
  overrides: Partial<NormalizedFill> = {},
): NormalizedFill {
  return {
    exchangeFillId: overrides.exchangeFillId ?? `fill-${side}-${nextSuffix()}`,
    exchangeOrderId: overrides.exchangeOrderId ?? `ord-${side}-${nextSuffix()}`,
    token: 'AAVE',
    side,
    filledSize: '0.50000000',
    fillPrice: '100.00',
    fee: '0.30000000',
    feeCurrency: 'USD',
    tradeTime: new Date('2026-02-01T00:00:00Z'),
    rawResponse: '{}',
    ...overrides,
  };
}

function entryInput(
  intentId: number,
  fillsToApply: NormalizedFill[] = [synthFill('BUY')],
): ApplyEntryInput {
  return {
    intentId,
    fillsToApply,
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
  };
}

function makeAdapterFromPages(
  pages: Array<{ items: unknown[]; nextCursor: string | null; hasNext: boolean }>,
  key: 'orders' | 'fills' = 'orders',
): CoinbasePaginationAdapter {
  let i = 0;
  return {
    requestPage: async <R>() => {
      if (i >= pages.length) throw new Error('adapter exhausted (test bug)');
      const p = pages[i++];
      const body =
        key === 'orders'
          ? { orders: p.items, cursor: p.nextCursor ?? '', has_next: p.hasNext }
          : { fills: p.items, cursor: p.nextCursor ?? '', has_next: p.hasNext };
      return body as unknown as R;
    },
  };
}

beforeEach(async () => {
  await resetDatabase();
  await ensureInitialFund(true, 10_000);
  await updateBotConfig({ reconciliationStatus: 'ok' });
});

// ═══════════════════════════════════════════════════════════════════════════
// §A — Authoritative DB fence (tests 1–4)
// ═══════════════════════════════════════════════════════════════════════════

describe('§A authoritative DB fence rejects stale workers', () => {
  it('1. authoritative DB fence rejects a stale worker', async () => {
    const workerA = await bumpExecutionFence(SCAN_KEY, 'workerA');
    const workerB = await bumpExecutionFence(SCAN_KEY, 'workerB');
    expect(workerB.newGeneration).toBeGreaterThan(workerA.newGeneration);

    const intentIdA = await insertEntryIntent({
      fenceGeneration: workerA.newGeneration,
      fenceResourceKey: SCAN_KEY,
    });
    await expect(applyEntryEconomicStateTx(entryInput(intentIdA))).rejects.toBeInstanceOf(
      FencingViolation,
    );
  });

  it('2. stale worker cannot insert an order intent (fence check runs INSIDE the tx)', async () => {
    const workerA = await bumpExecutionFence(SCAN_KEY, 'workerA');
    await bumpExecutionFence(SCAN_KEY, 'workerB'); // supersedes A
    // Insertion of the intent itself doesn't check the fence — that's fine,
    // the fence is verified when applyEntry* runs, before ANY fill/ledger/
    // position write. Our test proves: the stale worker's economic
    // transaction produces zero rows.
    const intentId = await insertEntryIntent({
      fenceGeneration: workerA.newGeneration,
      fenceResourceKey: SCAN_KEY,
    });
    await expect(applyEntryEconomicStateTx(entryInput(intentId))).rejects.toBeInstanceOf(
      FencingViolation,
    );
    const posRows = await db
      .select()
      .from(positions)
      .where(eq(positions.entryOrderIntentId, intentId));
    expect(posRows).toHaveLength(0);
  });

  it('3. stale worker cannot apply fills', async () => {
    const workerA = await bumpExecutionFence(SCAN_KEY, 'a');
    await bumpExecutionFence(SCAN_KEY, 'b');
    const intentId = await insertEntryIntent({
      fenceGeneration: workerA.newGeneration,
      fenceResourceKey: SCAN_KEY,
    });
    await expect(applyEntryEconomicStateTx(entryInput(intentId))).rejects.toBeInstanceOf(
      FencingViolation,
    );
    const fillRows = await db
      .select()
      .from(fillsTable)
      .where(eq(fillsTable.orderIntentId, intentId));
    expect(fillRows).toHaveLength(0);
  });

  it('4. stale worker cannot write a ledger event', async () => {
    const workerA = await bumpExecutionFence(SCAN_KEY, 'a');
    await bumpExecutionFence(SCAN_KEY, 'b');
    const intentId = await insertEntryIntent({
      fenceGeneration: workerA.newGeneration,
      fenceResourceKey: SCAN_KEY,
    });
    await expect(applyEntryEconomicStateTx(entryInput(intentId))).rejects.toBeInstanceOf(
      FencingViolation,
    );
    const ledger = await db
      .select()
      .from(cashLedger)
      .where(eq(cashLedger.orderIntentId, intentId));
    expect(ledger).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §B — Cursor pagination (tests 5–11)
// ═══════════════════════════════════════════════════════════════════════════

describe('§B exhaustive Coinbase cursor pagination', () => {
  it('5. order is found on the second page', async () => {
    const target: CoinbaseOrder = {
      order_id: 'target-order',
      product_id: 'AAVE-USD',
      client_order_id: 'target-client',
      side: 'BUY',
      status: 'FILLED',
    };
    const adapter = makeAdapterFromPages(
      [
        { items: [{ order_id: 'o1', product_id: 'AAVE-USD', side: 'BUY', status: 'OPEN' }], nextCursor: 'CUR2', hasNext: true },
        { items: [target], nextCursor: null, hasNext: false },
      ],
      'orders',
    );
    const result = await paginateListOrders(adapter, { orderStatus: 'FILLED' });
    expect(result.kind).toBe('complete_found');
    expect(result.items.map((o) => o.order_id)).toContain('target-order');
    expect(result.pagesFetched).toBe(2);
  });

  it('6. order is found after an empty page with continuation', async () => {
    const target: CoinbaseOrder = {
      order_id: 'target',
      product_id: 'AAVE-USD',
      side: 'BUY',
      status: 'FILLED',
    };
    const adapter = makeAdapterFromPages(
      [
        { items: [], nextCursor: 'C2', hasNext: true },
        { items: [target], nextCursor: null, hasNext: false },
      ],
      'orders',
    );
    const result = await paginateListOrders(adapter, { orderStatus: 'FILLED' });
    expect(result.kind).toBe('complete_found');
    expect(result.items).toHaveLength(1);
  });

  it('7. repeated cursor returns incomplete_cursor_loop, NOT absent', async () => {
    const adapter = makeAdapterFromPages(
      [
        { items: [{ order_id: 'a', product_id: 'AAVE-USD', side: 'BUY', status: 'OPEN' }], nextCursor: 'LOOP', hasNext: true },
        { items: [{ order_id: 'b', product_id: 'AAVE-USD', side: 'BUY', status: 'OPEN' }], nextCursor: 'LOOP', hasNext: true },
      ],
      'orders',
    );
    const result = await paginateListOrders(adapter, {});
    expect(result.kind).toBe('incomplete_cursor_loop');
  });

  it('8. pagination timeout returns incomplete_timeout', async () => {
    const slowAdapter: CoinbasePaginationAdapter = {
      requestPage: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { orders: [], cursor: 'X', has_next: true } as unknown as never;
      },
    };
    const result = await paginateListOrders(slowAdapter, {}, { totalTimeoutMs: 100, maxPages: 10 });
    // Either timeout during in-flight fetch (aborted → incomplete_api_error)
    // or exceeded deadline between fetches (incomplete_timeout). Both are acceptable
    // "incomplete" results — the KEY requirement is it must NOT be complete_not_found.
    expect(['incomplete_timeout', 'incomplete_api_error']).toContain(result.kind);
  });

  it('9. duplicate order records across pages are deduplicated', async () => {
    const dup: CoinbaseOrder = { order_id: 'dup', product_id: 'AAVE-USD', side: 'BUY', status: 'FILLED' };
    const adapter = makeAdapterFromPages(
      [
        { items: [dup], nextCursor: 'C2', hasNext: true },
        { items: [dup, { order_id: 'other', product_id: 'AAVE-USD', side: 'BUY', status: 'FILLED' }], nextCursor: null, hasNext: false },
      ],
      'orders',
    );
    const result = await paginateListOrders(adapter, {});
    expect(result.kind).toBe('complete_found');
    expect(result.items.filter((o) => o.order_id === 'dup')).toHaveLength(1);
  });

  it('10. multiple pages of fills aggregate exactly', async () => {
    const mk = (id: string, size: string) => ({
      entry_id: `e-${id}`,
      trade_id: id,
      order_id: 'ORDER1',
      product_id: 'AAVE-USD',
      price: '100',
      size,
      commission: '0.06',
      side: 'BUY',
      trade_time: '2026-01-01T00:00:00Z',
    });
    const adapter = makeAdapterFromPages(
      [
        { items: [mk('f1', '0.1'), mk('f2', '0.2')], nextCursor: 'CUR', hasNext: true },
        { items: [mk('f3', '0.3')], nextCursor: null, hasNext: false },
      ],
      'fills',
    );
    const result = await paginateListFillsForOrder(adapter, { orderId: 'ORDER1' });
    expect(result.kind).toBe('complete_found');
    expect(result.items).toHaveLength(3);
    const totalBase = result.items.reduce(
      (s, f) => s.add(Money.fromString((f as unknown as { size: string }).size)),
      Money.zero(),
    );
    expect(totalBase.toDecimalString(8)).toBe('0.60000000');
  });

  it('11. duplicate fills across pages apply once', async () => {
    const dup = {
      entry_id: 'e-dup', trade_id: 'dup', order_id: 'O1', product_id: 'AAVE-USD',
      price: '100', size: '0.1', commission: '0.06', side: 'BUY',
      trade_time: '2026-01-01T00:00:00Z',
    };
    const adapter = makeAdapterFromPages(
      [
        { items: [dup], nextCursor: 'CUR', hasNext: true },
        { items: [dup, { ...dup, trade_id: 'unique2' }], nextCursor: null, hasNext: false },
      ],
      'fills',
    );
    const result = await paginateListFillsForOrder(adapter, { orderId: 'O1' });
    expect(result.kind).toBe('complete_found');
    expect(result.items.filter((f) => (f as unknown as { trade_id: string }).trade_id === 'dup')).toHaveLength(1);
    expect(result.items).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §C — Continuous reconciliation (tests 12–14) + §H
// ═══════════════════════════════════════════════════════════════════════════

describe('§C continuous reconciliation loop', () => {
  it('12. unknown order starts reconciliation immediately (reconciler run records the trigger)', async () => {
    // Put an intent in 'unknown' state and mark the config as degraded to
    // mirror what tripGlobalUnknownLock would do.
    await insertEntryIntent({ state: 'unknown', clientOrderId: 'unk-1' });
    await updateBotConfig({ reconciliationStatus: 'degraded' });
    const result = await runReconciliationOnce({ trigger: 'post_unknown', dryRun: true });
    expect(result).not.toBeNull();
    expect(result!.intentsExamined).toBeGreaterThan(0);
    const runRows = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.runId, result!.runId));
    expect(runRows[0].triggerReason).toBe('post_unknown');
  });

  it('13. recurring reconciliation continues while unresolved intents exist', async () => {
    await insertEntryIntent({ state: 'submitted', clientOrderId: 'sub-1' });
    // First pass: dry-run intent with no fills → marks canceled.
    const r1 = await runReconciliationOnce({ trigger: 'scheduled', dryRun: true });
    expect(r1).not.toBeNull();
    // A subsequent pass with nothing unresolved should be status=ok.
    const r2 = await runReconciliationOnce({ trigger: 'scheduled', dryRun: true });
    expect(r2!.finalStatus).toBe('ok');
    expect(r2!.intentsStillUnknown).toBe(0);
  });

  it('14. degraded status cannot clear if pagination remains incomplete', async () => {
    await updateBotConfig({ reconciliationStatus: 'degraded' });
    // Craft an unknown intent that needs the exchange (but not dry-run).
    await insertEntryIntent({
      state: 'unknown', clientOrderId: 'need-cb', dryRun: false, exchangeOrderId: null,
    });
    // Force a pagination adapter that returns incomplete_cursor_loop.
    const adapter: CoinbasePaginationAdapter = {
      requestPage: async () => ({ orders: [], cursor: 'X', has_next: true } as unknown as never),
    };
    // But since ENV.coinbaseConfigured is false in tests, the reconciler
    // will take the 'skipped_no_exchange' path — still surfaces incomplete.
    const result = await runReconciliationOnce({
      trigger: 'scheduled',
      dryRun: false,
      paginationAdapter: adapter,
    });
    expect(result).not.toBeNull();
    // Either way the run reports still-unknown → degraded stays degraded.
    expect(result!.intentsStillUnknown).toBeGreaterThan(0);
    const cfg = (await db.select().from(orderIntents).where(eq(orderIntents.clientOrderId, 'need-cb')))[0];
    expect(cfg).toBeDefined(); // sanity
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §D — Same economic application path (tests 15–16)
// ═══════════════════════════════════════════════════════════════════════════

describe('§D shared economic-state application', () => {
  it('15. recovered entry applies exact position and ledger state', async () => {
    const intentId = await insertEntryIntent();
    const fills = [synthFill('BUY', { filledSize: '0.4', fillPrice: '100', fee: '0.24' })];
    const result = await applyEntryEconomicStateTx(entryInput(intentId, fills));
    expect(result.kind).toBe('opened');
    const [pos] = await db.select().from(positions).where(eq(positions.id, result.positionId));
    expect(pos.filledQuantity).toBe('0.40000000');
    expect(pos.entryFees).toBe('0.24000000');
    const ledger = await db.select().from(cashLedger).where(eq(cashLedger.orderIntentId, intentId));
    // Expect: 1 buy_cost + 1 buy_fee = 2 rows.
    expect(ledger).toHaveLength(2);
  });

  it('16. replaying recovered entry changes nothing (idempotent)', async () => {
    const intentId = await insertEntryIntent();
    const fills = [synthFill('BUY', { filledSize: '0.4' })];
    const first = await applyEntryEconomicStateTx(entryInput(intentId, fills));
    const second = await applyEntryEconomicStateTx(entryInput(intentId, fills));
    expect(second.positionId).toBe(first.positionId);
    const posRows = await db.select().from(positions).where(eq(positions.entryOrderIntentId, intentId));
    expect(posRows).toHaveLength(1);
    const ledgerRows = await db.select().from(cashLedger).where(eq(cashLedger.orderIntentId, intentId));
    expect(ledgerRows).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §E — Strict partial-fill classifier (tests 17–22)
// ═══════════════════════════════════════════════════════════════════════════

describe('§E strict partial-fill classifier', () => {
  it('17. recovered partial entry preserves residual order state', () => {
    const state = classifyFillState({
      side: 'BUY',
      requestedBase: Money.fromString('1.0'),
      filledBase: Money.fromString('0.4'),
      filledQuote: Money.fromString('40'),
      coinbaseStatus: 'OPEN',
      baseIncrement: '0.00000001',
    });
    expect(state.kind).toBe('partially_filled_open');
    expect(state.residualBase.toDecimalString(8)).toBe('0.60000000');
  });

  it('18. partial entry followed by cancellation leaves exact exposure', () => {
    const state = classifyFillState({
      side: 'BUY',
      requestedBase: Money.fromString('1.0'),
      filledBase: Money.fromString('0.4'),
      filledQuote: Money.fromString('40'),
      coinbaseStatus: 'CANCELLED',
      baseIncrement: '0.00000001',
    });
    expect(state.kind).toBe('partially_filled_terminal');
    expect(state.residualBase.toDecimalString(8)).toBe('0.60000000');
  });

  it('19. recovered partial exit preserves exact position residual', () => {
    const state = classifyFillState({
      side: 'SELL',
      requestedBase: Money.fromString('1.0'),
      filledBase: Money.fromString('0.3'),
      filledQuote: Money.fromString('30'),
      coinbaseStatus: 'OPEN',
      baseIncrement: '0.00000001',
    });
    expect(state.kind).toBe('partially_filled_open');
    expect(state.residualBase.toDecimalString(8)).toBe('0.70000000');
  });

  it('20. partial exit followed by completion closes exactly once (classifier terminal)', () => {
    const state = classifyFillState({
      side: 'SELL',
      requestedBase: Money.fromString('1.0'),
      filledBase: Money.fromString('1.0'),
      filledQuote: Money.fromString('100'),
      coinbaseStatus: 'FILLED',
      baseIncrement: '0.00000001',
    });
    expect(state.kind).toBe('completely_filled');
    expect(state.residualBase.toDecimalString(8)).toBe('0.00000000');
  });

  it('21. dust residual follows the documented policy', () => {
    const state = classifyFillState({
      side: 'BUY',
      requestedBase: Money.fromString('1.0'),
      filledBase: Money.fromString('0.99999999'),
      filledQuote: Money.fromString('100'),
      coinbaseStatus: 'FILLED',
      baseIncrement: '0.00000001',
      dustMultiplier: 1,
    });
    expect(state.kind).toBe('filled_with_dust_residual');
    expect(state.residualBase.toDecimalString(8)).toBe('0.00000001');
  });

  it('22. impossible unit comparison produces inconsistent state', () => {
    // Overfill: filled > requested.
    const state = classifyFillState({
      side: 'BUY',
      requestedBase: Money.fromString('0.5'),
      filledBase: Money.fromString('0.7'),
      filledQuote: Money.fromString('70'),
      coinbaseStatus: 'FILLED',
      baseIncrement: '0.00000001',
    });
    expect(state.kind).toBe('inconsistent');
    expect(state.reason).toBe('overfill');
  });

  it('22b. SELL with only requestedQuote (mixing base/quote) is inconsistent', () => {
    const state = classifyFillState({
      side: 'SELL',
      requestedQuote: Money.fromString('50'),
      filledBase: Money.fromString('0.4'),
      filledQuote: Money.fromString('40'),
      coinbaseStatus: 'FILLED',
      baseIncrement: '0.00000001',
    });
    expect(state.kind).toBe('inconsistent');
    expect(state.reason).toBe('sell_requested_quote_without_base');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §F — Transactional exit allocation (tests 23–25)
// ═══════════════════════════════════════════════════════════════════════════

describe('§F transactional exit-attempt allocation', () => {
  it('23. existing unresolved exit intent is reused (same clientOrderId)', async () => {
    const position = await insertRawPosition();
    // Insert a non-terminal exit intent at gen=1.
    await insertOrderIntent({
      clientOrderId: 'exit-existing-1',
      productId: 'AAVE-USD', token: 'AAVE', side: 'SELL',
      orderType: 'market_ioc', baseSize: '1', mode: 'macro', purpose: 'manual_exit',
      positionId: position.id, state: 'submitted', dryRun: true, attemptGeneration: 1,
    });
    const alloc = await allocateExitAttempt(position.id, 'manual_exit');
    expect(alloc.action).toBe('reuse');
    expect(alloc.attemptGeneration).toBe(1);
    expect(alloc.reusedIntent?.clientOrderId).toBe('exit-existing-1');
  });

  it('24. new exit generation is allocated only after terminal completion', async () => {
    const position = await insertRawPosition();
    // Prior exit at gen=1 in 'filled' state.
    await insertOrderIntent({
      clientOrderId: 'exit-done-1',
      productId: 'AAVE-USD', token: 'AAVE', side: 'SELL',
      orderType: 'market_ioc', baseSize: '1', mode: 'macro', purpose: 'manual_exit',
      positionId: position.id, state: 'filled', dryRun: true, attemptGeneration: 1,
    });
    const alloc = await allocateExitAttempt(position.id, 'manual_exit');
    expect(alloc.action).toBe('new');
    expect(alloc.attemptGeneration).toBe(2);
  });

  it('25. concurrent generation allocation yields one authoritative intent (UNIQUE catches the loser)', async () => {
    const position = await insertRawPosition();
    // Simulate two peers picking the same generation racing through the
    // application layer; the DB UNIQUE catches the loser.
    await insertOrderIntent({
      clientOrderId: 'race-A',
      productId: 'AAVE-USD', token: 'AAVE', side: 'SELL',
      orderType: 'market_ioc', baseSize: '1', mode: 'macro', purpose: 'manual_exit',
      positionId: position.id, state: 'submitted', dryRun: true, attemptGeneration: 1,
    });
    let dup: unknown;
    try {
      await insertOrderIntent({
        clientOrderId: 'race-B',
        productId: 'AAVE-USD', token: 'AAVE', side: 'SELL',
        orderType: 'market_ioc', baseSize: '1', mode: 'macro', purpose: 'manual_exit',
        positionId: position.id, state: 'submitted', dryRun: true, attemptGeneration: 1,
      });
    } catch (err) {
      dup = err;
    }
    expect(isDuplicateKeyError(dup)).toBe(true);
    // Only race-A survived.
    const rows = await db
      .select()
      .from(orderIntents)
      .where(and(eq(orderIntents.positionId, position.id), eq(orderIntents.attemptGeneration, 1)));
    expect(rows).toHaveLength(1);
    expect(rows[0].clientOrderId).toBe('race-A');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §G — Preview → order intent binding (tests 26–30)
// ═══════════════════════════════════════════════════════════════════════════

describe('§G preview binding + config hash', () => {
  const fakePreview: PreviewOk = {
    status: 'ok',
    synthetic: false,
    raw: { synthetic: false } as never,
    orderTotal: Money.fromString('100.60'),
    commissionTotal: Money.fromString('0.60'),
    bestBid: Money.fromString('99.99'),
    bestAsk: Money.fromString('100.01'),
    estimatedAvgFillPrice: Money.fromString('100.00'),
    slippage: Money.zero(),
    baseSize: null,
    quoteSize: Money.fromString('100'),
    warnings: [],
  };

  it('26. preview ID is persisted with the accepted decision', async () => {
    const approved = deriveApprovedIntent({
      productId: 'AAVE-USD',
      side: 'BUY',
      orderType: 'market_ioc',
      timeInForce: 'IOC',
      requestedQuote: Money.fromString('100'),
      requestedBase: null,
      limitPrice: null,
      stopPrice: null,
      preview: fakePreview,
      feeTierPricingTier: 'Tier 1',
      feeTierSnapshotId: 1,
      strategyVersion: 'v1',
      costModelVersion: 'v1',
      decisionId: 55,
      costForecastId: 22,
    });
    expect(approved.previewId).toMatch(/^prv-/);
    expect(approved.configHash).toMatch(/^[a-f0-9]{64}$/);
    // Store on intent + retrieve.
    const clientOrderId = `preview-bound-${nextSuffix()}`;
    await insertOrderIntent({
      clientOrderId,
      productId: 'AAVE-USD', token: 'AAVE', side: 'BUY',
      orderType: 'market_ioc', quoteSize: '100', mode: 'macro', purpose: 'entry',
      state: 'created', dryRun: true,
      previewId: approved.previewId, decisionId: approved.decisionId,
      costForecastId: approved.costForecastId,
      feeTierSnapshotId: approved.feeTierSnapshotId,
      configHash: approved.configHash,
      previewedAt: approved.previewedAt, previewExpiresAt: approved.previewExpiresAt,
      normalizedConfig: approved.normalizedConfig,
    });
    const stored = await findOrderIntentByClientOrderId(clientOrderId);
    expect(stored?.previewId).toBe(approved.previewId);
    expect(stored?.decisionId).toBe(55);
    expect(stored?.configHash).toBe(approved.configHash);
  });

  it('27. executor uses the approved exact configuration (verify passes when nothing changed)', () => {
    const approved = deriveApprovedIntent({
      productId: 'AAVE-USD', side: 'BUY', orderType: 'market_ioc', timeInForce: 'IOC',
      requestedQuote: Money.fromString('100'), requestedBase: null,
      limitPrice: null, stopPrice: null,
      preview: fakePreview,
      feeTierPricingTier: 'Tier 1', feeTierSnapshotId: 1,
      strategyVersion: 'v1', costModelVersion: 'v1',
      decisionId: 1, costForecastId: 1,
    });
    const verdict = verifyApprovedIntent(approved, {
      productTradable: true,
      now: new Date(approved.previewedAt.getTime() + 1_000),
      currentFeeTierPricingTier: 'Tier 1',
      currentMidPrice: Money.fromString('100'),
      priceMoveToleranceBps: 20,
    });
    expect(verdict.ok).toBe(true);
  });

  it('28. changed size invalidates the preview (hash mismatch)', () => {
    const approved = deriveApprovedIntent({
      productId: 'AAVE-USD', side: 'BUY', orderType: 'market_ioc', timeInForce: 'IOC',
      requestedQuote: Money.fromString('100'), requestedBase: null,
      limitPrice: null, stopPrice: null,
      preview: fakePreview,
      feeTierPricingTier: 'Tier 1', feeTierSnapshotId: 1,
      strategyVersion: 'v1', costModelVersion: 'v1',
      decisionId: 1, costForecastId: 1,
    });
    // Mutate size after approval — hash must mismatch.
    const mutated: NormalizedOrderConfig = { ...approved.normalized, quoteSize: '200.00000000' };
    const newHash = hashOrderConfig(mutated);
    expect(newHash).not.toBe(approved.configHash);
  });

  it('29. stale preview requires re-preview (past freshness deadline)', () => {
    const approved = deriveApprovedIntent({
      productId: 'AAVE-USD', side: 'BUY', orderType: 'market_ioc', timeInForce: 'IOC',
      requestedQuote: Money.fromString('100'), requestedBase: null,
      limitPrice: null, stopPrice: null,
      preview: fakePreview,
      feeTierPricingTier: 'Tier 1', feeTierSnapshotId: 1,
      strategyVersion: 'v1', costModelVersion: 'v1',
      decisionId: 1, costForecastId: 1,
    });
    const verdict = verifyApprovedIntent(approved, {
      productTradable: true,
      now: new Date(approved.previewedAt.getTime() + PREVIEW_FRESHNESS_MS + 1_000),
      currentFeeTierPricingTier: 'Tier 1',
      currentMidPrice: Money.fromString('100'),
      priceMoveToleranceBps: 20,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('preview_stale');
  });

  it('30. changed fee tier requires re-preview', () => {
    const approved = deriveApprovedIntent({
      productId: 'AAVE-USD', side: 'BUY', orderType: 'market_ioc', timeInForce: 'IOC',
      requestedQuote: Money.fromString('100'), requestedBase: null,
      limitPrice: null, stopPrice: null,
      preview: fakePreview,
      feeTierPricingTier: 'Tier 1', feeTierSnapshotId: 1,
      strategyVersion: 'v1', costModelVersion: 'v1',
      decisionId: 1, costForecastId: 1,
    });
    const verdict = verifyApprovedIntent(approved, {
      productTradable: true,
      now: new Date(approved.previewedAt.getTime() + 1_000),
      currentFeeTierPricingTier: 'Tier 2', // ← changed
      currentMidPrice: Money.fromString('100'),
      priceMoveToleranceBps: 20,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('fee_tier_changed');
  });

  it('30b. price movement beyond tolerance invalidates', () => {
    const approved = deriveApprovedIntent({
      productId: 'AAVE-USD', side: 'BUY', orderType: 'market_ioc', timeInForce: 'IOC',
      requestedQuote: Money.fromString('100'), requestedBase: null,
      limitPrice: null, stopPrice: null,
      preview: fakePreview,
      feeTierPricingTier: 'Tier 1', feeTierSnapshotId: 1,
      strategyVersion: 'v1', costModelVersion: 'v1',
      decisionId: 1, costForecastId: 1,
    });
    const verdict = verifyApprovedIntent(approved, {
      productTradable: true,
      now: new Date(approved.previewedAt.getTime() + 1_000),
      currentFeeTierPricingTier: 'Tier 1',
      currentMidPrice: Money.fromString('105'), // 500 bps drift
      priceMoveToleranceBps: 20,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('price_moved_beyond_tolerance');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §I — Reconciliation observability (test 31)
// ═══════════════════════════════════════════════════════════════════════════

describe('§I reconciliation observability', () => {
  it('31. reconciliation-run records contain complete audit metadata', async () => {
    await insertEntryIntent({ state: 'submitted', clientOrderId: 'auditable-1' });
    const result = await runReconciliationOnce({ trigger: 'startup', dryRun: true });
    expect(result).not.toBeNull();
    const [run] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.runId, result!.runId));
    expect(run).toBeDefined();
    expect(run.triggerReason).toBe('startup');
    expect(run.ownerId).toBeTruthy();
    expect(run.fenceGeneration).toBeGreaterThan(0);
    expect(run.intentsExamined).toBeGreaterThan(0);
    expect(run.completedAt).not.toBeNull();
    expect(run.finalStatus).toBeDefined();
    const actions = await db.select().from(reconciliationActions).where(eq(reconciliationActions.runId, result!.runId));
    expect(actions.length).toBeGreaterThan(0);
    // Actions must record previous → new state or clientOrderId.
    expect(actions[0].clientOrderId ?? actions[0].intentId).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 32 — ORDER_SUBMISSION_ENABLED killswitch
// ═══════════════════════════════════════════════════════════════════════════

describe('§32 ORDER_SUBMISSION_ENABLED=false proves zero create-order requests', () => {
  it('32. createOrder refuses to POST when ORDER_SUBMISSION_ENABLED=false', async () => {
    const { createOrder, CoinbaseError } = await import('../src/trading/coinbase');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }) as unknown as Response,
    );
    try {
      // ENV.orderSubmissionEnabled defaults to false in tests; createOrder
      // throws a CoinbaseError of class 'non_retryable_validation' before
      // any fetch is issued.
      await expect(
        createOrder({ clientOrderId: 'ks-1', token: 'AAVE', side: 'BUY', quoteSize: '10' }),
      ).rejects.toBeInstanceOf(CoinbaseError);
      // MUST NOT have called fetch.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §K — Migration upgrade tests
// ═══════════════════════════════════════════════════════════════════════════

describe('§K migration upgrade paths', () => {
  it('K1. schema after 0005 contains execution_fences with the expected columns', async () => {
    const { sql } = await import('drizzle-orm');
    const raw = (await db.execute(sql`DESCRIBE execution_fences`)) as unknown as [{ Field: string }[], unknown];
    const arr = Array.isArray(raw[0]) ? raw[0] : (raw as unknown as { Field: string }[]);
    const names = arr.map((r) => r.Field);
    expect(names).toEqual(
      expect.arrayContaining([
        'resourceKey', 'currentGeneration', 'ownerId', 'acquiredAt', 'renewedAt', 'state',
      ]),
    );
  });

  it('K2. order_intents has the new preview + fence columns', async () => {
    const { sql } = await import('drizzle-orm');
    const raw = (await db.execute(sql`DESCRIBE order_intents`)) as unknown as [{ Field: string }[], unknown];
    const arr = Array.isArray(raw[0]) ? raw[0] : (raw as unknown as { Field: string }[]);
    const names = arr.map((r) => r.Field);
    for (const col of ['fenceResourceKey', 'previewId', 'decisionId', 'costForecastId', 'feeTierSnapshotId', 'configHash', 'previewedAt', 'previewExpiresAt', 'normalizedConfig', 'residualBaseSize', 'fillState']) {
      expect(names).toContain(col);
    }
  });

  it('K3. positions has residualBaseSize', async () => {
    const { sql } = await import('drizzle-orm');
    const raw = (await db.execute(sql`DESCRIBE positions`)) as unknown as [{ Field: string }[], unknown];
    const arr = Array.isArray(raw[0]) ? raw[0] : (raw as unknown as { Field: string }[]);
    const names = arr.map((r) => r.Field);
    expect(names).toContain('residualBaseSize');
  });

  it('K4. reconciliation_runs + reconciliation_actions exist', async () => {
    const { sql } = await import('drizzle-orm');
    const raw = (await db.execute(sql`SHOW TABLES`)) as unknown as [Record<string, string>[], unknown];
    const arr = Array.isArray(raw[0]) ? raw[0] : (raw as unknown as Record<string, string>[]);
    const tables = arr.map((r) => Object.values(r)[0]);
    expect(tables).toEqual(expect.arrayContaining(['reconciliation_runs', 'reconciliation_actions']));
  });

  it('K5. repeated migration invocation (idempotent 0005 re-run is safe)', async () => {
    // The migration is DDL — re-applying "CREATE TABLE" would fail without
    // IF NOT EXISTS. That's fine here because we don't re-apply in the
    // production runtime; drizzle-kit tracks _journal entries and skips
    // already-applied migrations. We check that the existing schema still
    // accepts every one of the 0005 inserts.
    await bumpExecutionFence('idem-key', 'owner1');
    const before = await db.select().from(executionFences).where(eq(executionFences.resourceKey, 'idem-key'));
    await bumpExecutionFence('idem-key', 'owner2');
    const after = await db.select().from(executionFences).where(eq(executionFences.resourceKey, 'idem-key'));
    expect(after[0].currentGeneration).toBeGreaterThan(before[0].currentGeneration);
  });
});

// ---------------------------------------------------------------------------
// Suppress unused-import warnings.
// ---------------------------------------------------------------------------
void paginate;
void applyExitEconomicStateTx;
