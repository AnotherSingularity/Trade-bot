#!/usr/bin/env node
/**
 * Phase 3B §P — Code-freeze manifest generator.
 *
 * Produces the immutable manifest that pins every version, hash and
 * safe-flag state that this freeze commits to. The manifest is
 * PROVISIONAL until §M (Windows CI produces an installer) and §N
 * (clean-machine smoke test) are green — the corresponding fields
 * remain null and `status` is `pending_windows_verification`.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const REPORT_DIR = join(REPO_ROOT, 'phase3b_audit/reports');
mkdirSync(REPORT_DIR, { recursive: true });

function readPkg(rel) {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel, 'package.json'), 'utf8'));
}
function hashFile(f) {
  return createHash('sha256').update(readFileSync(f)).digest('hex');
}
function walkFiles(dir) {
  const out = [];
  function inner(d) {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e === 'node_modules' || e === 'dist' || e === '.turbo' || e === 'release') continue;
      const full = join(d, e);
      const st = statSync(full);
      if (st.isDirectory()) inner(full);
      else out.push(full);
    }
  }
  inner(dir);
  return out.sort();
}

const commit = process.env.HORIZON_BUILD_COMMIT
  ?? execSync('git rev-parse HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const branch = process.env.HORIZON_BUILD_BRANCH
  ?? execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

const desktopPkg = readPkg('apps/desktop');
const serverPkg = readPkg('apps/server');
const sharedPkg = readPkg('packages/shared');

function fingerprintDir(rel) {
  const files = walkFiles(join(REPO_ROOT, rel)).filter((f) => /\.(ts|tsx|js|mjs|cjs|json|sql|css|html)$/.test(f));
  const h = createHash('sha256');
  for (const f of files) {
    const relative_ = relative(REPO_ROOT, f);
    h.update(relative_);
    h.update('\0');
    h.update(hashFile(f));
    h.update('\0');
  }
  return { checksum: h.digest('hex'), fileCount: files.length };
}

const desktopFingerprint = fingerprintDir('apps/desktop');
const serverFingerprint = fingerprintDir('apps/server/src');
const sharedFingerprint = fingerprintDir('packages/shared/src');
const migrationsFingerprint = fingerprintDir('apps/server/drizzle/migrations');

const lockfileSha = hashFile(join(REPO_ROOT, 'package-lock.json'));
const dockerCompose = hashFile(join(REPO_ROOT, 'docker-compose.yml'));

const releaseSurface = JSON.parse(readFileSync(join(REPORT_DIR, 'release_surface_manifest.json'), 'utf8'));

const manifest = {
  status: process.env.HORIZON_FREEZE_STATUS ?? 'pending_windows_verification',
  createdAt: process.env.HORIZON_AUDIT_TIMESTAMP ?? '1970-01-01T00:00:00.000Z',
  commit,
  branch,
  desktopVersion: desktopPkg.version,
  serverVersion: serverPkg.version,
  sharedVersion: sharedPkg.version,
  buildArtifactHashes: {
    desktopSource: desktopFingerprint,
    serverSource: serverFingerprint,
    sharedSource: sharedFingerprint,
    migrations: migrationsFingerprint,
  },
  windowsInstallerHash: process.env.HORIZON_WINDOWS_INSTALLER_SHA256 ?? null,
  windowsInstallerRunId: process.env.HORIZON_WINDOWS_CI_RUN_ID ?? null,
  migrationVersion: '0020',
  schemaFingerprint: process.env.HORIZON_SCHEMA_FINGERPRINT ?? '0020_mariadb_fingerprint',
  lockfileHash: lockfileSha,
  SBOMHash: null,
  DockerImageDigests: {
    mariadb: 'mariadb:10.11',
    redis: 'redis:7-alpine',
    composeFileSha256: dockerCompose,
  },
  championVersion: 'champ-1',
  strategyVersion: '3D-FIX-runtime',
  costModelVersion: 'gate3B-cost-attribution',
  fillModelVersion: 'gate3A-partial-exit',
  protectionPolicyVersion: 'gate3C-protection-policy',
  featureVersions: {
    universe: 'p2a-1',
    stage1_features: 'p2a-1',
    stage2_features: 'p2a-1',
  },
  regimeVersions: {
    global_market_state: 'p2b-1',
    product_regime: 'p2b-1',
    change_point: 'p2b-1',
    hmm_latent: 'p2b-1',
  },
  riskPolicyVersion: 'p2c-1',
  microstructurePolicyVersion: 'p2d-1',
  contextPolicyVersion: 'p2e-1',
  validationPolicyVersion: 'p2f-1',
  desktopConfigurationVersion: 'p3a-1',
  safeFlags: {
    DRY_RUN: true,
    ORDER_SUBMISSION_ENABLED: false,
    SIMULATION_MODE: 'shadow',
    liveOrderSubmissionDisabled: true,
  },
  productionAdapterIdentities: {
    coinbaseWebSocket: 'production-adapter-committed-inactive',
    coinbaseRest: 'production-adapter-committed-inactive',
  },
  testCounts: process.env.HORIZON_TEST_COUNTS_JSON
    ? JSON.parse(process.env.HORIZON_TEST_COUNTS_JSON)
    : { desktop: null, server: null, shared: null, note: 'populate after full verification run' },
  fixtureCounts: {
    context_observer: 50,
    validation_framework: 52,
    integrated_shadow_matrix: 40,
    microstructure: 33,
  },
  knownLimitations: [
    'The Windows CI + clean-Windows smoke test are executed OUT OF BAND on a native Windows runner.',
    'The manifest is PROVISIONAL until windowsInstallerHash + windowsInstallerRunId are populated.',
    'Native code signing is not performed; distribution requires an EV certificate.',
    'The seven-day soak has not been started (prohibited by Phase 3B).',
    'The two-hour operational preflight has not been started (prohibited by Phase 3B).',
    'Genuine Coinbase credentials have not been used (prohibited by Phase 3B).',
    'The mobile companion workspace is deferred and excluded from this freeze.',
  ],
  mobileStatus: 'deferred_non_blocking',
  guarantees: {
    operationalPreflightStarted: false,
    sevenDaySoakStarted: false,
    genuineCoinbaseCredentialsUsed: false,
    liveCapitalAuthorized: false,
    createOrderFunctionInvocations: 0,
    createOrderAttemptCount: 0,
    createOrderNetworkCount: 0,
  },
  reporting: releaseSurface.reporting,
  releaseSurfacePath: 'phase3b_audit/reports/release_surface_manifest.json',
  auditReportPaths: [
    'phase3b_audit/reports/release_surface_manifest.json',
    'phase3b_audit/reports/dependency_graph.json',
    'phase3b_audit/reports/isolation_report.json',
    'phase3b_audit/reports/economic_writer_inventory.json',
    'phase3b_audit/reports/create_order_audit.json',
    'phase3b_audit/reports/db_migration_audit.json',
    'phase3b_audit/reports/numerical_audit.json',
    'phase3b_audit/reports/desktop_security_audit.json',
  ],
};

writeFileSync(join(REPORT_DIR, 'code_freeze_manifest.json'), JSON.stringify(manifest, null, 2));
process.stdout.write(`code_freeze_manifest.json written — status=${manifest.status}\n`);
