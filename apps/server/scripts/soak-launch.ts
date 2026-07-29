#!/usr/bin/env tsx
/**
 * Stage 6 — Durable operational soak launcher.
 *
 * Creates `SOAK_ANCHOR.json` at repo root and commits it. Refuses
 * to run if an anchor already exists and its `finalVerdict` is
 * `in_progress` — the caller must resolve the prior soak first.
 *
 * A launch:
 *   - Pins the exact commit SHA the workflow's checkout is running
 *     against.
 *   - Records the migration head + chain digest (derived from the
 *     migration files on disk).
 *   - Records the report-spec versions.
 *   - Sets expectedEndAt = startedAt + 7 UTC days.
 *   - Records installationIdHash + runtimeMode.
 *
 * The launcher never runs the workload — that's `soak-daily-cycle.ts`.
 * Every subsequent daily cycle refuses to run if the checkout's SHA
 * has drifted from the anchor.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SOAK_DAY_COUNT } from '@horizon/shared';
import { computeRuntimeContentDigest } from './lib/runtime-content-digest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const ANCHOR_PATH = resolve(REPO_ROOT, 'SOAK_ANCHOR.json');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'apps/server/drizzle/migrations');

interface SoakAnchor {
  soakId: string;
  commitSha: string;
  runtimeContentDigest: string;
  startedAt: string;
  expectedEndAt: string;
  finalVerdict: 'in_progress' | 'passed' | 'invalidated' | 'no_run';
  installationIdHash: string;
  migrationHead: string;
  migrationChainDigest: string;
  reportSpecVersions: Record<string, string>;
  runtimeMode: 'managed_docker' | 'packaged_managed_docker' | 'external_test_server';
}


function fail(code: string, detail: string): never {
  process.stderr.write(`soak_launch_failed ${code}: ${detail}\n`);
  process.exit(1);
}
function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function normalizeCommit(raw: string): string {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length === 40) return hex;
  if (hex.length === 0) return '0'.repeat(40);
  return (hex + '0'.repeat(40)).slice(0, 40);
}

function computeMigrationDigest(): { head: string; chainDigest: string } {
  if (!existsSync(MIGRATIONS_DIR)) fail('migrations_dir_missing', MIGRATIONS_DIR);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((n) => /^\d{4}_.*\.sql$/.test(n))
    .sort();
  if (files.length === 0) fail('no_migration_files', MIGRATIONS_DIR);
  const head = files[files.length - 1].slice(0, 4);
  const hash = createHash('sha256');
  for (const name of files) {
    hash.update(name);
    hash.update('\n');
    hash.update(readFileSync(resolve(MIGRATIONS_DIR, name)));
    hash.update('\n');
  }
  return { head, chainDigest: hash.digest('hex') };
}

function main(): void {
  if (existsSync(ANCHOR_PATH)) {
    const existing = JSON.parse(readFileSync(ANCHOR_PATH, 'utf8')) as SoakAnchor;
    if (existing.finalVerdict === 'in_progress') {
      fail('anchor_exists_in_progress', `SOAK_ANCHOR.json already tracks ${existing.soakId} at commit ${existing.commitSha}. Resolve prior soak first.`);
    }
    log(`prior_soak_verdict=${existing.finalVerdict} — safe to overwrite for a new run.`);
  }

  const commitSha = normalizeCommit(process.env.HORIZON_BUILD_COMMIT ?? process.env.GITHUB_SHA ?? '0'.repeat(40));
  const startedAt = process.env.HORIZON_SOAK_START_UTC ?? new Date().toISOString();
  const startedDate = new Date(startedAt);
  if (Number.isNaN(startedDate.getTime())) fail('start_iso_invalid', startedAt);
  const expectedEndAt = new Date(startedDate.getTime() + DEFAULT_SOAK_DAY_COUNT * 86_400_000).toISOString();

  const { head, chainDigest } = computeMigrationDigest();
  const { digest: runtimeContentDigest, fileCount } = computeRuntimeContentDigest(REPO_ROOT);
  const installationIdHash = 'ci-soak-' + createHash('sha256').update(commitSha).digest('hex').slice(0, 8);
  const soakId = 'soak-' + createHash('sha256').update(`${commitSha}|${startedAt}`).digest('hex').slice(0, 12);

  const anchor: SoakAnchor = {
    soakId,
    commitSha,
    runtimeContentDigest,
    startedAt,
    expectedEndAt,
    finalVerdict: 'in_progress',
    installationIdHash,
    migrationHead: head,
    migrationChainDigest: chainDigest,
    reportSpecVersions: {
      safety_status: 'safety_status.v1',
      system_manifest: 'system_manifest.v1',
      incidents: 'incidents.v1',
      cost_attribution: 'cost_attribution.v1',
      portfolio_risk: 'portfolio_risk.v1',
      universe_and_hygiene: 'universe_and_hygiene.v1',
      fingerprints: 'fingerprints.v1',
      regimes: 'regimes.v1',
      microstructure: 'microstructure.v1',
      context: 'context.v1',
      validation: 'validation.v1',
      daily_shadow: 'daily_shadow.v1',
      decision_chain: 'decision_chain.v1',
    },
    runtimeMode: (process.env.HORIZON_SOAK_RUNTIME_MODE as SoakAnchor['runtimeMode']) ?? 'managed_docker',
  };

  writeFileSync(ANCHOR_PATH, JSON.stringify(anchor, null, 2), 'utf8');

  log(`soak_launched soakId=${soakId} commit=${commitSha.slice(0, 8)} startedAt=${startedAt} expectedEndAt=${expectedEndAt}`);
  log(`migration_head=${head} chain=${chainDigest.slice(0, 12)}...`);
  log(`runtime_content_digest=${runtimeContentDigest.slice(0, 12)}... files=${fileCount}`);
  log(`anchor_written path=${ANCHOR_PATH}`);
}

main();
