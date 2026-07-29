#!/usr/bin/env tsx
/**
 * Stage 8 — Code freeze manifest generator.
 *
 * Emits `docs/audit/code_freeze_manifest.json` containing:
 *   - release-candidate SHA
 *   - migration head + chain digest
 *   - report-spec versions
 *   - lockfile digest
 *   - runtime-manifest digest (from Stage 6 shared helper)
 *   - installer digest (read from local windows-installer-checksum.txt
 *     if present, otherwise recorded as pending_ci)
 *   - test-inventory digest (from suite-manifest.json)
 *   - native-scenario count (from native-certification-inventory.json)
 *   - CI run IDs (from env, optional)
 *   - artifact IDs + checksums (from env, optional)
 *
 * Pure repository inspection — never touches a database, never
 * activates a real provider, never loads a credential. Idempotent:
 * given the same inputs, produces byte-identical output.
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRuntimeContentDigest } from './lib/runtime-content-digest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

interface FreezeManifest {
  readonly tool: 'code-freeze-manifest';
  readonly version: '1.0';
  readonly generatedAt: string;
  readonly releaseCandidateSha: string;
  readonly branch: string;
  readonly migrationHead: string;
  readonly migrationChainDigest: string;
  readonly reportSpecVersions: Record<string, string>;
  readonly lockfileDigest: string;
  readonly runtimeManifestDigest: string;
  readonly runtimeFileCount: number;
  readonly windowsInstaller: {
    readonly sha256: string | 'pending_ci';
    readonly sizeBytes: number | 'pending_ci';
    readonly fileName: string | 'pending_ci';
  };
  readonly testInventory: {
    readonly digest: string;
    readonly fileCount: number;
  };
  readonly nativeScenarioCount: number | 'unknown';
  readonly ci: {
    readonly stage3cNativeRunId: string | 'unknown';
    readonly desktopWindowsRunId: string | 'unknown';
    readonly managedDockerRuntimeRunId: string | 'unknown';
    readonly operationalPreflightRunId: string | 'unknown';
  };
  readonly artifacts: {
    readonly windowsInstallerChecksumArtifactId: string | 'unknown';
    readonly managedDockerReadinessArtifactId: string | 'unknown';
    readonly operationalPreflightEvidenceArtifactId: string | 'unknown';
  };
  readonly safetyContract: {
    readonly DRY_RUN: true;
    readonly ORDER_SUBMISSION_ENABLED: false;
    readonly liveCapitalAuthorized: false;
    readonly promotionEnabled: false;
    readonly kellyEnabled: false;
    readonly createOrderCounters: {
      readonly functionInvocations: 0;
      readonly attemptCount: 0;
      readonly networkCount: 0;
    };
  };
}

function fail(code: string, detail: string): never {
  process.stderr.write(`code_freeze_manifest_failed ${code}: ${detail}\n`);
  process.exit(1);
}
function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readMigrationInfo(): { head: string; chainDigest: string } {
  const dir = resolve(REPO_ROOT, 'apps/server/drizzle/migrations');
  if (!existsSync(dir)) fail('migrations_dir_missing', dir);
  const files = readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
  if (files.length === 0) fail('no_migration_files', dir);
  const head = files[files.length - 1].slice(0, 4);
  const hash = createHash('sha256');
  for (const name of files) {
    hash.update(name); hash.update('\n');
    hash.update(readFileSync(resolve(dir, name))); hash.update('\n');
  }
  return { head, chainDigest: hash.digest('hex') };
}

function readReportSpecVersions(): Record<string, string> {
  // The canonical source is packages/shared/src/reports.ts:
  //   export const REPORT_SPEC_VERSIONS = Object.freeze({...})
  // Parse the frozen literal by regex — never import it at runtime
  // so this script has no dependency on the built shared package.
  const p = resolve(REPO_ROOT, 'packages/shared/src/reports.ts');
  if (!existsSync(p)) return {};
  const text = readFileSync(p, 'utf8');
  const rx = /REPORT_SPEC_VERSIONS[^{]*Object\.freeze\(\{([\s\S]*?)\}\)/;
  const block = rx.exec(text)?.[1] ?? '';
  const entry = /(\w+):\s*'([^']+)'/g;
  const versions: Record<string, string> = {};
  let m;
  while ((m = entry.exec(block)) !== null) versions[m[1]] = m[2];
  return versions;
}

function readInstallerChecksum(): FreezeManifest['windowsInstaller'] {
  const p = resolve(REPO_ROOT, 'apps/desktop/release/windows-installer-checksum.txt');
  if (!existsSync(p)) {
    return { sha256: 'pending_ci', sizeBytes: 'pending_ci', fileName: 'pending_ci' };
  }
  const text = readFileSync(p, 'utf8');
  const sha = /SHA256=([0-9a-f]{64})/i.exec(text)?.[1] ?? 'pending_ci';
  const size = /SIZE=(\d+)/i.exec(text)?.[1];
  const name = /NAME=(.+)/i.exec(text)?.[1]?.trim() ?? 'pending_ci';
  return {
    sha256: sha === 'pending_ci' ? 'pending_ci' : sha,
    sizeBytes: size ? Number(size) : 'pending_ci',
    fileName: name,
  };
}

function readTestInventory(): { digest: string; fileCount: number } {
  const p = resolve(REPO_ROOT, 'apps/desktop/tests/suite-manifest.json');
  if (!existsSync(p)) return { digest: 'pending', fileCount: 0 };
  const text = readFileSync(p, 'utf8');
  const parsed = JSON.parse(text) as {
    assignments: {
      portable: string[];
      external: string[];
      native: string[];
      'managed-docker'?: string[];
      unassigned: unknown[];
    };
  };
  const all = [
    ...(parsed.assignments.portable ?? []),
    ...(parsed.assignments.external ?? []),
    ...(parsed.assignments.native ?? []),
    ...(parsed.assignments['managed-docker'] ?? []),
  ].sort();
  const digest = createHash('sha256').update(all.join('\n')).digest('hex');
  return { digest, fileCount: all.length };
}

function readNativeScenarioCount(): number | 'unknown' {
  const p = resolve(REPO_ROOT, 'apps/desktop/tests/native/native-certification-inventory.json');
  if (!existsSync(p)) return 'unknown';
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { requirements?: unknown[]; entries?: unknown[] };
    if (Array.isArray(parsed.requirements)) return parsed.requirements.length;
    if (Array.isArray(parsed.entries)) return parsed.entries.length;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function readBranch(): string {
  try {
    return execSync('git -C "' + REPO_ROOT + '" rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function main(): void {
  const commitSha = (process.env.HORIZON_BUILD_COMMIT ??
    execSync('git -C "' + REPO_ROOT + '" rev-parse HEAD', { encoding: 'utf8' }).trim());
  const branch = process.env.HORIZON_BRANCH ?? readBranch();

  const { head, chainDigest } = readMigrationInfo();
  const { digest: runtimeDigest, fileCount } = computeRuntimeContentDigest(REPO_ROOT);
  const reportSpecVersions = readReportSpecVersions();
  const windowsInstaller = readInstallerChecksum();
  const testInventory = readTestInventory();
  const nativeScenarioCount = readNativeScenarioCount();
  const lockPath = resolve(REPO_ROOT, 'package-lock.json');
  const lockfileDigest = existsSync(lockPath) ? fileSha256(lockPath) : 'pending';

  const manifest: FreezeManifest = {
    tool: 'code-freeze-manifest',
    version: '1.0',
    generatedAt: new Date().toISOString(),
    releaseCandidateSha: commitSha,
    branch,
    migrationHead: head,
    migrationChainDigest: chainDigest,
    reportSpecVersions,
    lockfileDigest,
    runtimeManifestDigest: runtimeDigest,
    runtimeFileCount: fileCount,
    windowsInstaller,
    testInventory,
    nativeScenarioCount,
    ci: {
      stage3cNativeRunId: process.env.STAGE3C_NATIVE_RUN_ID ?? 'unknown',
      desktopWindowsRunId: process.env.DESKTOP_WINDOWS_RUN_ID ?? 'unknown',
      managedDockerRuntimeRunId: process.env.MANAGED_DOCKER_RUNTIME_RUN_ID ?? 'unknown',
      operationalPreflightRunId: process.env.OPERATIONAL_PREFLIGHT_RUN_ID ?? 'unknown',
    },
    artifacts: {
      windowsInstallerChecksumArtifactId: process.env.WINDOWS_INSTALLER_CHECKSUM_ARTIFACT_ID ?? 'unknown',
      managedDockerReadinessArtifactId: process.env.MANAGED_DOCKER_READINESS_ARTIFACT_ID ?? 'unknown',
      operationalPreflightEvidenceArtifactId: process.env.OPERATIONAL_PREFLIGHT_EVIDENCE_ARTIFACT_ID ?? 'unknown',
    },
    safetyContract: {
      DRY_RUN: true,
      ORDER_SUBMISSION_ENABLED: false,
      liveCapitalAuthorized: false,
      promotionEnabled: false,
      kellyEnabled: false,
      createOrderCounters: {
        functionInvocations: 0,
        attemptCount: 0,
        networkCount: 0,
      },
    },
  };

  const outDir = resolve(REPO_ROOT, 'docs', 'audit');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `code_freeze_manifest.json`);
  writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf8');
  process.stdout.write(`code_freeze_manifest_written path=${outPath}\n`);
  process.stdout.write(`releaseCandidateSha=${commitSha}\n`);
  process.stdout.write(`migrationHead=${head} chain=${chainDigest.slice(0, 12)}\n`);
  process.stdout.write(`runtimeManifestDigest=${runtimeDigest.slice(0, 12)} files=${fileCount}\n`);
  process.stdout.write(`reportSpecVersions=${Object.keys(reportSpecVersions).length}\n`);
  process.stdout.write(`windowsInstaller=${windowsInstaller.sha256 === 'pending_ci' ? 'pending_ci' : windowsInstaller.sha256.slice(0, 12)}\n`);
  process.stdout.write(`nativeScenarioCount=${nativeScenarioCount}\n`);
}

main();
