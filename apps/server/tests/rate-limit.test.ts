import { beforeEach, describe, expect, it } from 'vitest';
import { checkLoginRate, resetLoginRateLimiter } from '../src/lib/services';

beforeEach(() => resetLoginRateLimiter());

describe('login rate limiter', () => {
  it('allows the configured number of attempts per minute', () => {
    for (let i = 0; i < 10; i++) {
      const r = checkLoginRate('1.1.1.1');
      expect(r.allowed).toBe(true);
    }
    // 11th attempt should be denied.
    expect(checkLoginRate('1.1.1.1').allowed).toBe(false);
  });

  it('locks the IP hard after 3× the limit', () => {
    for (let i = 0; i < 30; i++) checkLoginRate('2.2.2.2');
    const r = checkLoginRate('2.2.2.2');
    expect(r.allowed).toBe(false);
    expect(r.lockedUntil).toBeGreaterThan(0);
  });

  it('separate IPs have separate buckets', () => {
    for (let i = 0; i < 10; i++) checkLoginRate('3.3.3.3');
    expect(checkLoginRate('3.3.3.3').allowed).toBe(false);
    expect(checkLoginRate('4.4.4.4').allowed).toBe(true);
  });
});
