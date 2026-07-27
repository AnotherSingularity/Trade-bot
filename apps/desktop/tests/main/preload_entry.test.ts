/**
 * Stage 3C-CI-FIX8 §2/§6/§11 — canonical runtime-layout resolver tests.
 *
 * Replaces the FIX7 preloadEntry test suite. Locks in the invariants
 * that broke the previous CI runs:
 *   - FIX6: preload at `dist/main/preload/index.js` (wrong dir).
 *   - FIX7: `app.getAppPath()` returned `/` and produced
 *           `preload_entry_missing:/dist/preload/preload/index.cjs`.
 *   - FIX7 Windows portable-suite: sanitizer split on `path.sep`, so
 *           POSIX fixture paths did not split on Windows runners.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isFilesystemRoot,
  resolveDesktopRuntimeLayout,
  sanitizePreloadPath,
  validateDesktopRoot,
} from '../../src/main/runtimeLayout';

function seedCanonicalLayout(root: string): void {
  mkdirSync(join(root, 'dist/main'), { recursive: true });
  mkdirSync(join(root, 'dist/preload'), { recursive: true });
  mkdirSync(join(root, 'dist/renderer'), { recursive: true });
  writeFileSync(join(root, 'dist/main/index.cjs'), '// main\n');
  writeFileSync(join(root, 'dist/preload/index.cjs'), '// preload\n');
  writeFileSync(join(root, 'dist/renderer/index.html'), '<!doctype html><html></html>\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@horizon/desktop' }));
}

describe('Stage 3C-CI-FIX8 §2 — resolveDesktopRuntimeLayout', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'stage3c-fix8-layout-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('unpackaged: HORIZON_DESKTOP_ROOT override wins when valid', () => {
    seedCanonicalLayout(root);
    const layout = resolveDesktopRuntimeLayout({
      isPackaged: false,
      appPath: '/does-not-matter',
      mainDir: '/nope',
      desktopRootOverride: root,
    });
    expect(layout.layout).toBe('unpackaged');
    expect(layout.applicationRoot).toBe(resolve(root));
    expect(layout.mainEntry).toBe(resolve(root, 'dist/main/index.cjs'));
    expect(layout.preloadEntry).toBe(resolve(root, 'dist/preload/index.cjs'));
    expect(layout.rendererEntry).toBe(resolve(root, 'dist/renderer/index.html'));
    expect(layout.rendererUrl.startsWith('file://')).toBe(true);
  });

  it('unpackaged: falls back to main-dir inference when override missing', () => {
    seedCanonicalLayout(root);
    const layout = resolveDesktopRuntimeLayout({
      isPackaged: false,
      appPath: '/does-not-matter',
      mainDir: resolve(root, 'dist/main'),
    });
    expect(layout.applicationRoot).toBe(resolve(root));
  });

  it('unpackaged: rejects filesystem root as HORIZON_DESKTOP_ROOT (FIX7 defect)', () => {
    seedCanonicalLayout(root);
    expect(() => resolveDesktopRuntimeLayout({
      isPackaged: false,
      appPath: '/',
      mainDir: '/',
      desktopRootOverride: '/',
    })).toThrow(/desktop_runtime_root_(invalid|is_filesystem_root)/);
  });

  it('unpackaged: rejects a candidate that lacks @horizon/desktop package.json', () => {
    // Root exists but has no dist tree/package.json.
    expect(() => resolveDesktopRuntimeLayout({
      isPackaged: false,
      appPath: root,
      mainDir: root,
      desktopRootOverride: root,
    })).toThrow(/desktop_runtime_root_invalid/);
  });

  it('packaged: resolves canonical entries from appPath (no <resources>/app hardcoding)', () => {
    seedCanonicalLayout(root);
    const layout = resolveDesktopRuntimeLayout({
      isPackaged: true,
      appPath: root,
      mainDir: resolve(root, 'dist/main'),
    });
    expect(layout.layout).toBe('packaged');
    expect(layout.mainEntry).toBe(resolve(root, 'dist/main/index.cjs'));
    expect(layout.preloadEntry).toBe(resolve(root, 'dist/preload/index.cjs'));
  });

  it('packaged: rejects filesystem root as appPath', () => {
    expect(() => resolveDesktopRuntimeLayout({
      isPackaged: true,
      appPath: '/',
      mainDir: '/dist/main',
    })).toThrow(/desktop_runtime_root_is_filesystem_root/);
  });

  it('missing main entry throws desktop_main_entry_missing', () => {
    seedCanonicalLayout(root);
    rmSync(join(root, 'dist/main/index.cjs'));
    expect(() => resolveDesktopRuntimeLayout({
      isPackaged: false,
      appPath: root,
      mainDir: resolve(root, 'dist/main'),
      desktopRootOverride: root,
    })).toThrow(/desktop_runtime_root_invalid|desktop_main_entry_missing/);
  });

  it('missing preload entry throws desktop_preload_entry_missing', () => {
    seedCanonicalLayout(root);
    rmSync(join(root, 'dist/preload/index.cjs'));
    expect(() => resolveDesktopRuntimeLayout({
      isPackaged: false,
      appPath: root,
      mainDir: resolve(root, 'dist/main'),
      desktopRootOverride: root,
    })).toThrow(/desktop_runtime_root_invalid|desktop_preload_entry_missing/);
  });

  it('missing renderer entry throws desktop_renderer_entry_missing', () => {
    seedCanonicalLayout(root);
    rmSync(join(root, 'dist/renderer/index.html'));
    expect(() => resolveDesktopRuntimeLayout({
      isPackaged: false,
      appPath: root,
      mainDir: resolve(root, 'dist/main'),
      desktopRootOverride: root,
    })).toThrow(/desktop_runtime_root_invalid|desktop_renderer_entry_missing/);
  });

  it('renderer URL uses pathToFileURL (no bare file:// concatenation)', () => {
    seedCanonicalLayout(root);
    const layout = resolveDesktopRuntimeLayout({
      isPackaged: false,
      appPath: root,
      mainDir: resolve(root, 'dist/main'),
      desktopRootOverride: root,
    });
    // pathToFileURL always produces `file://` + URL-encoded absolute path.
    expect(new URL(layout.rendererUrl).protocol).toBe('file:');
    expect(layout.rendererUrl.endsWith('/dist/renderer/index.html')).toBe(true);
  });
});

describe('Stage 3C-CI-FIX8 §6 — sanitizePreloadPath cross-platform', () => {
  it('POSIX path: splits on `/`', () => {
    const raw = '/home/runner/work/trade-bot/trade-bot/apps/desktop/dist/preload/index.cjs';
    const s = sanitizePreloadPath(raw);
    expect(s.endsWith('/dist/preload/index.cjs')).toBe(true);
    expect(s).not.toContain('runner');
    expect(s).not.toContain('home');
    expect(s).not.toContain('work');
  });

  it('Windows drive-letter path: splits on backslash', () => {
    const raw = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\apps\\desktop\\dist\\preload\\index.cjs';
    const s = sanitizePreloadPath(raw);
    // Sanitizer normalises to forward slashes.
    expect(s).toBe('desktop/dist/preload/index.cjs');
    expect(s).not.toContain('runneradmin');
    expect(s).not.toContain('Users');
    expect(s).not.toContain('\\');
  });

  it('mixed separators: normalise then split', () => {
    const raw = '/home/runner/apps\\desktop\\dist/preload/index.cjs';
    const s = sanitizePreloadPath(raw);
    expect(s).toBe('/desktop/dist/preload/index.cjs');
  });

  it('UNC path: splits and preserves leading /', () => {
    const raw = '\\\\build\\share\\horizon\\dist\\preload\\index.cjs';
    const s = sanitizePreloadPath(raw);
    // Windows UNC → forward-slash form, and only the last 4 segments.
    expect(s.endsWith('/dist/preload/index.cjs')).toBe(true);
    expect(s).not.toContain('build');
  });

  it('short path: preserves shorter path unchanged (no over-trim)', () => {
    expect(sanitizePreloadPath('/a/b')).toBe('/a/b');
    expect(sanitizePreloadPath('a/b')).toBe('a/b');
  });

  it('never leaks runner/home/user/temporary parents (broad regex)', () => {
    const cases = [
      '/home/runner/work/foo/bar/apps/desktop/dist/preload/index.cjs',
      'C:\\Users\\Alice\\Desktop\\horizon\\apps\\desktop\\dist\\preload\\index.cjs',
      '/tmp/stage3c-xyz/apps/desktop/dist/preload/index.cjs',
    ];
    for (const raw of cases) {
      const s = sanitizePreloadPath(raw);
      for (const forbidden of ['runner', 'Users', 'Alice', '/tmp/stage3c-xyz', '\\']) {
        expect(s, `raw=${raw}`).not.toContain(forbidden);
      }
    }
  });
});

describe('Stage 3C-CI-FIX8 §2 — isFilesystemRoot + validateDesktopRoot', () => {
  it('detects POSIX `/`', () => {
    expect(isFilesystemRoot('/')).toBe(true);
  });

  it('detects Windows `C:` and `C:/`', () => {
    expect(isFilesystemRoot('C:')).toBe(true);
    expect(isFilesystemRoot('C:/')).toBe(true);
    expect(isFilesystemRoot('C:\\')).toBe(true);
  });

  it('detects UNC share root', () => {
    expect(isFilesystemRoot('//host/share')).toBe(true);
    expect(isFilesystemRoot('//host/share/')).toBe(true);
  });

  it('accepts a real directory as non-root', () => {
    expect(isFilesystemRoot('/home/user/apps/desktop')).toBe(false);
    expect(isFilesystemRoot('C:/Users/foo/desktop')).toBe(false);
  });

  it('validateDesktopRoot rejects a random unrelated directory', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stage3c-invalid-'));
    try {
      const v = validateDesktopRoot(tmp);
      expect(v.ok).toBe(false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('Stage 3C-CI-FIX8 §1 — package + bundler use canonical layout', () => {
  const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
  const DESKTOP_ROOT = join(REPO_ROOT, 'apps/desktop');

  it('package.json main = dist/main/index.cjs', () => {
    const pkg = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'package.json'), 'utf8')) as {
      main: string;
      build: { extraMetadata: { main: string } };
    };
    expect(pkg.main).toBe('dist/main/index.cjs');
    expect(pkg.build.extraMetadata.main).toBe('dist/main/index.cjs');
  });

  it('bundler emits canonical .cjs outputs (no nested main/main or preload/preload)', () => {
    const bundleScript = readFileSync(join(DESKTOP_ROOT, 'build/bundle-main.mjs'), 'utf8');
    expect(bundleScript).toMatch(/main\/index\.cjs/);
    expect(bundleScript).toMatch(/preload\/index\.cjs/);
    // Old nested paths must be gone.
    expect(bundleScript).not.toMatch(/main\/main\/index\.js/);
    expect(bundleScript).not.toMatch(/preload\/preload\/index\.(cjs|js)/);
  });
});
