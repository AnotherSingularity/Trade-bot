/**
 * Phase 3A §B — Preload bridge.
 *
 * The ONLY channel from renderer to main. contextBridge is used; the
 * renderer sees ONLY the typed `window.horizon` API defined here.
 * No filesystem, no shell, no arbitrary IPC.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_ALLOWLIST,
  IPC_CHANNELS,
  type AppVersionResponse,
  type AuthOperationResponse,
  type ControlledChangeResponse,
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

interface HorizonBridge {
  getDesktopStatus(): Promise<DesktopStatusResponse>;
  startLocalServices(input: ServicesStartRequest): Promise<ServicesStartResponse>;
  stopLocalServices(): Promise<ServicesGenericResponse>;
  restartLocalServices(input?: { service?: string }): Promise<ServicesGenericResponse>;
  openLogFolder(): Promise<{ opened: boolean }>;
  exportReport(input: ExportReportRequest): Promise<ExportReportResponse>;
  selectExportFolder(): Promise<{ folder: string | null }>;
  readSafeConfiguration(): Promise<SafeConfigResponse>;
  requestControlledConfigurationChange(input: RequestControlledChange): Promise<ControlledChangeResponse>;
  getApplicationVersion(): Promise<AppVersionResponse>;
  getServiceHealth(): Promise<{ services: ServiceHealth[] }>;
  // Stage 2 §16 — auth bridge. Renderer receives ONLY the sanitized
  // state or an operation response with the sanitized state embedded.
  // No access token, refresh token, password hash, salt, or bootstrap
  // token ever crosses this boundary.
  auth: {
    getState(): Promise<SanitizedAuthState>;
    setup(input: { username: string; password: string; passwordConfirmation: string }): Promise<AuthOperationResponse>;
    login(input: { username: string; password: string }): Promise<AuthOperationResponse>;
    logout(): Promise<AuthOperationResponse>;
    lock(): Promise<AuthOperationResponse>;
    refresh(): Promise<AuthOperationResponse>;
    changePassword(input: { currentPassword: string; newPassword: string; newPasswordConfirmation: string }): Promise<AuthOperationResponse>;
    revokeAll(): Promise<AuthOperationResponse>;
  };
}

async function invoke<T>(channel: string, payload: unknown): Promise<T> {
  const result = await ipcRenderer.invoke(channel, payload) as { ok: boolean; data: T | null; error: string | null };
  if (!result.ok || result.data == null) {
    throw new Error(result.error ?? 'ipc_call_failed');
  }
  return result.data;
}

const api: HorizonBridge = {
  getDesktopStatus: () => invoke(IPC_CHANNELS.getDesktopStatus, {}),
  startLocalServices: (input) => invoke(IPC_CHANNELS.startLocalServices, input),
  stopLocalServices: () => invoke(IPC_CHANNELS.stopLocalServices, {}),
  restartLocalServices: (input) => invoke(IPC_CHANNELS.restartLocalServices, input ?? {}),
  openLogFolder: () => invoke(IPC_CHANNELS.openLogFolder, {}),
  exportReport: (input) => invoke(IPC_CHANNELS.exportReport, input),
  selectExportFolder: () => invoke(IPC_CHANNELS.selectExportFolder, {}),
  readSafeConfiguration: () => invoke(IPC_CHANNELS.readSafeConfiguration, {}),
  requestControlledConfigurationChange: (input) => invoke(IPC_CHANNELS.requestControlledConfigurationChange, input),
  getApplicationVersion: () => invoke(IPC_CHANNELS.getApplicationVersion, {}),
  getServiceHealth: () => invoke(IPC_CHANNELS.getServiceHealth, {}),
  auth: {
    getState: () => invoke(IPC_CHANNELS.authGetState, {}),
    setup: (input) => invoke(IPC_CHANNELS.authSetup, input),
    login: (input) => invoke(IPC_CHANNELS.authLogin, input),
    logout: () => invoke(IPC_CHANNELS.authLogout, {}),
    lock: () => invoke(IPC_CHANNELS.authLock, {}),
    refresh: () => invoke(IPC_CHANNELS.authRefresh, {}),
    changePassword: (input) => invoke(IPC_CHANNELS.authChangePassword, input),
    revokeAll: () => invoke(IPC_CHANNELS.authRevokeAll, {}),
  },
};

// Sanity: every allowlisted channel must be reachable through the bridge.
// The `auth` group is one bridge property carrying 8 channels; the top-
// level bridge properties account for the other 11 channels.
const allowedChannels = new Set(IPC_ALLOWLIST.map((e) => e.channel));
const bridgeChannelCount = Object.keys(api).length - 1 + Object.keys(api.auth).length;
if (allowedChannels.size !== bridgeChannelCount) {
  console.error('[preload] allowlist size mismatch — refusing to expose bridge', {
    allowed: allowedChannels.size,
    exposed: bridgeChannelCount,
  });
} else {
  contextBridge.exposeInMainWorld('horizon', api);
}

export type { HorizonBridge };
