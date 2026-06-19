import { describe, it, expect } from 'vitest';
import { parseSignal } from '../src/trading/claude';

describe('parseSignal', () => {
  it('parses a clean JSON response', () => {
    const result = parseSignal('{"confidence": 0.81, "shouldEnter": true, "reason": "Strong setup"}');
    expect(result.confidence).toBeCloseTo(0.81);
    expect(result.shouldEnter).toBe(true);
    expect(result.reason).toBe('Strong setup');
  });

  it('extracts JSON wrapped in prose', () => {
    const result = parseSignal(
      'Here is my assessment: {"confidence": 0.4, "shouldEnter": false, "reason": "Weak volume"} hope that helps',
    );
    expect(result.shouldEnter).toBe(false);
    expect(result.confidence).toBeCloseTo(0.4);
  });

  it('clamps confidence to 0..1', () => {
    expect(parseSignal('{"confidence": 1.5, "shouldEnter": true, "reason": "x"}').confidence).toBe(1);
    expect(parseSignal('{"confidence": -2, "shouldEnter": false, "reason": "x"}').confidence).toBe(0);
  });

  it('falls back safely on unparseable input', () => {
    const result = parseSignal('no json here');
    expect(result.shouldEnter).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it('falls back safely on malformed json', () => {
    const result = parseSignal('{confidence: broken,,}');
    expect(result.shouldEnter).toBe(false);
  });
});
