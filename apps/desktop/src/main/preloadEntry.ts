/**
 * Stage 3C-CI-FIX7 §A3 — centralized preload entry resolver.
 *
 * The FIX6 native CI run proved the previous inline resolver
 * (`path.resolve(__dirname, '..', 'preload', 'index.js')`) computed
 * `dist/main/preload/index.js` — a path that does not exist. The
 * actual bundled preload lives at `dist/preload/preload/index.cjs`.
 * The renderer therefore never received `window.horizon`, and the
 * `preload_bridge_missing` banner appeared.
 *
 * This resolver:
 *   - Returns an ABSOLUTE path — no `..` traversal at the call site.
 *   - Verifies the file exists BEFORE `BrowserWindow` creation.
 *   - Verifies the extension is `.cjs` (unambiguous CommonJS).
 *   - Distinguishes packaged vs. unpackaged layouts.
 *   - Throws with `preload_entry_missing:<sanitized-path>` on failure
 *     so a startup failure is attributed to exactly this concern.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export interface PreloadResolveOptions {
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
  projectRoot?: string;
}

export interface PreloadResolveResult {
  path: string;
  layout: 'packaged' | 'unpackaged';
  bytes: number;
}

// Sanitize a path by trimming to the last four segments — enough to
// distinguish `dist/preload/preload/index.cjs` from any misresolution,
// without leaking a full runner or user directory.
export function sanitizePreloadPath(p: string): string {
  const parts = p.split(sep).filter(Boolean);
  const tail = parts.slice(Math.max(0, parts.length - 4));
  return (p.startsWith(sep) ? sep : '') + tail.join(sep);
}

// Packaged: preload sits under `<resourcesPath>/app/dist/preload/preload/index.cjs`
// (electron-builder places `dist/**` from the package under `app/dist`).
// Unpackaged (dev / native-test harness): preload is inside
// `<appPath>/dist/preload/preload/index.cjs` where appPath is the
// desktop package root as Electron sees it (the folder containing
// package.json). When Electron was launched with an explicit main file
// argument (as the native harness does), `appPath` is that main file's
// parent chain — `app.getAppPath()` returns the desktop package root.
export function resolvePreloadEntry(opts: PreloadResolveOptions): PreloadResolveResult {
  const layout: 'packaged' | 'unpackaged' = opts.isPackaged ? 'packaged' : 'unpackaged';
  const candidate = opts.isPackaged
    ? resolve(opts.resourcesPath, 'app', 'dist', 'preload', 'preload', 'index.cjs')
    : resolve(opts.appPath, 'dist', 'preload', 'preload', 'index.cjs');
  // Guard: whichever branch we take, the result MUST be absolute.
  if (!isAbsolute(candidate)) {
    throw new Error(`preload_entry_not_absolute:${sanitizePreloadPath(candidate)}`);
  }
  if (!existsSync(candidate)) {
    throw new Error(`preload_entry_missing:${sanitizePreloadPath(candidate)}`);
  }
  if (!candidate.endsWith('.cjs')) {
    throw new Error(`preload_entry_wrong_extension:${sanitizePreloadPath(candidate)}`);
  }
  const s = statSync(candidate);
  return { path: candidate, layout, bytes: s.size };
}
