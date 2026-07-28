/**
 * Stage 3C-CI-FIX9 §8 — bootstrap-token authority regression tests.
 *
 * The FIX8 native CI run failed with `state_status_401` from the
 * bootstrap-scoped desktop API path. Root cause: Electron main
 * called `mintBootstrapToken()` unconditionally while the native
 * harness had already spawned the server with a different token.
 * These tests lock in the FIX9 authority policy:
 *   - production/desktop-owned server → mint a fresh token
 *   - strict unpackaged native-test mode → import HORIZON_BOOTSTRAP_TOKEN
 *   - packaged / production / non-canonical envs → refuse to import
 */
import { describe, expect, it } from 'vitest';
import {
  importBootstrapToken,
  isExternalNativeTestMode,
  mintBootstrapToken,
  resolveBootstrapTokenAuthority,
  type ExternalBootstrapImportInput,
} from '../../src/main/bootstrapToken';

const VALID_HEX = 'a'.repeat(64);
const VALID_HEX_2 = '0123456789abcdef'.repeat(4);

describe('Stage 3C-CI-FIX9 §1 — bootstrap-token authority', () => {
  describe('mintBootstrapToken (desktop-owned server)', () => {
    it('mints a 64-hex-char token', () => {
      const t = mintBootstrapToken();
      expect(t.envValue).toMatch(/^[a-f0-9]{64}$/);
      expect(t.headerValue).toBe(t.envValue);
      expect(t.source).toBe('minted_desktop_owned');
      t.destroy();
    });

    it('each mint produces a distinct value', () => {
      const a = mintBootstrapToken();
      const b = mintBootstrapToken();
      expect(a.envValue).not.toBe(b.envValue);
      a.destroy();
      b.destroy();
    });

    it('destroyed token cannot be read', () => {
      const t = mintBootstrapToken();
      t.destroy();
      expect(() => t.envValue).toThrow(/destroyed/);
      expect(() => t.headerValue).toThrow(/destroyed/);
    });
  });

  describe('importBootstrapToken (strict external native-test mode)', () => {
    const baseline: ExternalBootstrapImportInput = {
      isPackaged: false,
      nodeEnv: 'test',
      nativeDiagnostics: 'true',
      serverExternal: 'true',
      envBootstrapToken: VALID_HEX,
    };

    it('imports the exact env token', () => {
      const t = importBootstrapToken(baseline);
      expect(t.envValue).toBe(VALID_HEX);
      expect(t.headerValue).toBe(VALID_HEX);
      expect(t.source).toBe('imported_external_test');
    });

    it('supports mixed-case hex tokens', () => {
      const t = importBootstrapToken({ ...baseline, envBootstrapToken: VALID_HEX_2.toUpperCase() });
      expect(t.envValue).toBe(VALID_HEX_2.toUpperCase());
    });

    it('rejects packaged mode structurally', () => {
      expect(() => importBootstrapToken({ ...baseline, isPackaged: true })).toThrow(/external_server_mode_forbidden_packaged/);
    });

    it('rejects non-test NODE_ENV', () => {
      expect(() => importBootstrapToken({ ...baseline, nodeEnv: 'production' })).toThrow(/external_server_mode_requires_test_policy/);
      expect(() => importBootstrapToken({ ...baseline, nodeEnv: 'development' })).toThrow(/external_server_mode_requires_test_policy/);
      expect(() => importBootstrapToken({ ...baseline, nodeEnv: undefined })).toThrow(/external_server_mode_requires_test_policy/);
    });

    it('rejects HORIZON_NATIVE_DIAGNOSTICS ≠ true', () => {
      expect(() => importBootstrapToken({ ...baseline, nativeDiagnostics: undefined })).toThrow(/external_server_mode_requires_test_policy/);
      expect(() => importBootstrapToken({ ...baseline, nativeDiagnostics: 'yes' })).toThrow(/external_server_mode_requires_test_policy/);
      expect(() => importBootstrapToken({ ...baseline, nativeDiagnostics: '1' })).toThrow(/external_server_mode_requires_test_policy/);
    });

    it('rejects HORIZON_SERVER_EXTERNAL ≠ true', () => {
      expect(() => importBootstrapToken({ ...baseline, serverExternal: undefined })).toThrow(/external_server_mode_requires_test_policy/);
      expect(() => importBootstrapToken({ ...baseline, serverExternal: 'false' })).toThrow(/external_server_mode_requires_test_policy/);
    });

    it('rejects missing token', () => {
      expect(() => importBootstrapToken({ ...baseline, envBootstrapToken: undefined })).toThrow(/external_bootstrap_token_missing/);
      expect(() => importBootstrapToken({ ...baseline, envBootstrapToken: '' })).toThrow(/external_bootstrap_token_missing/);
    });

    it('rejects token of wrong length or non-hex characters', () => {
      expect(() => importBootstrapToken({ ...baseline, envBootstrapToken: 'a'.repeat(63) })).toThrow(/external_bootstrap_token_invalid/);
      expect(() => importBootstrapToken({ ...baseline, envBootstrapToken: 'a'.repeat(65) })).toThrow(/external_bootstrap_token_invalid/);
      expect(() => importBootstrapToken({ ...baseline, envBootstrapToken: 'g'.repeat(64) })).toThrow(/external_bootstrap_token_invalid/);
      expect(() => importBootstrapToken({ ...baseline, envBootstrapToken: ` ${VALID_HEX}` })).toThrow(/external_bootstrap_token_invalid/);
    });

    it('never includes the token value in the error message', () => {
      try {
        importBootstrapToken({ ...baseline, envBootstrapToken: 'z'.repeat(64) });
      } catch (e) {
        const msg = String(e);
        expect(msg).not.toContain('zzzz');
      }
    });
  });

  describe('isExternalNativeTestMode gate', () => {
    it('returns true only when all four conditions align', () => {
      expect(isExternalNativeTestMode({
        isPackaged: false, nodeEnv: 'test', nativeDiagnostics: 'true', serverExternal: 'true', envBootstrapToken: VALID_HEX,
      })).toBe(true);
    });

    it('any single violation flips it to false', () => {
      const good: ExternalBootstrapImportInput = {
        isPackaged: false, nodeEnv: 'test', nativeDiagnostics: 'true', serverExternal: 'true', envBootstrapToken: VALID_HEX,
      };
      expect(isExternalNativeTestMode({ ...good, isPackaged: true })).toBe(false);
      expect(isExternalNativeTestMode({ ...good, nodeEnv: 'production' })).toBe(false);
      expect(isExternalNativeTestMode({ ...good, nativeDiagnostics: 'false' })).toBe(false);
      expect(isExternalNativeTestMode({ ...good, serverExternal: 'false' })).toBe(false);
    });
  });

  describe('resolveBootstrapTokenAuthority (unified entry)', () => {
    it('mints when NOT in external native-test mode', () => {
      const t = resolveBootstrapTokenAuthority({
        isPackaged: false, nodeEnv: 'development', nativeDiagnostics: undefined,
        serverExternal: undefined, envBootstrapToken: undefined,
      });
      expect(t.source).toBe('minted_desktop_owned');
      expect(t.envValue).toMatch(/^[a-f0-9]{64}$/);
    });

    it('imports when in external native-test mode', () => {
      const t = resolveBootstrapTokenAuthority({
        isPackaged: false, nodeEnv: 'test', nativeDiagnostics: 'true',
        serverExternal: 'true', envBootstrapToken: VALID_HEX,
      });
      expect(t.source).toBe('imported_external_test');
      expect(t.envValue).toBe(VALID_HEX);
    });

    it('packaged mode with all other flags true → still mints (never imports)', () => {
      const t = resolveBootstrapTokenAuthority({
        isPackaged: true, nodeEnv: 'test', nativeDiagnostics: 'true',
        serverExternal: 'true', envBootstrapToken: VALID_HEX,
      });
      // Packaged installers never accept an env-supplied bootstrap
      // token; the gateway falls through to mintBootstrapToken.
      expect(t.source).toBe('minted_desktop_owned');
      expect(t.envValue).not.toBe(VALID_HEX);
    });
  });
});

describe('Stage 3C-CI-FIX9 §7 — preload marker ordering', () => {
  it('MODULE_ENTERED is emitted AFTER ipcRenderer binding (source-level assertion)', async () => {
    // Read the preload source and prove the module-entered emit call
    // appears after the electron require + sendNativeMarker binding.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const preloadPath = resolve(__dirname, '..', '..', 'src/preload/index.ts');
    const src = readFileSync(preloadPath, 'utf8');
    const requireElectronIdx = src.indexOf('require(\'electron\')');
    const sendNativeBindIdx = src.indexOf('sendNativeMarker = ');
    const moduleEnteredIdx = src.indexOf('HORIZON_NATIVE_PRELOAD_MODULE_ENTERED');
    expect(requireElectronIdx).toBeGreaterThan(0);
    expect(sendNativeBindIdx).toBeGreaterThan(0);
    expect(moduleEnteredIdx).toBeGreaterThan(0);
    expect(moduleEnteredIdx).toBeGreaterThan(sendNativeBindIdx);
  });
});
