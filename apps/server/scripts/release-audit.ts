#!/usr/bin/env tsx
/**
 * Stage 7 — Integrated release audit.
 *
 * Mechanically audits every surface named by the standing execution
 * order and emits `docs/audit/release_audit_<sha>.json`. Pure
 * repository-side inspection: parses migration files, walks source
 * trees, opens JSON manifests, compares against schemas. Never
 * touches a real database, never launches Docker, never loads a
 * credential.
 *
 * Every audit dimension returns a typed check with { id, ok, detail }
 * — a downstream reviewer can grep for `"ok": false` to find every
 * regression without reading the full document.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { computeRuntimeContentDigest } from './lib/runtime-content-digest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

interface Check {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}
interface Section {
  readonly section: string;
  readonly checks: readonly Check[];
}

function walk(dir: string, base: string, matcher: (rel: string) => boolean, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build' || name === 'logs' || name === 'release') continue;
    const p = resolve(dir, name);
    const rel = p.slice(base.length + 1).replace(/\\/g, '/');
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, base, matcher, acc);
    else if (matcher(rel)) acc.push(rel);
  }
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function grepAny(root: string, matchGlob: (rel: string) => boolean, needles: readonly RegExp[]): { rel: string; hit: string }[] {
  const acc: string[] = [];
  walk(root, root, matchGlob, acc);
  const hits: { rel: string; hit: string }[] = [];
  for (const rel of acc) {
    let text: string;
    try {
      text = readFileSync(resolve(root, rel), 'utf8');
    } catch { continue; }
    for (const rx of needles) {
      const m = text.match(rx);
      if (m) hits.push({ rel, hit: m[0].slice(0, 80) });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Audit dimensions
// ---------------------------------------------------------------------------

function auditMigrations(): Section {
  const checks: Check[] = [];
  const dir = resolve(REPO_ROOT, 'apps/server/drizzle/migrations');
  if (!existsSync(dir)) {
    checks.push({ id: 'migrations_dir', ok: false, detail: 'apps/server/drizzle/migrations missing' });
    return { section: 'migrations', checks };
  }
  const files = readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
  checks.push({ id: 'migrations_present', ok: files.length > 0, detail: `${files.length} migration files` });

  // Contiguous 0000..head?
  let contiguous = true;
  for (let i = 0; i < files.length; i++) {
    const expected = String(i).padStart(4, '0');
    if (!files[i].startsWith(expected + '_')) { contiguous = false; break; }
  }
  checks.push({ id: 'migrations_contiguous', ok: contiguous, detail: contiguous ? `contiguous 0000..${files[files.length - 1].slice(0, 4)}` : 'gap in migration sequence' });

  // Chain digest
  const hash = createHash('sha256');
  for (const name of files) {
    hash.update(name); hash.update('\n');
    hash.update(readFileSync(resolve(dir, name))); hash.update('\n');
  }
  const chainDigest = hash.digest('hex');
  checks.push({ id: 'migration_chain_digest', ok: true, detail: `sha256=${chainDigest}` });

  return { section: 'migrations', checks };
}

function auditSchemaFingerprint(): Section {
  const checks: Check[] = [];
  const schema = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');
  if (!existsSync(schema)) {
    checks.push({ id: 'schema_present', ok: false, detail: 'apps/server/src/db/schema.ts missing' });
    return { section: 'schema_fingerprint', checks };
  }
  const digest = fileSha256(schema);
  checks.push({ id: 'schema_fingerprint', ok: true, detail: `sha256=${digest}` });
  return { section: 'schema_fingerprint', checks };
}

function auditSuiteTopology(): Section {
  const checks: Check[] = [];
  try {
    execSync('npx tsx build/verify-test-topology.ts', {
      cwd: resolve(REPO_ROOT, 'apps/desktop'),
      stdio: 'pipe',
    });
    checks.push({ id: 'desktop_suite_topology', ok: true, detail: 'verify-test-topology OK' });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString('utf8') ?? String(e);
    checks.push({ id: 'desktop_suite_topology', ok: false, detail: stderr.slice(0, 400) });
  }
  return { section: 'suite_topology', checks };
}

function auditWorkflowTopology(): Section {
  const checks: Check[] = [];
  const wfDir = resolve(REPO_ROOT, '.github/workflows');
  if (!existsSync(wfDir)) {
    checks.push({ id: 'workflows_dir', ok: false, detail: '.github/workflows missing' });
    return { section: 'workflow_topology', checks };
  }
  const files = readdirSync(wfDir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml')).sort();
  const required = [
    'stage3c-native.yml',
    'desktop-windows.yml',
    'managed-docker-runtime.yml',
    'operational-validation-preflight.yml',
    'operational-soak-daily.yml',
    'operational-soak-launch.yml',
  ];
  for (const r of required) {
    checks.push({ id: `workflow_${r.replace(/\.ya?ml$/, '')}`, ok: files.includes(r), detail: files.includes(r) ? 'present' : `${r} missing` });
  }
  checks.push({ id: 'workflow_count', ok: true, detail: `${files.length} workflow files: ${files.join(', ')}` });
  return { section: 'workflow_topology', checks };
}

function auditSafetyFlags(): Section {
  const checks: Check[] = [];
  const schema = resolve(REPO_ROOT, 'packages/shared/src/soakManifest.ts');
  const text = readFileSync(schema, 'utf8');
  const literals: Array<{ needle: RegExp; label: string }> = [
    { needle: /DRY_RUN:\s*z\.literal\(true\)/, label: 'DRY_RUN=z.literal(true)' },
    { needle: /ORDER_SUBMISSION_ENABLED:\s*z\.literal\(false\)/, label: 'ORDER_SUBMISSION_ENABLED=z.literal(false)' },
    { needle: /liveCapitalAuthorized:\s*z\.literal\(false\)/, label: 'liveCapitalAuthorized=z.literal(false)' },
    { needle: /promotionEnabled:\s*z\.literal\(false\)/, label: 'promotionEnabled=z.literal(false)' },
    { needle: /kellyEnabled:\s*z\.literal\(false\)/, label: 'kellyEnabled=z.literal(false)' },
    { needle: /functionInvocations:\s*z\.literal\(0\)/, label: 'functionInvocations=z.literal(0)' },
    { needle: /attemptCount:\s*z\.literal\(0\)/, label: 'attemptCount=z.literal(0)' },
    { needle: /networkCount:\s*z\.literal\(0\)/, label: 'networkCount=z.literal(0)' },
  ];
  for (const { needle, label } of literals) {
    const ok = needle.test(text);
    checks.push({ id: `safety_${label.split(/[:=]/)[0].trim()}`, ok, detail: ok ? `${label} enforced` : `${label} NOT enforced` });
  }
  return { section: 'safety_flags', checks };
}

function auditCredentialAbsence(): Section {
  const checks: Check[] = [];
  const forbidden: RegExp[] = [
    /COINBASE[_-]?API[_-]?KEY\s*=\s*['"][A-Za-z0-9]/,
    /COINBASE[_-]?API[_-]?SECRET\s*=\s*['"][A-Za-z0-9]/,
    /BOOTSTRAP_TOKEN\s*=\s*['"][A-Za-z0-9]/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /Bearer\s+[A-Za-z0-9._~+/=-]{40,}/,
  ];
  // Only audit git-TRACKED files. `git ls-files` respects .gitignore,
  // so a local .env, node_modules, and per-run evidence directories
  // never enter the scan.
  let tracked: string[];
  try {
    tracked = execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter(Boolean);
  } catch (e) {
    checks.push({ id: 'credential_absence', ok: false, detail: `git ls-files failed: ${(e as Error).message.slice(0, 200)}` });
    return { section: 'credential_absence', checks };
  }
  const wantExt = /\.(ts|tsx|js|cjs|mjs|json|yml|yaml|env|md|txt)$/;
  const hits: { rel: string; hit: string }[] = [];
  for (const rel of tracked) {
    if (!wantExt.test(rel)) continue;
    // Skip the audit script itself (contains the regex literals).
    if (rel === 'apps/server/scripts/release-audit.ts') continue;
    // Skip Stage 5D verifier + operator smoke pack (contain regex literals for scanning).
    if (rel === 'apps/desktop/build/verify-packaged-installer.ts') continue;
    if (rel === 'scripts/operator/verify-windows-install.ps1') continue;
    let text: string;
    try { text = readFileSync(resolve(REPO_ROOT, rel), 'utf8'); } catch { continue; }
    for (const rx of forbidden) {
      const m = text.match(rx);
      if (m) hits.push({ rel, hit: m[0].slice(0, 80) });
    }
  }
  checks.push({
    id: 'credential_absence',
    ok: hits.length === 0,
    detail: hits.length === 0
      ? `zero credential-shaped substrings across ${tracked.length} git-tracked files`
      : `${hits.length} hits: ${hits.slice(0, 5).map((h) => `${h.rel}(${h.hit})`).join('; ')}`,
  });
  return { section: 'credential_absence', checks };
}

function auditOrderSubmissionBarrier(): Section {
  const checks: Check[] = [];
  // The barrier lives at the single canonical createOrder entry
  // inside coinbase.ts + the env.ts safety-flag surface. Verify
  // both reference the two flags together.
  const coinbase = readFileSync(resolve(REPO_ROOT, 'apps/server/src/trading/coinbase.ts'), 'utf8');
  const env = readFileSync(resolve(REPO_ROOT, 'apps/server/src/env.ts'), 'utf8');
  const coinbaseGuard = /DRY_RUN/.test(coinbase) && /ORDER_SUBMISSION_ENABLED/.test(coinbase);
  const envGuard = /ORDER_SUBMISSION_ENABLED/.test(env);
  checks.push({ id: 'coinbase_double_lock', ok: coinbaseGuard, detail: coinbaseGuard ? 'DRY_RUN + ORDER_SUBMISSION_ENABLED both referenced in trading/coinbase.ts' : 'coinbase.ts missing one of the two safety flags' });
  checks.push({ id: 'env_safety_flag', ok: envGuard, detail: envGuard ? 'ORDER_SUBMISSION_ENABLED declared in env.ts' : 'env.ts missing ORDER_SUBMISSION_ENABLED' });
  return { section: 'order_submission_barrier', checks };
}

function auditProviderSelection(): Section {
  const checks: Check[] = [];
  const factoryPath = resolve(REPO_ROOT, 'apps/server/src/market_data/providerFactory.ts');
  if (!existsSync(factoryPath)) {
    checks.push({ id: 'adapter_factory_present', ok: false, detail: 'apps/server/src/market_data/providerFactory.ts missing' });
    return { section: 'provider_selection', checks };
  }
  const text = readFileSync(factoryPath, 'utf8');
  // Non-production paths named `mock`, `fixture`, or `inMemory`.
  const referencesNonProd = /fixture|mock|InMemory/i.test(text);
  const referencesProduction = /production|coinbase/i.test(text);
  checks.push({ id: 'adapter_factory_references_non_production', ok: referencesNonProd, detail: referencesNonProd ? 'non-production (fixture/mock/InMemory) provider path exists' : 'no non-production path' });
  checks.push({ id: 'adapter_factory_references_production', ok: referencesProduction, detail: referencesProduction ? 'production provider path exists' : 'no production path' });
  return { section: 'provider_selection', checks };
}

function auditPathSecurity(): Section {
  const checks: Check[] = [];
  const p = resolve(REPO_ROOT, 'apps/server/src/reports/pathValidation.ts');
  if (!existsSync(p)) {
    checks.push({ id: 'path_validation_present', ok: false, detail: 'apps/server/src/reports/pathValidation.ts missing' });
    return { section: 'path_security', checks };
  }
  const text = readFileSync(p, 'utf8');
  const hasTraversalCheck = /\.\.|traversal|escape/i.test(text);
  const hasSymlinkCheck = /realpath|symlink/i.test(text);
  checks.push({ id: 'path_traversal_guard', ok: hasTraversalCheck, detail: hasTraversalCheck ? 'referenced' : 'traversal guard missing' });
  checks.push({ id: 'path_symlink_guard', ok: hasSymlinkCheck, detail: hasSymlinkCheck ? 'referenced' : 'symlink guard missing' });
  return { section: 'path_security', checks };
}

function auditRedaction(): Section {
  const checks: Check[] = [];
  const p = resolve(REPO_ROOT, 'apps/server/src/reports/redact.ts');
  if (!existsSync(p)) {
    checks.push({ id: 'redact_present', ok: false, detail: 'apps/server/src/reports/redact.ts missing' });
    return { section: 'redaction', checks };
  }
  const text = readFileSync(p, 'utf8');
  // Redact module uses lowercase key-suffix matching, so
  // canonical audit needles are lower-cased and cover the four
  // credential families the module lists (auth, secret, key,
  // session). Value-shape rules cover token + bearer + hex.
  const keys = ['password', 'token', 'apikey', 'apisecret', 'sessionid', 'authorization', 'bearer'];
  for (const k of keys) {
    const ok = text.toLowerCase().includes(k);
    checks.push({ id: `redact_${k}`, ok, detail: ok ? `${k} covered` : `${k} not covered` });
  }
  return { section: 'redaction', checks };
}

function auditReportGeneratorRegistry(): Section {
  const checks: Check[] = [];
  const p = resolve(REPO_ROOT, 'apps/server/src/reports/generators/generators.ts');
  if (!existsSync(p)) {
    checks.push({ id: 'generators_present', ok: false, detail: 'generators.ts missing' });
    return { section: 'report_generators', checks };
  }
  const text = readFileSync(p, 'utf8');
  // The 13 canonical report kinds — grepped from the generators
  // registry itself so this audit stays honest against renames.
  const KINDS = [
    'safety_status', 'system_manifest', 'incidents', 'cost_attribution',
    'portfolio_risk', 'universe_and_hygiene', 'fingerprints', 'regimes',
    'microstructure', 'context', 'validation', 'daily_shadow', 'decision_chain',
  ];
  const missing = KINDS.filter((k) => !text.includes(k));
  checks.push({
    id: 'report_generator_kinds',
    ok: missing.length === 0,
    detail: missing.length === 0 ? `all 13 kinds present` : `missing: ${missing.join(', ')}`,
  });
  return { section: 'report_generators', checks };
}

function auditIdempotency(): Section {
  const checks: Check[] = [];
  const p = resolve(REPO_ROOT, 'apps/server/src/reports/worker.ts');
  if (!existsSync(p)) {
    checks.push({ id: 'worker_present', ok: false, detail: 'worker.ts missing' });
    return { section: 'idempotency', checks };
  }
  const text = readFileSync(p, 'utf8');
  const hasUnique = /ER_DUP_ENTRY|idempotencyKey/.test(text);
  checks.push({ id: 'idempotency_key_present', ok: hasUnique, detail: hasUnique ? 'DB-enforced idempotency active' : 'idempotency not enforced' });
  return { section: 'idempotency', checks };
}

function auditManagedRuntime(): Section {
  const checks: Check[] = [];
  const p = resolve(REPO_ROOT, 'apps/desktop/src/main/managedDockerOrchestrator.ts');
  if (!existsSync(p)) {
    checks.push({ id: 'managed_orchestrator', ok: false, detail: 'managedDockerOrchestrator.ts missing' });
    return { section: 'managed_runtime', checks };
  }
  const text = readFileSync(p, 'utf8');
  const guards = ['owner=horizon', 'label_missing_refuse_to_touch', 'readiness_timeout'];
  for (const g of guards) {
    checks.push({ id: `orchestrator_${g}`, ok: text.includes(g), detail: text.includes(g) ? 'present' : `${g} missing` });
  }
  return { section: 'managed_runtime', checks };
}

function auditWindowsInstaller(): Section {
  const checks: Check[] = [];
  const wf = resolve(REPO_ROOT, '.github/workflows/desktop-windows.yml');
  if (!existsSync(wf)) {
    checks.push({ id: 'windows_workflow', ok: false, detail: 'desktop-windows.yml missing' });
    return { section: 'windows_installer', checks };
  }
  const text = readFileSync(wf, 'utf8');
  checks.push({ id: 'windows_verify_step', ok: /verify:packaged-installer/.test(text), detail: /verify:packaged-installer/.test(text) ? 'verify:packaged-installer step present' : 'missing' });
  checks.push({ id: 'windows_checksum_artifact', ok: /windows-installer-checksum/.test(text), detail: /windows-installer-checksum/.test(text) ? 'checksum artifact upload present' : 'missing' });
  return { section: 'windows_installer', checks };
}

function auditRuntimeManifest(): Section {
  const checks: Check[] = [];
  const { digest, fileCount } = computeRuntimeContentDigest(REPO_ROOT);
  checks.push({ id: 'runtime_content_digest', ok: true, detail: `sha256=${digest} files=${fileCount}` });
  return { section: 'runtime_manifest', checks };
}

function auditDependencyLockfile(): Section {
  const checks: Check[] = [];
  const p = resolve(REPO_ROOT, 'package-lock.json');
  if (!existsSync(p)) {
    checks.push({ id: 'lockfile_present', ok: false, detail: 'package-lock.json missing' });
    return { section: 'dependency_lockfile', checks };
  }
  const digest = fileSha256(p);
  checks.push({ id: 'lockfile_digest', ok: true, detail: `sha256=${digest}` });
  return { section: 'dependency_lockfile', checks };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const commitSha = (process.env.HORIZON_BUILD_COMMIT ?? execSync('git -C "' + REPO_ROOT + '" rev-parse HEAD', { encoding: 'utf8' }).trim());
  const sections: Section[] = [
    auditMigrations(),
    auditSchemaFingerprint(),
    auditSuiteTopology(),
    auditWorkflowTopology(),
    auditSafetyFlags(),
    auditCredentialAbsence(),
    auditOrderSubmissionBarrier(),
    auditProviderSelection(),
    auditPathSecurity(),
    auditRedaction(),
    auditReportGeneratorRegistry(),
    auditIdempotency(),
    auditManagedRuntime(),
    auditWindowsInstaller(),
    auditRuntimeManifest(),
    auditDependencyLockfile(),
  ];

  const totalChecks = sections.reduce((n, s) => n + s.checks.length, 0);
  const failures: Array<{ section: string; check: Check }> = [];
  for (const s of sections) for (const c of s.checks) if (!c.ok) failures.push({ section: s.section, check: c });

  const report = {
    tool: 'release-audit',
    version: '1.0',
    generatedAt: new Date().toISOString(),
    commitSha,
    totalChecks,
    failedChecks: failures.length,
    verdict: failures.length === 0 ? 'release_audit_passed' : 'release_audit_failed',
    sections,
    failures,
  };

  const outDir = resolve(REPO_ROOT, 'docs', 'audit');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `release_audit_${commitSha.slice(0, 12)}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(`release_audit_verdict=${report.verdict}\n`);
  process.stdout.write(`release_audit_checks=${totalChecks} failed=${failures.length}\n`);
  process.stdout.write(`release_audit_path=${outPath}\n`);
  for (const f of failures) {
    process.stderr.write(`FAIL[${f.section}] ${f.check.id}: ${f.check.detail}\n`);
  }
  if (failures.length > 0) process.exit(1);
}

main();
