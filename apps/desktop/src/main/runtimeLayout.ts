/**
 * Stage 3C-CI-FIX8 §2 — canonical Electron runtime layout resolver.
 *
 * One authoritative source of truth for main, preload, and renderer
 * paths. Replaces the FIX7 narrow `resolvePreloadEntry` that trusted
 * `app.getAppPath()` — which returned `/` in the FIX7 CI run when
 * Electron was launched with an explicit main file argument, causing
 * `preload_entry_missing:/dist/preload/preload/index.cjs`.
 *
 * Canonical layout:
 *   <root>/dist/main/index.cjs
 *   <root>/dist/preload/index.cjs
 *   <root>/dist/renderer/index.html
 *
 * Root resolution priority (unpackaged):
 *   1. `desktopRootOverride` (from `HORIZON_DESKTOP_ROOT` env or a test
 *      injection) — trusted only when it validates.
 *   2. Two-level parent of the bundled main directory
 *      (`<root>/dist/main/index.cjs` → walk up two levels).
 *   3. `appPath` — accepted only when it validates.
 *
 * Filesystem root (`/` on POSIX, `C:\`/UNC-root on Windows) is
 * structurally rejected.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve, dirname, parse } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface RuntimeLayoutInput {
  isPackaged: boolean;
  appPath: string;
  mainDir: string;
  desktopRootOverride?: string;
}

export interface DesktopRuntimeLayout {
  applicationRoot: string;
  mainEntry: string;
  preloadEntry: string;
  rendererEntry: string;
  rendererUrl: string;
  layout: 'packaged' | 'unpackaged';
}

// Cross-platform path sanitizer — always splits on either separator
// regardless of the running platform. Fixes the FIX7 POSIX-on-Windows
// defect where the sanitizer used `path.sep` (which is `\` on Windows)
// and therefore never split a POSIX fixture path.
export function sanitizePreloadPath(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const tail = parts.slice(Math.max(0, parts.length - 4)).join('/');
  return normalized.startsWith('/') ? `/${tail}` : tail;
}

// Filesystem-root detection — must catch POSIX `/`, `C:\`, `\\host\share`.
export function isFilesystemRoot(candidate: string): boolean {
  if (!candidate) return true;
  const normalized = candidate.replace(/\\/g, '/');
  if (normalized === '/' || normalized === '') return true;
  // Windows drive root: `C:` or `C:/`.
  if (/^[A-Za-z]:\/?$/.test(normalized)) return true;
  // UNC share root: `//host/share` with no path beyond it.
  if (/^\/\/[^/]+\/[^/]+\/?$/.test(normalized)) return true;
  return false;
}

// A candidate is a valid desktop root iff it contains our canonical
// layout AND its package.json advertises `@horizon/desktop`.
export function validateDesktopRoot(candidate: string): { ok: boolean; reason?: string } {
  if (!candidate) return { ok: false, reason: 'desktop_runtime_root_missing' };
  if (!isAbsolute(candidate)) return { ok: false, reason: 'desktop_runtime_root_invalid' };
  if (isFilesystemRoot(candidate)) return { ok: false, reason: 'desktop_runtime_root_is_filesystem_root' };
  const pkgPath = resolve(candidate, 'package.json');
  if (!existsSync(pkgPath)) return { ok: false, reason: 'desktop_runtime_root_invalid' };
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
    if (pkg.name !== '@horizon/desktop') return { ok: false, reason: 'desktop_runtime_root_invalid' };
  } catch { return { ok: false, reason: 'desktop_runtime_root_invalid' }; }
  const mainEntry = resolve(candidate, 'dist', 'main', 'index.cjs');
  if (!existsSync(mainEntry)) return { ok: false, reason: 'desktop_main_entry_missing' };
  const preloadEntry = resolve(candidate, 'dist', 'preload', 'index.cjs');
  if (!existsSync(preloadEntry)) return { ok: false, reason: 'desktop_preload_entry_missing' };
  const rendererEntry = resolve(candidate, 'dist', 'renderer', 'index.html');
  if (!existsSync(rendererEntry)) return { ok: false, reason: 'desktop_renderer_entry_missing' };
  return { ok: true };
}

export function resolveDesktopRuntimeLayout(input: RuntimeLayoutInput): DesktopRuntimeLayout {
  const layout: 'packaged' | 'unpackaged' = input.isPackaged ? 'packaged' : 'unpackaged';

  // Packaged: trust app.getAppPath() (electron-builder places our
  // bundled dist inside the packaged app root; asar-safe).
  if (layout === 'packaged') {
    const applicationRoot = input.appPath;
    if (isFilesystemRoot(applicationRoot)) {
      throw new Error(`desktop_runtime_root_is_filesystem_root:${sanitizePreloadPath(applicationRoot)}`);
    }
    const mainEntry = resolve(applicationRoot, 'dist', 'main', 'index.cjs');
    const preloadEntry = resolve(applicationRoot, 'dist', 'preload', 'index.cjs');
    const rendererEntry = resolve(applicationRoot, 'dist', 'renderer', 'index.html');
    for (const [name, path, code] of [
      ['main', mainEntry, 'desktop_main_entry_missing'],
      ['preload', preloadEntry, 'desktop_preload_entry_missing'],
      ['renderer', rendererEntry, 'desktop_renderer_entry_missing'],
    ] as const) {
      if (!existsSync(path)) throw new Error(`${code}:${sanitizePreloadPath(path)}`);
      // Also assert it's actually a file (defends against dir shadowing).
      const s = statSync(path);
      if (!s.isFile()) throw new Error(`${code}:${sanitizePreloadPath(path)}`);
      void name;
    }
    return {
      applicationRoot,
      mainEntry,
      preloadEntry,
      rendererEntry,
      rendererUrl: pathToFileURL(rendererEntry).href,
      layout,
    };
  }

  // Unpackaged: try each candidate in priority order until one validates.
  const candidates: Array<{ label: string; path: string | undefined }> = [
    { label: 'HORIZON_DESKTOP_ROOT', path: input.desktopRootOverride },
    { label: 'main-dir-parent', path: input.mainDir ? resolve(input.mainDir, '..', '..') : undefined },
    { label: 'appPath', path: input.appPath },
  ];
  const attempts: Array<{ label: string; path: string; reason: string }> = [];
  for (const c of candidates) {
    if (!c.path) continue;
    const abs = resolve(c.path);
    const v = validateDesktopRoot(abs);
    if (v.ok) {
      const applicationRoot = abs;
      const mainEntry = resolve(applicationRoot, 'dist', 'main', 'index.cjs');
      const preloadEntry = resolve(applicationRoot, 'dist', 'preload', 'index.cjs');
      const rendererEntry = resolve(applicationRoot, 'dist', 'renderer', 'index.html');
      return {
        applicationRoot,
        mainEntry,
        preloadEntry,
        rendererEntry,
        rendererUrl: pathToFileURL(rendererEntry).href,
        layout,
      };
    }
    attempts.push({ label: c.label, path: sanitizePreloadPath(abs), reason: v.reason ?? 'unknown' });
  }
  const attempted = attempts.map((a) => `${a.label}=${a.path}(${a.reason})`).join('; ');
  throw new Error(`desktop_runtime_root_invalid: ${attempted || 'no candidates'}`);
}

// Small helper to derive the bundled main directory in a way that
// doesn't depend on `__dirname` at call sites (test callers can
// pass any path). At runtime the caller passes `__dirname`.
export function mainDirFrom(mainEntryPath: string): string {
  return dirname(mainEntryPath);
}

// Windows-drive-root detection is exported for tests.
export function isWindowsDriveRoot(candidate: string): boolean {
  const n = candidate.replace(/\\/g, '/');
  return /^[A-Za-z]:\/?$/.test(n) || parse(candidate).root === candidate;
}
