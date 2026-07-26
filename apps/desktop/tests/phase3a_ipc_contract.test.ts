import { describe, expect, it } from 'vitest';
import {
  DesktopStatusResponseSchema,
  ExportReportRequestSchema,
  IPC_ALLOWLIST,
  IPC_CHANNELS,
  RequestControlledChangeSchema,
  SafeConfigResponseSchema,
  SafeFlagsSchema,
  isAllowlistedChannel,
} from '../src/shared/ipcContract';

describe('phase3a §B — IPC allowlist and schemas', () => {
  it('T12: allowlist enumerates every IPC channel constant', () => {
    const channels = new Set(IPC_ALLOWLIST.map((e) => e.channel));
    for (const c of Object.values(IPC_CHANNELS)) expect(channels.has(c)).toBe(true);
  });

  it('T13: isAllowlistedChannel rejects unknown channels', () => {
    expect(isAllowlistedChannel('fs.readFile')).toBe(false);
    expect(isAllowlistedChannel('shell.exec')).toBe(false);
    expect(isAllowlistedChannel(IPC_CHANNELS.getDesktopStatus)).toBe(true);
  });

  it('T14: SafeFlagsSchema enforces DRY_RUN=true and ORDER_SUBMISSION_ENABLED=false', () => {
    expect(SafeFlagsSchema.safeParse({ DRY_RUN: false, ORDER_SUBMISSION_ENABLED: false, SIMULATION_MODE: 'shadow' }).success).toBe(false);
    expect(SafeFlagsSchema.safeParse({ DRY_RUN: true, ORDER_SUBMISSION_ENABLED: true, SIMULATION_MODE: 'shadow' }).success).toBe(false);
    expect(SafeFlagsSchema.safeParse({ DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false, SIMULATION_MODE: 'shadow' }).success).toBe(true);
  });

  it('T15: DesktopStatusResponseSchema forces liveOrderSubmissionDisabled=true', () => {
    const bad = {
      desktopVersion: '3.0.0', buildCommit: 'x', schemaVersion: '0019',
      safeFlags: { DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false, SIMULATION_MODE: 'shadow' },
      providerMode: 'fixture', databaseMode: 'managed_docker', redisMode: 'managed_docker',
      liveOrderSubmissionDisabled: false,
      createOrderCounters: { functionInvocations: 0, attemptCount: 0, networkCount: 0 },
    };
    expect(DesktopStatusResponseSchema.safeParse(bad).success).toBe(false);
    const good = { ...bad, liveOrderSubmissionDisabled: true };
    expect(DesktopStatusResponseSchema.safeParse(good).success).toBe(true);
  });

  it('T16: ExportReportRequestSchema rejects unknown kinds and empty target folders', () => {
    expect(ExportReportRequestSchema.safeParse({ kind: 'not_a_kind', format: 'json', targetFolder: '/tmp', referenceId: null }).success).toBe(false);
    expect(ExportReportRequestSchema.safeParse({ kind: 'daily_shadow', format: 'json', targetFolder: '', referenceId: null }).success).toBe(false);
    expect(ExportReportRequestSchema.safeParse({ kind: 'daily_shadow', format: 'csv', targetFolder: '/tmp', referenceId: null }).success).toBe(true);
  });

  it('T17: RequestControlledChangeSchema rejects unsafe keys', () => {
    // DRY_RUN and ORDER_SUBMISSION_ENABLED are NOT in CONTROLLED_CONFIG_KEYS
    expect(RequestControlledChangeSchema.safeParse({ key: 'DRY_RUN', proposedValue: false, confirmationText: 'yes', operatorActor: 'admin' }).success).toBe(false);
    expect(RequestControlledChangeSchema.safeParse({ key: 'ORDER_SUBMISSION_ENABLED', proposedValue: true, confirmationText: 'yes', operatorActor: 'admin' }).success).toBe(false);
    expect(RequestControlledChangeSchema.safeParse({ key: 'reportLocation', proposedValue: '/exports', confirmationText: 'yes', operatorActor: 'admin' }).success).toBe(true);
  });

  it('T18: SafeConfigResponseSchema requires observer policy versions and credential status maps', () => {
    const cfg = {
      desktopStartupBehavior: 'manual', serviceMode: 'managed_docker', databaseMode: 'managed_docker',
      logRetentionDays: 30, rawEventRetentionDays: 90, reportLocation: '', reportSchedule: 'off',
      timeZoneDisplay: 'UTC', providerSelection: 'fixture',
      safeFlags: { DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false, SIMULATION_MODE: 'shadow' },
      observerPolicyVersions: { universe: 'p2a-1' },
      championConfigurationView: { championVersion: 'champ-1' },
      credentialStatus: { 'coinbase.apiKey': 'absent' },
    };
    expect(SafeConfigResponseSchema.safeParse(cfg).success).toBe(true);
    const bad = { ...cfg, credentialStatus: { 'coinbase.apiKey': 'invalid_state' } };
    expect(SafeConfigResponseSchema.safeParse(bad).success).toBe(false);
  });
});
