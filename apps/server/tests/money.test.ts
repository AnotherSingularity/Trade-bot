import { describe, expect, it } from 'vitest';
import { Money, MONEY_SCALE_BIGINT } from '@horizon/shared';

/**
 * Money is the decimal-safe foundation for all Phase 1 cost / EV / ledger
 * arithmetic. These tests cover the edge cases that ordinary float math gets
 * wrong: repeated small additions, exact fee percentages, rounding halves,
 * and rounding to product increments.
 */

describe('Money — construction & parity', () => {
  it('parses a canonical decimal string', () => {
    expect(Money.fromString('1.23456789').toDecimalString()).toBe('1.23456789');
  });
  it('preserves 8 fractional digits by default', () => {
    expect(Money.fromString('0').toDecimalString()).toBe('0.00000000');
    expect(Money.fromString('100').toDecimalString()).toBe('100.00000000');
  });
  it('rounds excess fractional digits half-even', () => {
    // 0.123456785 → 0.12345678 (round half-even: prev digit 8 is even, stay)
    expect(Money.fromString('0.123456785').toDecimalString()).toBe('0.12345678');
    // 0.123456795 → 0.12345680 (prev digit 9 is odd, bump up)
    expect(Money.fromString('0.123456795').toDecimalString()).toBe('0.12345680');
  });
  it('parses negative values', () => {
    expect(Money.fromString('-1.5').toDecimalString()).toBe('-1.50000000');
  });
  it('rejects invalid strings', () => {
    expect(() => Money.fromString('1.2.3')).toThrow();
    expect(() => Money.fromString('abc')).toThrow();
    expect(() => Money.fromString('')).toThrow();
  });
  it('fromBps: 1 bp = 0.0001', () => {
    expect(Money.fromBps(1).toDecimalString()).toBe('0.00010000');
    expect(Money.fromBps(50).toDecimalString()).toBe('0.00500000');
    expect(Money.fromBps(10_000).toDecimalString()).toBe('1.00000000');
  });
  it('round-trips through JSON', () => {
    const m = Money.fromString('12345.67891234');
    const json = JSON.stringify({ v: m });
    expect(JSON.parse(json).v).toBe('12345.67891234');
  });
});

describe('Money — arithmetic invariants', () => {
  it('0.1 + 0.2 === 0.3 exactly (the canonical float-fail)', () => {
    const s = Money.fromString('0.1').add(Money.fromString('0.2'));
    expect(s.eq(Money.fromString('0.3'))).toBe(true);
    // The classic float test — should NOT match here.
    expect(0.1 + 0.2 === 0.3).toBe(false);
  });
  it('a thousand cent additions equal $10.00 exactly', () => {
    let m = Money.zero();
    for (let i = 0; i < 1000; i++) m = m.add(Money.fromString('0.01'));
    expect(m.toDecimalString(2)).toBe('10.00');
  });
  it('subtracting a fee leaves an exact remainder', () => {
    const gross = Money.fromString('100');
    const fee = gross.pct(0.6); // 60 bps taker
    expect(fee.toDecimalString(2)).toBe('0.60');
    expect(gross.sub(fee).toDecimalString(2)).toBe('99.40');
  });
  it('mul is Money*Money → Money (scale-preserving)', () => {
    const price = Money.fromString('123.45');
    const qty = Money.fromString('2.5');
    // 123.45 * 2.5 = 308.625
    expect(price.mul(qty).toDecimalString()).toBe('308.62500000');
  });
  it('div by zero throws', () => {
    expect(() => Money.fromString('1').div(Money.zero())).toThrow('division by zero');
  });
  it('pct 3% of 100 = 3 exactly', () => {
    expect(Money.fromString('100').pct(3).eq(Money.fromString('3'))).toBe(true);
  });
});

describe('Money — rounding modes', () => {
  it('HALF_EVEN rounds .5 to nearest even', () => {
    // 0.5 → 0 (0 is even); 1.5 → 2 (2 is even); 2.5 → 2 (2 is even)
    expect(
      Money.fromString('0.5').mul(Money.fromString('1'), 'HALF_EVEN').toDecimalString(0),
    ).toBe('0'); // wait: 0.5 * 1 = 0.5; toDecimalString(0) rounds via HALF_EVEN
    expect(Money.fromString('0.5').toDecimalString(0)).toBe('0');
    expect(Money.fromString('1.5').toDecimalString(0)).toBe('2');
    expect(Money.fromString('2.5').toDecimalString(0)).toBe('2');
    expect(Money.fromString('3.5').toDecimalString(0)).toBe('4');
  });
  it('roundToIncrement DOWN never exceeds original', () => {
    // Coinbase increment 0.01 on a size of 1.2378 → 1.23
    const size = Money.fromString('1.2378');
    const inc = Money.fromString('0.01');
    expect(size.roundToIncrement(inc, 'DOWN').toDecimalString(2)).toBe('1.23');
  });
  it('roundToIncrement DOWN for negative moves toward zero', () => {
    // Guards the sizing math: never round up when trimming to increments.
    const size = Money.fromString('-1.2378');
    const inc = Money.fromString('0.01');
    // DOWN = truncate toward zero → -1.23 (not -1.24)
    expect(size.roundToIncrement(inc, 'DOWN').toDecimalString(2)).toBe('-1.23');
  });
});

describe('Money — comparison & combinators', () => {
  it('cmp / lt / gte behave transitively', () => {
    const a = Money.fromString('1');
    const b = Money.fromString('2');
    const c = Money.fromString('2');
    expect(a.lt(b)).toBe(true);
    expect(b.eq(c)).toBe(true);
    expect(b.gte(c)).toBe(true);
    expect(a.cmp(b)).toBe(-1);
    expect(b.cmp(a)).toBe(1);
    expect(b.cmp(c)).toBe(0);
  });
  it('sum of empty is zero', () => {
    expect(Money.sum([]).isZero()).toBe(true);
  });
  it('sum aggregates without drift', () => {
    const parts = Array.from({ length: 10 }, () => Money.fromString('0.1'));
    expect(Money.sum(parts).eq(Money.fromString('1'))).toBe(true);
  });
  it('min/max return the correct value', () => {
    const a = Money.fromString('5');
    const b = Money.fromString('7');
    expect(Money.max(a, b).eq(b)).toBe(true);
    expect(Money.min(a, b).eq(a)).toBe(true);
  });
});

describe('Money — scale invariants', () => {
  it('scaled is always an exact bigint', () => {
    const m = Money.fromString('12345.6789');
    expect(typeof m.scaled).toBe('bigint');
    expect(m.scaled).toBe(1234567890000n);
  });
  it('MONEY_SCALE_BIGINT is 10^8', () => {
    expect(MONEY_SCALE_BIGINT).toBe(100_000_000n);
  });
  it('fromScaled preserves exact value', () => {
    const raw = 1234567890000n;
    expect(Money.fromScaled(raw).scaled).toBe(raw);
  });
});
