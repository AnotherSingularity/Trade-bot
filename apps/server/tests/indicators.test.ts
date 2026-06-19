import { describe, it, expect } from 'vitest';
import {
  sma,
  ema,
  rsi,
  macd,
  bollingerBands,
  percentChange,
} from '../src/trading/indicators';

describe('sma', () => {
  it('returns the average of the last period values', () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([2, 4, 6], 2)).toBe(5);
  });
  it('returns null with insufficient data', () => {
    expect(sma([1, 2], 5)).toBeNull();
    expect(sma([], 3)).toBeNull();
  });
});

describe('ema', () => {
  it('weights recent values more heavily than the full-series average', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const e = ema(values, 5);
    expect(e).not.toBeNull();
    // On a rising series, EMA (recent-weighted) should exceed the overall mean.
    const fullMean = sma(values, values.length) as number;
    expect(e as number).toBeGreaterThan(fullMean);
  });
  it('returns null with insufficient data', () => {
    expect(ema([1, 2], 5)).toBeNull();
  });
});

describe('rsi', () => {
  it('returns 100 for a strictly rising series (no losses)', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(rsi(values, 14)).toBe(100);
  });
  it('stays within 0..100', () => {
    const values = [44, 44.5, 43.8, 44.2, 45, 45.5, 45.2, 46, 45.8, 46.5, 46.2, 47, 46.8, 47.5, 48];
    const value = rsi(values, 14);
    expect(value).not.toBeNull();
    expect(value as number).toBeGreaterThanOrEqual(0);
    expect(value as number).toBeLessThanOrEqual(100);
  });
  it('returns null with insufficient data', () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });
});

describe('macd', () => {
  it('produces histogram = macd - signal', () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.1);
    const result = macd(values);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.histogram).toBeCloseTo(result.macd - result.signal, 6);
    }
  });
  it('returns null with insufficient data', () => {
    expect(macd([1, 2, 3, 4, 5])).toBeNull();
  });
});

describe('bollingerBands', () => {
  it('brackets the middle band', () => {
    const values = Array.from({ length: 25 }, (_, i) => 100 + (i % 5));
    const bands = bollingerBands(values, 20, 2);
    expect(bands).not.toBeNull();
    if (bands) {
      expect(bands.upper).toBeGreaterThan(bands.middle);
      expect(bands.lower).toBeLessThan(bands.middle);
      expect(bands.bandwidth).toBeGreaterThanOrEqual(0);
    }
  });
  it('returns null with insufficient data', () => {
    expect(bollingerBands([1, 2, 3], 20)).toBeNull();
  });
});

describe('percentChange', () => {
  it('computes percentage change between first and last', () => {
    expect(percentChange([100, 110])).toBeCloseTo(10);
    expect(percentChange([200, 150])).toBeCloseTo(-25);
  });
  it('returns null when first value is zero or series too short', () => {
    expect(percentChange([0, 10])).toBeNull();
    expect(percentChange([5])).toBeNull();
  });
});
