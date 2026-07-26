import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  ServiceSupervisor,
  isLegalTransition,
  type ServiceAdapter,
  type ServiceState,
} from '../src/main/serviceSupervisor';
import { Logger, MemorySink } from '../src/main/logging';

function makeAdapter(overrides: Partial<ServiceAdapter> = {}): ServiceAdapter {
  return {
    kind: 'mariadb',
    checkDependencies: async () => ({ ok: true }),
    start: async () => ({ ok: true }),
    healthCheck: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    ...overrides,
  };
}

function makeSupervisor(adapters: ServiceAdapter[]): ServiceSupervisor {
  const sink = new MemorySink();
  return new ServiceSupervisor(adapters, new Logger(sink, 'sup'), DEFAULT_SUPERVISOR_CONFIG);
}

describe('phase3a §D — service supervisor state machine', () => {
  it('T26: legal transitions from `starting` include healthy, migrating, synchronizing, failed, stopping', () => {
    for (const target of ['migrating', 'synchronizing', 'healthy', 'failed', 'stopping'] as ServiceState[]) {
      expect(isLegalTransition('starting', target)).toBe(true);
    }
    expect(isLegalTransition('starting', 'stopped')).toBe(false);
  });

  it('T27: recovery_required only transitions to stopped', () => {
    expect(isLegalTransition('recovery_required', 'stopped')).toBe(true);
    expect(isLegalTransition('recovery_required', 'healthy')).toBe(false);
    expect(isLegalTransition('recovery_required', 'starting')).toBe(false);
  });

  it('T28: happy-path start yields healthy state', async () => {
    const sup = makeSupervisor([makeAdapter()]);
    const rec = await sup.start('mariadb');
    expect(rec.state).toBe('healthy');
    expect(rec.restartCount).toBe(0);
  });

  it('T29: dependency failure escalates to failed and increments restart count', async () => {
    const sup = makeSupervisor([
      makeAdapter({ checkDependencies: async () => ({ ok: false, detail: 'no_docker' }) }),
    ]);
    const rec = await sup.start('mariadb');
    expect(rec.state).toBe('failed');
    expect(rec.detail).toBe('no_docker');
    expect(rec.restartCount).toBe(1);
  });

  it('T30: crash-loop after 3 failures in a window transitions to recovery_required', async () => {
    let calls = 0;
    const sup = makeSupervisor([
      makeAdapter({
        checkDependencies: async () => ({ ok: false, detail: `fail_${++calls}` }),
      }),
    ]);
    await sup.start('mariadb');
    await sup.start('mariadb');
    await sup.start('mariadb');
    const rec = await sup.start('mariadb');
    expect(rec.crashLoopDetected).toBe(true);
    expect(rec.state).toBe('recovery_required');
  });

  it('T31: healthCheck failure degrades a healthy service', async () => {
    let hcHealthy = true;
    const sup = makeSupervisor([
      makeAdapter({
        healthCheck: async () => (hcHealthy ? { ok: true } : { ok: false, detail: 'ping_timeout' }),
      }),
    ]);
    await sup.start('mariadb');
    hcHealthy = false;
    const polled = await sup.pollHealth('mariadb');
    expect(polled.state).toBe('degraded');
  });

  it('T32: resetForRecovery clears crash loop and restart count', async () => {
    let ok = false;
    const sup = makeSupervisor([
      makeAdapter({ checkDependencies: async () => (ok ? { ok: true } : { ok: false, detail: 'x' }) }),
    ]);
    await sup.start('mariadb');
    await sup.start('mariadb');
    await sup.start('mariadb');
    await sup.start('mariadb');
    sup.resetForRecovery('mariadb');
    ok = true;
    await sup.stop('mariadb').catch(() => undefined);
    const rec = await sup.start('mariadb');
    expect(rec.crashLoopDetected).toBe(false);
    expect(rec.state).toBe('healthy');
  });

  it('T33: stop transitions healthy → stopping → stopped', async () => {
    const sup = makeSupervisor([makeAdapter()]);
    await sup.start('mariadb');
    const rec = await sup.stop('mariadb');
    expect(rec.state).toBe('stopped');
  });

  it('T34: restart performs stop then start', async () => {
    let starts = 0;
    const sup = makeSupervisor([makeAdapter({ start: async () => { starts++; return { ok: true }; } })]);
    await sup.start('mariadb');
    await sup.restart('mariadb');
    expect(starts).toBe(2);
  });

  it('T35: snapshot is immutable — mutating a copy does not affect the supervisor', async () => {
    const sup = makeSupervisor([makeAdapter()]);
    await sup.start('mariadb');
    const snap = sup.snapshot();
    snap[0].state = 'failed';
    expect(sup.getState('mariadb')).toBe('healthy');
  });
});
