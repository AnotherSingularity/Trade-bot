import { z } from 'zod';
import {
  IPC_ALLOWLIST,
  IPC_CHANNELS,
  isAllowlistedChannel,
  type AppVersionResponse,
  type ControlledChangeResponse,
  type DesktopStatusResponse,
  type ExportReportRequest,
  type ExportReportResponse,
  type RequestControlledChange,
  type SafeConfigResponse,
  type ServiceHealth,
  type ServicesGenericResponse,
  type ServicesStartRequest,
  type ServicesStartResponse,
} from '../shared/ipcContract';
import type { Logger } from './logging';
import type { CredentialStatusMap } from './secrets';
import { toSanitizedSnapshot, type DesktopEnvironment } from './localEnvironment';
import type { ServiceKind, ServiceRecord, ServiceSupervisor } from './serviceSupervisor';

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
  isAuthenticated: () => boolean;
  authenticationRequired: boolean;
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
  if (entry.requiresAuthenticatedSession && ctx.authenticationRequired && !ctx.isAuthenticated()) {
    ctx.logger.warn('ipc call blocked — authentication required', { channel });
    return { ok: false, channel, data: null, error: 'authentication_required' };
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
