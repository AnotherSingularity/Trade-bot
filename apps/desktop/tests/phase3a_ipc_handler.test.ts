import { beforeEach, describe, expect, it } from 'vitest';
import { handleIpcCall, type IpcHostContext } from '../src/main/ipc';
import { IPC_CHANNELS, type SanitizedAuthState } from '../src/shared/ipcContract';
import { Logger, MemorySink } from '../src/main/logging';
import { resolveDesktopEnvironment } from '../src/main/localEnvironment';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  ServiceSupervisor,
  type ServiceAdapter,
} from '../src/main/serviceSupervisor';
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

function makeStubAdapter(kind: ServiceAdapter['kind']): ServiceAdapter {
  return {
    kind,
    checkDependencies: async () => ({ ok: true }),
    start: async () => ({ ok: true }),
    healthCheck: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
  };
}

function buildContext(overrides: Partial<IpcHostContext> = {}): IpcHostContext {
  const sink = new MemorySink();
  const logger = new Logger(sink, 'test');
  const supervisor = new ServiceSupervisor(
    [makeStubAdapter('mariadb'), makeStubAdapter('redis'), makeStubAdapter('server')],
    logger,
    DEFAULT_SUPERVISOR_CONFIG,
  );
  return {
    logger,
    supervisor,
    environment: resolveDesktopEnvironment({}),
    credentialStatus: async () => ({ 'coinbase.apiKey': 'absent' }),
    createOrderCounters: async () => ({ functionInvocations: 0, attemptCount: 0, networkCount: 0 }),
    observerPolicyVersions: async () => ({ universe: 'p2a-1' }),
    championConfigurationView: async () => ({ championVersion: 'champ-1' }),
    selectExportFolder: async () => '/tmp/exports',
    openLogFolder: async () => true,
    exportReport: async () => ({
      ok: false, artifactPath: null, checksum: null, reportVersion: 'p3a-report-1',
      generatedAt: '2026-07-26T00:00:00.000Z', redactionsApplied: ['coinbase_api_key'], failureReason: 'deferred',
    }),
    requestControlledChange: async () => ({ ok: true, auditEventId: 0, restartRequired: [], failureReason: null }),
    authManager: fakeAuthManager('authenticated'),
    authenticationRequired: true,
    ...overrides,
  };
}

describe('phase3a §B — IPC handler behavior', () => {
  let ctx: IpcHostContext;
  beforeEach(() => { ctx = buildContext(); });

  it('T19: rejects channels not in allowlist', async () => {
    const res = await handleIpcCall(ctx, 'fs.readFile', {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('channel_not_allowlisted');
  });

  it('T20: rejects invalid payloads for a real channel', async () => {
    const res = await handleIpcCall(ctx, IPC_CHANNELS.exportReport, { kind: 'not_a_kind' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid_payload');
  });

  it('T21: blocks authenticated channels when session missing', async () => {
    ctx = buildContext({ authManager: fakeAuthManager('unauthenticated'), authenticationRequired: true });
    const res = await handleIpcCall(ctx, IPC_CHANNELS.exportReport, {
      kind: 'daily_shadow', format: 'json', targetFolder: '/tmp', referenceId: null,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('authentication_required');
  });

  it('T22: getDesktopStatus returns DRY_RUN=true and zero CreateOrder counters', async () => {
    const res = await handleIpcCall(ctx, IPC_CHANNELS.getDesktopStatus, {});
    expect(res.ok).toBe(true);
    const d = res.data as { safeFlags: { DRY_RUN: boolean; ORDER_SUBMISSION_ENABLED: boolean }; createOrderCounters: { functionInvocations: number; attemptCount: number; networkCount: number }; liveOrderSubmissionDisabled: boolean };
    expect(d.safeFlags.DRY_RUN).toBe(true);
    expect(d.safeFlags.ORDER_SUBMISSION_ENABLED).toBe(false);
    expect(d.liveOrderSubmissionDisabled).toBe(true);
    expect(d.createOrderCounters).toEqual({ functionInvocations: 0, attemptCount: 0, networkCount: 0 });
  });

  it('T23: getServiceHealth returns supervisor snapshot', async () => {
    const res = await handleIpcCall(ctx, IPC_CHANNELS.getServiceHealth, {});
    expect(res.ok).toBe(true);
    const d = res.data as { services: Array<{ kind: string; state: string }> };
    expect(d.services.map((s) => s.kind).sort()).toEqual(['mariadb', 'redis', 'server']);
  });

  it('T24: requestControlledChange refuses to alter safety flags when handler enforces it', async () => {
    ctx = buildContext({
      requestControlledChange: async (input) => {
        if (input.key === 'serviceMode' && input.proposedValue === 'live') {
          return { ok: false, auditEventId: null, restartRequired: [], failureReason: 'safety_flags_immutable_in_phase_3a' };
        }
        return { ok: true, auditEventId: 1, restartRequired: [], failureReason: null };
      },
    });
    const res = await handleIpcCall(ctx, IPC_CHANNELS.requestControlledConfigurationChange, {
      key: 'serviceMode', proposedValue: 'live', confirmationText: 'yes', operatorActor: 'admin',
    });
    expect(res.ok).toBe(true);
    const d = res.data as { ok: boolean; failureReason: string | null };
    expect(d.ok).toBe(false);
    expect(d.failureReason).toBe('safety_flags_immutable_in_phase_3a');
  });

  it('T25: response schema mismatch is caught and returned as response_invalid', async () => {
    ctx = buildContext({
      exportReport: async () => ({
        // Missing required fields entirely to trigger schema failure.
        ok: 'not_a_boolean',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    });
    const res = await handleIpcCall(ctx, IPC_CHANNELS.exportReport, {
      kind: 'daily_shadow', format: 'json', targetFolder: '/tmp', referenceId: null,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('response_invalid');
  });
});
