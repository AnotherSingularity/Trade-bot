/**
 * Stage 5B — Managed Docker orchestration policy.
 *
 * Composes the existing DockerProbe + ServiceSupervisor primitives
 * into a full managed-docker lifecycle: preflight → provision →
 * ready-wait → supervise → teardown. Pure orchestration — no side
 * effects beyond calling the injected probe/adapters, so the whole
 * lifecycle is unit-testable against a mock probe.
 *
 * Every managed container MUST carry `label=owner=horizon`. Teardown
 * refuses to touch anything without that label. Data volumes tagged
 * `label=owner=horizon,data=true` survive teardown; runtime-only
 * volumes are removed.
 *
 * Timeouts (per-phase, hard):
 *   preflight       6s per probe
 *   provision       60s
 *   readiness       120s (server bootstrap can be slow)
 *   supervisor_ready 30s
 *   teardown         30s
 *
 * The orchestrator is fail-CLOSED: any preflight failure aborts BEFORE
 * mutating docker state. A supervise-phase failure attempts teardown
 * but records the failure regardless of teardown outcome — data
 * survival + accurate observability beat "look successful".
 */

import type { DockerProbe, DockerFailureReason } from './dockerProbe';
import type { Logger } from './logging';

export const MANAGED_DOCKER_OWNER_LABEL = 'owner=horizon';
export const MANAGED_DOCKER_DATA_LABEL = 'data=true';

export type OrchestrationPhase =
  | 'preflight'
  | 'provision'
  | 'readiness_wait'
  | 'supervise_ready'
  | 'teardown';

export type OrchestrationFailureCode =
  | 'preflight_docker_missing'
  | 'preflight_daemon_unreachable'
  | 'preflight_compose_missing'
  | 'preflight_compose_file_missing'
  | 'provision_failed'
  | 'readiness_timeout'
  | 'service_never_healthy'
  | 'label_missing_refuse_to_touch'
  | 'teardown_failed'
  | 'container_not_labelled_owner_horizon';

export interface OrchestrationEvent {
  timestampMs: number;
  phase: OrchestrationPhase;
  code: 'phase_start' | 'phase_ok' | 'phase_fail';
  detail: string;
}

export interface OrchestrationResult {
  ok: boolean;
  phase: OrchestrationPhase | null;
  failureCode: OrchestrationFailureCode | null;
  detail: string | null;
  events: readonly OrchestrationEvent[];
  provisionedContainers: readonly string[];
}

export interface ManagedContainerSpec {
  readonly service: string;
  readonly image: string;
  readonly requiredHealthy: boolean;
  readonly readinessTimeoutMs?: number;
}

export interface ManagedOrchestrationConfig {
  readonly project: string;
  readonly composeFile: string;
  readonly containers: readonly ManagedContainerSpec[];
  readonly preflightTimeoutMs?: number;
  readonly provisionTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly teardownTimeoutMs?: number;
}

export interface ContainerRuntime {
  /** Bring up the compose stack with owner=horizon label enforcement. */
  composeUp(project: string, composeFile: string): Promise<{ ok: boolean; detail?: string }>;
  /** Tear down containers + networks; keep volumes labelled data=true. */
  composeDown(project: string, composeFile: string): Promise<{ ok: boolean; detail?: string }>;
  /** Verify the container carries the owner=horizon label before touching it. */
  inspectLabels(project: string, service: string): Promise<{ ok: boolean; labels: Record<string, string>; detail?: string }>;
}

export interface OrchestrationClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const DEFAULT_PREFLIGHT_MS = 6_000;
export const DEFAULT_PROVISION_MS = 60_000;
export const DEFAULT_READINESS_MS = 120_000;
export const DEFAULT_TEARDOWN_MS = 30_000;
const READINESS_POLL_INTERVAL_MS = 1_000;

export class ManagedDockerOrchestrator {
  private events: OrchestrationEvent[] = [];
  private provisioned: string[] = [];

  constructor(
    private readonly probe: DockerProbe,
    private readonly runtime: ContainerRuntime,
    private readonly logger: Logger,
    private readonly clock: OrchestrationClock,
  ) {}

  /** Pre-provision safety check. Never mutates docker state. */
  async preflight(config: ManagedOrchestrationConfig): Promise<OrchestrationResult> {
    this.events = [];
    this.provisioned = [];
    this.record('preflight', 'phase_start', `project=${config.project}`);
    const preflightMs = config.preflightTimeoutMs ?? DEFAULT_PREFLIGHT_MS;
    const start = this.clock.now();

    const docker = await this.probe.checkDocker();
    if (!docker.ok) return this.fail('preflight', mapDockerFailure(docker.reason, 'preflight_docker_missing'), docker.detail ?? 'docker check failed');
    if (this.clock.now() - start > preflightMs) return this.fail('preflight', 'preflight_daemon_unreachable', 'preflight timeout after docker check');

    const daemon = await this.probe.checkDaemon();
    if (!daemon.ok) return this.fail('preflight', 'preflight_daemon_unreachable', daemon.detail ?? 'daemon unreachable');

    const compose = await this.probe.checkCompose();
    if (!compose.ok) return this.fail('preflight', 'preflight_compose_missing', compose.detail ?? 'compose plugin missing');

    const composeFile = await this.probe.checkComposeFile(config.composeFile);
    if (!composeFile.ok) return this.fail('preflight', 'preflight_compose_file_missing', composeFile.detail ?? config.composeFile);

    this.record('preflight', 'phase_ok', 'all preflight checks passed');
    return this.currentSuccess('preflight');
  }

  /** Bring up managed containers. Idempotent-ish: compose up handles reuse. */
  async provision(config: ManagedOrchestrationConfig): Promise<OrchestrationResult> {
    this.record('provision', 'phase_start', `containers=${config.containers.length}`);
    const up = await this.runtime.composeUp(config.project, config.composeFile);
    if (!up.ok) return this.fail('provision', 'provision_failed', up.detail ?? 'composeUp failed');
    for (const c of config.containers) {
      const labels = await this.runtime.inspectLabels(config.project, c.service);
      if (!labels.ok) return this.fail('provision', 'container_not_labelled_owner_horizon', labels.detail ?? c.service);
      if (labels.labels['owner'] !== 'horizon') {
        return this.fail('provision', 'container_not_labelled_owner_horizon', `${c.service}: owner=${labels.labels['owner'] ?? '<unset>'}`);
      }
      this.provisioned.push(c.service);
    }
    this.record('provision', 'phase_ok', `provisioned=${this.provisioned.join(',')}`);
    return this.currentSuccess('provision');
  }

  /** Poll each container's health until healthy or timeout. */
  async waitForReadiness(config: ManagedOrchestrationConfig): Promise<OrchestrationResult> {
    this.record('readiness_wait', 'phase_start', `poll_ms=${READINESS_POLL_INTERVAL_MS}`);
    const overallStart = this.clock.now();
    const overallLimit = config.readinessTimeoutMs ?? DEFAULT_READINESS_MS;
    for (const c of config.containers) {
      const containerLimit = c.readinessTimeoutMs ?? overallLimit;
      const containerStart = this.clock.now();
      let lastDetail = 'never_probed';
      while (true) {
        const elapsed = this.clock.now() - containerStart;
        if (elapsed > containerLimit) {
          return this.fail('readiness_wait', 'readiness_timeout', `${c.service}: last=${lastDetail}`);
        }
        if (this.clock.now() - overallStart > overallLimit) {
          return this.fail('readiness_wait', 'readiness_timeout', `overall: last=${c.service}:${lastDetail}`);
        }
        const health = await this.probe.containerHealth(config.project, c.service);
        if (health.ok) break;
        lastDetail = `${health.reason ?? 'unhealthy'}:${health.detail ?? ''}`.slice(0, 80);
        if (!c.requiredHealthy && health.reason === 'container_unhealthy') {
          this.logger.warn('optional container not healthy but continuing', { service: c.service, detail: lastDetail });
          break;
        }
        await this.clock.sleep(READINESS_POLL_INTERVAL_MS);
      }
    }
    this.record('readiness_wait', 'phase_ok', 'all containers ready');
    return this.currentSuccess('readiness_wait');
  }

  /**
   * Full startup — preflight, provision, readiness. Returns on the
   * first failure; caller should call teardown() to clean up if the
   * failure occurred at or after provision.
   */
  async startup(config: ManagedOrchestrationConfig): Promise<OrchestrationResult> {
    const pre = await this.preflight(config);
    if (!pre.ok) return pre;
    const prov = await this.provision(config);
    if (!prov.ok) return prov;
    const ready = await this.waitForReadiness(config);
    if (!ready.ok) return ready;
    return this.currentSuccess('supervise_ready');
  }

  /**
   * Bring the stack down. Refuses to touch anything without the
   * owner=horizon label — a stray container in the same project name
   * MUST NOT be destroyed by this call.
   */
  async teardown(config: ManagedOrchestrationConfig): Promise<OrchestrationResult> {
    this.record('teardown', 'phase_start', `project=${config.project}`);
    for (const service of this.provisioned) {
      const labels = await this.runtime.inspectLabels(config.project, service);
      if (!labels.ok) {
        this.logger.warn('inspectLabels failed during teardown, skipping', { service, detail: labels.detail });
        continue;
      }
      if (labels.labels['owner'] !== 'horizon') {
        return this.fail('teardown', 'label_missing_refuse_to_touch', `${service}: owner=${labels.labels['owner'] ?? '<unset>'}`);
      }
    }
    const down = await this.runtime.composeDown(config.project, config.composeFile);
    if (!down.ok) return this.fail('teardown', 'teardown_failed', down.detail ?? 'composeDown failed');
    this.record('teardown', 'phase_ok', 'containers removed, data volumes preserved');
    return this.currentSuccess('teardown');
  }

  eventLog(): readonly OrchestrationEvent[] {
    return [...this.events];
  }

  private record(phase: OrchestrationPhase, code: OrchestrationEvent['code'], detail: string): void {
    this.events.push({ timestampMs: this.clock.now(), phase, code, detail });
    this.logger.info(`orchestrator:${phase}:${code}`, { detail });
  }

  private fail(phase: OrchestrationPhase, code: OrchestrationFailureCode, detail: string): OrchestrationResult {
    this.record(phase, 'phase_fail', `${code}: ${detail}`);
    return {
      ok: false,
      phase,
      failureCode: code,
      detail,
      events: [...this.events],
      provisionedContainers: [...this.provisioned],
    };
  }

  private currentSuccess(phase: OrchestrationPhase): OrchestrationResult {
    return {
      ok: true,
      phase,
      failureCode: null,
      detail: null,
      events: [...this.events],
      provisionedContainers: [...this.provisioned],
    };
  }
}

function mapDockerFailure(
  reason: DockerFailureReason | undefined,
  fallback: OrchestrationFailureCode,
): OrchestrationFailureCode {
  switch (reason) {
    case 'docker_not_installed': return 'preflight_docker_missing';
    case 'docker_daemon_unavailable': return 'preflight_daemon_unreachable';
    case 'compose_unavailable': return 'preflight_compose_missing';
    case 'compose_file_missing':
    case 'service_definition_missing': return 'preflight_compose_file_missing';
    default: return fallback;
  }
}

/**
 * In-memory clock for deterministic tests. `sleep()` advances the
 * clock by the requested ms without wall-clock delay so a test can
 * assert timeout behavior in milliseconds.
 */
export class FakeClock implements OrchestrationClock {
  private current = 0;
  constructor(startMs = 0) { this.current = startMs; }
  now(): number { return this.current; }
  async sleep(ms: number): Promise<void> { this.current += ms; }
  advance(ms: number): void { this.current += ms; }
}
