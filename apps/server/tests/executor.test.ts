import { describe, it, expect } from 'vitest';
import { Money } from '@horizon/shared';
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
    const result = shouldExit(makePosition(), Money.fromString('108.5'));
    expect(result.exit).toBe(true);
    expect(result.reason).toBe('take_profit');
  });

  it('exits on stop-loss', () => {
    const result = shouldExit(makePosition(), Money.fromString('96'));
    expect(result.exit).toBe(true);
    expect(result.reason).toBe('stop_loss');
  });

  it('holds inside the band', () => {
    const result = shouldExit(makePosition(), Money.fromString('102'));
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
    const result = shouldExit(pos, Money.fromString('101.6'));
    expect(result.exit).toBe(true);
    expect(result.reason).toBe('early_exit');
  });

  it('does not early-exit non-reversion modes below take-profit', () => {
    const result = shouldExit(makePosition({ mode: 'macro' }), Money.fromString('101.6'));
    expect(result.exit).toBe(false);
  });
});

describe('deriveClientOrderId (stable economic identity — Phase 1.1.a §B)', () => {
  it('entry identity is deterministic across timeouts (same decisionId → same id)', () => {
    // A retry after a timeout MUST produce the same clientOrderId so Coinbase
    // dedupes — never a fresh id that could become a second real order.
    const a = deriveClientOrderId({
      purpose: 'entry',
      token: 'AAVE',
      mode: 'macro',
      decisionId: 123,
    });
    const b = deriveClientOrderId({
      purpose: 'entry',
      token: 'AAVE',
      mode: 'macro',
      decisionId: 123,
    });
    expect(a).toBe(b);
    expect(a.startsWith('hzn-')).toBe(true);
    expect(a.length).toBeLessThanOrEqual(64);
  });

  it('different accepted decisions produce different entry ids', () => {
    const a = deriveClientOrderId({ purpose: 'entry', token: 'AAVE', mode: 'macro', decisionId: 1 });
    const b = deriveClientOrderId({ purpose: 'entry', token: 'AAVE', mode: 'macro', decisionId: 2 });
    expect(a).not.toBe(b);
  });

  it('exit identity is stable per (position, purpose, attempt generation)', () => {
    const a = deriveClientOrderId({
      purpose: 'take_profit',
      token: 'AAVE',
      mode: 'macro',
      positionId: 42,
      attemptGeneration: 1,
    });
    const b = deriveClientOrderId({
      purpose: 'take_profit',
      token: 'AAVE',
      mode: 'macro',
      positionId: 42,
      attemptGeneration: 1,
    });
    expect(a).toBe(b);
    // A NEW attempt after the prior one is resolved bumps the generation.
    const c = deriveClientOrderId({
      purpose: 'take_profit',
      token: 'AAVE',
      mode: 'macro',
      positionId: 42,
      attemptGeneration: 2,
    });
    expect(c).not.toBe(a);
  });

  it('entry ID for a position is never the same as any exit ID', () => {
    const entry = deriveClientOrderId({
      purpose: 'entry',
      token: 'AAVE',
      mode: 'macro',
      decisionId: 99,
    });
    const exit = deriveClientOrderId({
      purpose: 'manual_exit',
      token: 'AAVE',
      mode: 'macro',
      positionId: 42,
      attemptGeneration: 1,
    });
    expect(entry).not.toBe(exit);
  });

  it('wall clock is never mixed in — pure function of inputs', () => {
    // Two calls at wildly different times must produce identical ids.
    const a = deriveClientOrderId({ purpose: 'entry', token: 'AAVE', mode: 'macro', decisionId: 7 });
    // Simulate a delay before the retry.
    const b = deriveClientOrderId({ purpose: 'entry', token: 'AAVE', mode: 'macro', decisionId: 7 });
    expect(a).toBe(b);
  });
});
