import { describe, expect, it } from 'vitest';
import {
  resolveDesktopEnvironment,
  toSanitizedSnapshot,
  validateDesktopEnvironment,
} from '../src/main/localEnvironment';

describe('phase3a §E — desktop environment invariants', () => {
  it('T1: default resolution enforces DRY_RUN=true and ORDER_SUBMISSION_ENABLED=false', () => {
    const env = resolveDesktopEnvironment({});
    expect(env.DRY_RUN).toBe(true);
    expect(env.ORDER_SUBMISSION_ENABLED).toBe(false);
    const val = validateDesktopEnvironment(env);
    expect(val.ok).toBe(true);
    expect(val.violations).toEqual([]);
  });

  it('T2: validation rejects DRY_RUN=false', () => {
    const env = resolveDesktopEnvironment({ DRY_RUN: 'false' });
    const val = validateDesktopEnvironment(env);
    expect(val.ok).toBe(false);
    expect(val.violations).toContain('DRY_RUN must be true');
  });

  it('T3: validation rejects ORDER_SUBMISSION_ENABLED=true', () => {
    const env = resolveDesktopEnvironment({ ORDER_SUBMISSION_ENABLED: 'true' });
    const val = validateDesktopEnvironment(env);
    expect(val.ok).toBe(false);
    expect(val.violations).toContain('ORDER_SUBMISSION_ENABLED must be false');
  });

  it('T4: validation rejects external provider mode', () => {
    const env = resolveDesktopEnvironment({ HORIZON_PROVIDER_MODE: 'external' });
    const val = validateDesktopEnvironment(env);
    expect(val.ok).toBe(false);
    expect(val.violations).toContain('production providers must remain inactive during Phase 3A');
  });

  it('T5: sanitized snapshot refuses to serialize an invalid environment', () => {
    const env = resolveDesktopEnvironment({ DRY_RUN: 'false' });
    expect(() => toSanitizedSnapshot(env)).toThrow(/invariants violated/);
  });

  it('T6: sanitized snapshot pins DRY_RUN=true and ORDER_SUBMISSION_ENABLED=false as literals', () => {
    const env = resolveDesktopEnvironment({});
    const snap = toSanitizedSnapshot(env);
    expect(snap.DRY_RUN).toBe(true);
    expect(snap.ORDER_SUBMISSION_ENABLED).toBe(false);
    expect(snap).not.toHaveProperty('coinbaseKey');
    expect(snap).not.toHaveProperty('apiSecret');
    expect(snap).not.toHaveProperty('password');
  });
});
