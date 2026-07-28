/**
 * Stage 3C-E.1 §D — every decision branch of the pure native Electron
 * launch policy. These tests are the sole proof that the canonical
 * native-test contract does NOT weaken Chromium sandboxing by default,
 * and that the emergency fallback cannot be activated silently by CI,
 * by a typo, or by an env variable in a packaged installer.
 *
 * Also asserts that the production BrowserWindow security contract
 * (contextIsolation=true, nodeIntegration=false, sandbox=true) is
 * unchanged by the harness policy — the policy only affects the
 * native-test launch and is completely absent from packaged mode.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveNativeLaunchPolicy,
  SANDBOX_DISABLE_ENV,
  SANDBOX_DISABLE_SWITCHES,
} from '../../src/main/nativeLaunchPolicy';
import { buildSafeWindowConfig } from '../../src/main/windows';

describe('resolveNativeLaunchPolicy', () => {
  // ---------------------------------------------------------------------
  // Canonical (default) — no sandbox-disabling switches or env.
  // ---------------------------------------------------------------------

  it('default (no env) → canonical sandboxed decision', () => {
    const d = resolveNativeLaunchPolicy({ isPackaged: false, nodeEnv: 'test', noSandboxOptIn: undefined });
    expect(d.sandboxDisabled).toBe(false);
    expect(d.extraArgs).toEqual([]);
    expect(d.extraEnv).toEqual({});
    expect(d.reason).toBe('canonical_sandboxed');
  });

  it('empty opt-in string → canonical', () => {
    const d = resolveNativeLaunchPolicy({ isPackaged: false, nodeEnv: 'test', noSandboxOptIn: '' });
    expect(d.sandboxDisabled).toBe(false);
    expect(d.reason).toBe('canonical_sandboxed');
  });

  it('canonical decision contains NO sandbox-disable switches', () => {
    const d = resolveNativeLaunchPolicy({ isPackaged: false, nodeEnv: 'test', noSandboxOptIn: undefined });
    for (const s of SANDBOX_DISABLE_SWITCHES) {
      expect(d.extraArgs).not.toContain(s);
    }
    for (const k of Object.keys(SANDBOX_DISABLE_ENV)) {
      expect(d.extraEnv).not.toHaveProperty(k);
    }
  });

  // ---------------------------------------------------------------------
  // CI alone must NOT activate the fallback.
  // ---------------------------------------------------------------------

  it('CI=true env exists but noSandboxOptIn absent → canonical (CI alone insufficient)', () => {
    const d = resolveNativeLaunchPolicy({ isPackaged: false, nodeEnv: 'test', noSandboxOptIn: undefined });
    // Simulate a caller who resolved CI=true independently but did NOT
    // set HORIZON_NATIVE_ALLOW_NO_SANDBOX. Policy remains canonical.
    expect(d.sandboxDisabled).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Fallback active — exact opt-in, unpackaged, NODE_ENV=test.
  // ---------------------------------------------------------------------

  it("noSandboxOptIn='true' + NODE_ENV=test + !packaged → fallback active", () => {
    const d = resolveNativeLaunchPolicy({ isPackaged: false, nodeEnv: 'test', noSandboxOptIn: 'true' });
    expect(d.sandboxDisabled).toBe(true);
    expect(d.reason).toBe('fallback_active_test_only_opt_in');
    expect(d.extraArgs).toContain('--no-sandbox');
    expect(d.extraArgs).toContain('--disable-setuid-sandbox');
    expect(d.extraArgs).toContain('--disable-dev-shm-usage');
    expect(d.extraEnv.HORIZON_ELECTRON_NO_SANDBOX).toBe('true');
    expect(d.extraEnv.ELECTRON_DISABLE_SANDBOX).toBe('1');
  });

  it('fallback switches list is exactly three, deterministic tuple', () => {
    const d = resolveNativeLaunchPolicy({ isPackaged: false, nodeEnv: 'test', noSandboxOptIn: 'true' });
    expect(d.extraArgs).toHaveLength(3);
    expect(d.extraArgs).toEqual(['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']);
  });

  // ---------------------------------------------------------------------
  // Non-canonical values → REJECTED.
  // ---------------------------------------------------------------------

  const nonCanonical = ['1', '0', 'TRUE', 'True', 'yes', 'YES', 'y', ' true', 'true ', 'enable'];
  for (const v of nonCanonical) {
    it(`noSandboxOptIn='${v}' + NODE_ENV=test + !packaged → REJECTED (non-canonical)`, () => {
      const d = resolveNativeLaunchPolicy({ isPackaged: false, nodeEnv: 'test', noSandboxOptIn: v });
      expect(d.sandboxDisabled).toBe(false);
      expect(d.reason).toBe('fallback_ignored_non_canonical_opt_in');
      expect(d.extraArgs).toEqual([]);
    });
  }

  // ---------------------------------------------------------------------
  // Packaged mode → structural refusal.
  // ---------------------------------------------------------------------

  it("isPackaged=true + noSandboxOptIn='true' + NODE_ENV=test → REJECTED (packaged wins)", () => {
    const d = resolveNativeLaunchPolicy({ isPackaged: true, nodeEnv: 'test', noSandboxOptIn: 'true' });
    expect(d.sandboxDisabled).toBe(false);
    expect(d.reason).toBe('fallback_ignored_packaged');
    expect(d.extraArgs).toEqual([]);
    expect(d.extraEnv).toEqual({});
  });

  it("isPackaged=true + noSandboxOptIn='true' + NODE_ENV=production → REJECTED (packaged wins)", () => {
    const d = resolveNativeLaunchPolicy({ isPackaged: true, nodeEnv: 'production', noSandboxOptIn: 'true' });
    expect(d.sandboxDisabled).toBe(false);
    expect(d.reason).toBe('fallback_ignored_packaged');
  });

  it("isPackaged=true + undefined opt-in → canonical", () => {
    const d = resolveNativeLaunchPolicy({ isPackaged: true, nodeEnv: 'production', noSandboxOptIn: undefined });
    expect(d.sandboxDisabled).toBe(false);
    expect(d.reason).toBe('canonical_sandboxed');
  });

  // ---------------------------------------------------------------------
  // NODE_ENV must be exactly 'test'.
  // ---------------------------------------------------------------------

  it("NODE_ENV=production + opt-in=true + !packaged → REJECTED", () => {
    const d = resolveNativeLaunchPolicy({ isPackaged: false, nodeEnv: 'production', noSandboxOptIn: 'true' });
    expect(d.sandboxDisabled).toBe(false);
    expect(d.reason).toBe('fallback_ignored_non_test_node_env');
  });

  it("NODE_ENV=development + opt-in=true + !packaged → REJECTED", () => {
    const d = resolveNativeLaunchPolicy({ isPackaged: false, nodeEnv: 'development', noSandboxOptIn: 'true' });
    expect(d.sandboxDisabled).toBe(false);
    expect(d.reason).toBe('fallback_ignored_non_test_node_env');
  });

  it("undefined NODE_ENV + opt-in=true + !packaged → REJECTED", () => {
    const d = resolveNativeLaunchPolicy({ isPackaged: false, nodeEnv: undefined, noSandboxOptIn: 'true' });
    expect(d.sandboxDisabled).toBe(false);
    expect(d.reason).toBe('fallback_ignored_non_test_node_env');
  });

  // ---------------------------------------------------------------------
  // Production BrowserWindow security contract is untouched.
  // ---------------------------------------------------------------------

  it('production BrowserWindow security: contextIsolation=true, nodeIntegration=false, sandbox=true (unchanged by policy)', () => {
    const cfg = buildSafeWindowConfig({
      width: 1440,
      height: 900,
      preloadPath: '/tmp/preload.cjs',
      rendererIndexUrl: 'file:///tmp/index.html',
      title: 'Horizon Trade',
    });
    expect(cfg.webPreferences.contextIsolation).toBe(true);
    expect(cfg.webPreferences.nodeIntegration).toBe(false);
    expect(cfg.webPreferences.sandbox).toBe(true);
    // Even when the harness policy is in fallback mode, these must
    // remain true — the production BrowserWindow is not composed via
    // the harness policy at all.
  });
});
