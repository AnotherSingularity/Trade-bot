import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fullReset, mockState, coinbaseMock } from './setup/coinbase-mock';

// Mock the coinbase module BEFORE any executor import.
vi.mock('../src/trading/coinbase', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/trading/coinbase')>();
  return { ...original, ...coinbaseMock };
});

import {
  aggregateFills,
  ensureInitialFund,
  findOrderIntentByClientOrderId,
  getBotConfig,
  getCashBalance,
  getFillsForOrderIntent,
  getOpenPositions,
  getRoundTripSummary,
  updateBotConfig,
} from '../src/db/queries';
import { closePosition, deriveClientOrderId, openPosition } from '../src/trading/executor';
import { _testOverride } from '../src/env';

// Monotonic decisionId helper — each call yields a fresh id so tests that
// open MULTIPLE positions don't accidentally reuse the same clientOrderId.
let __nextDecisionId = 10_000;
const decision = (overrides: Partial<Parameters<typeof openPosition>[0]> = {}) => ({
  token: 'AAVE',
  mode: 'macro' as const,
  scanPrice: 100,
  allocationPct: 5,
  claudeReason: 'test',
  claudeModel: 'test-model',
  claudeConfidence: 0.8,
  decisionId: __nextDecisionId++, // §B: stable economic identity
  ...overrides,
});

/**
 * Tests that need to exercise createOrder's failure paths flip a test-only
 * ENV override so the executor takes the "live" branch while all Coinbase I/O
 * remains mocked — no real network calls.
 */
async function withForcedLivePath<T>(fn: () => Promise<T>): Promise<T> {
  const restore = _testOverride({ testForceLivePath: true, coinbaseConfigured: true });
  try {
    return await fn();
  } finally {
    restore();
  }
}

beforeAll(async () => {
  await updateBotConfig({ reconciliationStatus: 'ok' }).catch(() => undefined);
});

beforeEach(async () => {
  await fullReset();
  await ensureInitialFund(true, 10_000);
  await updateBotConfig({ reconciliationStatus: 'ok' });
});

describe('open position — happy path (dry-run simulator)', () => {
  it('creates intent → simulates → fills → persists position from actual fills', async () => {
    const result = await openPosition(decision());
    expect(result.kind).toBe('opened');

    const positions = await getOpenPositions();
    expect(positions).toHaveLength(1);
    const p = positions[0];
    expect(p.token).toBe('AAVE');
    expect(Number(p.filledQuantity)).toBeGreaterThan(0);
    // avgEntryPrice comes from the (dry-run) fill's price, NOT the scanPrice.
    expect(Number(p.avgEntryPrice)).toBeGreaterThan(0);
    expect(Number(p.entryFees)).toBeGreaterThan(0);
    expect(p.entryOrderIntentId).toBeGreaterThan(0);

    const fills = await getFillsForOrderIntent(p.entryOrderIntentId);
    expect(fills.length).toBeGreaterThanOrEqual(1);
    const agg = aggregateFills(fills);
    expect(agg.filledSize).toBeCloseTo(Number(p.filledQuantity), 8);
  });
});

describe('idempotency — same clientOrderId is never economically duplicated', () => {
  it('two calls with the same scanSeed produce ONE position', async () => {
    const d = decision();
    const first = await openPosition(d);
    expect(first.kind).toBe('opened');
    const second = await openPosition(d);
    expect(second.kind).not.toBe('opened');
    expect(await getOpenPositions()).toHaveLength(1);
  });

  it('deterministic clientOrderId collapses race attempts', async () => {
    const a = deriveClientOrderId({ purpose: 'entry', token: 'AAVE', mode: 'macro', decisionId: 1 });
    const b = deriveClientOrderId({ purpose: 'entry', token: 'AAVE', mode: 'macro', decisionId: 1 });
    expect(a).toBe(b);
  });
});

describe('unknown outcome — never blindly retried', () => {
  it('marks intent state=unknown and returns kind=unknown (does not create position)', async () => {
    await withForcedLivePath(async () => {
      mockState.createOrderBehavior = { type: 'throw_unknown' };
      const d = decision();
      const result = await openPosition(d);
      expect(result.kind).toBe('unknown');

      const cid = deriveClientOrderId({
        purpose: 'entry',
        token: 'AAVE',
        mode: 'macro',
        decisionId: d.decisionId,
      });
      const intent = await findOrderIntentByClientOrderId(cid);
      expect(intent?.state).toBe('unknown');
      expect(intent?.failureClass).toBe('unknown');

      expect(await getOpenPositions()).toHaveLength(0);
    });
  });
});

describe('rejected order — captured, no position', () => {
  it('records rejection with failureClass=definitely_rejected', async () => {
    await withForcedLivePath(async () => {
      mockState.createOrderBehavior = { type: 'reject', reason: 'INSUFFICIENT_FUND' };
      const d = decision();
      const result = await openPosition(d);
      expect(result.kind).toBe('rejected');

      const cid = deriveClientOrderId({
        purpose: 'entry',
        token: 'AAVE',
        mode: 'macro',
        decisionId: d.decisionId,
      });
      const intent = await findOrderIntentByClientOrderId(cid);
      expect(intent?.state).toBe('rejected');
      expect(intent?.failureClass).toBe('definitely_rejected');

      expect(await getOpenPositions()).toHaveLength(0);
    });
  });
});

describe('zero fill', () => {
  it('marks intent canceled and creates no position', async () => {
    await withForcedLivePath(async () => {
      mockState.createOrderBehavior = {
        type: 'success',
        fills: [{ size: '0', commission: '0', price: '100' }],
      };
      const d = decision();
      const result = await openPosition(d);
      expect(result.kind).toBe('skipped');
      expect(result.reason).toBe('zero_fill');

      const cid = deriveClientOrderId({
        purpose: 'entry',
        token: 'AAVE',
        mode: 'macro',
        decisionId: d.decisionId,
      });
      const intent = await findOrderIntentByClientOrderId(cid);
      expect(intent?.state).toBe('canceled');
      expect(await getOpenPositions()).toHaveLength(0);
    });
  });
});

describe('partial fills — position sized to actual fill total', () => {
  it('sums partial fills into a single position', async () => {
    await withForcedLivePath(async () => {
      mockState.createOrderBehavior = {
        type: 'success',
        fills: [
          { size: '0.4', commission: '0.24', price: '100' },
          { size: '0.4', commission: '0.24', price: '100' },
        ],
      };
      const result = await openPosition(decision());
      expect(result.kind).toBe('opened');

      const positions = await getOpenPositions();
      expect(positions).toHaveLength(1);
      expect(Number(positions[0].filledQuantity)).toBeCloseTo(0.8, 8);
      expect(Number(positions[0].entryFees)).toBeCloseTo(0.48, 8);
    });
  });
});

describe('close position — round-trip accounting', () => {
  it('produces exactly one round_trip per completed position (not two)', async () => {
    await openPosition(decision());
    const p = (await getOpenPositions())[0]!;
    mockState.createOrderBehavior = null;
    const closed = await closePosition(p, 'manual');
    expect(closed.kind).toBe('closed');
    const summary = await getRoundTripSummary();
    expect(summary.totalTrades).toBe(1);
    expect(summary.wins + summary.losses + summary.flats).toBe(1);
  });

  it('failed exit returns kind=failed and does NOT close the position', async () => {
    await openPosition(decision());
    const p = (await getOpenPositions())[0]!;
    await withForcedLivePath(async () => {
      mockState.createOrderBehavior = { type: 'reject', reason: 'MARKET_CLOSED' };
      const closed = await closePosition(p, 'manual');
      expect(closed.kind).toBe('failed');
      expect(await getOpenPositions()).toHaveLength(1);
    });
  });

  it('unknown exit returns kind=pending (not closed)', async () => {
    await openPosition(decision());
    const p = (await getOpenPositions())[0]!;
    await withForcedLivePath(async () => {
      mockState.createOrderBehavior = { type: 'throw_unknown' };
      const closed = await closePosition(p, 'manual');
      expect(closed.kind).toBe('pending');
      expect(await getOpenPositions()).toHaveLength(1);
    });
  });
});

describe('accounting reconciliation — dry-run cash balances', () => {
  it('cash DECREASES after a buy (previously stayed at $10k)', async () => {
    const before = await getCashBalance(true);
    expect(before.toDecimalString(2)).toBe('10000.00');
    await openPosition(decision());
    const after = await getCashBalance(true);
    expect(after.lt(before)).toBe(true);
  });

  it('cash INCREASES after a sell (net of fees applied on both sides)', async () => {
    await openPosition(decision());
    const afterBuy = await getCashBalance(true);
    const p = (await getOpenPositions())[0]!;
    mockState.createOrderBehavior = null;
    await closePosition(p, 'manual');
    const afterSell = await getCashBalance(true);
    expect(afterSell.gt(afterBuy)).toBe(true);
    const summary = await getRoundTripSummary();
    expect(summary.totalTrades).toBe(1);
    // With zero price move + 2× taker fee, net P&L must be NEGATIVE.
    expect(summary.totalPnlDollars).toBeLessThan(0);
  });
});

describe('circuit breaker — trips after CONSECUTIVE_LOSS_LIMIT losses', () => {
  it('after three losses, consecutiveLosses hits limit and circuitBreakerUntil is set', async () => {
    for (let i = 0; i < 3; i++) {
      await openPosition(decision());
      const p = (await getOpenPositions())[0]!;
      // Force a losing exit by moving the mocked mid-price down.
      mockState.product = { ...mockState.product, price: (Number(mockState.product.price) * 0.9).toString() };
      await closePosition(p, 'manual');
      mockState.product = { ...mockState.product, price: '100' };
    }
    const cfg = await getBotConfig();
    expect(cfg.consecutiveLosses).toBeGreaterThanOrEqual(3);
    expect(cfg.circuitBreakerUntil).toBeTruthy();
  });
});

describe('one open position per token', () => {
  it('a second openPosition on the same token is skipped', async () => {
    await openPosition(decision());
    const second = await openPosition(decision());
    expect(second.kind).toBe('skipped');
    expect((await getOpenPositions()).length).toBe(1);
  });
});

describe('order intent persisted BEFORE submission (recoverable on crash)', () => {
  it('a mid-submit throw still leaves the intent row behind', async () => {
    await withForcedLivePath(async () => {
      coinbaseMock.createOrder.mockImplementationOnce(async () => {
        throw new Error('unexpected explosion');
      });
      const d = decision();
      const result = await openPosition(d);
      expect(result.kind).toBe('rejected');

      const cid = deriveClientOrderId({
        purpose: 'entry',
        token: 'AAVE',
        mode: 'macro',
        decisionId: d.decisionId,
      });
      const intent = await findOrderIntentByClientOrderId(cid);
      expect(intent).toBeTruthy();
      expect(intent?.clientOrderId).toBe(cid);
    });
  });
});
