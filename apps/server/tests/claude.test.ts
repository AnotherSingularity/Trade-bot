import { describe, it, expect } from 'vitest';
import { parseSignal } from '../src/trading/claude';

describe('parseSignal', () => {
  it('parses a clean JSON response', () => {
    const r = parseSignal('{"confidence": 0.81, "shouldEnter": true, "reason": "Strong setup"}');
    expect(r.confidence).toBeCloseTo(0.81);
    expect(r.shouldEnter).toBe(true);
    expect(r.reason).toBe('Strong setup');
  });

  it('extracts the FIRST JSON object when wrapped in prose', () => {
    const r = parseSignal(
      'Assessment: {"confidence": 0.4, "shouldEnter": false, "reason": "Weak volume"} extra {ignored:1}',
    );
    expect(r.shouldEnter).toBe(false);
    expect(r.confidence).toBeCloseTo(0.4);
    expect(r.reason).toBe('Weak volume');
  });

  it('REJECTS the string "false" as shouldEnter (Phase-0 hardened parser)', () => {
    // The old Boolean("false") coerced this to true and would have entered the
    // trade. The strict schema now refuses it and fails closed.
    const r = parseSignal(
      '{"confidence": 0.9, "shouldEnter": "false", "reason": "coerced string"}',
    );
    expect(r.shouldEnter).toBe(false);
    expect(r.confidence).toBe(0);
    expect(r.reason).toMatch(/schema violation/i);
  });

  it('REJECTS the string "true" as shouldEnter', () => {
    const r = parseSignal(
      '{"confidence": 0.9, "shouldEnter": "true", "reason": "coerced string"}',
    );
    expect(r.shouldEnter).toBe(false);
    expect(r.reason).toMatch(/schema violation/i);
  });

  it('rejects confidence outside 0..1', () => {
    expect(parseSignal('{"confidence": 1.5, "shouldEnter": true, "reason": "x"}').shouldEnter).toBe(
      false,
    );
    expect(
      parseSignal('{"confidence": -0.1, "shouldEnter": true, "reason": "x"}').shouldEnter,
    ).toBe(false);
  });

  it('rejects non-finite confidence', () => {
    expect(parseSignal('{"confidence": null, "shouldEnter": true, "reason": "x"}').shouldEnter).toBe(
      false,
    );
  });

  it('rejects empty reason', () => {
    expect(parseSignal('{"confidence": 0.5, "shouldEnter": true, "reason": ""}').shouldEnter).toBe(
      false,
    );
  });

  it('fails closed on missing JSON', () => {
    expect(parseSignal('no json here').shouldEnter).toBe(false);
  });

  it('fails closed on malformed JSON', () => {
    expect(parseSignal('{confidence: broken,,}').shouldEnter).toBe(false);
  });

  it('fails closed on missing shouldEnter field', () => {
    expect(parseSignal('{"confidence": 0.9, "reason": "x"}').shouldEnter).toBe(false);
  });
});
