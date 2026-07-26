/**
 * Stage 2 §2 — Bootstrap token generator (desktop side).
 */
import { describe, expect, it } from 'vitest';
import { mintBootstrapToken } from '../src/main/bootstrapToken';

describe('stage2 §2 desktop bootstrap token', () => {
  it('BT1: mints a 256-bit hex string (64 chars)', () => {
    const h = mintBootstrapToken();
    expect(h.headerValue).toMatch(/^[0-9a-f]{64}$/);
  });

  it('BT2: header and env values are identical for the same token', () => {
    const h = mintBootstrapToken();
    expect(h.headerValue).toBe(h.envValue);
  });

  it('BT3: two mints produce different tokens (randomBytes)', () => {
    const a = mintBootstrapToken();
    const b = mintBootstrapToken();
    expect(a.headerValue).not.toBe(b.headerValue);
  });

  it('BT4: destroy clears the token and future access throws', () => {
    const h = mintBootstrapToken();
    h.destroy();
    expect(() => h.headerValue).toThrow(/destroyed/);
    expect(() => h.envValue).toThrow(/destroyed/);
  });
});
