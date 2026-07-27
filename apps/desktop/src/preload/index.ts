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
import {
  DESKTOP_DATA_KEYS,
  type DesktopDataRequestKey,
  type DesktopDataResponse,
} from '@horizon/shared';

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
  /**
   * Stage 3 §5 — desktop-data bridge. `key` MUST be one of the compile-time
   * DesktopDataRequestKey values; unknown keys reject at the IPC boundary.
   * The renderer receives the sanitized envelope or a sanitized error —
   * never a raw server response, connection string, or bearer token.
   */
  desktopData<K extends DesktopDataRequestKey>(
    key: K,
    input?: unknown,
  ): Promise<
    | { ok: true; key: K; envelope: DesktopDataResponse<K> }
    | { ok: false; key: K; error: { code: string; detail: string | null } }
  >;
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
  desktopData: async (key, input) => {
    // Compile-time refusal: only enumerated keys reach the boundary.
    if (!(DESKTOP_DATA_KEYS as readonly string[]).includes(key)) {
      return { ok: false, key, error: { code: 'unknown_desktop_data_key', detail: null } };
    }
    const req: DesktopDataChannelRequest = input === undefined
      ? { key } as DesktopDataChannelRequest
      : { key, input } as DesktopDataChannelRequest;
    const result = await ipcRenderer.invoke(IPC_CHANNELS.desktopData, req) as {
      ok: boolean; data: DesktopDataChannelResponse | null; error: string | null;
    };
    if (!result.ok || !result.data) {
      return { ok: false, key, error: { code: result.error ?? 'ipc_call_failed', detail: null } };
    }
    return result.data.ok
      ? { ok: true, key, envelope: result.data.envelope as DesktopDataResponse<typeof key> }
      : { ok: false, key, error: result.data.error };
  },
};

// Sanity: every allowlisted channel must be reachable through the bridge.
// The `auth` group is one bridge property carrying 8 channels; `desktopData`
// is one bridge property that carries the Stage 3 discriminated union
// (dispatches all 22 keys through a single IPC channel).
const allowedChannels = new Set(IPC_ALLOWLIST.map((e) => e.channel));
const bridgeChannelCount = Object.keys(api).length - 1 + Object.keys(api.auth).length;
if (allowedChannels.size !== bridgeChannelCount) {
  console.error('[preload] allowlist size mismatch — refusing to expose bridge', {
    allowed: allowedChannels.size,
    exposed: bridgeChannelCount,
  });
} else {
  // Stage 3C-CI-FIX4 §A5: strict native-diagnostics opt-in.
  // The main process deletes HORIZON_NATIVE_DIAGNOSTICS from
  // process.env when app.isPackaged is true — so a packaged
  // installer cannot reach the ON branch here. Even so, we require
  // strict NODE_ENV=test + strict 'true' env value; non-canonical
  // values ('1', 'yes', 'YES', ' true ') are rejected.
  const nativeDiagnosticsOn =
    process.env.NODE_ENV === 'test'
    && process.env.HORIZON_NATIVE_DIAGNOSTICS === 'true';
  const bridged = { ...api, nativeDiagnosticsEnabled: nativeDiagnosticsOn };
  contextBridge.exposeInMainWorld('horizon', bridged);
  if (nativeDiagnosticsOn) {
    // Fixed marker consumed by the native harness page.on('console')
    // capture. The receiving stream writes it to preload.log.
    // eslint-disable-next-line no-console
    console.log('HORIZON_NATIVE_PRELOAD_INITIALIZED');
  }
}

export type { HorizonBridge };
