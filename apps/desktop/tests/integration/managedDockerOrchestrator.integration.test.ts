/**
 * Stage 5C — Managed-Docker orchestrator integration test.
 *
 * Runs the ORCHESTRATOR against a REAL docker daemon using the
 * shipped `resources/managed-docker-compose.yml`. Gated on
 * `HORIZON_REQUIRE_MANAGED_DOCKER=true` — skipped otherwise so the
 * portable suite is not held hostage to docker availability.
 *
 * Test flow:
 *   1. preflight — docker + daemon + compose plugin + compose file
 *   2. provision — composeUp, verify every container's owner=horizon label
 *   3. readiness — poll containerHealth until each service is healthy
 *   4. readiness report — emit machine-readable evidence artifact
 *   5. teardown — composeDown (label-guarded)
 *   6. leak check — assert no owner=horizon container remains
 *
 * The test uses a random project name so parallel CI jobs cannot
 * step on each other, and it always attempts teardown even if the
 * assertions fail.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChildProcessCommandRunner } from '../../src/main/commandRunner';
import type { DockerProbe } from '../../src/main/dockerProbe';
import { RealDockerProbe } from '../../src/main/dockerProbe';
import type { Logger } from '../../src/main/logging';
import {
  buildManagedRuntimeReadinessReport,
  serializeReadinessReport,
} from '../../src/main/managedDockerEvidence';
import type { ContainerRuntime } from '../../src/main/managedDockerOrchestrator';
import {
  ManagedDockerOrchestrator,
  type ManagedOrchestrationConfig,
} from '../../src/main/managedDockerOrchestrator';

const shouldRun = process.env.HORIZON_REQUIRE_MANAGED_DOCKER === 'true';
const describeGated = shouldRun ? describe : describe.skip;

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const COMPOSE_FILE = resolve(REPO_ROOT, 'apps/desktop/resources/managed-docker-compose.yml');
const EVIDENCE_DIR = resolve(REPO_ROOT, 'apps/desktop/tests/integration/logs');
const RUN_ID = createHash('sha256').update(String(process.pid) + String(process.env.GITHUB_RUN_ID ?? '')).digest('hex').slice(0, 12);
const PROJECT = `horizon-md-${RUN_ID}`;

const logger = {
  info: (msg: string, ctx?: unknown): void => { process.stdout.write(`[INFO] ${msg} ${ctx ? JSON.stringify(ctx) : ''}\n`); },
  warn: (msg: string, ctx?: unknown): void => { process.stderr.write(`[WARN] ${msg} ${ctx ? JSON.stringify(ctx) : ''}\n`); },
  error: (msg: string, ctx?: unknown): void => { process.stderr.write(`[ERROR] ${msg} ${ctx ? JSON.stringify(ctx) : ''}\n`); },
  debug: (): void => undefined,
} as unknown as Logger;

function makeRuntime(runner: ChildProcessCommandRunner): ContainerRuntime {
  return {
    async composeUp(project, composeFile) {
      const r = await runner.run('docker', ['compose', '-p', project, '-f', composeFile, 'up', '-d'], {
        cwd: process.cwd(), timeoutMs: 120_000, maxBufferBytes: 1024 * 1024,
      });
      return r.ok ? { ok: true } : { ok: false, detail: r.stderr.slice(0, 400) };
    },
    async composeDown(project, composeFile) {
      const r = await runner.run('docker', ['compose', '-p', project, '-f', composeFile, 'down', '--remove-orphans'], {
        cwd: process.cwd(), timeoutMs: 60_000, maxBufferBytes: 1024 * 1024,
      });
      return r.ok ? { ok: true } : { ok: false, detail: r.stderr.slice(0, 400) };
    },
    async inspectLabels(project, service) {
      const psRes = await runner.run('docker', ['compose', '-p', project, 'ps', '-q', service], {
        cwd: process.cwd(), timeoutMs: 10_000, maxBufferBytes: 4096,
      });
      const cid = psRes.stdout.trim().split(/\r?\n/)[0];
      if (!cid) return { ok: false, labels: {}, detail: 'container_not_found' };
      const inspect = await runner.run('docker', ['inspect', '--format', '{{json .Config.Labels}}', cid], {
        cwd: process.cwd(), timeoutMs: 10_000, maxBufferBytes: 65_536,
      });
      if (!inspect.ok) return { ok: false, labels: {}, detail: inspect.stderr.slice(0, 200) };
      try {
        const raw = JSON.parse(inspect.stdout.trim()) as Record<string, string>;
        return { ok: true, labels: raw ?? {} };
      } catch (e) {
        return { ok: false, labels: {}, detail: String(e).slice(0, 200) };
      }
    },
  };
}

async function countOwnerHorizonContainers(runner: ChildProcessCommandRunner): Promise<number> {
  const r = await runner.run('docker', ['ps', '-a', '--filter', 'label=owner=horizon', '--format', '{{.Names}}'], {
    cwd: process.cwd(), timeoutMs: 10_000, maxBufferBytes: 65_536,
  });
  if (!r.ok) return -1;
  const trimmed = r.stdout.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\r?\n/).length;
}

describeGated('Stage 5C — managed-Docker orchestrator vs real docker daemon', () => {
  const runner = new ChildProcessCommandRunner();
  const probe: DockerProbe = new RealDockerProbe(runner);
  const runtime = makeRuntime(runner);
  const clock = { now: (): number => Date.now(), sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)) };
  const orch = new ManagedDockerOrchestrator(probe, runtime, logger, clock);
  const config: ManagedOrchestrationConfig = {
    project: PROJECT,
    composeFile: COMPOSE_FILE,
    containers: [
      { service: 'mariadb', image: 'mariadb:10.11.6', requiredHealthy: true, readinessTimeoutMs: 120_000 },
      { service: 'redis', image: 'redis:7.4-alpine', requiredHealthy: true, readinessTimeoutMs: 30_000 },
    ],
    readinessTimeoutMs: 150_000,
  };

  beforeAll(() => {
    if (!existsSync(EVIDENCE_DIR)) mkdirSync(EVIDENCE_DIR, { recursive: true });
    process.stdout.write(`[INFO] compose_file=${COMPOSE_FILE} project=${PROJECT}\n`);
    const composeExists = existsSync(COMPOSE_FILE);
    expect(composeExists).toBe(true);
  });

  afterAll(async () => {
    // Always attempt teardown even if a test above failed. Real
    // integration tests must never leak containers on failure.
    try {
      await runtime.composeDown(PROJECT, COMPOSE_FILE);
    } catch {
      /* best effort */
    }
  });

  it('startup completes and every container is owner=horizon labelled', async () => {
    const result = await orch.startup(config);
    const report = buildManagedRuntimeReadinessReport({
      project: PROJECT,
      composeFile: COMPOSE_FILE,
      result,
      environment: {
        runtimeMode: 'managed_docker',
        packaged: false,
        nodeEnv: process.env.NODE_ENV ?? null,
        desktopVersion: '3.0.0',
        installationIdHash: 'integration',
        hostOs: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
        hostArch: process.arch,
      },
      generatedAtIso: new Date().toISOString(),
    });
    writeFileSync(join(EVIDENCE_DIR, `managed-docker-readiness-${RUN_ID}.json`), serializeReadinessReport(report), 'utf8');
    expect(result.ok, `orchestrator failure: ${result.failureCode ?? ''}: ${result.detail ?? ''}`).toBe(true);
    expect(result.provisionedContainers).toContain('mariadb');
    expect(result.provisionedContainers).toContain('redis');
  }, 300_000);

  it('teardown removes containers and no owner=horizon container remains from this project', async () => {
    const td = await orch.teardown(config);
    expect(td.ok, `teardown failure: ${td.failureCode ?? ''}: ${td.detail ?? ''}`).toBe(true);
    // Verify: `docker ps -a --filter label=owner=horizon` count returns to whatever was there before us.
    // Because parallel CI jobs COULD have other owner=horizon projects, we don't assert count=0. We
    // instead assert that OUR project's containers no longer exist.
    const psOurs = await runner.run('docker', [
      'ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--format', '{{.Names}}',
    ], { cwd: process.cwd(), timeoutMs: 10_000, maxBufferBytes: 4096 });
    expect(psOurs.ok).toBe(true);
    expect(psOurs.stdout.trim(), 'no containers should remain for our project after teardown').toBe('');
  }, 120_000);

  it('records at least one owner=horizon container while the stack is up (regression against label drift)', async () => {
    // Bring the stack back up briefly to check the label-count regression.
    const up = await orch.startup(config);
    expect(up.ok).toBe(true);
    try {
      const count = await countOwnerHorizonContainers(runner);
      expect(count).toBeGreaterThan(0);
    } finally {
      await orch.teardown(config);
    }
  }, 300_000);
});
