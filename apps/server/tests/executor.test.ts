import { describe, it, expect } from 'vitest';
import { shouldExit } from '../src/trading/executor';
import type { PositionRow } from '../src/db/schema';

function makePosition(overrides: Partial<PositionRow> = {}): PositionRow {
  return {
    id: 1,
    token: 'AAVE',
    mode: 'macro',
    entryPrice: '100',
    quantity: '1',
    allocationPct: '10',
    takeProfitPrice: '108',
    stopLossPrice: '97',
    takeProfitPct: '8',
    stopLossPct: '3',
    claudeReason: null,
    coinbaseOrderId: null,
    status: 'open',
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
      entryPrice: '100',
      takeProfitPrice: '103',
      stopLossPrice: '98',
      takeProfitPct: '3',
      stopLossPct: '2',
    });
    // 1.6% gain exceeds the 1.5% early-exit threshold but is below take-profit.
    const result = shouldExit(pos, 101.6);
    expect(result.exit).toBe(true);
    expect(result.reason).toBe('early_exit');
  });

  it('does not early-exit non-reversion modes below take-profit', () => {
    const result = shouldExit(makePosition({ mode: 'macro' }), 101.6);
    expect(result.exit).toBe(false);
  });
});
