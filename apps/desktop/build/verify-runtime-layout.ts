#!/usr/bin/env tsx
/**
 * Stage 3C-CI-FIX8 §8.1 — runtime layout verifier.
 *
 * Runs BEFORE `electron-builder --win` in CI. Ensures every
 * canonical entry exists and the package.json declared main file
 * matches. Fails fast if any structural invariant is violated.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = resolve(ROOT, 'dist');

interface DesktopPackage {
  name: string;
  main: string;
  devDependencies: Record<string, string>;
  build: { electronVersion: string; extraMetadata: { main: string } };
}

function fail(code: string, detail: string): never {
  process.stderr.write(`verify_runtime_layout_failed ${code}: ${detail}\n`);
  process.exit(1);
}

function main(): void {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as DesktopPackage;
  if (pkg.name !== '@horizon/desktop') fail('unexpected_package_name', pkg.name);
  const canonicalMain = 'dist/main/index.cjs';
  if (pkg.main !== canonicalMain) fail('package_main_mismatch', `${pkg.main} !== ${canonicalMain}`);
  if (pkg.build.extraMetadata.main !== canonicalMain) fail('extra_metadata_main_mismatch', pkg.build.extraMetadata.main);

  const electronVersion = pkg.devDependencies.electron;
  if (!/^\d+\.\d+\.\d+$/.test(electronVersion)) fail('electron_version_not_exact', electronVersion);
  if (pkg.build.electronVersion !== electronVersion) fail('electron_version_mismatch', `${electronVersion} !== ${pkg.build.electronVersion}`);

  const required = [
    { key: 'main', path: join(DIST, 'main/index.cjs'), code: 'build_manifest_main_missing' },
    { key: 'preload', path: join(DIST, 'preload/index.cjs'), code: 'build_manifest_preload_missing' },
    { key: 'renderer', path: join(DIST, 'renderer/index.html'), code: 'build_manifest_renderer_missing' },
  ];
  for (const r of required) {
    if (!existsSync(r.path)) fail(r.code, r.path);
  }
  process.stdout.write(`runtime_layout_verified electron=${electronVersion} main=${canonicalMain}\n`);
}

main();
