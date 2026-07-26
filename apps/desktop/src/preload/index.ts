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
};

const allowedChannels = new Set(IPC_ALLOWLIST.map((e) => e.channel));
if (allowedChannels.size !== Object.keys(api).length) {
  console.error('[preload] allowlist size mismatch — refusing to expose bridge');
} else {
  contextBridge.exposeInMainWorld('horizon', api);
}

export type { HorizonBridge };
