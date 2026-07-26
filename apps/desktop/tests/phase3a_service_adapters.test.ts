import { describe, expect, it } from 'vitest';
import {
  createMariadbAdapter,
  createRedisAdapter,
  createServerAdapter,
  createStubAdapter,
  InMemoryRunner,
  type AdapterConfig,
} from '../src/main/serviceAdapters';

function cfg(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  const runner = new InMemoryRunner();
  return {
    mode: 'managed_docker',
    composeDir: '/tmp/compose',
    mariadbUrl: 'mysql://root:x@127.0.0.1:3306/db',
    redisUrl: 'redis://127.0.0.1:6379',
    serverHost: '127.0.0.1',
    serverPort: 3000,
    runner,
    externalProbe: runner,
    ...overrides,
  };
}

describe('phase3a §C — service adapters', () => {
  it('T36: mariadb adapter fails dependency check when docker missing (managed_docker)', async () => {
    const runner = new InMemoryRunner();
    runner.dockerInstalled = false;
    const a = createMariadbAdapter(cfg({ runner, externalProbe: runner }));
    const dep = await a.checkDependencies();
    expect(dep.ok).toBe(false);
    expect(dep.detail).toBe('docker_not_installed');
  });

  it('T37: mariadb adapter probes reachable when external', async () => {
    const runner = new InMemoryRunner();
    runner.mariadbOk = false;
    const a = createMariadbAdapter(cfg({ mode: 'external_services', runner, externalProbe: runner }));
    const dep = await a.checkDependencies();
    expect(dep.ok).toBe(false);
    expect(dep.detail).toContain('mariadb_stub_down');
  });

  it('T38: redis adapter is symmetric to mariadb adapter', async () => {
    const runner = new InMemoryRunner();
    runner.redisOk = false;
    const a = createRedisAdapter(cfg({ mode: 'external_services', runner, externalProbe: runner }));
    const dep = await a.checkDependencies();
    expect(dep.ok).toBe(false);
    expect(dep.detail).toContain('redis_stub_down');
  });

  it('T39: server adapter refuses to start if mariadb or redis unreachable', async () => {
    const runner = new InMemoryRunner();
    runner.mariadbOk = false;
    const a = createServerAdapter(cfg({ runner, externalProbe: runner }));
    const dep = await a.checkDependencies();
    expect(dep.ok).toBe(false);
    expect(dep.detail).toContain('mariadb');
  });

  it('T40: stub adapters (workers) always ok — used for scanner/reconciler/market_data/reporting/desktop_shell', async () => {
    for (const kind of ['desktop_shell', 'scanner_worker', 'reconciliation_worker', 'market_data', 'reporting'] as const) {
      const a = createStubAdapter(kind);
      const dep = await a.checkDependencies();
      const started = await a.start();
      const health = await a.healthCheck();
      expect(dep.ok).toBe(true);
      expect(started.ok).toBe(true);
      expect(health.ok).toBe(true);
    }
  });
});
