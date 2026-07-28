/**
 * Stage 3C-CI-RESET Part 2 Checkpoint D.1 + D.14 items 1..10 —
 * induction-controller policy unit tests.
 *
 * These exercise the pure `decideNativeInductionPolicy` gate plus
 * the shared Zod schemas. The server-side HTTP layer is tested by
 * the external suite (real MariaDB not required — the induction
 * router is pure JS + in-memory state).
 */

import { describe, expect, it } from 'vitest';
import {
  NATIVE_INDUCTION_MODES,
  NATIVE_INDUCTION_ROUTE_KEYS,
  NativeInductionActivateRequestSchema,
  NativeInductionClearRequestSchema,
  decideNativeInductionPolicy,
} from '@horizon/shared';

const OK_NONCE = 'a'.repeat(16);
const OK_ACTIVATE = {
  mode: 'stale_response' as const,
  routeKey: 'reconciliationStatus' as const,
  nonce: OK_NONCE,
  ttlMs: 30_000,
};

describe('Stage 3C-CI-RESET Part 2 Checkpoint D.1 — induction policy', () => {
  it('P1: disabled outside strict test mode (NODE_ENV=production)', () => {
    const d = decideNativeInductionPolicy({ nodeEnv: 'production', nativeDiagnostics: 'true', serverExternal: 'true', isPackaged: false });
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error('narrowing');
    expect(d.reason).toBe('policy_disabled_not_test_mode');
  });

  it('P2: disabled in packaged mode (isPackaged=true overrides every other gate)', () => {
    const d = decideNativeInductionPolicy({ nodeEnv: 'test', nativeDiagnostics: 'true', serverExternal: 'true', isPackaged: true });
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error('narrowing');
    expect(d.reason).toBe('policy_disabled_packaged');
  });

  it('P3: disabled when diagnostics flag is off', () => {
    const d = decideNativeInductionPolicy({ nodeEnv: 'test', nativeDiagnostics: undefined, serverExternal: 'true', isPackaged: false });
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error('narrowing');
    expect(d.reason).toBe('policy_disabled_diagnostics_off');
  });

  it('P4: disabled when server-external flag is off', () => {
    const d = decideNativeInductionPolicy({ nodeEnv: 'test', nativeDiagnostics: 'true', serverExternal: 'false', isPackaged: false });
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error('narrowing');
    expect(d.reason).toBe('policy_disabled_server_not_external');
  });

  it('P5: allowed only when every gate is set correctly', () => {
    const d = decideNativeInductionPolicy({ nodeEnv: 'test', nativeDiagnostics: 'true', serverExternal: 'true', isPackaged: false });
    expect(d.allowed).toBe(true);
  });

  it('P6: strict "true" match — "1", "yes", "TRUE" are not permitted', () => {
    for (const val of ['1', 'yes', 'TRUE', 'True', 'on']) {
      const d = decideNativeInductionPolicy({ nodeEnv: 'test', nativeDiagnostics: val, serverExternal: 'true', isPackaged: false });
      expect(d.allowed, `native-diagnostics='${val}'`).toBe(false);
    }
  });

  it('P7: activate schema rejects unknown mode', () => {
    const r = NativeInductionActivateRequestSchema.safeParse({ ...OK_ACTIVATE, mode: 'blow_up' });
    expect(r.success).toBe(false);
  });

  it('P8: activate schema rejects mode="none"', () => {
    const r = NativeInductionActivateRequestSchema.safeParse({ ...OK_ACTIVATE, mode: 'none' });
    expect(r.success).toBe(false);
  });

  it('P9: activate schema rejects non-allowlisted route (auth/order/config)', () => {
    for (const bad of ['authLogin', 'createOrder', 'championConfiguration', 'authSession']) {
      const r = NativeInductionActivateRequestSchema.safeParse({ ...OK_ACTIVATE, routeKey: bad });
      expect(r.success, `routeKey='${bad}'`).toBe(false);
    }
  });

  it('P10: activate schema requires 16..64 url-safe nonce', () => {
    for (const bad of ['', 'short', 'a'.repeat(15), 'a'.repeat(65), '💥'.repeat(16), 'has spaces here']) {
      const r = NativeInductionActivateRequestSchema.safeParse({ ...OK_ACTIVATE, nonce: bad });
      expect(r.success, `nonce='${bad.slice(0, 30)}'`).toBe(false);
    }
  });

  it('P11: activate schema honours ttlMs bounds (1s..300s)', () => {
    expect(NativeInductionActivateRequestSchema.safeParse({ ...OK_ACTIVATE, ttlMs: 500 }).success).toBe(false);
    expect(NativeInductionActivateRequestSchema.safeParse({ ...OK_ACTIVATE, ttlMs: 400_000 }).success).toBe(false);
    expect(NativeInductionActivateRequestSchema.safeParse({ ...OK_ACTIVATE, ttlMs: 60_000 }).success).toBe(true);
  });

  it('P12: clear schema requires nonce', () => {
    expect(NativeInductionClearRequestSchema.safeParse({}).success).toBe(false);
    expect(NativeInductionClearRequestSchema.safeParse({ nonce: OK_NONCE }).success).toBe(true);
  });

  it('P13: mode list is exhaustive + immutable at the type level', () => {
    expect(NATIVE_INDUCTION_MODES).toEqual(['none', 'stale_response', 'degraded_response', 'unavailable_response', 'contract_mismatch']);
    // NATIVE_INDUCTION_MODES is `as const`; frozen at runtime is a
    // documentation guarantee, not a runtime one, but the tuple
    // shape must not drift.
    expect(NATIVE_INDUCTION_MODES.length).toBe(5);
  });

  it('P14: allowlisted routes are read-only observers — no auth/order/safety keys', () => {
    for (const key of NATIVE_INDUCTION_ROUTE_KEYS) {
      expect(key).not.toMatch(/^auth/);
      expect(key).not.toMatch(/order/i);
      expect(key).not.toMatch(/safety/i);
      expect(key).not.toMatch(/coinbase/i);
      expect(key).not.toMatch(/configuration/i);
    }
  });
});
