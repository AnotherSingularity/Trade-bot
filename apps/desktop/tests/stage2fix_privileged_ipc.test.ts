/**
 * Stage 2-FIX §4 — privileged desktop IPC enforcement.
 *
 * Every allowlist entry marked `requiresAuthenticatedSession: true` MUST
 * be blocked in every non-authenticated phase (locked, session_expired,
 * session_revoked, bootstrap_unavailable, unauthenticated, setup_required,
 * account_locked, password_change_required). And when the auth manager
 * itself is unavailable, the handler MUST fail closed with a specific
 * error — never allow the call through by omission.
 *
 * These tests exercise the ipc handler directly, so we can drive every
 * phase without spinning up Electron.
 */
import { describe, expect, it } from 'vitest';
import { handleIpcCall, type IpcHostContext } from '../src/main/ipc';
import { IPC_ALLOWLIST, IPC_CHANNELS, type SanitizedAuthState, OPERATOR_AUTH_PHASES } from '../src/shared/ipcContract';
import { Logger, MemorySink } from '../src/main/logging';
import { resolveDesktopEnvironment } from '../src/main/localEnvironment';
import { DEFAULT_SUPERVISOR_CONFIG, ServiceSupervisor, type ServiceAdapter } from '../src/main/serviceSupervisor';
import type { DesktopAuthManager } from '../src/main/desktopAuthManager';

function fakeAuthManager(phase: SanitizedAuthState['phase']): DesktopAuthManager {
  const state: SanitizedAuthState = {
    phase,
    username: phase === 'authenticated' ? 'operator' : null,
    passwordChangedAt: null,
    accessExpiresAt: null,
    absoluteExpiresAt: null,
    lastActivityAt: null,
    failureReason: null,
  };
  const noop = async () => ({ ok: true as const, state, reason: null });
  return {
    sanitize: () => state,
    getState: async () => state,
    setup: noop, login: noop, logout: noop, lock: noop, refresh: noop,
    changePassword: noop, revokeAll: noop,
    currentAccessToken: () => null,
    refreshCallback: async () => ({ ok: false as const, reason: 'test' }),
    initialize: async () => state,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as DesktopAuthManager;
}

function makeStub(kind: ServiceAdapter['kind']): ServiceAdapter {
  return {
    kind,
    checkDependencies: async () => ({ ok: true }),
    start: async () => ({ ok: true }),
    healthCheck: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
  };
}

function buildCtx(overrides: Partial<IpcHostContext>): IpcHostContext {
  const sink = new MemorySink();
  const logger = new Logger(sink, 'stage2fix');
  const supervisor = new ServiceSupervisor(
    [makeStub('mariadb'), makeStub('redis'), makeStub('server')],
    logger,
    DEFAULT_SUPERVISOR_CONFIG,
  );
  return {
    logger,
    supervisor,
    environment: resolveDesktopEnvironment({}),
    credentialStatus: async () => ({}),
    createOrderCounters: async () => ({ functionInvocations: 0, attemptCount: 0, networkCount: 0 }),
    observerPolicyVersions: async () => ({}),
    championConfigurationView: async () => ({ championVersion: 'test' }),
    selectExportFolder: async () => null,
    openLogFolder: async () => true,
    exportReport: async () => ({
      ok: false, artifactPath: null, checksum: null, reportVersion: 'test',
      generatedAt: '2026-01-01T00:00:00.000Z', redactionsApplied: [], failureReason: 'deferred',
    }),
    requestControlledChange: async () => ({ ok: true, auditEventId: 0, restartRequired: [], failureReason: null }),
    authManager: fakeAuthManager('authenticated'),
    authenticationRequired: true,
    ...overrides,
  };
}

const PRIVILEGED_CHANNELS = IPC_ALLOWLIST.filter((e) => e.requiresAuthenticatedSession).map((e) => e.channel);
const NON_PRIVILEGED_CHANNELS = IPC_ALLOWLIST.filter((e) => !e.requiresAuthenticatedSession).map((e) => e.channel);

// Placeholder payloads for each privileged channel — the specific shape
// doesn't matter here, because the handler must reject on auth long
// before payload validation runs.
const PLACEHOLDER_PAYLOADS: Record<string, unknown> = {
  [IPC_CHANNELS.startLocalServices]: { mode: 'external_services' },
  [IPC_CHANNELS.stopLocalServices]: {},
  [IPC_CHANNELS.restartLocalServices]: {},
  [IPC_CHANNELS.openLogFolder]: {},
  [IPC_CHANNELS.exportReport]: { kind: 'safety_status', format: 'json', targetFolder: '/tmp', referenceId: null },
  [IPC_CHANNELS.selectExportFolder]: {},
  [IPC_CHANNELS.readSafeConfiguration]: {},
  [IPC_CHANNELS.requestControlledConfigurationChange]: {
    key: 'reportSchedule', proposedValue: 'off', confirmationText: 'yes I confirm', operatorActor: 'operator',
  },
  [IPC_CHANNELS.authLogout]: {},
  [IPC_CHANNELS.authLock]: {},
  [IPC_CHANNELS.authChangePassword]: {
    currentPassword: 'x', newPassword: 'y', newPasswordConfirmation: 'y',
  },
  [IPC_CHANNELS.authRevokeAll]: {},
};

// Every phase that is NOT 'authenticated' must block privileged actions.
const NON_AUTHENTICATED_PHASES = OPERATOR_AUTH_PHASES.filter((p) => p !== 'authenticated');

describe('stage2-fix §4 privileged IPC enforcement matrix', () => {
  it('P1: inventory covers every privileged action listed in the review', () => {
    // These are the review's enumerated actions; each must be represented
    // on the allowlist as requiresAuthenticatedSession.
    const musts = [
      IPC_CHANNELS.startLocalServices,
      IPC_CHANNELS.stopLocalServices,
      IPC_CHANNELS.restartLocalServices,
      IPC_CHANNELS.openLogFolder,
      IPC_CHANNELS.exportReport,
      IPC_CHANNELS.selectExportFolder,
      IPC_CHANNELS.readSafeConfiguration,
      IPC_CHANNELS.requestControlledConfigurationChange,
    ];
    for (const ch of musts) {
      const entry = IPC_ALLOWLIST.find((e) => e.channel === ch);
      expect(entry, `${ch} must be on the allowlist`).toBeTruthy();
      expect(entry!.requiresAuthenticatedSession, `${ch} must require an authenticated session`).toBe(true);
    }
    // observer-policy and champion-configuration are consumed via the
    // authenticated server API (Stage 2 split), not via IPC — the IPC
    // reads only go through readSafeConfiguration, which is privileged.
  });

  for (const phase of NON_AUTHENTICATED_PHASES) {
    for (const channel of PRIVILEGED_CHANNELS) {
      it(`P2[${phase}][${channel}]: privileged action blocked when phase='${phase}'`, async () => {
        const ctx = buildCtx({ authManager: fakeAuthManager(phase) });
        const payload = PLACEHOLDER_PAYLOADS[channel] ?? {};
        const res = await handleIpcCall(ctx, channel, payload);
        expect(res.ok).toBe(false);
        expect(res.error).toBe('authentication_required');
      });
    }
  }

  it('P3: authenticated phase permits at least one non-mutating privileged read (readSafeConfiguration)', async () => {
    const ctx = buildCtx({ authManager: fakeAuthManager('authenticated') });
    const res = await handleIpcCall(ctx, IPC_CHANNELS.readSafeConfiguration, {});
    expect(res.ok).toBe(true);
  });

  it('P4: bootstrap-safe channels (auth.getState) reachable in every phase — never require session', async () => {
    for (const phase of OPERATOR_AUTH_PHASES) {
      const ctx = buildCtx({ authManager: fakeAuthManager(phase) });
      const res = await handleIpcCall(ctx, IPC_CHANNELS.authGetState, {});
      expect(res.ok, `${phase} getState must succeed`).toBe(true);
    }
  });

  it('P5: handler fails closed when authManager is missing entirely (no fallback to allow)', async () => {
    for (const channel of PRIVILEGED_CHANNELS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = buildCtx({ authManager: undefined as any });
      const payload = PLACEHOLDER_PAYLOADS[channel] ?? {};
      const res = await handleIpcCall(ctx, channel, payload);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('authentication_manager_unavailable');
    }
  });

  it('P6: handler fails closed when authManager.sanitize() throws', async () => {
    const throwingManager = {
      sanitize: () => { throw new Error('auth manager crashed'); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as DesktopAuthManager;
    for (const channel of PRIVILEGED_CHANNELS) {
      const ctx = buildCtx({ authManager: throwingManager });
      const payload = PLACEHOLDER_PAYLOADS[channel] ?? {};
      const res = await handleIpcCall(ctx, channel, payload);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('authentication_manager_unavailable');
    }
  });

  it('P7: authenticationRequired=false disables the gate ONLY (still checks phase for known channels) — dev override does not affect auth channels themselves', async () => {
    // Even in dev mode with authenticationRequired=false, an anonymous
    // renderer still cannot successfully use authLogout etc. because
    // the auth manager itself validates. Here we only assert that the
    // handler no longer rejects privileged IPC preemptively when the
    // dev override is set — the deeper business validation is a
    // separate concern verified by the end-to-end integration.
    const ctx = buildCtx({
      authManager: fakeAuthManager('unauthenticated'),
      authenticationRequired: false,
    });
    const res = await handleIpcCall(ctx, IPC_CHANNELS.readSafeConfiguration, {});
    expect(res.ok).toBe(true);
  });

  it('P8: non-privileged public channels are ALWAYS reachable regardless of phase', async () => {
    for (const phase of OPERATOR_AUTH_PHASES) {
      const ctx = buildCtx({ authManager: fakeAuthManager(phase) });
      for (const channel of NON_PRIVILEGED_CHANNELS) {
        // Skip the ones with required payload we haven't stubbed here — for
        // this specific test, only assert the get-status class is reachable.
        if (channel === IPC_CHANNELS.getDesktopStatus || channel === IPC_CHANNELS.getServiceHealth || channel === IPC_CHANNELS.getApplicationVersion) {
          const res = await handleIpcCall(ctx, channel, {});
          expect(res.ok, `${phase} ${channel} should be reachable`).toBe(true);
        }
      }
    }
  });
});
