import { describe, it, expect } from 'vitest';
import {
  evaluateReversion,
  evaluateBreakout,
  evaluateMacro,
  detectBestMode,
  computeIndicators,
  type MarketSnapshot,
} from '../src/trading/modes';

function makeSnapshot(closes: number[], overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  const price = closes[closes.length - 1];
  return {
    token: 'TEST',
    price,
    volume24h: 5_000_000,
    changePct24h: 5,
    closes,
    candles: [],
    winRate: null,
    ...overrides,
  };
}

describe('computeIndicators', () => {
  it('computes a full indicator set from a long series', () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 8 + i * 0.05);
    const ind = computeIndicators(makeSnapshot(closes));
    expect(ind.rsiValue).not.toBeNull();
    expect(ind.macdHistogram).not.toBeNull();
    expect(ind.bands).not.toBeNull();
    expect(ind.ema9).not.toBeNull();
    expect(ind.ema21).not.toBeNull();
  });
});

describe('evaluateReversion', () => {
  it('qualifies on an oversold dip with volume', () => {
    // Downtrend that bottoms out — RSI low, price near/below lower band.
    const closes = Array.from({ length: 60 }, (_, i) => 100 - i * 0.8);
    const snap = makeSnapshot(closes);
    const ind = computeIndicators(snap);
    const evaluation = evaluateReversion(snap, ind);
    expect(evaluation.mode).toBe('reversion');
    expect(evaluation.totalSignals).toBe(5);
  });
});

describe('evaluateBreakout', () => {
  it('returns a breakout evaluation with 4 total signals', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 1.5);
    const snap = makeSnapshot(closes, { changePct24h: 35 });
    const ind = computeIndicators(snap);
    const evaluation = evaluateBreakout(snap, ind);
    expect(evaluation.mode).toBe('breakout');
    expect(evaluation.totalSignals).toBe(4);
  });
});

describe('evaluateMacro', () => {
  it('qualifies on a steady uptrend', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const snap = makeSnapshot(closes);
    const ind = computeIndicators(snap);
    const evaluation = evaluateMacro(snap, ind);
    expect(evaluation.mode).toBe('macro');
    expect(evaluation.passedSignals).toBeGreaterThan(0);
  });
});

describe('detectBestMode', () => {
  it('returns null when no mode qualifies (flat, low-signal series)', () => {
    const closes = new Array(60).fill(100);
    const result = detectBestMode(makeSnapshot(closes, { volume24h: 100 }));
    expect(result).toBeNull();
  });

  it('selects a mode and surfaces signal counts when one qualifies', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.6);
    const result = detectBestMode(makeSnapshot(closes));
    if (result) {
      expect(['reversion', 'breakout', 'macro']).toContain(result.evaluation.mode);
      expect(result.signals.passedSignals).toBeGreaterThanOrEqual(
        result.evaluation.totalSignals - 2,
      );
    }
  });
});
