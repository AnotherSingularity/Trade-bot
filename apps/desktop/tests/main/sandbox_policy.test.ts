/**
 * Stage 3C-ENV — sandbox policy unit tests.
 *
 * The resolver is pure — no Electron mock needed. Every branch of
 * resolveSandboxPolicy MUST be locked in so a future refactor that
 * weakens the guard trips the suite before it ships.
 */
import { describe, expect, it } from 'vitest';
import {
  SANDBOX_DISABLE_SWITCHES,
  resolveSandboxPolicy,
} from '../../src/main/localEnvironment';

describe('Stage 3C-ENV — resolveSandboxPolicy', () => {
  it('S1: packaged build always keeps sandbox even with opt-in env', () => {
    const d = resolveSandboxPolicy({
      isPackaged: true,
      nodeEnv: 'production',
      envOptIn: 'true',
      isDevelopmentFake: false,
    });
    expect(d.disableSandbox).toBe(false);
    expect(d.reason).toBe('production_hardening');
    expect(d.appliedSwitches).toEqual([]);
  });

  it('S2: packaged wins even when NODE_ENV=test + opt-in are present', () => {
    const d = resolveSandboxPolicy({
      isPackaged: true,
      nodeEnv: 'test',
      envOptIn: 'true',
      isDevelopmentFake: false,
    });
    expect(d.disableSandbox).toBe(false);
    expect(d.reason).toBe('production_hardening');
  });

  it('S3: unpackaged + NODE_ENV=test + opt-in=true → sandbox disabled (test-only)', () => {
    const d = resolveSandboxPolicy({
      isPackaged: false,
      nodeEnv: 'test',
      envOptIn: 'true',
      isDevelopmentFake: false,
    });
    expect(d.disableSandbox).toBe(true);
    expect(d.reason).toBe('test_only_xvfb_opt_in');
    expect(d.appliedSwitches).toEqual(['no-sandbox', 'disable-gpu-sandbox', 'disable-dev-shm-usage']);
  });

  it('S4: unpackaged + NODE_ENV=production + opt-in=true → still hardened (test-only gate)', () => {
    const d = resolveSandboxPolicy({
      isPackaged: false,
      nodeEnv: 'production',
      envOptIn: 'true',
      isDevelopmentFake: false,
    });
    expect(d.disableSandbox).toBe(false);
    expect(d.reason).toBe('default_hardened');
    expect(d.appliedSwitches).toEqual([]);
  });

  it('S5: unpackaged + no opt-in → default hardened', () => {
    const d = resolveSandboxPolicy({
      isPackaged: false,
      nodeEnv: 'development',
      envOptIn: undefined,
      isDevelopmentFake: false,
    });
    expect(d.disableSandbox).toBe(false);
    expect(d.reason).toBe('default_hardened');
  });

  it("S6: non-canonical env opt-in values ('1'/'yes'/'YES'/'TRUE') are REJECTED — strict 'true' only", () => {
    for (const v of ['1', 'yes', 'YES', 'TRUE', 'True', ' true', 'true ', 'True', '']) {
      const d = resolveSandboxPolicy({
        isPackaged: false,
        nodeEnv: 'test',
        envOptIn: v,
        isDevelopmentFake: false,
      });
      expect(d.disableSandbox, `envOptIn=${JSON.stringify(v)} must not disable sandbox`).toBe(false);
      expect(d.reason).toBe('default_hardened');
    }
  });

  it('S7: SANDBOX_DISABLE_SWITCHES is a frozen deterministic tuple', () => {
    expect(Object.isFrozen(SANDBOX_DISABLE_SWITCHES)).toBe(true);
    expect(SANDBOX_DISABLE_SWITCHES).toEqual(['no-sandbox', 'disable-gpu-sandbox', 'disable-dev-shm-usage']);
    // Cast around readonly to prove immutability enforcement.
    expect(() => {
      (SANDBOX_DISABLE_SWITCHES as unknown as string[]).push('extra-switch');
    }).toThrow();
  });

  it('S8: HORIZON_DEVELOPMENT_FAKE=true blocks sandbox disable even when test-only inputs match', () => {
    const d = resolveSandboxPolicy({
      isPackaged: false,
      nodeEnv: 'test',
      envOptIn: 'true',
      isDevelopmentFake: true,
    });
    expect(d.disableSandbox).toBe(false);
    expect(d.reason).toBe('default_hardened');
  });
});
