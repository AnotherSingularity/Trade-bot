/**
 * Phase 3A §B — Preload bridge.
 *
 * The ONLY channel from renderer to main. contextBridge is used; the
 * renderer sees ONLY the typed `window.horizon` API defined here.
 * No filesystem, no shell, no arbitrary IPC.
 *
 * Stage 3C-CI-FIX7 §B1/§B3/§B4: preload initialisation is wrapped in
 * a top-level diagnostic boundary. Under strict native-test diagnostics
 * only, per-phase markers are written to a test-only file sink whose
 * path is passed via `HORIZON_NATIVE_PRELOAD_LOG_PATH`. Packaged
 * installers and production builds cannot enable this — the main
 * process strips the env vars before subprocess spawn, and
 * `nativeDiagnosticsOn` requires the strict NODE_ENV=test + canonical
 * 'true' triple.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Stage 3C-CI-FIX8 §4: SANDBOX-SAFE marker transport.
// FIX7 wrote markers via `require('node:fs').appendFileSync(...)`.
// A sandboxed preload cannot rely on arbitrary filesystem access;
// the FIX7 CI run showed the preload.log stayed empty. FIX8 sends
// markers over a fixed test-only IPC channel that the main process
// registers BEFORE window creation. Main owns the sink file. The
// channel and its marker enum are hardcoded on both sides.
const nativeDiagnosticsOn =
  process.env.NODE_ENV === 'test'
  && process.env.HORIZON_NATIVE_DIAGNOSTICS === 'true';

const NATIVE_DIAGNOSTIC_CHANNEL = 'horizon.nativeDiagnostic';

// Bound to `ipcRenderer` after successful electron import below —
// held ONLY inside preload's closure. Never exposed to the renderer.
let sendNativeMarker: ((marker: string, detail?: string) => void) = () => {};

function emitPreloadMarker(marker: string, detail?: string): void {
  if (!nativeDiagnosticsOn) return;
  try { sendNativeMarker(marker, detail); }
  catch { /* best-effort */ }
  try {
    // Belt-and-suspenders: also log to console. ELECTRON_ENABLE_LOGGING=1
    // routes preload console output to main stdout, which the harness
    // tees to `electron-main.stdout.log`. The IPC channel is the primary
    // sink; the console line is a fallback for post-hoc greps.
    // eslint-disable-next-line no-console
    console.log(marker);
  } catch { /* best-effort */ }
}

// Top-level diagnostic boundary — any error during preload
// initialisation surfaces with a specific classification code AND
// re-throws so main receives an observable failure.
function preloadFail(code: string, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  const sanitized = msg
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <REDACTED>')
    .replace(/[A-Fa-f0-9]{32,}/g, '<HEX_REDACTED>')
    .slice(0, 400);
  emitPreloadMarker('HORIZON_NATIVE_PRELOAD_FAILED', `${code}:${sanitized}`);
  throw new Error(`${code}:${sanitized}`);
}

let contextBridge: typeof import('electron').contextBridge;
let ipcRenderer: typeof import('electron').ipcRenderer;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electron = require('electron') as typeof import('electron');
  contextBridge = electron.contextBridge;
  ipcRenderer = electron.ipcRenderer;
  if (!contextBridge) throw new Error('contextBridge_missing');
  // Bind the marker sender ONLY inside preload's closure. This
  // reference is never passed through `contextBridge.exposeInMainWorld`
  // — the renderer cannot reach it.
  sendNativeMarker = (marker: string, detail?: string): void => {
    try { ipcRenderer.send(NATIVE_DIAGNOSTIC_CHANNEL, { marker, detail: detail ?? null }); }
    catch { /* best-effort */ }
  };
} catch (e) {
  preloadFail('preload_electron_import_failed', e);
}

// Stage 3C-CI-FIX9 §7: MODULE_ENTERED must be emitted AFTER ipcRenderer
// is bound so it actually reaches main via the fixed diagnostic channel.
// Emitting before the electron import (as FIX8 did) meant the marker
// only reached the fallback console sink and never appeared in preload.log
// via the IPC path. Order is now guaranteed:
//   1. MODULE_ENTERED  (immediately after electron import)
//   2. BRIDGE_EXPOSING
//   3. BRIDGE_EXPOSED
//   4. INITIALIZED
emitPreloadMarker('HORIZON_NATIVE_PRELOAD_MODULE_ENTERED');

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

let api: HorizonBridge;
try {
  api = {
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
        // Stage 3C-E.1.15/E.1.16 — the outer IPC handler blocks the
        // desktopData channel BEFORE reaching desktopDataClient when
        // the auth phase is not `authenticated`, returning
        // `authentication_required` (or `authentication_manager_
        // unavailable` if the manager is missing) at the outer
        // envelope. These are indistinguishable from a genuine gate
        // and are treated the same way — throw so direct callers can
        // detect the block.
        const outerCode = result.error ?? 'ipc_call_failed';
        if (outerCode === 'authentication_required' || outerCode === 'authentication_manager_unavailable') {
          throw new Error(`${outerCode}:${key}`);
        }
        return { ok: false, key, error: { code: outerCode, detail: null } };
      }
      if (!result.data.ok) {
        // Auth-loss errors (no access token, session expired, session
        // revoked) reported by the inner client are EXCEPTIONAL: the
        // operator is no longer authorized to observe business data
        // at all. The preload rejects such responses so consumers can
        // distinguish "operator is gated" from "server returned an
        // error envelope for a still-authorized operator".
        // useDesktopData has already cleared its cache via the
        // authPhase-loss effect, so the rejection is a no-op for the
        // React tree; direct callers (like behavioral test T36) see
        // the throw and can assert the gate is real. All other error
        // codes (contract mismatch, timeout, api_failure, etc.) still
        // return as a resolved `{ok:false}` envelope so screens can
        // render them.
        const code = result.data.error?.code ?? '';
        if (code === 'unauthenticated' || code === 'session_expired' || code === 'session_revoked') {
          throw new Error(`${code}:${result.data.error?.detail ?? 'auth_gate'}`);
        }
        return { ok: false, key, error: result.data.error };
      }
      return { ok: true, key, envelope: result.data.envelope as DesktopDataResponse<typeof key> };
    },
  };
} catch (e) {
  preloadFail('preload_bridge_definition_failed', e);
}

// Sanity: every allowlisted channel must be reachable through the bridge.
const allowedChannels = new Set(IPC_ALLOWLIST.map((e) => e.channel));
const bridgeChannelCount = Object.keys(api!).length - 1 + Object.keys(api!.auth).length;
if (allowedChannels.size !== bridgeChannelCount) {
  preloadFail('preload_bridge_allowlist_mismatch', new Error(
    `allowed=${allowedChannels.size} exposed=${bridgeChannelCount}`,
  ));
}

emitPreloadMarker('HORIZON_NATIVE_PRELOAD_BRIDGE_EXPOSING');

try {
  const bridged = { ...api!, nativeDiagnosticsEnabled: nativeDiagnosticsOn };
  contextBridge!.exposeInMainWorld('horizon', bridged);
} catch (e) {
  preloadFail('preload_bridge_exposure_failed', e);
}

emitPreloadMarker('HORIZON_NATIVE_PRELOAD_BRIDGE_EXPOSED');

// Stage 3C-CI-FIX7 §C3: durable preload flag on the main world.
// Set via `contextBridge.exposeInMainWorld` under the same
// diagnostics-only gate. Not exposed on packaged builds because
// nativeDiagnosticsOn is false there.
if (nativeDiagnosticsOn) {
  try {
    contextBridge!.exposeInMainWorld('__HORIZON_NATIVE_PRELOAD_READY__', true);
  } catch { /* best-effort */ }
}

emitPreloadMarker('HORIZON_NATIVE_PRELOAD_INITIALIZED');

// Fixed console marker consumed by the renderer harness — legacy
// path from FIX4 kept for backward compatibility.
if (nativeDiagnosticsOn) {
  // eslint-disable-next-line no-console
  console.log('HORIZON_NATIVE_PRELOAD_INITIALIZED');
}

export type { HorizonBridge };
