import { z } from 'zod';
import {
  IPC_ALLOWLIST,
  IPC_CHANNELS,
  isAllowlistedChannel,
  type AppVersionResponse,
  type AuthOperationResponse,
  type ControlledChangeResponse,
  type DesktopDataChannelRequest,
  type DesktopDataChannelResponse,
  type DesktopStatusResponse,
  type ExportReportRequest,
  type ExportReportResponse,
  type RequestControlledChange,
  type SafeConfigResponse,
  type SanitizedAuthState,
  type ServiceHealth,
  type ServicesGenericResponse,
  type ServicesStartRequest,
  type ServicesStartResponse,
} from '../shared/ipcContract';
import type { Logger } from './logging';
import type { CredentialStatusMap } from './secrets';
import { toSanitizedSnapshot, type DesktopEnvironment } from './localEnvironment';
import type { ServiceKind, ServiceRecord, ServiceSupervisor } from './serviceSupervisor';
import type { DesktopAuthManager } from './desktopAuthManager';
import type { DesktopDataClient, DesktopDataClientResult } from './desktopDataClient';
import { sanitizeError } from './desktopDataClient';
import type { DesktopDataRequestKey } from '@horizon/shared';

/**
 * Phase 3A §B — IPC handler.
 *
 * The main process registers this handler for every allowlisted
 * channel. Every payload is validated against its Zod schema. A
 * payload that fails validation is REJECTED — never coerced. Channels
 * outside the allowlist are dropped with a warning.
 *
 * The session gate blocks channels that require authentication until
 * the operator has logged in.
 */

export interface IpcHostContext {
  logger: Logger;
  supervisor: ServiceSupervisor;
  environment: DesktopEnvironment;
  credentialStatus: () => Promise<CredentialStatusMap>;
  createOrderCounters: () => Promise<{ functionInvocations: number; attemptCount: number; networkCount: number }>;
  observerPolicyVersions: () => Promise<Record<string, string>>;
  championConfigurationView: () => Promise<Record<string, unknown>>;
  selectExportFolder: () => Promise<string | null>;
  openLogFolder: () => Promise<boolean>;
  exportReport: (input: ExportReportRequest) => Promise<ExportReportResponse>;
  requestControlledChange: (input: RequestControlledChange) => Promise<ControlledChangeResponse>;
  authManager: DesktopAuthManager;
  authenticationRequired: boolean;
  // Stage 3 §4 — main-process client for the desktop.* tRPC surface.
  // Optional so unit tests can construct a context without a live server.
  desktopDataClient?: DesktopDataClient;
}

export interface IpcCallResult<T = unknown> {
  ok: boolean;
  channel: string;
  data: T | null;
  error: string | null;
}

function serviceRecordToHealth(rec: ServiceRecord): ServiceHealth {
  return {
    kind: rec.kind as ServiceHealth['kind'],
    state: rec.state as ServiceHealth['state'],
    lastCheckedAt: rec.lastTransitionAt.toISOString(),
    restartCount: rec.restartCount,
    crashLoopDetected: rec.crashLoopDetected,
    detail: rec.detail,
  };
}

export async function handleIpcCall(
  ctx: IpcHostContext,
  channel: string,
  rawPayload: unknown,
): Promise<IpcCallResult> {
  if (!isAllowlistedChannel(channel)) {
    ctx.logger.warn('ipc channel not in allowlist', { channel });
    return { ok: false, channel, data: null, error: 'channel_not_allowlisted' };
  }
  const entry = IPC_ALLOWLIST.find((e) => e.channel === channel)!;
  if (entry.requiresAuthenticatedSession && ctx.authenticationRequired) {
    // Stage 2-FIX §4: fail closed if the auth manager is unreachable
    // — a missing or throwing sanitize() must not be treated as
    // "authenticated" by omission.
    let phase: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!ctx.authManager || typeof (ctx.authManager as any).sanitize !== 'function') {
        throw new Error('authManager missing');
      }
      phase = ctx.authManager.sanitize().phase;
    } catch (err) {
      ctx.logger.error('ipc call blocked — auth manager unavailable', { channel, err: String(err) });
      return { ok: false, channel, data: null, error: 'authentication_manager_unavailable' };
    }
    if (phase !== 'authenticated') {
      ctx.logger.warn('ipc call blocked — authentication required', { channel, phase });
      return { ok: false, channel, data: null, error: 'authentication_required' };
    }
  }
  let parsed: z.SafeParseReturnType<unknown, unknown>;
  try {
    parsed = entry.requestSchema.safeParse(rawPayload);
  } catch (err) {
    ctx.logger.error('ipc payload validation threw', { channel, err: String(err) });
    return { ok: false, channel, data: null, error: 'validation_threw' };
  }
  if (!parsed.success) {
    ctx.logger.warn('ipc payload rejected', { channel, issues: parsed.error.issues });
    return { ok: false, channel, data: null, error: 'invalid_payload' };
  }

  try {
    let data: unknown;
    switch (channel) {
      case IPC_CHANNELS.getDesktopStatus: {
        const counters = await ctx.createOrderCounters();
        const snap = toSanitizedSnapshot(ctx.environment);
        const status: DesktopStatusResponse = {
          desktopVersion: snap.desktopVersion,
          buildCommit: snap.buildCommit,
          schemaVersion: snap.schemaVersion,
          safeFlags: {
            DRY_RUN: true,
            ORDER_SUBMISSION_ENABLED: false,
            SIMULATION_MODE: snap.SIMULATION_MODE,
          },
          providerMode: snap.providerMode,
          databaseMode: snap.databaseMode,
          redisMode: snap.redisMode,
          liveOrderSubmissionDisabled: true,
          createOrderCounters: counters,
        };
        data = status;
        break;
      }
      case IPC_CHANNELS.startLocalServices: {
        const input = parsed.data as ServicesStartRequest;
        const kinds = ctx.supervisor.snapshot().map((r) => r.kind);
        const results: ServiceHealth[] = [];
        for (const kind of kinds) {
          const rec = await ctx.supervisor.start(kind);
          results.push(serviceRecordToHealth(rec));
        }
        const failed = results.filter((r) => r.state === 'failed' || r.state === 'recovery_required');
        const resp: ServicesStartResponse = {
          ok: failed.length === 0,
          services: results,
          failureReason: failed.length > 0 ? failed[0].detail : null,
        };
        data = resp;
        void input;
        break;
      }
      case IPC_CHANNELS.stopLocalServices: {
        const kinds = ctx.supervisor.snapshot().map((r) => r.kind);
        const results: ServiceHealth[] = [];
        for (const kind of kinds) {
          const rec = await ctx.supervisor.stop(kind);
          results.push(serviceRecordToHealth(rec));
        }
        const resp: ServicesGenericResponse = { ok: true, services: results, failureReason: null };
        data = resp;
        break;
      }
      case IPC_CHANNELS.restartLocalServices: {
        const input = parsed.data as { service?: ServiceKind };
        const targets = input.service
          ? [input.service]
          : ctx.supervisor.snapshot().map((r) => r.kind);
        const results: ServiceHealth[] = [];
        for (const kind of targets) {
          const rec = await ctx.supervisor.restart(kind);
          results.push(serviceRecordToHealth(rec));
        }
        const failed = results.filter((r) => r.state === 'failed' || r.state === 'recovery_required');
        const resp: ServicesGenericResponse = {
          ok: failed.length === 0,
          services: results,
          failureReason: failed.length > 0 ? failed[0].detail : null,
        };
        data = resp;
        break;
      }
      case IPC_CHANNELS.openLogFolder: {
        const opened = await ctx.openLogFolder();
        data = { opened };
        break;
      }
      case IPC_CHANNELS.exportReport: {
        data = await ctx.exportReport(parsed.data as ExportReportRequest);
        break;
      }
      case IPC_CHANNELS.selectExportFolder: {
        const folder = await ctx.selectExportFolder();
        data = { folder };
        break;
      }
      case IPC_CHANNELS.readSafeConfiguration: {
        const status = await ctx.credentialStatus();
        const observerPolicyVersions = await ctx.observerPolicyVersions();
        const championConfigurationView = await ctx.championConfigurationView();
        const snap = toSanitizedSnapshot(ctx.environment);
        const cfg: SafeConfigResponse = {
          desktopStartupBehavior: 'manual',
          serviceMode: snap.databaseMode,
          databaseMode: snap.databaseMode,
          logRetentionDays: 30,
          rawEventRetentionDays: 90,
          reportLocation: '',
          reportSchedule: 'off',
          timeZoneDisplay: 'UTC',
          providerSelection: snap.providerMode,
          safeFlags: {
            DRY_RUN: true,
            ORDER_SUBMISSION_ENABLED: false,
            SIMULATION_MODE: snap.SIMULATION_MODE,
          },
          observerPolicyVersions,
          championConfigurationView,
          credentialStatus: status as Record<string, 'absent' | 'present_encrypted' | 'expired' | 'unknown'>,
        };
        data = cfg;
        break;
      }
      case IPC_CHANNELS.requestControlledConfigurationChange: {
        data = await ctx.requestControlledChange(parsed.data as RequestControlledChange);
        break;
      }
      case IPC_CHANNELS.getApplicationVersion: {
        const snap = toSanitizedSnapshot(ctx.environment);
        const resp: AppVersionResponse = {
          desktopVersion: snap.desktopVersion,
          buildCommit: snap.buildCommit,
          buildTimestamp: '1970-01-01T00:00:00.000Z',
          electronVersion: process.versions.electron ?? '0.0.0',
          nodeVersion: process.versions.node ?? '0.0.0',
          platform: (process.platform as 'win32' | 'darwin' | 'linux') ?? 'linux',
        };
        data = resp;
        break;
      }
      case IPC_CHANNELS.getServiceHealth: {
        const records = ctx.supervisor.snapshot().map(serviceRecordToHealth);
        data = { services: records };
        break;
      }
      case IPC_CHANNELS.authGetState: {
        const state: SanitizedAuthState = await ctx.authManager.getState();
        data = state;
        break;
      }
      case IPC_CHANNELS.authSetup: {
        const resp: AuthOperationResponse = await ctx.authManager.setup(parsed.data as {
          username: string; password: string; passwordConfirmation: string;
        });
        data = resp;
        break;
      }
      case IPC_CHANNELS.authLogin: {
        const resp: AuthOperationResponse = await ctx.authManager.login(parsed.data as {
          username: string; password: string;
        });
        data = resp;
        break;
      }
      case IPC_CHANNELS.authLogout: {
        data = await ctx.authManager.logout();
        break;
      }
      case IPC_CHANNELS.authLock: {
        data = await ctx.authManager.lock();
        break;
      }
      case IPC_CHANNELS.authRefresh: {
        data = await ctx.authManager.refresh();
        break;
      }
      case IPC_CHANNELS.authChangePassword: {
        data = await ctx.authManager.changePassword(parsed.data as {
          currentPassword: string; newPassword: string; newPasswordConfirmation: string;
        });
        break;
      }
      case IPC_CHANNELS.authRevokeAll: {
        data = await ctx.authManager.revokeAll();
        break;
      }
      case IPC_CHANNELS.desktopData: {
        // Stage 3 §5. The IPC schema has already validated the request
        // shape (discriminated union over the 22 known keys). We pass it
        // straight to the compiled-in main client — the renderer cannot
        // choose paths, methods, or procedure names beyond this union.
        if (!ctx.desktopDataClient) {
          const resp: DesktopDataChannelResponse = {
            ok: false,
            key: (parsed.data as DesktopDataChannelRequest).key,
            error: { code: 'desktop_data_client_unavailable', detail: null },
          };
          data = resp;
          break;
        }
        const req = parsed.data as DesktopDataChannelRequest;
        const inputArg = 'input' in req ? req.input : undefined;
        const result: DesktopDataClientResult<DesktopDataRequestKey> = await ctx.desktopDataClient.call(
          req.key as DesktopDataRequestKey,
          inputArg,
        );
        if (result.ok) {
          const resp: DesktopDataChannelResponse = { ok: true, key: req.key, envelope: result.envelope };
          data = resp;
        } else {
          const sanitized = sanitizeError(result.error);
          const resp: DesktopDataChannelResponse = { ok: false, key: req.key, error: sanitized };
          data = resp;
        }
        break;
      }
      default:
        return { ok: false, channel, data: null, error: 'unhandled_channel' };
    }
    const responseParse = entry.responseSchema.safeParse(data);
    if (!responseParse.success) {
      ctx.logger.error('ipc response failed validation', { channel, issues: responseParse.error.issues });
      return { ok: false, channel, data: null, error: 'response_invalid' };
    }
    return { ok: true, channel, data: responseParse.data, error: null };
  } catch (err) {
    ctx.logger.error('ipc handler threw', { channel, err: String(err) });
    return { ok: false, channel, data: null, error: 'handler_threw' };
  }
}
