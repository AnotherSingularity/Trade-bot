/**
 * Stage 3 §5 — desktop-data IPC boundary test.
 *
 * Ensures:
 *   §21.11/12  renderer cannot supply arbitrary procedure names or paths
 *   §21.16/17  logout / lock does NOT invoke the desktop-data channel
 *              (renderer-side is covered separately), but the IPC must
 *              refuse desktop-data requests when the session phase is
 *              anything other than `authenticated`
 *   §21.4      response envelopes are validated before crossing the bridge
 */

import { describe, expect, it, vi } from 'vitest';
import type { DesktopAuthManager } from '../src/main/desktopAuthManager';
import type { DesktopDataClient } from '../src/main/desktopDataClient';
import type { IpcHostContext } from '../src/main/ipc';
import { handleIpcCall } from '../src/main/ipc';
import { IPC_CHANNELS } from '../src/shared/ipcContract';

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeAuthManager(phase: 'authenticated' | 'unauthenticated' | 'locked' | 'session_expired' | 'session_revoked' | 'setup_required' | 'account_locked' | 'password_change_required') {
  return {
    sanitize: () => ({ phase, username: null, passwordChangedAt: null, accessExpiresAt: null, absoluteExpiresAt: null, lastActivityAt: null, failureReason: null }),
    getState: async () => ({ phase, username: null, passwordChangedAt: null, accessExpiresAt: null, absoluteExpiresAt: null, lastActivityAt: null, failureReason: null }),
    setup: async () => ({ ok: false, state: { phase } as never, reason: null }),
    login: async () => ({ ok: false, state: { phase } as never, reason: null }),
    logout: async () => ({ ok: true, state: { phase: 'unauthenticated' } as never, reason: null }),
    lock: async () => ({ ok: true, state: { phase: 'locked' } as never, reason: null }),
    refresh: async () => ({ ok: true, state: { phase } as never, reason: null }),
    changePassword: async () => ({ ok: false, state: { phase } as never, reason: null }),
    revokeAll: async () => ({ ok: true, state: { phase: 'unauthenticated' } as never, reason: null }),
  } as unknown as DesktopAuthManager;
}

function makeDataClient(spy: ReturnType<typeof vi.fn>): DesktopDataClient {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    call: spy as any,
  } as DesktopDataClient;
}

function makeContext(opts: {
  phase: Parameters<typeof makeAuthManager>[0];
  dataClient?: DesktopDataClient;
  authenticationRequired?: boolean;
}): IpcHostContext {
  return {
    logger: silentLogger() as unknown as IpcHostContext['logger'],
    supervisor: { snapshot: () => [], start: vi.fn(), stop: vi.fn(), restart: vi.fn() } as unknown as IpcHostContext['supervisor'],
    environment: {} as IpcHostContext['environment'],
    credentialStatus: async () => ({}),
    createOrderCounters: async () => ({ functionInvocations: 0, attemptCount: 0, networkCount: 0 }),
    observerPolicyVersions: async () => ({}),
    championConfigurationView: async () => ({}),
    selectExportFolder: async () => null,
    openLogFolder: async () => false,
    exportReport: async () => ({ ok: false, artifactPath: null, checksum: null, reportVersion: '0', generatedAt: '', redactionsApplied: [], failureReason: 'stub' }),
    requestControlledChange: async () => ({ ok: false, auditEventId: null, restartRequired: [], failureReason: 'stub' }),
    authManager: makeAuthManager(opts.phase),
    authenticationRequired: opts.authenticationRequired ?? true,
    desktopDataClient: opts.dataClient,
  };
}

describe('Stage 3 §5 — desktop-data IPC boundary', () => {
  it('rejects the channel when authentication is required but phase !== authenticated', async () => {
    for (const phase of ['unauthenticated', 'locked', 'session_expired', 'session_revoked', 'setup_required', 'account_locked'] as const) {
      const result = await handleIpcCall(makeContext({ phase }), IPC_CHANNELS.desktopData, { key: 'overview.get' });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('authentication_required');
    }
  });

  it('§21.11 rejects unknown keys via the request-schema validator', async () => {
    const spy = vi.fn();
    const result = await handleIpcCall(
      makeContext({ phase: 'authenticated', dataClient: makeDataClient(spy) }),
      IPC_CHANNELS.desktopData,
      { key: 'not.a.real.key' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_payload');
    expect(spy).not.toHaveBeenCalled();
  });

  it('§21.12 renderer cannot inject alternate HTTP path via IPC payload', async () => {
    const spy = vi.fn();
    // The schema strips unknown fields — any attempt to smuggle a path
    // property is validated away at the union boundary.
    const result = await handleIpcCall(
      makeContext({ phase: 'authenticated', dataClient: makeDataClient(spy) }),
      IPC_CHANNELS.desktopData,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { key: 'overview.get', input: {}, url: 'http://attacker/', method: 'PATCH' } as any,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_payload');
    expect(spy).not.toHaveBeenCalled();
  });

  it('routes valid requests to the desktopDataClient', async () => {
    const spy = vi.fn(async () => ({ ok: true, envelope: { contractVersion: '3.0.0', status: 'healthy', data: null, generatedAt: '2026-07-26T20:00:00.000Z' } }));
    const result = await handleIpcCall(
      makeContext({ phase: 'authenticated', dataClient: makeDataClient(spy) }),
      IPC_CHANNELS.desktopData,
      { key: 'overview.get' },
    );
    expect(spy).toHaveBeenCalledWith('overview.get', undefined);
    expect(result.ok).toBe(true);
  });

  it('fails closed when no desktopDataClient is provided', async () => {
    const result = await handleIpcCall(
      makeContext({ phase: 'authenticated' }),
      IPC_CHANNELS.desktopData,
      { key: 'overview.get' },
    );
    expect(result.ok).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = result.data as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('desktop_data_client_unavailable');
  });
});
