import { z } from 'zod';

/**
 * Phase 3A §B — IPC allowlist contract.
 *
 * Every renderer-to-main call is exhaustively enumerated here. The
 * preload bridge exposes ONLY these channels. Every payload is
 * validated by its Zod schema in the main process before dispatch.
 * A payload that fails validation is rejected — never coerced.
 *
 * Explicitly NOT permitted:
 *   - generic filesystem access
 *   - generic shell execution
 *   - arbitrary process spawning
 *   - arbitrary URL fetching
 *   - raw environment variables
 *   - Coinbase credentials
 *   - database credentials
 *   - Redis credentials
 *   - unrestricted IPC calls
 */

export const IPC_CHANNELS = {
  getDesktopStatus: 'desktop.getStatus',
  startLocalServices: 'services.start',
  stopLocalServices: 'services.stop',
  restartLocalServices: 'services.restart',
  openLogFolder: 'desktop.openLogFolder',
  exportReport: 'reports.export',
  selectExportFolder: 'reports.selectExportFolder',
  readSafeConfiguration: 'config.readSafe',
  requestControlledConfigurationChange: 'config.requestChange',
  getApplicationVersion: 'desktop.getVersion',
  getServiceHealth: 'services.getHealth',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// ---------------------------------------------------------------------------
// getDesktopStatus
// ---------------------------------------------------------------------------

export const DesktopStatusRequestSchema = z.object({}).strict();
export type DesktopStatusRequest = z.infer<typeof DesktopStatusRequestSchema>;

export const SafeFlagsSchema = z.object({
  DRY_RUN: z.literal(true),
  ORDER_SUBMISSION_ENABLED: z.literal(false),
  SIMULATION_MODE: z.string(),
}).strict();
export type SafeFlags = z.infer<typeof SafeFlagsSchema>;

export const CreateOrderCountersSchema = z.object({
  functionInvocations: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative(),
  networkCount: z.number().int().nonnegative(),
}).strict();
export type CreateOrderCounters = z.infer<typeof CreateOrderCountersSchema>;

// Stage 1 §12: counters must be authoritative. `known=false` means
// the desktop cannot vouch for the values; the UI renders "unknown"
// and readiness is BLOCKED.
export const CreateOrderCountersEnvelopeSchema = z.object({
  known: z.boolean(),
  source: z.string(),
  values: CreateOrderCountersSchema,
}).strict();
export type CreateOrderCountersEnvelope = z.infer<typeof CreateOrderCountersEnvelopeSchema>;

export const DesktopStatusResponseSchema = z.object({
  desktopVersion: z.string(),
  buildCommit: z.string(),
  schemaVersion: z.string(),
  safeFlags: SafeFlagsSchema,
  providerMode: z.enum(['fixture', 'deferred_production', 'external']),
  databaseMode: z.enum(['managed_docker', 'external_services']),
  redisMode: z.enum(['managed_docker', 'external_services']),
  liveOrderSubmissionDisabled: z.literal(true),
  // Kept for renderer backward-compat; ALWAYS mirrors `counters.values`.
  createOrderCounters: CreateOrderCountersSchema,
  // Stage 1: authoritative counter envelope.
  counters: CreateOrderCountersEnvelopeSchema.optional(),
  scannerReadiness: z.object({
    state: z.enum(['ready', 'blocked', 'unknown']),
    blockingReasons: z.array(z.string()),
  }).strict().optional(),
}).strict();
export type DesktopStatusResponse = z.infer<typeof DesktopStatusResponseSchema>;

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export const SERVICE_STATES = [
  'not_configured', 'checking_dependencies', 'starting', 'migrating',
  'synchronizing', 'healthy', 'degraded', 'stopping', 'stopped',
  'failed', 'recovery_required',
] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

export const ServiceKindSchema = z.enum([
  'desktop_shell', 'server', 'scanner_worker', 'reconciliation_worker',
  'mariadb', 'redis', 'market_data', 'reporting',
]);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;

export const ServiceHealthSchema = z.object({
  kind: ServiceKindSchema,
  state: z.enum(SERVICE_STATES),
  lastCheckedAt: z.string(),
  restartCount: z.number().int().nonnegative(),
  crashLoopDetected: z.boolean(),
  detail: z.string().nullable(),
}).strict();
export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;

export const ServicesStartRequestSchema = z.object({
  mode: z.enum(['managed_docker', 'external_services']),
}).strict();
export type ServicesStartRequest = z.infer<typeof ServicesStartRequestSchema>;

export const ServicesStartResponseSchema = z.object({
  ok: z.boolean(),
  services: z.array(ServiceHealthSchema),
  failureReason: z.string().nullable(),
}).strict();
export type ServicesStartResponse = z.infer<typeof ServicesStartResponseSchema>;

export const ServicesGenericResponseSchema = z.object({
  ok: z.boolean(),
  services: z.array(ServiceHealthSchema),
  failureReason: z.string().nullable(),
}).strict();
export type ServicesGenericResponse = z.infer<typeof ServicesGenericResponseSchema>;

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const EXPORT_REPORT_KINDS = [
  'decision_chain', 'daily_shadow', 'portfolio_risk', 'universe_and_hygiene',
  'fingerprints', 'regimes', 'microstructure', 'context', 'cost_attribution',
  'validation', 'incidents', 'safety_status', 'system_manifest',
] as const;
export const ExportReportRequestSchema = z.object({
  kind: z.enum(EXPORT_REPORT_KINDS),
  format: z.enum(['json', 'csv', 'html']),
  targetFolder: z.string().min(1),
  referenceId: z.string().nullable(),
}).strict();
export type ExportReportRequest = z.infer<typeof ExportReportRequestSchema>;

export const ExportReportResponseSchema = z.object({
  ok: z.boolean(),
  artifactPath: z.string().nullable(),
  checksum: z.string().nullable(),
  reportVersion: z.string(),
  generatedAt: z.string(),
  redactionsApplied: z.array(z.string()),
  failureReason: z.string().nullable(),
}).strict();
export type ExportReportResponse = z.infer<typeof ExportReportResponseSchema>;

export const SelectExportFolderRequestSchema = z.object({}).strict();
export const SelectExportFolderResponseSchema = z.object({
  folder: z.string().nullable(),
}).strict();

// ---------------------------------------------------------------------------
// Safe configuration read + controlled change
// ---------------------------------------------------------------------------

export const SafeConfigResponseSchema = z.object({
  desktopStartupBehavior: z.enum(['manual', 'auto_check', 'auto_start']),
  serviceMode: z.enum(['managed_docker', 'external_services']),
  databaseMode: z.enum(['managed_docker', 'external_services']),
  logRetentionDays: z.number().int().nonnegative(),
  rawEventRetentionDays: z.number().int().nonnegative(),
  reportLocation: z.string(),
  reportSchedule: z.enum(['off', 'daily', 'weekly']),
  timeZoneDisplay: z.string(),
  providerSelection: z.enum(['fixture', 'deferred_production', 'external']),
  safeFlags: SafeFlagsSchema,
  observerPolicyVersions: z.record(z.string()),
  championConfigurationView: z.record(z.unknown()),
  credentialStatus: z.record(z.enum(['absent', 'present_encrypted', 'expired', 'unknown'])),
}).strict();
export type SafeConfigResponse = z.infer<typeof SafeConfigResponseSchema>;

export const CONTROLLED_CONFIG_KEYS = [
  'desktopStartupBehavior', 'serviceMode', 'databaseMode',
  'logRetentionDays', 'rawEventRetentionDays', 'reportLocation',
  'reportSchedule', 'timeZoneDisplay',
] as const;

export const RequestControlledChangeSchema = z.object({
  key: z.enum(CONTROLLED_CONFIG_KEYS),
  proposedValue: z.union([z.string(), z.number(), z.boolean()]),
  confirmationText: z.string().min(3),
  operatorActor: z.string().min(1),
}).strict();
export type RequestControlledChange = z.infer<typeof RequestControlledChangeSchema>;

export const ControlledChangeResponseSchema = z.object({
  ok: z.boolean(),
  auditEventId: z.number().int().nullable(),
  restartRequired: z.array(ServiceKindSchema),
  failureReason: z.string().nullable(),
}).strict();
export type ControlledChangeResponse = z.infer<typeof ControlledChangeResponseSchema>;

// ---------------------------------------------------------------------------
// Application version
// ---------------------------------------------------------------------------

export const AppVersionResponseSchema = z.object({
  desktopVersion: z.string(),
  buildCommit: z.string(),
  buildTimestamp: z.string(),
  electronVersion: z.string(),
  nodeVersion: z.string(),
  platform: z.enum(['win32', 'darwin', 'linux']),
}).strict();
export type AppVersionResponse = z.infer<typeof AppVersionResponseSchema>;

// ---------------------------------------------------------------------------
// Registry — the exhaustive allowlist
// ---------------------------------------------------------------------------

export const IPC_ALLOWLIST: readonly {
  channel: IpcChannel;
  requestSchema: z.ZodTypeAny;
  responseSchema: z.ZodTypeAny;
  requiresAuthenticatedSession: boolean;
}[] = [
  { channel: IPC_CHANNELS.getDesktopStatus, requestSchema: DesktopStatusRequestSchema, responseSchema: DesktopStatusResponseSchema, requiresAuthenticatedSession: false },
  { channel: IPC_CHANNELS.startLocalServices, requestSchema: ServicesStartRequestSchema, responseSchema: ServicesStartResponseSchema, requiresAuthenticatedSession: true },
  { channel: IPC_CHANNELS.stopLocalServices, requestSchema: z.object({}).strict(), responseSchema: ServicesGenericResponseSchema, requiresAuthenticatedSession: true },
  { channel: IPC_CHANNELS.restartLocalServices, requestSchema: z.object({ service: ServiceKindSchema.optional() }).strict(), responseSchema: ServicesGenericResponseSchema, requiresAuthenticatedSession: true },
  { channel: IPC_CHANNELS.openLogFolder, requestSchema: z.object({}).strict(), responseSchema: z.object({ opened: z.boolean() }).strict(), requiresAuthenticatedSession: true },
  { channel: IPC_CHANNELS.exportReport, requestSchema: ExportReportRequestSchema, responseSchema: ExportReportResponseSchema, requiresAuthenticatedSession: true },
  { channel: IPC_CHANNELS.selectExportFolder, requestSchema: SelectExportFolderRequestSchema, responseSchema: SelectExportFolderResponseSchema, requiresAuthenticatedSession: true },
  { channel: IPC_CHANNELS.readSafeConfiguration, requestSchema: z.object({}).strict(), responseSchema: SafeConfigResponseSchema, requiresAuthenticatedSession: true },
  { channel: IPC_CHANNELS.requestControlledConfigurationChange, requestSchema: RequestControlledChangeSchema, responseSchema: ControlledChangeResponseSchema, requiresAuthenticatedSession: true },
  { channel: IPC_CHANNELS.getApplicationVersion, requestSchema: z.object({}).strict(), responseSchema: AppVersionResponseSchema, requiresAuthenticatedSession: false },
  { channel: IPC_CHANNELS.getServiceHealth, requestSchema: z.object({}).strict(), responseSchema: z.object({ services: z.array(ServiceHealthSchema) }).strict(), requiresAuthenticatedSession: false },
];

export function isAllowlistedChannel(channel: string): channel is IpcChannel {
  return IPC_ALLOWLIST.some((entry) => entry.channel === channel);
}
