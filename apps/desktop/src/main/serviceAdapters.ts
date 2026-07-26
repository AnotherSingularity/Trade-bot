/**
 * Stage 1 §3, §4, §5, §6 — Real service adapters.
 *
 * Uses the ChildProcessCommandRunner + RealDockerProbe + MariadbProbe
 * + RedisProbe + MigrationRunner + SchemaFingerprintVerifier +
 * ServerProcessManager. No stubs in production. No InMemoryRunner in
 * production.
 *
 * Canonical compose service names: `db`, `redis`, `server`.
 * Enforced against the operator's compose file via a
 * service-name contract test.
 */

import type { CommandRunner } from './commandRunner';
import { RealDockerProbe, type DockerCheckResult } from './dockerProbe';
import { MariadbProbe, type MariadbProbeResult } from './mariadbProbe';
import { RedisProbe, type RedisProbeResult } from './redisProbe';
import { MigrationRunner } from './migrationRunner';
import { SchemaFingerprintVerifier } from './schemaFingerprint';
import { ServerProcessManager } from './serverProcess';
import type { RuntimeAssets } from './runtimeAssets';
import type { ServiceAdapter, ServiceKind } from './serviceSupervisor';

export const CANONICAL_SERVICES = {
  db: 'db',
  redis: 'redis',
  server: 'server',
} as const;

export interface AdapterRuntimeInput {
  runner: CommandRunner;
  serviceMode: 'managed_docker' | 'external_services';
  assets: RuntimeAssets;
  mariadbUrl: string;         // mysql://user:pw@host:port/db  (from keytar-backed secrets in production)
  redisUrl: string;
  serverHealthUrl: string;    // http://127.0.0.1:3000/health
  redisNamespace?: string;
}

export interface AdapterRuntime {
  dockerProbe: RealDockerProbe;
  mariadbProbe: MariadbProbe;
  redisProbe: RedisProbe;
  migrationRunner: MigrationRunner;
  fingerprintVerifier: SchemaFingerprintVerifier;
  serverProcess: ServerProcessManager;
  input: AdapterRuntimeInput;
}

export function createAdapterRuntime(input: AdapterRuntimeInput): AdapterRuntime {
  return {
    dockerProbe: new RealDockerProbe(input.runner),
    mariadbProbe: new MariadbProbe(),
    redisProbe: new RedisProbe(),
    migrationRunner: new MigrationRunner(input.runner),
    fingerprintVerifier: new SchemaFingerprintVerifier(),
    serverProcess: new ServerProcessManager(input.runner),
    input,
  };
}

function detailOfDocker(res: DockerCheckResult): string {
  return res.reason ? `${res.reason}${res.detail ? `: ${res.detail}` : ''}` : (res.detail ?? 'ok');
}
function detailOfMariadb(res: MariadbProbeResult): string {
  return res.reason ? `${res.reason}${res.detail ? `: ${res.detail}` : ''}` : `v${res.serverVersion ?? '?'} db=${res.currentDatabase ?? '?'} migrations=${res.migrationCount ?? 0}`;
}
function detailOfRedis(res: RedisProbeResult): string {
  return res.reason ? `${res.reason}${res.detail ? `: ${res.detail}` : ''}` : `v${res.version ?? '?'} persist=${res.persistencePolicy ?? '?'}`;
}

// ---------------------------------------------------------------------------
// Managed Docker adapters (composeFile-aware)
// ---------------------------------------------------------------------------

export function createMariadbAdapterManaged(rt: AdapterRuntime): ServiceAdapter {
  return {
    kind: 'mariadb',
    checkDependencies: async () => {
      // Docker + daemon + compose + service definition must all be present.
      const d = await rt.dockerProbe.checkDocker();
      if (!d.ok) return { ok: false, detail: detailOfDocker(d) };
      const daemon = await rt.dockerProbe.checkDaemon();
      if (!daemon.ok) return { ok: false, detail: detailOfDocker(daemon) };
      const compose = await rt.dockerProbe.checkCompose();
      if (!compose.ok) return { ok: false, detail: detailOfDocker(compose) };
      const file = await rt.dockerProbe.checkComposeFile(rt.input.assets.composeFile);
      if (!file.ok) return { ok: false, detail: detailOfDocker(file) };
      const services = rt.dockerProbe.listComposeServices(rt.input.assets.composeFile);
      if (!services.includes(CANONICAL_SERVICES.db)) {
        return { ok: false, detail: `service_definition_missing: expected '${CANONICAL_SERVICES.db}' in compose file` };
      }
      return { ok: true };
    },
    start: async () => {
      const r = await rt.input.runner.run('docker', [
        'compose', '-p', rt.input.assets.composeProject, '-f', rt.input.assets.composeFile,
        'up', '-d', CANONICAL_SERVICES.db,
      ], { cwd: rt.input.assets.workingDirectory, timeoutMs: 60_000 });
      return r.ok ? { ok: true } : { ok: false, detail: `container_start_failed: ${r.stderr.slice(0, 200)}` };
    },
    healthCheck: async () => {
      const p = await rt.mariadbProbe.probe({
        connection: parseMysqlUrl(rt.input.mariadbUrl),
        expectedDatabase: 'horizon_trade',
      });
      return { ok: p.ok, detail: detailOfMariadb(p) };
    },
    stop: async () => {
      // Do NOT run `docker compose down -v`. Only stop the service.
      const r = await rt.input.runner.run('docker', [
        'compose', '-p', rt.input.assets.composeProject, '-f', rt.input.assets.composeFile,
        'stop', CANONICAL_SERVICES.db,
      ], { cwd: rt.input.assets.workingDirectory, timeoutMs: 30_000 });
      return r.ok ? { ok: true } : { ok: false, detail: r.stderr.slice(0, 200) };
    },
  };
}

export function createRedisAdapterManaged(rt: AdapterRuntime): ServiceAdapter {
  return {
    kind: 'redis',
    checkDependencies: async () => {
      const d = await rt.dockerProbe.checkDocker();
      if (!d.ok) return { ok: false, detail: detailOfDocker(d) };
      const daemon = await rt.dockerProbe.checkDaemon();
      if (!daemon.ok) return { ok: false, detail: detailOfDocker(daemon) };
      const compose = await rt.dockerProbe.checkCompose();
      if (!compose.ok) return { ok: false, detail: detailOfDocker(compose) };
      const file = await rt.dockerProbe.checkComposeFile(rt.input.assets.composeFile);
      if (!file.ok) return { ok: false, detail: detailOfDocker(file) };
      const services = rt.dockerProbe.listComposeServices(rt.input.assets.composeFile);
      if (!services.includes(CANONICAL_SERVICES.redis)) {
        return { ok: false, detail: `service_definition_missing: expected '${CANONICAL_SERVICES.redis}' in compose file` };
      }
      return { ok: true };
    },
    start: async () => {
      const r = await rt.input.runner.run('docker', [
        'compose', '-p', rt.input.assets.composeProject, '-f', rt.input.assets.composeFile,
        'up', '-d', CANONICAL_SERVICES.redis,
      ], { cwd: rt.input.assets.workingDirectory, timeoutMs: 60_000 });
      return r.ok ? { ok: true } : { ok: false, detail: `container_start_failed: ${r.stderr.slice(0, 200)}` };
    },
    healthCheck: async () => {
      const p = await rt.redisProbe.probe({
        url: rt.input.redisUrl,
        requiredNamespace: rt.input.redisNamespace,
      });
      return { ok: p.ok, detail: detailOfRedis(p) };
    },
    stop: async () => {
      const r = await rt.input.runner.run('docker', [
        'compose', '-p', rt.input.assets.composeProject, '-f', rt.input.assets.composeFile,
        'stop', CANONICAL_SERVICES.redis,
      ], { cwd: rt.input.assets.workingDirectory, timeoutMs: 30_000 });
      return r.ok ? { ok: true } : { ok: false, detail: r.stderr.slice(0, 200) };
    },
  };
}

export function createServerAdapterManaged(rt: AdapterRuntime, fingerprintPath: string): ServiceAdapter {
  return {
    kind: 'server',
    checkDependencies: async () => {
      const m = await rt.mariadbProbe.probe({ connection: parseMysqlUrl(rt.input.mariadbUrl), expectedDatabase: 'horizon_trade' });
      if (!m.ok) return { ok: false, detail: `mariadb: ${detailOfMariadb(m)}` };
      const r = await rt.redisProbe.probe({ url: rt.input.redisUrl });
      if (!r.ok) return { ok: false, detail: `redis: ${detailOfRedis(r)}` };
      return { ok: true };
    },
    start: async () => {
      const services = rt.dockerProbe.listComposeServices(rt.input.assets.composeFile);
      if (!services.includes(CANONICAL_SERVICES.server)) {
        return { ok: false, detail: `service_definition_missing: expected '${CANONICAL_SERVICES.server}' in compose file` };
      }
      const r = await rt.input.runner.run('docker', [
        'compose', '-p', rt.input.assets.composeProject, '-f', rt.input.assets.composeFile,
        'up', '-d', CANONICAL_SERVICES.server,
      ], { cwd: rt.input.assets.workingDirectory, timeoutMs: 120_000 });
      return r.ok ? { ok: true } : { ok: false, detail: `container_start_failed: ${r.stderr.slice(0, 200)}` };
    },
    migrate: async () => {
      const outcome = await rt.migrationRunner.apply({ spec: rt.input.assets.migrationCommand });
      if (outcome.ok) return { ok: true, detail: `migration_ok in ${outcome.durationMs}ms` };
      return { ok: false, detail: `migration_${outcome.reason}: ${outcome.stderrTail.slice(0, 200)}` };
    },
    synchronize: async () => {
      const result = await rt.fingerprintVerifier.verify({
        connection: parseMysqlUrl(rt.input.mariadbUrl),
        expectedFingerprintPath: fingerprintPath,
      });
      if (result.state === 'verified') return { ok: true };
      return { ok: false, detail: `fingerprint_${result.state}: ${result.detail ?? ''}` };
    },
    healthCheck: async () => {
      const health = await rt.serverProcess.checkHealth({
        entry: rt.input.assets.migrationCommand, // ignored for check
        healthUrl: rt.input.serverHealthUrl,
      });
      return { ok: health.ok, detail: health.ok ? `${health.ms}ms` : `${health.reason}: ${health.detail ?? ''}` };
    },
    stop: async () => {
      const r = await rt.input.runner.run('docker', [
        'compose', '-p', rt.input.assets.composeProject, '-f', rt.input.assets.composeFile,
        'stop', CANONICAL_SERVICES.server,
      ], { cwd: rt.input.assets.workingDirectory, timeoutMs: 60_000 });
      return r.ok ? { ok: true } : { ok: false, detail: r.stderr.slice(0, 200) };
    },
  };
}

// ---------------------------------------------------------------------------
// External-services adapters (operator manages MariaDB + Redis outside)
// ---------------------------------------------------------------------------

export function createMariadbAdapterExternal(rt: AdapterRuntime): ServiceAdapter {
  return {
    kind: 'mariadb',
    checkDependencies: async () => {
      const p = await rt.mariadbProbe.probe({ connection: parseMysqlUrl(rt.input.mariadbUrl), expectedDatabase: 'horizon_trade' });
      return { ok: p.ok, detail: detailOfMariadb(p) };
    },
    start: async () => ({ ok: true, detail: 'externally_managed' }),
    healthCheck: async () => {
      const p = await rt.mariadbProbe.probe({ connection: parseMysqlUrl(rt.input.mariadbUrl), expectedDatabase: 'horizon_trade' });
      return { ok: p.ok, detail: detailOfMariadb(p) };
    },
    stop: async () => ({ ok: true, detail: 'externally_managed' }),
  };
}

export function createRedisAdapterExternal(rt: AdapterRuntime): ServiceAdapter {
  return {
    kind: 'redis',
    checkDependencies: async () => {
      const p = await rt.redisProbe.probe({ url: rt.input.redisUrl });
      return { ok: p.ok, detail: detailOfRedis(p) };
    },
    start: async () => ({ ok: true, detail: 'externally_managed' }),
    healthCheck: async () => {
      const p = await rt.redisProbe.probe({ url: rt.input.redisUrl });
      return { ok: p.ok, detail: detailOfRedis(p) };
    },
    stop: async () => ({ ok: true, detail: 'externally_managed' }),
  };
}

export function createServerAdapterOutOfProcess(rt: AdapterRuntime, fingerprintPath: string, extraEnv?: Record<string, string>): ServiceAdapter {
  return {
    kind: 'server',
    checkDependencies: async () => {
      const m = await rt.mariadbProbe.probe({ connection: parseMysqlUrl(rt.input.mariadbUrl), expectedDatabase: 'horizon_trade' });
      if (!m.ok) return { ok: false, detail: `mariadb: ${detailOfMariadb(m)}` };
      const r = await rt.redisProbe.probe({ url: rt.input.redisUrl });
      if (!r.ok) return { ok: false, detail: `redis: ${detailOfRedis(r)}` };
      return { ok: true };
    },
    start: async () => {
      // Desktop-owned out-of-process server: spawn the built server via
      // `node dist/index.js` (packaged) or `npx tsx src/index.ts` (dev).
      const rec = await rt.serverProcess.start({
        entry: {
          command: rt.input.assets.mode === 'packaged' ? 'node' : 'npx',
          args: rt.input.assets.mode === 'packaged'
            ? [rt.input.assets.serverEntry]
            : ['tsx', rt.input.assets.serverEntry],
          cwd: rt.input.assets.serverCwd,
        },
        healthUrl: rt.input.serverHealthUrl,
        env: extraEnv,
      });
      return { ok: rec.pid != null, detail: `pid=${rec.pid ?? '?'}` };
    },
    migrate: async () => {
      const outcome = await rt.migrationRunner.apply({ spec: rt.input.assets.migrationCommand });
      if (outcome.ok) return { ok: true, detail: `migration_ok in ${outcome.durationMs}ms` };
      return { ok: false, detail: `migration_${outcome.reason}: ${outcome.stderrTail.slice(0, 200)}` };
    },
    synchronize: async () => {
      const result = await rt.fingerprintVerifier.verify({
        connection: parseMysqlUrl(rt.input.mariadbUrl),
        expectedFingerprintPath: fingerprintPath,
      });
      if (result.state === 'verified') return { ok: true };
      return { ok: false, detail: `fingerprint_${result.state}: ${result.detail ?? ''}` };
    },
    healthCheck: async () => {
      const health = await rt.serverProcess.waitForHealthy({
        entry: rt.input.assets.migrationCommand,
        healthUrl: rt.input.serverHealthUrl,
        startupTimeoutMs: 5_000,
      });
      return { ok: health.ok, detail: health.ok ? `${health.ms}ms` : `${health.reason}` };
    },
    stop: async () => {
      await rt.serverProcess.stop();
      return { ok: true, detail: 'stopped' };
    },
  };
}

// ---------------------------------------------------------------------------
// Worker adapters (Stage 1 policy §10)
// ---------------------------------------------------------------------------

export function createReconciliationAdapter(rt: AdapterRuntime): ServiceAdapter {
  return {
    kind: 'reconciliation_worker',
    // Reconciliation runs as a server-internal loop today; its health
    // is derived from a server API. We probe it via /api/reconciliation/status.
    checkDependencies: async () => ({ ok: true }),
    start: async () => ({ ok: true, detail: 'server_internal_loop' }),
    healthCheck: async () => {
      try {
        const url = new URL('/api/reconciliation/status', rt.input.serverHealthUrl).toString();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3_000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return { ok: false, detail: `status=${res.status}` };
        return { ok: true, detail: `${res.status}` };
      } catch (e) {
        return { ok: false, detail: `probe_error: ${String(e).slice(0, 120)}` };
      }
    },
    stop: async () => ({ ok: true, detail: 'server_internal_loop' }),
  };
}

export function createNotImplementedAdapter(kind: ServiceKind, reason: string): ServiceAdapter {
  return {
    kind,
    checkDependencies: async () => ({ ok: false, detail: `not_implemented: ${reason}` }),
    start: async () => ({ ok: false, detail: `not_implemented: ${reason}` }),
    healthCheck: async () => ({ ok: false, detail: `not_implemented: ${reason}` }),
    stop: async () => ({ ok: true, detail: 'noop' }),
  };
}

export function createDesktopShellAdapter(): ServiceAdapter {
  // The desktop shell is the process running this code — always healthy
  // while the boot sequence has completed.
  return {
    kind: 'desktop_shell',
    checkDependencies: async () => ({ ok: true }),
    start: async () => ({ ok: true }),
    healthCheck: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
  };
}

// ---------------------------------------------------------------------------
// mysql URL parser (avoids leaking passwords in logs)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseMysqlUrl(url: string): any {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username || 'root'),
    password: decodeURIComponent(u.password || ''),
    database: u.pathname.replace(/^\//, ''),
  };
}
