/**
 * Stage 1 §9 — Real server process management.
 *
 * Spawns the built server (or dev entry) via the CommandRunner and
 * probes /health for readiness. The process is not considered
 * healthy simply because it exists.
 */

import type { CommandRunner, ManagedProcess } from './commandRunner';
import type { CommandSpec } from './runtimeAssets';

export interface ServerProcessInput {
  entry: CommandSpec;
  healthUrl: string;
  healthTimeoutMs?: number;
  startupTimeoutMs?: number;
  env?: Record<string, string>;
}

export interface ServerProcessRecord {
  process: ManagedProcess;
  pid: number | undefined;
  startedAt: Date;
  restartCount: number;
  lastHealthyAt: Date | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export type HealthOutcome =
  | { ok: true; body: string; ms: number; readiness?: ReadinessBody }
  | { ok: false; reason: 'not_running' | 'timeout' | 'non_2xx' | 'body_missing' | 'not_ready'; detail?: string; ms: number; readiness?: ReadinessBody };

export interface ReadinessBody {
  ready: boolean;
  components: Record<string, { ok: boolean; detail?: string }>;
}

export class ServerProcessManager {
  private record: ServerProcessRecord | null = null;
  constructor(private readonly runner: CommandRunner) {}

  get current(): ServerProcessRecord | null { return this.record; }

  async start(input: ServerProcessInput): Promise<ServerProcessRecord> {
    if (this.record?.process && this.record.exitCode == null) {
      return this.record;
    }
    const proc = this.runner.spawn(input.entry.command, input.entry.args, { cwd: input.entry.cwd, env: input.env });
    this.record = {
      process: proc,
      pid: proc.pid,
      startedAt: new Date(),
      restartCount: (this.record?.restartCount ?? 0) + 1,
      lastHealthyAt: null,
      exitCode: null,
      signal: null,
    };
    proc.wait().then((res) => {
      if (this.record) {
        this.record.exitCode = res.exitCode;
        this.record.signal = res.signal;
      }
    }).catch(() => { /* wait resolves normally */ });
    return this.record;
  }

  async stop(gracefulMs: number = 10_000): Promise<void> {
    if (!this.record?.process) return;
    this.record.process.kill('SIGTERM');
    // Give the server gracefulMs to exit cleanly.
    const deadline = Date.now() + gracefulMs;
    while (Date.now() < deadline && this.record?.exitCode == null) {
      await sleep(100);
    }
    if (this.record?.exitCode == null) {
      this.record.process.kill('SIGKILL');
    }
  }

  async checkHealth(input: ServerProcessInput): Promise<HealthOutcome> {
    if (!this.record || this.record.exitCode != null) {
      return { ok: false, reason: 'not_running', ms: 0 };
    }
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.healthTimeoutMs ?? 3_000);
      const res = await fetch(input.healthUrl, { signal: controller.signal });
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (!res.ok) return { ok: false, reason: 'non_2xx', detail: `status=${res.status}`, ms };
      const body = await res.text();
      if (!body) return { ok: false, reason: 'body_missing', ms };
      // Stage 1-FIX §4/§F: if the endpoint returns a dependency-aware
      // readiness body (`ready: boolean`, `components: {...}`), treat
      // `ready=false` as `not_ready` — HTTP success alone does NOT
      // establish operational readiness.
      let readiness: ReadinessBody | undefined;
      try {
        const parsed = JSON.parse(body) as { ready?: boolean; components?: Record<string, { ok: boolean; detail?: string }> };
        if (parsed && typeof parsed.ready === 'boolean' && parsed.components) {
          readiness = { ready: parsed.ready, components: parsed.components };
          if (!parsed.ready) {
            const failed = Object.entries(parsed.components)
              .filter(([, c]) => !c.ok).map(([k, c]) => `${k}:${c.detail ?? 'not_ok'}`).join(',');
            return { ok: false, reason: 'not_ready', detail: failed || 'ready=false', ms, readiness };
          }
        }
      } catch { /* body is not JSON — treat as legacy /health */ }
      if (this.record) this.record.lastHealthyAt = new Date();
      return { ok: true, body, ms, readiness };
    } catch (e) {
      const msg = String(e);
      if (/Abort|abort/.test(msg)) return { ok: false, reason: 'timeout', detail: msg.slice(0, 200), ms: Date.now() - started };
      return { ok: false, reason: 'timeout', detail: msg.slice(0, 200), ms: Date.now() - started };
    }
  }

  async waitForHealthy(input: ServerProcessInput): Promise<HealthOutcome> {
    const startedAt = Date.now();
    const deadline = startedAt + (input.startupTimeoutMs ?? 30_000);
    let lastFailure: HealthOutcome = { ok: false, reason: 'not_running', ms: 0 };
    while (Date.now() < deadline) {
      const outcome = await this.checkHealth(input);
      if (outcome.ok) return outcome;
      lastFailure = outcome;
      await sleep(500);
    }
    return lastFailure;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
