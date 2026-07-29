/**
 * Stage 5B — ManagedDockerOrchestrator unit tests.
 *
 * Pure — no real Docker, no real network, no real filesystem. Every
 * dependency (probe, runtime, clock, logger) is injected as a
 * deterministic fake. The orchestrator's job is state machine +
 * label enforcement, so we test each phase transition + each
 * failure code + the label-guard on teardown.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DockerProbe, DockerCheckResult } from '../../src/main/dockerProbe';
import type { Logger } from '../../src/main/logging';
import {
  FakeClock,
  ManagedDockerOrchestrator,
  type ContainerRuntime,
  type ManagedOrchestrationConfig,
} from '../../src/main/managedDockerOrchestrator';

const NOOP_LOGGER: Logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
} as unknown as Logger;

function makeConfig(overrides: Partial<ManagedOrchestrationConfig> = {}): ManagedOrchestrationConfig {
  return {
    project: 'horizon',
    composeFile: '/tmp/compose.yml',
    containers: [
      { service: 'mariadb', image: 'mariadb:11', requiredHealthy: true },
      { service: 'redis', image: 'redis:7', requiredHealthy: true },
    ],
    preflightTimeoutMs: 6_000,
    provisionTimeoutMs: 60_000,
    readinessTimeoutMs: 5_000,
    teardownTimeoutMs: 30_000,
    ...overrides,
  };
}

function okProbe(overrides: Partial<DockerProbe> = {}): DockerProbe {
  return {
    checkDocker: async (): Promise<DockerCheckResult> => ({ ok: true }),
    checkDaemon: async (): Promise<DockerCheckResult> => ({ ok: true, detail: 'server=24.0.7' }),
    checkCompose: async (): Promise<DockerCheckResult> => ({ ok: true, detail: 'compose=v2.24.0' }),
    checkComposeFile: async (): Promise<DockerCheckResult> => ({ ok: true, detail: 'services=mariadb,redis' }),
    listComposeServices: () => ['mariadb', 'redis'],
    containerHealth: async (): Promise<DockerCheckResult> => ({ ok: true, detail: 'healthy' }),
    ...overrides,
  };
}

function okRuntime(overrides: Partial<ContainerRuntime> = {}): ContainerRuntime {
  return {
    composeUp: async () => ({ ok: true }),
    composeDown: async () => ({ ok: true }),
    inspectLabels: async () => ({ ok: true, labels: { owner: 'horizon' } }),
    ...overrides,
  };
}

describe('ManagedDockerOrchestrator — preflight', () => {
  it('passes when all probes succeed', async () => {
    const o = new ManagedDockerOrchestrator(okProbe(), okRuntime(), NOOP_LOGGER, new FakeClock());
    const r = await o.preflight(makeConfig());
    expect(r.ok).toBe(true);
    expect(r.phase).toBe('preflight');
  });

  it('fails on docker missing with mapped code', async () => {
    const o = new ManagedDockerOrchestrator(
      okProbe({ checkDocker: async () => ({ ok: false, reason: 'docker_not_installed', detail: 'not in PATH' }) }),
      okRuntime(),
      NOOP_LOGGER,
      new FakeClock(),
    );
    const r = await o.preflight(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('preflight_docker_missing');
    expect(r.detail).toContain('not in PATH');
  });

  it('fails on daemon unreachable', async () => {
    const o = new ManagedDockerOrchestrator(
      okProbe({ checkDaemon: async () => ({ ok: false, reason: 'docker_daemon_unavailable', detail: 'timeout' }) }),
      okRuntime(),
      NOOP_LOGGER,
      new FakeClock(),
    );
    const r = await o.preflight(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('preflight_daemon_unreachable');
  });

  it('fails on compose plugin missing', async () => {
    const o = new ManagedDockerOrchestrator(
      okProbe({ checkCompose: async () => ({ ok: false, reason: 'compose_unavailable' }) }),
      okRuntime(),
      NOOP_LOGGER,
      new FakeClock(),
    );
    const r = await o.preflight(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('preflight_compose_missing');
  });

  it('fails on compose file missing', async () => {
    const o = new ManagedDockerOrchestrator(
      okProbe({ checkComposeFile: async () => ({ ok: false, reason: 'compose_file_missing', detail: '/no/path.yml' }) }),
      okRuntime(),
      NOOP_LOGGER,
      new FakeClock(),
    );
    const r = await o.preflight(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('preflight_compose_file_missing');
  });
});

describe('ManagedDockerOrchestrator — provision + label enforcement', () => {
  it('records provisioned containers on success', async () => {
    const o = new ManagedDockerOrchestrator(okProbe(), okRuntime(), NOOP_LOGGER, new FakeClock());
    const r = await o.provision(makeConfig());
    expect(r.ok).toBe(true);
    expect(r.provisionedContainers).toEqual(['mariadb', 'redis']);
  });

  it('fails provision if composeUp fails', async () => {
    const o = new ManagedDockerOrchestrator(
      okProbe(),
      okRuntime({ composeUp: async () => ({ ok: false, detail: 'docker daemon exited during pull' }) }),
      NOOP_LOGGER,
      new FakeClock(),
    );
    const r = await o.provision(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('provision_failed');
  });

  it('fails hard if a container is missing owner=horizon label', async () => {
    const o = new ManagedDockerOrchestrator(
      okProbe(),
      okRuntime({ inspectLabels: async () => ({ ok: true, labels: { owner: 'someone-else' } }) }),
      NOOP_LOGGER,
      new FakeClock(),
    );
    const r = await o.provision(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('container_not_labelled_owner_horizon');
    expect(r.detail).toContain('owner=someone-else');
  });

  it('fails if inspectLabels itself fails', async () => {
    const o = new ManagedDockerOrchestrator(
      okProbe(),
      okRuntime({ inspectLabels: async () => ({ ok: false, labels: {}, detail: 'container not found' }) }),
      NOOP_LOGGER,
      new FakeClock(),
    );
    const r = await o.provision(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('container_not_labelled_owner_horizon');
  });
});

describe('ManagedDockerOrchestrator — readiness polling', () => {
  it('returns ok once every container reports healthy', async () => {
    const o = new ManagedDockerOrchestrator(okProbe(), okRuntime(), NOOP_LOGGER, new FakeClock());
    await o.provision(makeConfig());
    const r = await o.waitForReadiness(makeConfig());
    expect(r.ok).toBe(true);
  });

  it('polls until healthy — advances virtual clock', async () => {
    let calls = 0;
    const probe = okProbe({
      containerHealth: async () => {
        calls++;
        return calls >= 3
          ? { ok: true, detail: 'healthy' }
          : { ok: false, reason: 'container_unhealthy', detail: 'starting' };
      },
    });
    const clock = new FakeClock();
    const o = new ManagedDockerOrchestrator(probe, okRuntime(), NOOP_LOGGER, clock);
    await o.provision(makeConfig({ containers: [{ service: 'mariadb', image: 'x', requiredHealthy: true }] }));
    const r = await o.waitForReadiness(makeConfig({ containers: [{ service: 'mariadb', image: 'x', requiredHealthy: true }] }));
    expect(r.ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(clock.now()).toBeGreaterThanOrEqual(2_000);
  });

  it('fails on readiness timeout with last observed reason', async () => {
    const o = new ManagedDockerOrchestrator(
      okProbe({ containerHealth: async () => ({ ok: false, reason: 'container_unhealthy', detail: 'still starting' }) }),
      okRuntime(),
      NOOP_LOGGER,
      new FakeClock(),
    );
    await o.provision(makeConfig());
    const r = await o.waitForReadiness(
      makeConfig({ readinessTimeoutMs: 100, containers: [{ service: 'mariadb', image: 'x', requiredHealthy: true }] }),
    );
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('readiness_timeout');
    expect(r.detail).toContain('container_unhealthy');
  });

  it('non-required containers proceed even if unhealthy', async () => {
    const o = new ManagedDockerOrchestrator(
      okProbe({ containerHealth: async () => ({ ok: false, reason: 'container_unhealthy', detail: 'optional service' }) }),
      okRuntime(),
      NOOP_LOGGER,
      new FakeClock(),
    );
    const cfg = makeConfig({
      containers: [{ service: 'optional_metrics', image: 'x', requiredHealthy: false }],
    });
    await o.provision(cfg);
    const r = await o.waitForReadiness(cfg);
    expect(r.ok).toBe(true);
  });
});

describe('ManagedDockerOrchestrator — startup composite', () => {
  it('runs preflight + provision + readiness in order', async () => {
    const o = new ManagedDockerOrchestrator(okProbe(), okRuntime(), NOOP_LOGGER, new FakeClock());
    const r = await o.startup(makeConfig());
    expect(r.ok).toBe(true);
    expect(r.phase).toBe('supervise_ready');
    const phases = o.eventLog().map((e) => e.phase);
    expect(phases).toContain('preflight');
    expect(phases).toContain('provision');
    expect(phases).toContain('readiness_wait');
  });

  it('short-circuits after preflight failure', async () => {
    const o = new ManagedDockerOrchestrator(
      okProbe({ checkDocker: async () => ({ ok: false, reason: 'docker_not_installed' }) }),
      okRuntime(),
      NOOP_LOGGER,
      new FakeClock(),
    );
    const r = await o.startup(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('preflight_docker_missing');
    expect(r.provisionedContainers).toEqual([]);
  });
});

describe('ManagedDockerOrchestrator — teardown label guard', () => {
  it('brings the stack down when every provisioned container is owner=horizon', async () => {
    const composeDown = vi.fn(async () => ({ ok: true }));
    const o = new ManagedDockerOrchestrator(okProbe(), okRuntime({ composeDown }), NOOP_LOGGER, new FakeClock());
    await o.provision(makeConfig());
    const r = await o.teardown(makeConfig());
    expect(r.ok).toBe(true);
    expect(composeDown).toHaveBeenCalledTimes(1);
  });

  it('refuses to bring down a provisioned container missing owner=horizon', async () => {
    // Simulate label drift between provision and teardown.
    let call = 0;
    const runtime = okRuntime({
      inspectLabels: async () => {
        call++;
        return call === 1 || call === 2
          ? { ok: true, labels: { owner: 'horizon' } } // provision phase
          : { ok: true, labels: { owner: 'someone-else' } }; // teardown phase
      },
    });
    const composeDown = vi.fn(async () => ({ ok: true }));
    const o = new ManagedDockerOrchestrator(okProbe(), { ...runtime, composeDown }, NOOP_LOGGER, new FakeClock());
    await o.provision(makeConfig());
    const r = await o.teardown(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('label_missing_refuse_to_touch');
    expect(composeDown).not.toHaveBeenCalled();
  });

  it('records teardown_failed when composeDown fails', async () => {
    const o = new ManagedDockerOrchestrator(
      okProbe(),
      okRuntime({ composeDown: async () => ({ ok: false, detail: 'network in use' }) }),
      NOOP_LOGGER,
      new FakeClock(),
    );
    await o.provision(makeConfig());
    const r = await o.teardown(makeConfig());
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('teardown_failed');
  });
});

describe('ManagedDockerOrchestrator — event log', () => {
  it('records phase_start + phase_ok events in order', async () => {
    const o = new ManagedDockerOrchestrator(okProbe(), okRuntime(), NOOP_LOGGER, new FakeClock());
    await o.startup(makeConfig());
    const codes = o.eventLog().map((e) => `${e.phase}:${e.code}`);
    expect(codes).toContain('preflight:phase_start');
    expect(codes).toContain('preflight:phase_ok');
    expect(codes).toContain('provision:phase_ok');
    expect(codes).toContain('readiness_wait:phase_ok');
  });

  it('records phase_fail with mapped failure code', async () => {
    const o = new ManagedDockerOrchestrator(
      okProbe({ checkDaemon: async () => ({ ok: false, reason: 'docker_daemon_unavailable', detail: 'econnrefused' }) }),
      okRuntime(),
      NOOP_LOGGER,
      new FakeClock(),
    );
    await o.startup(makeConfig());
    const fail = o.eventLog().find((e) => e.code === 'phase_fail');
    expect(fail).toBeDefined();
    expect(fail?.detail).toContain('preflight_daemon_unreachable');
  });
});
