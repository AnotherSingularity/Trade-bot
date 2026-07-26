/**
 * Stage 1 §1 — Production command runner.
 *
 * Real child_process-backed runner. Never uses shell concatenation.
 * Command and arguments are passed separately to `spawn`/`execFile`.
 * Every invocation has a bounded stdout/stderr buffer, a required
 * timeout, and structured result recording.
 *
 * Credentials that appear inside args or environment are redacted
 * before the invocation is logged.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  maxBufferBytes?: number;
  input?: string;
}

export interface SpawnOnlyOptions {
  cwd: string;
  env?: Record<string, string>;
}

export interface RunResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  sanitizedCommand: string;
}

export interface ManagedProcess {
  pid: number | undefined;
  child: ChildProcess;
  kill(signal?: NodeJS.Signals): void;
  wait(): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

export interface CommandRunner {
  readonly kind: 'ChildProcessCommandRunner' | 'InMemoryCommandRunner';
  isAvailable(command: string): Promise<boolean>;
  run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult>;
  spawn(command: string, args: readonly string[], options: SpawnOnlyOptions): ManagedProcess;
}

const DEFAULT_BUFFER = 1_048_576; // 1 MiB per stream
const REDACT_PATTERNS: readonly RegExp[] = [
  /--password[=\s]+\S+/gi,
  /-p\S+/g,
  /MYSQL_ROOT_PASSWORD=\S+/gi,
  /COINBASE_[A-Z_]+=\S+/g,
  /ANTHROPIC_[A-Z_]+=\S+/g,
  /JWT_SECRET=\S+/g,
];

const ALLOWED_EXECUTABLES = new Set([
  'docker', 'docker.exe',
  'node', 'node.exe',
  'npx', 'npx.cmd', 'npx.exe',
  'npm', 'npm.cmd', 'npm.exe',
]);

export function isSafeCommand(command: string): boolean {
  // Absolute paths must exist and be readable.
  if (isAbsolute(command)) {
    try { accessSync(command, fsConstants.R_OK); } catch { return false; }
    const basename = command.split(/[\/\\]/).pop() ?? '';
    return ALLOWED_EXECUTABLES.has(basename);
  }
  // Bare names must be in the allowlist.
  return ALLOWED_EXECUTABLES.has(command);
}

function sanitize(command: string, args: readonly string[]): string {
  let s = `${command} ${args.join(' ')}`;
  for (const p of REDACT_PATTERNS) s = s.replace(p, (m) => m.split(/[=\s]/)[0] + '=[REDACTED]');
  return s.slice(0, 400);
}

export class UnsafeCommandError extends Error {
  constructor(command: string) { super(`unsafe_command: ${command}`); }
}

export class InvalidWorkingDirectoryError extends Error {
  constructor(cwd: string) { super(`invalid_working_directory: ${cwd}`); }
}

export class ChildProcessCommandRunner implements CommandRunner {
  readonly kind = 'ChildProcessCommandRunner';

  async isAvailable(command: string): Promise<boolean> {
    if (!isSafeCommand(command)) return false;
    // Cheap availability check: spawn `command --version` with a
    // very short timeout. If it fails, the command is unavailable.
    try {
      const r = await this.run(command, ['--version'], {
        cwd: process.cwd(),
        timeoutMs: 4_000,
        maxBufferBytes: 8_192,
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  async run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
    if (!isSafeCommand(command)) throw new UnsafeCommandError(command);
    if (!isAbsolute(options.cwd)) throw new InvalidWorkingDirectoryError(options.cwd);
    try { accessSync(options.cwd, fsConstants.R_OK); } catch { throw new InvalidWorkingDirectoryError(options.cwd); }

    const started = Date.now();
    const spawnOpts: SpawnOptions = {
      cwd: options.cwd,
      env: this.buildEnv(options.env),
      shell: false, // NEVER shell — args are literal
      stdio: options.input == null ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    };
    const child = spawn(command, [...args], spawnOpts);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxBuf = options.maxBufferBytes ?? DEFAULT_BUFFER;
    let timedOut = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBuf) stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuf) stderrChunks.push(chunk);
    });

    if (options.input != null && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 2_000);
    }, options.timeoutMs);

    const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    clearTimeout(timer);

    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    return {
      ok: !timedOut && exitCode === 0,
      exitCode,
      signal,
      stdout: redactString(stdout),
      stderr: redactString(stderr),
      durationMs: Date.now() - started,
      timedOut,
      sanitizedCommand: sanitize(command, args),
    };
  }

  spawn(command: string, args: readonly string[], options: SpawnOnlyOptions): ManagedProcess {
    if (!isSafeCommand(command)) throw new UnsafeCommandError(command);
    if (!isAbsolute(options.cwd)) throw new InvalidWorkingDirectoryError(options.cwd);
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: this.buildEnv(options.env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (code, sig) => resolve({ exitCode: code, signal: sig }));
    });
    return {
      pid: child.pid,
      child,
      kill: (sig: NodeJS.Signals = 'SIGTERM') => { try { child.kill(sig); } catch { /* already gone */ } },
      wait: () => done,
    };
  }

  private buildEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
    // Never leak the entire process.env by default; only pass explicit keys.
    const base: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    return { ...base, ...(extra ?? {}) };
  }
}

function redactString(s: string): string {
  let out = s;
  for (const p of REDACT_PATTERNS) out = out.replace(p, (m) => m.split(/[=\s]/)[0] + '=[REDACTED]');
  return out;
}

/**
 * InMemoryCommandRunner — deterministic test double.
 * Never invoke in production; the ProductionAdapterFactory refuses it.
 */
export class InMemoryCommandRunner implements CommandRunner {
  readonly kind = 'InMemoryCommandRunner';
  readonly log: string[] = [];
  private scripted = new Map<string, RunResult>();
  private available = new Set<string>();

  setAvailable(command: string, isAvailable: boolean): void {
    if (isAvailable) this.available.add(command); else this.available.delete(command);
  }

  script(commandLine: string, result: Partial<RunResult>): void {
    const base: RunResult = {
      ok: true, exitCode: 0, signal: null,
      stdout: '', stderr: '',
      durationMs: 1, timedOut: false, sanitizedCommand: commandLine,
    };
    this.scripted.set(commandLine, { ...base, ...result, sanitizedCommand: commandLine });
  }

  async isAvailable(command: string): Promise<boolean> {
    return this.available.has(command);
  }

  async run(command: string, args: readonly string[], _options: RunOptions): Promise<RunResult> {
    const line = `${command} ${args.join(' ')}`;
    this.log.push(line);
    const scripted = this.scripted.get(line);
    if (scripted) return scripted;
    // Default: succeed with empty stdout.
    return {
      ok: true, exitCode: 0, signal: null, stdout: '', stderr: '',
      durationMs: 1, timedOut: false, sanitizedCommand: sanitize(command, args),
    };
  }

  spawn(command: string, args: readonly string[], _options: SpawnOnlyOptions): ManagedProcess {
    this.log.push(`spawn ${command} ${args.join(' ')}`);
    return {
      pid: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      child: null as any,
      kill: () => undefined,
      wait: async () => ({ exitCode: 0, signal: null }),
    };
  }
}
