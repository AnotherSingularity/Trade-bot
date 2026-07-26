/**
 * Stage 1 §7 — Real migration execution.
 *
 * Spawns drizzle-kit through the CommandRunner. Captures output,
 * exit code and duration. On non-zero exit the desktop supervisor
 * transitions to `failed` and the operator sees the exact stderr.
 */

import type { CommandRunner } from './commandRunner';
import type { CommandSpec } from './runtimeAssets';

export type MigrationOutcome =
  | { ok: true; durationMs: number; sanitizedCommand: string; stdoutTail: string }
  | { ok: false; reason: 'nonzero_exit' | 'timeout' | 'runner_threw'; durationMs: number; sanitizedCommand: string; exitCode: number | null; stderrTail: string };

export interface MigrationRunnerInput {
  spec: CommandSpec;
  timeoutMs?: number;
  extraEnv?: Record<string, string>;
}

export class MigrationRunner {
  constructor(private readonly runner: CommandRunner) {}

  async apply(input: MigrationRunnerInput): Promise<MigrationOutcome> {
    const timeoutMs = input.timeoutMs ?? 120_000;
    try {
      const r = await this.runner.run(input.spec.command, input.spec.args, {
        cwd: input.spec.cwd,
        env: input.extraEnv,
        timeoutMs,
        maxBufferBytes: 512 * 1024,
      });
      if (r.timedOut) {
        return { ok: false, reason: 'timeout', durationMs: r.durationMs, sanitizedCommand: r.sanitizedCommand, exitCode: r.exitCode, stderrTail: tail(r.stderr) };
      }
      if (!r.ok) {
        return { ok: false, reason: 'nonzero_exit', durationMs: r.durationMs, sanitizedCommand: r.sanitizedCommand, exitCode: r.exitCode, stderrTail: tail(r.stderr) };
      }
      return { ok: true, durationMs: r.durationMs, sanitizedCommand: r.sanitizedCommand, stdoutTail: tail(r.stdout) };
    } catch (e) {
      return { ok: false, reason: 'runner_threw', durationMs: 0, sanitizedCommand: `${input.spec.command} ${input.spec.args.join(' ')}`, exitCode: null, stderrTail: String(e).slice(0, 400) };
    }
  }
}

function tail(s: string): string {
  const lines = s.split(/\r?\n/);
  return lines.slice(-20).join('\n').slice(0, 4_000);
}
