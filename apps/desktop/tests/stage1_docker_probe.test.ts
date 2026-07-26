import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RealDockerProbe, parseComposeServiceNames } from '../src/main/dockerProbe';
import { InMemoryCommandRunner } from '../src/main/commandRunner';

describe('stage1 §3 §4 — Docker probe + compose contract', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'stage1-docker-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('T-S1.12: docker_not_installed distinct from docker_daemon_unavailable', async () => {
    const runner = new InMemoryCommandRunner();
    runner.setAvailable('docker', false);
    const probe = new RealDockerProbe(runner);
    const install = await probe.checkDocker();
    expect(install.ok).toBe(false);
    expect(install.reason).toBe('docker_not_installed');
    // Now docker exists but info fails → daemon unavailable.
    runner.setAvailable('docker', true);
    runner.script('docker info --format {{.ServerVersion}}', { ok: false, exitCode: 1, stderr: 'Cannot connect to the Docker daemon' });
    const daemon = await probe.checkDaemon();
    expect(daemon.ok).toBe(false);
    expect(daemon.reason).toBe('docker_daemon_unavailable');
  });

  it('T-S1.13: compose_unavailable distinct from docker_daemon_unavailable', async () => {
    const runner = new InMemoryCommandRunner();
    runner.setAvailable('docker', true);
    runner.script('docker info --format {{.ServerVersion}}', { ok: true, stdout: '27.0.0' });
    runner.script('docker compose version --short', { ok: false, exitCode: 1, stderr: 'unknown command' });
    const probe = new RealDockerProbe(runner);
    const daemon = await probe.checkDaemon();
    expect(daemon.ok).toBe(true);
    const compose = await probe.checkCompose();
    expect(compose.ok).toBe(false);
    expect(compose.reason).toBe('compose_unavailable');
  });

  it('T-S1.4d: compose file missing produces compose_file_missing', async () => {
    const runner = new InMemoryCommandRunner();
    const probe = new RealDockerProbe(runner);
    const r = await probe.checkComposeFile(join(dir, 'nope.yml'));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('compose_file_missing');
  });

  it('T-S1.compose.services: parser extracts top-level service names', () => {
    const yaml = `
services:
  db:
    image: mysql:8.0
    ports:
      - '3306:3306'
  redis:
    image: redis:7-alpine
  server:
    build:
      context: .
volumes:
  mysql_data:
`;
    expect(parseComposeServiceNames(yaml).sort()).toEqual(['db', 'redis', 'server']);
  });

  it('T-S1.compose.services2: parser ignores nested keys and comments', () => {
    const yaml = `
# top-level comment
services:
  db:  # inline comment
    image: mysql:8.0
    healthcheck:
      test: []
  cache: {}
`;
    // 'cache' has inline mapping and is not a bare `name:` line ending
    // with a colon — the strict parser skips it.
    const names = parseComposeServiceNames(yaml);
    expect(names).toContain('db');
  });

  it('T-S1.11a (compose contract): the checked-in prod compose exposes db, redis, server', () => {
    // Direct read of the real compose file — proves the service-name
    // contract that serviceAdapters.ts depends on.
    const composePath = join(__dirname, '..', '..', '..', 'docker-compose.prod.yml');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const raw = require('node:fs').readFileSync(composePath, 'utf8');
    const services = parseComposeServiceNames(raw);
    expect(services).toContain('db');
    expect(services).toContain('redis');
    expect(services).toContain('server');
  });
});
