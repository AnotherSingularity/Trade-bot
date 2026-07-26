/**
 * Phase 3A §D — Desktop service supervisor.
 *
 * Deterministic 11-state service FSM. Each service is tracked
 * independently so a failed scanner is not conflated with a failed
 * database. Restart is bounded; crash-loops are detected and
 * escalated to `recovery_required` rather than causing uncontrolled
 * restart loops.
 */

import type { Logger } from './logging';

export type ServiceState =
  | 'not_configured'
  | 'checking_dependencies'
  | 'starting'
  | 'migrating'
  | 'synchronizing'
  | 'healthy'
  | 'degraded'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'recovery_required';

export type ServiceKind =
  | 'desktop_shell'
  | 'server'
  | 'scanner_worker'
  | 'reconciliation_worker'
  | 'mariadb'
  | 'redis'
  | 'market_data'
  | 'reporting';

export interface ServiceRecord {
  kind: ServiceKind;
  state: ServiceState;
  restartCount: number;
  lastTransitionAt: Date;
  lastFailureAt: Date | null;
  crashLoopDetected: boolean;
  detail: string | null;
}

export interface ServiceHealthCheck {
  ok: boolean;
  detail?: string;
}

export interface ServiceAdapter {
  kind: ServiceKind;
  checkDependencies(): Promise<ServiceHealthCheck>;
  start(): Promise<ServiceHealthCheck>;
  migrate?(): Promise<ServiceHealthCheck>;
  synchronize?(): Promise<ServiceHealthCheck>;
  healthCheck(): Promise<ServiceHealthCheck>;
  stop(): Promise<ServiceHealthCheck>;
}

export interface SupervisorConfig {
  maxRestartAttempts: number;
  crashLoopWindowMs: number;
  crashLoopThreshold: number;
}

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  maxRestartAttempts: 5,
  crashLoopWindowMs: 60_000,
  crashLoopThreshold: 3,
};

const LEGAL_TRANSITIONS: Record<ServiceState, readonly ServiceState[]> = {
  not_configured: ['checking_dependencies', 'stopped'],
  checking_dependencies: ['starting', 'failed', 'recovery_required', 'stopped'],
  starting: ['migrating', 'synchronizing', 'healthy', 'failed', 'stopping'],
  migrating: ['synchronizing', 'healthy', 'failed', 'stopping'],
  synchronizing: ['healthy', 'degraded', 'failed', 'stopping'],
  healthy: ['degraded', 'stopping', 'failed'],
  degraded: ['healthy', 'stopping', 'failed', 'recovery_required'],
  stopping: ['stopped'],
  stopped: ['checking_dependencies', 'not_configured'],
  failed: ['checking_dependencies', 'stopped', 'recovery_required'],
  recovery_required: ['stopped'],
};

export function isLegalTransition(from: ServiceState, to: ServiceState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export class ServiceSupervisor {
  private records = new Map<ServiceKind, ServiceRecord>();
  private failureTimestamps = new Map<ServiceKind, number[]>();

  constructor(
    private readonly adapters: readonly ServiceAdapter[],
    private readonly logger: Logger,
    private readonly config: SupervisorConfig = DEFAULT_SUPERVISOR_CONFIG,
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const a of adapters) {
      this.records.set(a.kind, {
        kind: a.kind,
        state: 'not_configured',
        restartCount: 0,
        lastTransitionAt: this.now(),
        lastFailureAt: null,
        crashLoopDetected: false,
        detail: null,
      });
    }
  }

  snapshot(): ServiceRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  getState(kind: ServiceKind): ServiceState {
    return this.records.get(kind)?.state ?? 'not_configured';
  }

  private transition(kind: ServiceKind, next: ServiceState, detail?: string): boolean {
    const rec = this.records.get(kind);
    if (!rec) return false;
    if (!isLegalTransition(rec.state, next)) {
      this.logger.warn(`illegal transition rejected`, { kind, from: rec.state, to: next });
      return false;
    }
    if (next === 'failed') {
      const ts = this.failureTimestamps.get(kind) ?? [];
      const now = this.now().getTime();
      const recent = ts.filter((t) => now - t <= this.config.crashLoopWindowMs);
      recent.push(now);
      this.failureTimestamps.set(kind, recent);
      if (recent.length >= this.config.crashLoopThreshold) {
        rec.crashLoopDetected = true;
      }
    }
    rec.state = next;
    rec.lastTransitionAt = this.now();
    rec.detail = detail ?? null;
    if (next === 'failed') rec.lastFailureAt = this.now();
    return true;
  }

  async start(kind: ServiceKind): Promise<ServiceRecord> {
    const rec = this.records.get(kind);
    const adapter = this.adapters.find((a) => a.kind === kind);
    if (!rec || !adapter) throw new Error(`unknown service ${kind}`);
    if (rec.crashLoopDetected) {
      this.transition(kind, 'recovery_required', 'crash_loop_detected');
      return { ...rec };
    }
    if (rec.restartCount >= this.config.maxRestartAttempts) {
      this.transition(kind, 'recovery_required', 'max_restart_attempts');
      return { ...rec };
    }
    this.transition(kind, 'checking_dependencies');
    const deps = await adapter.checkDependencies();
    if (!deps.ok) {
      this.transition(kind, 'failed', deps.detail ?? 'dependency_check_failed');
      rec.restartCount += 1;
      return { ...rec };
    }
    this.transition(kind, 'starting');
    const started = await adapter.start();
    if (!started.ok) {
      this.transition(kind, 'failed', started.detail ?? 'start_failed');
      rec.restartCount += 1;
      return { ...rec };
    }
    if (adapter.migrate) {
      this.transition(kind, 'migrating');
      const mig = await adapter.migrate();
      if (!mig.ok) {
        this.transition(kind, 'failed', mig.detail ?? 'migration_failed');
        rec.restartCount += 1;
        return { ...rec };
      }
    }
    if (adapter.synchronize) {
      this.transition(kind, 'synchronizing');
      const sync = await adapter.synchronize();
      if (!sync.ok) {
        this.transition(kind, 'failed', sync.detail ?? 'sync_failed');
        rec.restartCount += 1;
        return { ...rec };
      }
    }
    const hc = await adapter.healthCheck();
    this.transition(kind, hc.ok ? 'healthy' : 'degraded', hc.detail);
    return { ...rec };
  }

  async stop(kind: ServiceKind): Promise<ServiceRecord> {
    const rec = this.records.get(kind);
    const adapter = this.adapters.find((a) => a.kind === kind);
    if (!rec || !adapter) throw new Error(`unknown service ${kind}`);
    if (rec.state === 'stopped' || rec.state === 'not_configured') return { ...rec };
    this.transition(kind, 'stopping');
    const res = await adapter.stop();
    this.transition(kind, 'stopped', res.detail);
    return { ...rec };
  }

  async pollHealth(kind: ServiceKind): Promise<ServiceRecord> {
    const rec = this.records.get(kind);
    const adapter = this.adapters.find((a) => a.kind === kind);
    if (!rec || !adapter) throw new Error(`unknown service ${kind}`);
    if (rec.state !== 'healthy' && rec.state !== 'degraded') return { ...rec };
    const hc = await adapter.healthCheck();
    if (hc.ok && rec.state === 'degraded') this.transition(kind, 'healthy', hc.detail);
    else if (!hc.ok && rec.state === 'healthy') this.transition(kind, 'degraded', hc.detail);
    return { ...rec };
  }

  async restart(kind: ServiceKind): Promise<ServiceRecord> {
    const rec = this.records.get(kind);
    if (!rec) throw new Error(`unknown service ${kind}`);
    if (rec.state === 'healthy' || rec.state === 'degraded' || rec.state === 'failed') {
      await this.stop(kind);
    }
    return this.start(kind);
  }

  resetForRecovery(kind: ServiceKind): void {
    const rec = this.records.get(kind);
    if (!rec) return;
    rec.restartCount = 0;
    rec.crashLoopDetected = false;
    this.failureTimestamps.set(kind, []);
  }
}
