/**
 * Phase 3A §C — Local-service strategy.
 *
 * The `managed_docker` mode expects Docker Desktop to be installed
 * and starts MariaDB, Redis, and the Horizon server via the
 * production Compose definition. The `external_services` mode
 * verifies that operator-managed MariaDB and Redis are reachable and
 * refuses to silently substitute a different database.
 *
 * MariaDB and Redis binaries are NEVER embedded inside the renderer.
 */

import type { ServiceAdapter, ServiceKind } from './serviceSupervisor';

export interface DockerCommandRunner {
  which(name: string): Promise<string | null>;
  compose(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  ping(host: string, port: number, timeoutMs: number): Promise<boolean>;
}

export interface ExternalServiceProbe {
  probeMariadb(url: string): Promise<{ ok: boolean; detail?: string }>;
  probeRedis(url: string): Promise<{ ok: boolean; detail?: string }>;
}

export interface AdapterConfig {
  mode: 'managed_docker' | 'external_services';
  composeDir: string;
  mariadbUrl: string;
  redisUrl: string;
  serverHost: string;
  serverPort: number;
  runner: DockerCommandRunner;
  externalProbe: ExternalServiceProbe;
}

export function createMariadbAdapter(cfg: AdapterConfig): ServiceAdapter {
  return {
    kind: 'mariadb',
    checkDependencies: async () => {
      if (cfg.mode === 'external_services') {
        const p = await cfg.externalProbe.probeMariadb(cfg.mariadbUrl);
        return p.ok ? { ok: true } : { ok: false, detail: p.detail ?? 'mariadb_unreachable' };
      }
      const docker = await cfg.runner.which('docker');
      if (!docker) return { ok: false, detail: 'docker_not_installed' };
      return { ok: true };
    },
    start: async () => {
      if (cfg.mode === 'external_services') return { ok: true, detail: 'externally_managed' };
      const r = await cfg.runner.compose(['up', '-d', 'mariadb'], cfg.composeDir);
      return r.ok ? { ok: true } : { ok: false, detail: `compose_up_failed: ${r.stderr}` };
    },
    healthCheck: async () => {
      const p = await cfg.externalProbe.probeMariadb(cfg.mariadbUrl);
      return p.ok ? { ok: true } : { ok: false, detail: p.detail };
    },
    stop: async () => {
      if (cfg.mode === 'external_services') return { ok: true, detail: 'externally_managed' };
      const r = await cfg.runner.compose(['stop', 'mariadb'], cfg.composeDir);
      return r.ok ? { ok: true } : { ok: false, detail: r.stderr };
    },
  };
}

export function createRedisAdapter(cfg: AdapterConfig): ServiceAdapter {
  return {
    kind: 'redis',
    checkDependencies: async () => {
      if (cfg.mode === 'external_services') {
        const p = await cfg.externalProbe.probeRedis(cfg.redisUrl);
        return p.ok ? { ok: true } : { ok: false, detail: p.detail ?? 'redis_unreachable' };
      }
      const docker = await cfg.runner.which('docker');
      if (!docker) return { ok: false, detail: 'docker_not_installed' };
      return { ok: true };
    },
    start: async () => {
      if (cfg.mode === 'external_services') return { ok: true, detail: 'externally_managed' };
      const r = await cfg.runner.compose(['up', '-d', 'redis'], cfg.composeDir);
      return r.ok ? { ok: true } : { ok: false, detail: r.stderr };
    },
    healthCheck: async () => {
      const p = await cfg.externalProbe.probeRedis(cfg.redisUrl);
      return p.ok ? { ok: true } : { ok: false, detail: p.detail };
    },
    stop: async () => {
      if (cfg.mode === 'external_services') return { ok: true, detail: 'externally_managed' };
      const r = await cfg.runner.compose(['stop', 'redis'], cfg.composeDir);
      return r.ok ? { ok: true } : { ok: false, detail: r.stderr };
    },
  };
}

export function createServerAdapter(cfg: AdapterConfig): ServiceAdapter {
  return {
    kind: 'server',
    checkDependencies: async () => {
      // Server depends on MariaDB + Redis being reachable.
      const [m, r] = await Promise.all([
        cfg.externalProbe.probeMariadb(cfg.mariadbUrl),
        cfg.externalProbe.probeRedis(cfg.redisUrl),
      ]);
      if (!m.ok) return { ok: false, detail: `mariadb: ${m.detail ?? 'unreachable'}` };
      if (!r.ok) return { ok: false, detail: `redis: ${r.detail ?? 'unreachable'}` };
      return { ok: true };
    },
    start: async () => {
      if (cfg.mode === 'external_services') return { ok: true, detail: 'server_out_of_process' };
      const r = await cfg.runner.compose(['up', '-d', 'server'], cfg.composeDir);
      return r.ok ? { ok: true } : { ok: false, detail: r.stderr };
    },
    migrate: async () => ({ ok: true, detail: 'migrations_applied_via_server_boot' }),
    synchronize: async () => ({ ok: true, detail: 'sync_stub' }),
    healthCheck: async () => {
      const ok = await cfg.runner.ping(cfg.serverHost, cfg.serverPort, 5000);
      return ok ? { ok: true } : { ok: false, detail: 'server_ping_failed' };
    },
    stop: async () => {
      if (cfg.mode === 'external_services') return { ok: true, detail: 'server_out_of_process' };
      const r = await cfg.runner.compose(['stop', 'server'], cfg.composeDir);
      return r.ok ? { ok: true } : { ok: false, detail: r.stderr };
    },
  };
}

export function createStubAdapter(kind: ServiceKind): ServiceAdapter {
  return {
    kind,
    checkDependencies: async () => ({ ok: true }),
    start: async () => ({ ok: true }),
    healthCheck: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
  };
}

/**
 * A memory-only command runner + probe used in tests. Deterministic;
 * no network access; no process spawning.
 */
export class InMemoryRunner implements DockerCommandRunner, ExternalServiceProbe {
  dockerInstalled = true;
  composeSucceeds = true;
  mariadbOk = true;
  redisOk = true;
  serverOk = true;

  async which(name: string): Promise<string | null> {
    if (name === 'docker' && this.dockerInstalled) return '/usr/local/bin/docker';
    return null;
  }
  async compose(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    void args; void cwd;
    return { ok: this.composeSucceeds, stdout: '', stderr: this.composeSucceeds ? '' : 'compose_failed' };
  }
  async ping(host: string, port: number, timeoutMs: number): Promise<boolean> {
    void host; void port; void timeoutMs;
    return this.serverOk;
  }
  async probeMariadb(url: string): Promise<{ ok: boolean; detail?: string }> {
    void url;
    return this.mariadbOk ? { ok: true } : { ok: false, detail: 'mariadb_stub_down' };
  }
  async probeRedis(url: string): Promise<{ ok: boolean; detail?: string }> {
    void url;
    return this.redisOk ? { ok: true } : { ok: false, detail: 'redis_stub_down' };
  }
}
