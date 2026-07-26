/**
 * Phase 3A §B — Electron window creation with secure defaults.
 *
 * Every window enforces:
 *   - contextIsolation: true
 *   - nodeIntegration: false
 *   - sandbox: true
 *   - remote module disabled (Electron removed it in v14; we assert we
 *     never import from 'electron-remote' or '@electron/remote')
 *
 * The preload script is the ONLY channel from renderer to main.
 */

import path from 'node:path';

export interface WindowOptions {
  width: number;
  height: number;
  preloadPath: string;
  rendererIndexUrl: string;
  title: string;
}

export interface SafeWindowConfig {
  webPreferences: {
    contextIsolation: true;
    nodeIntegration: false;
    sandbox: true;
    webSecurity: true;
    allowRunningInsecureContent: false;
    experimentalFeatures: false;
    enableBlinkFeatures: string;
    disableBlinkFeatures: string;
    preload: string;
  };
  width: number;
  height: number;
  title: string;
  show: false;
  autoHideMenuBar: true;
}

export function buildSafeWindowConfig(options: WindowOptions): SafeWindowConfig {
  if (!path.isAbsolute(options.preloadPath)) {
    throw new Error('preload path must be absolute');
  }
  return {
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      enableBlinkFeatures: '',
      disableBlinkFeatures: 'AuxclickTargetBlankNoopener',
      preload: options.preloadPath,
    },
    width: options.width,
    height: options.height,
    title: options.title,
    show: false,
    autoHideMenuBar: true,
  };
}

export function validateWindowConfig(cfg: SafeWindowConfig): string[] {
  const violations: string[] = [];
  const wp = cfg.webPreferences;
  if (wp.contextIsolation !== true) violations.push('contextIsolation_disabled');
  if (wp.nodeIntegration !== false) violations.push('nodeIntegration_enabled');
  if (wp.sandbox !== true) violations.push('sandbox_disabled');
  if (wp.webSecurity !== true) violations.push('webSecurity_disabled');
  if (wp.allowRunningInsecureContent !== false) violations.push('insecure_content_allowed');
  if (wp.experimentalFeatures !== false) violations.push('experimental_features_enabled');
  if (!wp.preload || wp.preload.trim() === '') violations.push('preload_missing');
  return violations;
}
