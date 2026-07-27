#!/usr/bin/env node
/**
 * Stage 3C — desktop main + preload bundler.
 *
 * `tsc` produces per-file JS that at runtime does `require('@horizon/shared')`
 * — which resolves to `packages/shared/src/index.ts` per that package's
 * `main` field. Electron's raw Node cannot parse TypeScript, so the
 * `require()` throws before any of our main entry runs.
 *
 * This step bundles the compiled main + preload into single files that
 * inline `@horizon/shared`. Only workspace packages are bundled;
 * native modules (`electron`, `keytar`, `mysql2`, `ioredis`, `electron-log`,
 * `electron-store`) stay external so their compiled/native versions are
 * loaded at runtime.
 */
import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = resolve(ROOT, 'dist');

const external = [
  'electron',
  'keytar',
  'mysql2',
  'ioredis',
  'electron-log',
  'electron-store',
  'react',
  'react-dom',
];

async function bundle(entry, out) {
  await esbuild.build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: false,
    logLevel: 'info',
    external,
    // Preserve names to keep stack traces readable.
    minify: false,
    // Inline @horizon/shared source but let Node resolve everything else.
    resolveExtensions: ['.ts', '.js', '.mjs'],
    loader: { '.ts': 'ts' },
    tsconfig: join(ROOT, 'tsconfig.main.json'),
    allowOverwrite: true,
  });
}

// Stage 3C-CI-FIX8 §1.1: canonical runtime layout.
//   apps/desktop/dist/main/index.cjs      (esbuild CJS bundle)
//   apps/desktop/dist/preload/index.cjs   (esbuild CJS bundle)
//   apps/desktop/dist/renderer/index.html (Vite build)
// One canonical path used by main, preload resolver, renderer URL,
// electron-builder metadata, build manifest, and native harness.
await bundle(
  resolve(ROOT, 'src/main/index.ts'),
  join(DIST, 'main/index.cjs'),
);
await bundle(
  resolve(ROOT, 'src/preload/index.ts'),
  join(DIST, 'preload/index.cjs'),
);
console.log('desktop main + preload bundled (canonical layout)');
