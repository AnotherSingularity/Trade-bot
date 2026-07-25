import { describe, it, expect } from 'vitest';
import { deriveClientOrderId, shouldExit } from '../src/trading/executor';
import type { PositionRow } from '../src/db/schema';

function makePosition(overrides: Partial<PositionRow> = {}): PositionRow {
  return {
    id: 1,
    token: 'AAVE',
    mode: 'macro',
    avgEntryPrice: '100',
    filledQuantity: '1',
    entryFees: '0',
    entryQuoteSpent: '100',
    allocationPct: '10',
    takeProfitPrice: '108',
    stopLossPrice: '97',
    takeProfitPct: '8',
    stopLossPct: '3',
    entryOrderIntentId: 1,
    protectiveTpIntentId: null,
    protectiveSlIntentId: null,
    protectionMode: 'polling_fallback',
    claudeReason: null,
    claudeModel: null,
    claudeConfidence: null,
    strategyVersion: null,
    lifecycleState: 'open',
    status: 'open',
    version: 0,
    openedAt: new Date(),
    closedAt: null,
    ...overrides,
  } as PositionRow;
}

describe('shouldExit', () => {
  it('exits on take-profit', () => {
    const result = shouldExit(makePosition(), 108.5);
    expect(result.exit).toBe(true);
    expect(result.reason).toBe('take_profit');
  });

  it('exits on stop-loss', () => {
    const result = shouldExit(makePosition(), 96);
    expect(result.exit).toBe(true);
    expect(result.reason).toBe('stop_loss');
  });

  it('holds inside the band', () => {
    const result = shouldExit(makePosition(), 102);
    expect(result.exit).toBe(false);
  });

  it('applies reversion early-exit at the configured gain', () => {
    const pos = makePosition({
      mode: 'reversion',
      avgEntryPrice: '100',
      takeProfitPrice: '103',
      stopLossPrice: '98',
      takeProfitPct: '3',
      stopLossPct: '2',
    });
    const result = shouldExit(pos, 101.6);
    expect(result.exit).toBe(true);
    expect(result.reason).toBe('early_exit');
  });

  it('does not early-exit non-reversion modes below take-profit', () => {
    const result = shouldExit(makePosition({ mode: 'macro' }), 101.6);
    expect(result.exit).toBe(false);
  });
});

describe('deriveClientOrderId', () => {
  it('is deterministic for identical inputs', () => {
    const a = deriveClientOrderId({
      purpose: 'entry',
      token: 'AAVE',
      mode: 'macro',
      seed: '2026-06-19T21:00:00Z',
    });
    const b = deriveClientOrderId({
      purpose: 'entry',
      token: 'AAVE',
      mode: 'macro',
      seed: '2026-06-19T21:00:00Z',
    });
    expect(a).toBe(b);
    expect(a.startsWith('hzn-')).toBe(true);
    expect(a.length).toBeLessThanOrEqual(64);
  });

  it('produces different IDs for different seeds', () => {
    const a = deriveClientOrderId({
      purpose: 'entry',
      token: 'AAVE',
      mode: 'macro',
      seed: 'A',
    });
    const b = deriveClientOrderId({
      purpose: 'entry',
      token: 'AAVE',
      mode: 'macro',
      seed: 'B',
    });
    expect(a).not.toBe(b);
  });

  it('separates entry from exit for the same position', () => {
    const entry = deriveClientOrderId({
      purpose: 'entry',
      token: 'AAVE',
      mode: 'macro',
      positionId: 42,
      seed: 't',
    });
    const exit = deriveClientOrderId({
      purpose: 'manual_exit',
      token: 'AAVE',
      mode: 'macro',
      positionId: 42,
      seed: 't',
    });
    expect(entry).not.toBe(exit);
  });
});
