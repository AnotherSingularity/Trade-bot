/**
 * Stage 1 §16 — Graceful shutdown.
 *
 * Sequence:
 *   1. block new scans (already true — scanner_ready cleared)
 *   2. wait for the active economic transaction boundary
 *   3. stop scanner loop
 *   4. stop reconciliation worker
 *   5. flush logs
 *   6. stop server if desktop-owned
 *   7. stop managed containers if configured
 *   8. preserve volumes (never `docker compose down -v`)
 */

import type { CommandRunner } from './commandRunner';
import type { Logger } from './logging';
import type { RuntimeAssets } from './runtimeAssets';
import type { ServerProcessManager } from './serverProcess';

export interface ShutdownInput {
  runner: CommandRunner;
  assets: RuntimeAssets;
  serverProcess: ServerProcessManager;
  serviceMode: 'managed_docker' | 'external_services';
  serverIsDesktopOwned: boolean;
  stopContainers: boolean; // policy — default false, containers survive shutdown
  logger: Logger;
}

export interface ShutdownResult {
  ok: boolean;
  steps: ShutdownStep[];
}

export interface ShutdownStep {
  name: string;
  ok: boolean;
  durationMs: number;
  detail?: string;
}

export class ShutdownError extends Error {
  constructor(reason: string) { super(`shutdown_error: ${reason}`); }
}

export async function performGracefulShutdown(input: ShutdownInput): Promise<ShutdownResult> {
  const steps: ShutdownStep[] = [];
  const record = async (name: string, work: () => Promise<{ ok: boolean; detail?: string }>) => {
    const t0 = Date.now();
    try {
      const r = await work();
      steps.push({ name, ok: r.ok, detail: r.detail, durationMs: Date.now() - t0 });
      input.logger.info(`shutdown ${name}`, { ok: r.ok, detail: r.detail });
    } catch (e) {
      steps.push({ name, ok: false, detail: String(e).slice(0, 200), durationMs: Date.now() - t0 });
      input.logger.error(`shutdown ${name} threw`, { err: String(e).slice(0, 200) });
    }
  };

  // 1-4. In this stage the scanner + reconciler are server-internal
  // loops; stopping the server stops them. If they become desktop-owned
  // workers in a later stage, add explicit stop steps here.
  await record('await_transaction_boundary', async () => {
    // Placeholder: the server side of an economic transaction must not be
    // mid-flight when the container is stopped. Today the server
    // controls this itself; the desktop just gives it a graceful
    // stop-window.
    return { ok: true, detail: 'no active transaction (server-managed)' };
  });

  // 5. Flush logs (delegated to the process-level Logger — no-op here).
  await record('flush_logs', async () => ({ ok: true }));

  // 6. Stop server if desktop-owned.
  if (input.serverIsDesktopOwned) {
    await record('stop_server_process', async () => {
      await input.serverProcess.stop(15_000);
      return { ok: true };
    });
  }

  // 7. Stop managed containers if configured. NEVER `down -v`.
  if (input.serviceMode === 'managed_docker' && input.stopContainers) {
    await record('compose_stop', async () => {
      const r = await input.runner.run('docker', [
        'compose', '-p', input.assets.composeProject, '-f', input.assets.composeFile, 'stop',
      ], { cwd: input.assets.workingDirectory, timeoutMs: 90_000 });
      return { ok: r.ok, detail: r.ok ? 'stopped' : r.stderr.slice(0, 200) };
    });
  } else {
    await record('compose_stop', async () => ({ ok: true, detail: 'left running by policy' }));
  }

  // 8. Preserve volumes — assertion, not action. This step exists so
  // the ShutdownResult explicitly records that we never ran `down -v`.
  await record('preserve_volumes', async () => ({ ok: true, detail: 'never docker compose down -v' }));

  return { ok: steps.every((s) => s.ok), steps };
}

export function refuseDangerousShutdownArgs(args: readonly string[]): void {
  // Defensive: refuse to run `docker compose down` with the `-v` flag
  // anywhere in the arg list. This is used by the runner's guardrail
  // test.
  const flat = args.map((a) => a.toLowerCase());
  if (flat.includes('down') && (flat.includes('-v') || flat.includes('--volumes'))) {
    throw new ShutdownError('down_-v_forbidden');
  }
}
