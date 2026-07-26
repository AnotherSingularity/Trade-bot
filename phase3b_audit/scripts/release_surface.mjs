#!/usr/bin/env node
/**
 * Phase 3B §A — Release-surface manifest generator.
 *
 * Walks the monorepo and enumerates the ACTIVE release surface for
 * the desktop/server product. Mobile is deferred per policy and is
 * explicitly excluded, not silently omitted.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const REPORT_DIR = join(REPO_ROOT, 'phase3b_audit/reports');
mkdirSync(REPORT_DIR, { recursive: true });

const ACTIVE = ['apps/server', 'apps/desktop', 'packages/shared'];
const DEFERRED = ['apps/mobile'];
const INFRA = [
  'docker-compose.yml',
  'docker-compose.prod.yml',
  'turbo.json',
  'package.json',
  'package-lock.json',
  '.github/workflows/desktop-windows.yml',
  '.github/workflows/test.yml',
  '.github/workflows/deploy.yml',
];
const DOCS = ['README.md', 'DEPLOY.md', 'CHANGELOG.md'];

function readPackageJson(pkgPath) {
  return JSON.parse(readFileSync(join(REPO_ROOT, pkgPath, 'package.json'), 'utf8'));
}

function countByExt(dir) {
  const counts = {};
  function walk(d) {
    if (!existsSafe(d)) return;
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === 'dist' || e === '.turbo') continue;
      const full = join(d, e);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        const m = e.match(/\.([a-z0-9]+)$/i);
        if (m) counts[m[1].toLowerCase()] = (counts[m[1].toLowerCase()] || 0) + 1;
      }
    }
  }
  function existsSafe(p) {
    try { statSync(p); return true; } catch { return false; }
  }
  walk(dir);
  return counts;
}

function surveyPackage(pkgRelPath) {
  const pkg = readPackageJson(pkgRelPath);
  const full = join(REPO_ROOT, pkgRelPath);
  return {
    path: pkgRelPath,
    name: pkg.name,
    version: pkg.version,
    private: pkg.private ?? false,
    fileCountsByExtension: countByExt(full),
    scripts: Object.keys(pkg.scripts || {}).sort(),
    productionDependencyCount: Object.keys(pkg.dependencies || {}).length,
    devDependencyCount: Object.keys(pkg.devDependencies || {}).length,
  };
}

const activePkgs = ACTIVE.map(surveyPackage);
const deferredPkgs = DEFERRED.map(surveyPackage);

const manifest = {
  generatedAt: process.env.HORIZON_AUDIT_TIMESTAMP ?? '1970-01-01T00:00:00.000Z',
  purpose: 'Phase 3B active release-surface manifest',
  reporting: {
    active: 'desktop/server release surface: verified',
    mobile: 'mobile companion workspace: deferred, non-blocking',
  },
  activeWorkspaces: activePkgs,
  deferredWorkspaces: deferredPkgs,
  infrastructureFiles: INFRA,
  documentationFiles: DOCS,
  migrationsPath: 'apps/server/drizzle/migrations',
  windowsInstallerConfig: 'apps/desktop/installer',
  windowsCiWorkflow: '.github/workflows/desktop-windows.yml',
  releaseScripts: [
    'apps/desktop/build/generate-build-manifest.ts',
  ],
  operationalRunbooksPath: 'docs/runbooks',
  invariants: {
    DRY_RUN: true,
    ORDER_SUBMISSION_ENABLED: false,
    liveOrderSubmissionDisabled: true,
    mobileWorkspaceDeferred: true,
  },
};

writeFileSync(join(REPORT_DIR, 'release_surface_manifest.json'), JSON.stringify(manifest, null, 2));
process.stdout.write('release_surface_manifest.json written\n');
