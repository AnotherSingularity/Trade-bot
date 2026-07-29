#!/usr/bin/env tsx
/**
 * Stage 5 §CI — operational-validation preflight runner.
 *
 * Invoked by `.github/workflows/operational-validation-preflight.yml`.
 * Runs the pure `runOperationalValidationPreflight()` harness and
 * writes the evidence JSON to `apps/server/reports/operational-preflight/`.
 * Exits 1 on any preflight verdict other than `preflight_passed`.
 *
 * The runner is intentionally tiny — every meaningful assertion
 * lives in the harness so a downstream consumer can reproduce it
 * without spawning this script.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveEvidenceRunId,
  runOperationalValidationPreflight,
} from '../src/soak/operationalPreflight';

const HERE = dirname(fileURLToPath(import.meta.url));

function normalizeCommit(raw: string): string {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length === 40) return hex;
  if (hex.length === 0) return '0'.repeat(40);
  return (hex + '0'.repeat(40)).slice(0, 40);
}

function main(): void {
  const commitSha = normalizeCommit(process.env.HORIZON_BUILD_COMMIT ?? process.env.GITHUB_SHA ?? '0'.repeat(40));
  const installationIdHash = 'ci-preflight';
  const nowIso = new Date().toISOString();
  const evidenceRunId = deriveEvidenceRunId(commitSha, process.env.GITHUB_RUN_ID);

  const outDir = resolve(HERE, '..', 'reports', 'operational-preflight');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `preflight-${evidenceRunId}.json`);

  const result = runOperationalValidationPreflight({
    commitSha,
    installationIdHash,
    nowIso,
    evidenceRunId,
  });
  writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

  process.stdout.write(`preflight_verdict=${result.verdict}\n`);
  process.stdout.write(`preflight_events=${result.counts.observedEvents}\n`);
  process.stdout.write(`preflight_evidence=${outPath}\n`);
  for (const c of result.checks) {
    process.stdout.write(`check[${c.id}]=${c.ok ? 'ok' : 'FAIL'}: ${c.detail}\n`);
  }
  if (result.verdict !== 'preflight_passed') {
    process.stderr.write(`preflight_failed: ${result.detail}\n`);
    process.exit(1);
  }
}

main();
