/**
 * Stage 3C-CI-FIX10 §5 — canonical auth contract regression.
 *
 * FIX9's native run failed with `native_auth_login_rejected:unknown`
 * because the harness at nativeElectron.integration.test.ts:236 read
 * `resp.error` — a field that does not exist on AuthOperationResponse.
 * The canonical failure field is `reason` (see AuthOperationResponseSchema
 * in apps/desktop/src/shared/ipcContract.ts and desktopAuthManager.ts).
 *
 * These tests lock the FIX10 contract at three levels so a future
 * refactor cannot silently reintroduce the drift:
 *
 *   §5.1  The shared schema shape — {ok, state, reason} — is stable.
 *   §5.2  IPC_ALLOWLIST wires authLogin ↔ AuthOperationResponseSchema.
 *   §5.3  The native harness reads `resp.reason`, not `resp.error`,
 *         and includes the sanitized state phase in the classification.
 *   §5.4  The native harness's T2 assertion names the canonical
 *         `dist/main/index.cjs` entry, not the pre-FIX8 `.js` path.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AuthLoginRequestSchema, AuthOperationResponseSchema, IPC_ALLOWLIST,
  IPC_CHANNELS, OPERATOR_AUTH_PHASES, SanitizedAuthStateSchema,
} from '../../src/shared/ipcContract';

const NATIVE_TEST = resolve(__dirname, '..', 'native', 'nativeElectron.integration.test.ts');
const NATIVE_SEED = resolve(__dirname, '..', 'native', 'deterministicSeed.ts');

describe('Stage 3C-CI-FIX10 §5.1 — AuthOperationResponse canonical shape', () => {
  it('exposes exactly {ok, state, reason} (strict)', () => {
    const shape = AuthOperationResponseSchema.shape;
    // The three canonical fields. `error` is NOT present — the FIX9
    // regression came from an assumption that this field existed.
    expect(Object.keys(shape).sort()).toEqual(['ok', 'reason', 'state']);
    expect(shape.ok).toBeInstanceOf(z.ZodBoolean);
    expect(shape.reason).toBeInstanceOf(z.ZodNullable);
  });

  it('validates a canonical failure response with reason', () => {
    const parsed = AuthOperationResponseSchema.parse({
      ok: false,
      state: {
        phase: 'unauthenticated', username: null, passwordChangedAt: null,
        accessExpiresAt: null, absoluteExpiresAt: null, lastActivityAt: null,
        failureReason: 'password_mismatch',
      },
      reason: 'password_mismatch',
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('password_mismatch');
  });

  it('rejects a payload carrying a spurious `error` field (strict schema)', () => {
    expect(() => AuthOperationResponseSchema.parse({
      ok: false, state: {
        phase: 'unauthenticated', username: null, passwordChangedAt: null,
        accessExpiresAt: null, absoluteExpiresAt: null, lastActivityAt: null,
        failureReason: null,
      },
      reason: null, error: 'password_mismatch',
    })).toThrow();
  });

  it('SanitizedAuthState declares every OperatorAuthPhase', () => {
    for (const phase of OPERATOR_AUTH_PHASES) {
      const parsed = SanitizedAuthStateSchema.parse({
        phase, username: null, passwordChangedAt: null,
        accessExpiresAt: null, absoluteExpiresAt: null, lastActivityAt: null,
        failureReason: null,
      });
      expect(parsed.phase).toBe(phase);
    }
  });
});

describe('Stage 3C-CI-FIX10 §5.2 — IPC_ALLOWLIST auth wiring', () => {
  it('authLogin uses AuthLoginRequestSchema + AuthOperationResponseSchema', () => {
    const entry = IPC_ALLOWLIST.find((e) => e.channel === IPC_CHANNELS.authLogin);
    expect(entry).toBeDefined();
    expect(entry!.requestSchema).toBe(AuthLoginRequestSchema);
    expect(entry!.responseSchema).toBe(AuthOperationResponseSchema);
    // Bootstrap-safe: the login screen must be reachable pre-auth.
    expect(entry!.requiresAuthenticatedSession).toBe(false);
  });

  it('every auth channel returns AuthOperationResponseSchema (except authGetState)', () => {
    const authChannels: readonly string[] = [
      IPC_CHANNELS.authSetup, IPC_CHANNELS.authLogin, IPC_CHANNELS.authLogout,
      IPC_CHANNELS.authLock, IPC_CHANNELS.authRefresh,
      IPC_CHANNELS.authChangePassword, IPC_CHANNELS.authRevokeAll,
    ];
    for (const channel of authChannels) {
      const entry = IPC_ALLOWLIST.find((e) => e.channel === channel);
      expect(entry, `no allowlist entry for ${channel}`).toBeDefined();
      expect(entry!.responseSchema, `${channel} response schema drift`)
        .toBe(AuthOperationResponseSchema);
    }
    // authGetState is the exception — it returns SanitizedAuthState directly.
    const state = IPC_ALLOWLIST.find((e) => e.channel === IPC_CHANNELS.authGetState);
    expect(state!.responseSchema).toBe(SanitizedAuthStateSchema);
  });
});

describe('Stage 3C-CI-FIX10 §5.3 — native harness classification (source-level)', () => {
  const src = readFileSync(NATIVE_TEST, 'utf8');

  it('performAuthenticatedLogin reads resp.reason (canonical failure field)', () => {
    // Sanity: the function exists and mentions the canonical field.
    expect(src).toContain('function performAuthenticatedLogin');
    expect(src).toContain('resp.reason');
  });

  it('performAuthenticatedLogin does NOT read resp.error (pre-FIX10 defect)', () => {
    // Search for the exact pre-FIX10 pattern that produced `unknown`.
    // Allow the string `error` to appear elsewhere (e.g. bridge_failure
    // classification), but not on the AuthOperationResponse payload.
    expect(src).not.toContain('resp?.error');
    expect(src).not.toContain('r.resp?.error');
    expect(src).not.toContain('.resp.error');
  });

  it('performAuthenticatedLogin surfaces the sanitized state phase on rejection', () => {
    expect(src).toMatch(/native_auth_login_rejected:\$\{[^}]+\}:phase=/);
    expect(src).toMatch(/state_failure_reason=/);
  });

  it('performAuthenticatedLogin has no `as any` cast (typed contract)', () => {
    // The pre-FIX10 code used `const r = result as any;` — the typed
    // NativeLoginProbeResult discriminated union replaces it.
    const fnStart = src.indexOf('function performAuthenticatedLogin');
    const fnEnd = src.indexOf('\n}\n', fnStart);
    expect(fnStart).toBeGreaterThan(0);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = src.slice(fnStart, fnEnd);
    expect(body).not.toContain('as any');
    expect(body).toContain('NativeLoginProbeResult');
  });

  it('probe never logs passwords or tokens', () => {
    const fnStart = src.indexOf('function performAuthenticatedLogin');
    const fnEnd = src.indexOf('\n}\n', fnStart);
    const body = src.slice(fnStart, fnEnd);
    // No error-message construction should embed the password
    // variable directly. The probe accepts u,p and passes them into
    // h.auth.login only; error strings only interpolate reason/phase.
    expect(body).not.toMatch(/console\.log\([^)]*password/i);
    expect(body).not.toMatch(/console\.log\([^)]*token/i);
    expect(body).not.toMatch(/console\.log\([^)]*\$\{p\}/);
  });
});

describe('Stage 3C-CI-FIX10 §5.4 — T2 canonical entry name', () => {
  const src = readFileSync(NATIVE_TEST, 'utf8');

  it('T2 assertion names dist/main/index.cjs (canonical FIX8+ layout)', () => {
    expect(src).toContain('T2: real Electron main entry loaded (apps/desktop/dist/main/index.cjs)');
  });

  it('T2 assertion does NOT reference the pre-FIX8 dist/main/index.js path', () => {
    expect(src).not.toContain('T2: real Electron main entry loaded (apps/desktop/dist/main/index.js)');
  });
});

describe('Stage 3C-CI-FIX10 §5.5 — Costs honest empty state (three-site reconciliation)', () => {
  const testSrc = readFileSync(NATIVE_TEST, 'utf8');
  const seedSrc = readFileSync(NATIVE_SEED, 'utf8');

  it('T-sig[costs_attribution] asserts empty state, not a fabricated attribution', () => {
    expect(testSrc).toContain("T-sig[costs_attribution]: renders honest empty state");
    expect(testSrc).toMatch(/data-screen="costs"[\s\S]*?data-state="empty"/);
  });

  it('seed does not attempt a dead forecast_vs_realized_attributions insert', () => {
    expect(seedSrc).not.toContain('INSERT INTO forecast_vs_realized_attributions');
  });

  it('RECOMMENDED_SEED_ROWS no longer lists Costs (avoids misleading gap warning)', () => {
    // The RECOMMENDED_SEED_ROWS array declaration contains one line
    // per screen. Costs is intentionally absent post-FIX10.
    const arrStart = seedSrc.indexOf('export const RECOMMENDED_SEED_ROWS');
    const arrEnd = seedSrc.indexOf(']);', arrStart);
    expect(arrStart).toBeGreaterThan(0);
    expect(arrEnd).toBeGreaterThan(arrStart);
    const block = seedSrc.slice(arrStart, arrEnd);
    expect(block).not.toMatch(/screen:\s*'Costs'/);
  });
});
