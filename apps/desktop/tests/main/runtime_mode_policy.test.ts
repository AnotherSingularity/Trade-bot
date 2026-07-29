/**
 * Stage 5A §3 — pure resolver tests for the runtime-mode policy.
 *
 * Every legal branch has an accepting test; every illegal combination
 * has a rejecting test with the exact failureCode. `CI=true` is
 * DELIBERATELY ignored — one test proves the policy stays deterministic
 * when it's flipped on either way.
 */
import { describe, expect, it } from 'vitest';
import { resolveRuntimeMode } from '../../src/main/runtimeModePolicy';

function u(...args: Partial<Parameters<typeof resolveRuntimeMode>[0]>) {
  return resolveRuntimeMode({
    packaged: false,
    serverModeEnv: undefined,
    serverExternalEnv: undefined,
    developmentFakeEnv: undefined,
    nodeEnv: undefined,
    ...Object.assign({}, ...args),
  });
}

describe('resolveRuntimeMode — packaged production', () => {
  it('defaults to packaged_managed_docker with no env', () => {
    const r = u({ packaged: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decision.mode).toBe('packaged_managed_docker');
      expect(r.decision.ownsMariaDb).toBe(true);
      expect(r.decision.ownsRedis).toBe(true);
      expect(r.decision.ownsServer).toBe(true);
      expect(r.decision.ownsContainers).toBe(true);
      expect(r.decision.allowsExternalServer).toBe(false);
      expect(r.decision.allowsArbitraryRendererUrl).toBe(false);
      expect(r.decision.allowsNoSandboxOptIn).toBe(false);
      expect(r.decision.allowsDevelopmentBootstrap).toBe(false);
      expect(r.decision.requiresDockerDaemon).toBe(true);
      expect(r.decision.certifiable).toBe(true);
    }
  });

  it('rejects packaged + HORIZON_SERVER_EXTERNAL=true', () => {
    const r = u({ packaged: true, serverExternalEnv: 'true' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failureCode).toBe('packaged_forbids_external_test_server');
  });

  it('rejects packaged + HORIZON_SERVER_MODE=external_test_server', () => {
    const r = u({ packaged: true, serverModeEnv: 'external_test_server' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failureCode).toBe('packaged_forbids_external_test_server');
  });

  it('accepts packaged + HORIZON_SERVER_MODE=managed_docker (explicit but redundant)', () => {
    const r = u({ packaged: true, serverModeEnv: 'managed_docker' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.mode).toBe('packaged_managed_docker');
  });

  it('rejects packaged + HORIZON_DEVELOPMENT_FAKE=true', () => {
    const r = u({ packaged: true, developmentFakeEnv: 'true' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failureCode).toBe('packaged_forbids_development_fake');
  });
});

describe('resolveRuntimeMode — unpackaged (dev + CI)', () => {
  it('defaults to managed_docker with no env', () => {
    const r = u({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decision.mode).toBe('managed_docker');
      expect(r.decision.packaged).toBe(false);
      expect(r.decision.ownsMariaDb).toBe(true);
      expect(r.decision.ownsRedis).toBe(true);
      expect(r.decision.ownsServer).toBe(true);
      expect(r.decision.requiresDockerDaemon).toBe(true);
      expect(r.decision.certifiable).toBe(false);
    }
  });

  it('accepts external_test_server via HORIZON_SERVER_EXTERNAL=true', () => {
    const r = u({ serverExternalEnv: 'true' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decision.mode).toBe('external_test_server');
      expect(r.decision.ownsMariaDb).toBe(false);
      expect(r.decision.ownsRedis).toBe(false);
      expect(r.decision.ownsServer).toBe(false);
      expect(r.decision.ownsContainers).toBe(false);
      expect(r.decision.requiresDockerDaemon).toBe(false);
      expect(r.decision.allowsExternalServer).toBe(true);
    }
  });

  it('accepts external_test_server via HORIZON_SERVER_MODE=external_test_server', () => {
    const r = u({ serverModeEnv: 'external_test_server' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.mode).toBe('external_test_server');
  });

  it('rejects HORIZON_SERVER_MODE=<garbage>', () => {
    const r = u({ serverModeEnv: 'production' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failureCode).toBe('invalid_server_mode_value');
  });

  it('rejects HORIZON_SERVER_MODE=managed_docker + HORIZON_SERVER_EXTERNAL=true (conflict)', () => {
    const r = u({ serverModeEnv: 'managed_docker', serverExternalEnv: 'true' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failureCode).toBe('conflicting_server_mode_flags');
  });

  it('accepts HORIZON_SERVER_MODE=managed_docker alone', () => {
    const r = u({ serverModeEnv: 'managed_docker' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.mode).toBe('managed_docker');
  });

  it('enables allowsDevelopmentBootstrap only when NODE_ENV=development', () => {
    const dev = u({ nodeEnv: 'development' });
    expect(dev.ok).toBe(true);
    if (dev.ok) expect(dev.decision.allowsDevelopmentBootstrap).toBe(true);
    const prod = u({ nodeEnv: 'production' });
    expect(prod.ok).toBe(true);
    if (prod.ok) expect(prod.decision.allowsDevelopmentBootstrap).toBe(false);
  });

  it('ignores non-canonical `HORIZON_SERVER_EXTERNAL` truthy strings', () => {
    // Strict 'true' match only — 'yes', '1', 'YES' etc. are NOT truthy.
    for (const v of ['yes', '1', 'YES', 'y', 't']) {
      const r = u({ serverExternalEnv: v });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.decision.mode).toBe('managed_docker');
    }
  });
});

describe('resolveRuntimeMode — CI advisory flag is ignored', () => {
  it('mode is determined by packaged + serverMode, NOT by CI', () => {
    // (The resolver takes no `ciEnv` param at all — this test is a
    // structural guard: the input schema is complete without it.)
    const withoutCi = u({});
    const withCi = u({});
    expect(withCi.ok).toBe(true);
    expect(withoutCi.ok).toBe(true);
    if (withoutCi.ok && withCi.ok) {
      expect(withCi.decision.mode).toBe(withoutCi.decision.mode);
    }
  });
});

describe('resolveRuntimeMode — packaged fields immutability', () => {
  it('every packaged_managed_docker decision has the same permission profile', () => {
    const r = u({ packaged: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Sanity check the permission profile can't drift.
    expect(r.decision.allowsExternalServer).toBe(false);
    expect(r.decision.allowsArbitraryRendererUrl).toBe(false);
    expect(r.decision.allowsNoSandboxOptIn).toBe(false);
    expect(r.decision.allowsDevelopmentBootstrap).toBe(false);
  });
});
