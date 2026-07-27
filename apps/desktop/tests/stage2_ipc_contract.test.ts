/**
 * Stage 2 §16 — IPC boundary contract.
 *
 * Confirms the Stage 2 auth channels are:
 *   - Fully enumerated on the allowlist.
 *   - Backed by request/response schemas that reject unknown fields.
 *   - Marked as authenticated-session-required where appropriate.
 * Also confirms the SanitizedAuthState schema NEVER admits raw token
 * fields (regression guard).
 */
import { describe, expect, it } from 'vitest';
import {
  IPC_ALLOWLIST,
  IPC_CHANNELS,
  AuthLoginRequestSchema,
  AuthSetupRequestSchema,
  AuthChangePasswordRequestSchema,
  AuthOperationResponseSchema,
  SanitizedAuthStateSchema,
  OPERATOR_AUTH_PHASES,
} from '../src/shared/ipcContract';

const authChannels = [
  IPC_CHANNELS.authGetState,
  IPC_CHANNELS.authSetup,
  IPC_CHANNELS.authLogin,
  IPC_CHANNELS.authLogout,
  IPC_CHANNELS.authLock,
  IPC_CHANNELS.authRefresh,
  IPC_CHANNELS.authChangePassword,
  IPC_CHANNELS.authRevokeAll,
];

describe('stage2 §16 auth IPC contract', () => {
  it('I1: all 8 stage-2 auth channels are in the allowlist', () => {
    const allowed = new Set(IPC_ALLOWLIST.map((e) => e.channel));
    for (const c of authChannels) expect(allowed.has(c)).toBe(true);
  });

  it('I2: unauth-required channels are get-state, setup, login, refresh; the rest need a session', () => {
    const requiresSession = Object.fromEntries(
      IPC_ALLOWLIST.filter((e) => (authChannels as readonly string[]).includes(e.channel)).map((e) => [e.channel, e.requiresAuthenticatedSession]),
    );
    expect(requiresSession[IPC_CHANNELS.authGetState]).toBe(false);
    expect(requiresSession[IPC_CHANNELS.authSetup]).toBe(false);
    expect(requiresSession[IPC_CHANNELS.authLogin]).toBe(false);
    expect(requiresSession[IPC_CHANNELS.authRefresh]).toBe(false);
    expect(requiresSession[IPC_CHANNELS.authLogout]).toBe(true);
    expect(requiresSession[IPC_CHANNELS.authLock]).toBe(true);
    expect(requiresSession[IPC_CHANNELS.authChangePassword]).toBe(true);
    expect(requiresSession[IPC_CHANNELS.authRevokeAll]).toBe(true);
  });

  it('I3: login schema rejects unknown fields', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(AuthLoginRequestSchema.safeParse({ username: 'a', password: 'b', extra: 'evil' } as any).success).toBe(false);
  });

  it('I4: setup schema requires passwordConfirmation', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(AuthSetupRequestSchema.safeParse({ username: 'a', password: 'p' } as any).success).toBe(false);
  });

  it('I5: change-password schema requires all three fields', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(AuthChangePasswordRequestSchema.safeParse({ currentPassword: 'a', newPassword: 'b' } as any).success).toBe(false);
  });

  it('I6: SanitizedAuthState admits ONLY sanitized fields — accessToken is rejected', () => {
    const r = SanitizedAuthStateSchema.safeParse({
      phase: 'authenticated',
      username: 'op',
      passwordChangedAt: null,
      accessExpiresAt: null,
      absoluteExpiresAt: null,
      lastActivityAt: null,
      failureReason: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      accessToken: 'leak',
    } as any);
    expect(r.success).toBe(false);
  });

  it('I7: SanitizedAuthState phase enum enumerates all supported phases', () => {
    for (const phase of OPERATOR_AUTH_PHASES) {
      const r = SanitizedAuthStateSchema.safeParse({
        phase,
        username: null,
        passwordChangedAt: null,
        accessExpiresAt: null,
        absoluteExpiresAt: null,
        lastActivityAt: null,
        failureReason: null,
      });
      expect(r.success).toBe(true);
    }
  });

  it('I8: AuthOperationResponse embeds SanitizedAuthState (no raw tokens)', () => {
    const r = AuthOperationResponseSchema.safeParse({
      ok: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      state: { phase: 'authenticated', username: null, passwordChangedAt: null, accessExpiresAt: null, absoluteExpiresAt: null, lastActivityAt: null, failureReason: null, accessToken: 'leak' } as any,
      reason: null,
    });
    expect(r.success).toBe(false);
  });
});
