import { describe, expect, it } from 'vitest';
import { buildSafeWindowConfig, validateWindowConfig } from '../src/main/windows';

describe('phase3a §B — Electron window security defaults', () => {
  const opts = {
    width: 1440,
    height: 900,
    preloadPath: '/abs/preload/index.js',
    rendererIndexUrl: 'file:///abs/renderer/index.html',
    title: 'Horizon Trade',
  };

  it('T7: default config enables contextIsolation, disables nodeIntegration, enables sandbox', () => {
    const cfg = buildSafeWindowConfig(opts);
    expect(cfg.webPreferences.contextIsolation).toBe(true);
    expect(cfg.webPreferences.nodeIntegration).toBe(false);
    expect(cfg.webPreferences.sandbox).toBe(true);
    expect(cfg.webPreferences.webSecurity).toBe(true);
    expect(cfg.webPreferences.allowRunningInsecureContent).toBe(false);
    expect(cfg.webPreferences.experimentalFeatures).toBe(false);
  });

  it('T8: default config has no violations', () => {
    const cfg = buildSafeWindowConfig(opts);
    expect(validateWindowConfig(cfg)).toEqual([]);
  });

  it('T9: refuses relative preload paths', () => {
    expect(() => buildSafeWindowConfig({ ...opts, preloadPath: 'preload/index.js' })).toThrow(/absolute/);
  });

  it('T10: validator flags every disabled setting', () => {
    const cfg = buildSafeWindowConfig(opts);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cfg.webPreferences as any).contextIsolation = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cfg.webPreferences as any).nodeIntegration = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cfg.webPreferences as any).sandbox = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cfg.webPreferences as any).webSecurity = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cfg.webPreferences as any).allowRunningInsecureContent = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cfg.webPreferences as any).experimentalFeatures = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cfg.webPreferences as any).preload = '';
    const violations = validateWindowConfig(cfg);
    expect(violations).toContain('contextIsolation_disabled');
    expect(violations).toContain('nodeIntegration_enabled');
    expect(violations).toContain('sandbox_disabled');
    expect(violations).toContain('webSecurity_disabled');
    expect(violations).toContain('insecure_content_allowed');
    expect(violations).toContain('experimental_features_enabled');
    expect(violations).toContain('preload_missing');
  });

  it('T11: window is created hidden and menu bar auto-hides', () => {
    const cfg = buildSafeWindowConfig(opts);
    expect(cfg.show).toBe(false);
    expect(cfg.autoHideMenuBar).toBe(true);
  });
});
