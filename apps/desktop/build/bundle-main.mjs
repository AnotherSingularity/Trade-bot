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

await bundle(
  resolve(ROOT, 'src/main/index.ts'),
  join(DIST, 'main/main/index.js'),
);
await bundle(
  resolve(ROOT, 'src/preload/index.ts'),
  join(DIST, 'preload/preload/index.js'),
);
console.log('desktop main + preload bundled');
