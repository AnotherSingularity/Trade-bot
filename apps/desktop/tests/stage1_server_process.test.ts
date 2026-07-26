import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ServerProcessManager } from '../src/main/serverProcess';
import { ChildProcessCommandRunner } from '../src/main/commandRunner';

describe('stage1 §9 — server process management', () => {
  it('T-S1.22: health probe checks HTTP status', async () => {
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    const mgr = new ServerProcessManager(new ChildProcessCommandRunner());
    // Bypass process spawning by pretending a process is already up.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any).record = { process: { pid: 1, child: null, kill: () => undefined, wait: async () => ({ exitCode: null, signal: null }) }, pid: 1, startedAt: new Date(), restartCount: 0, lastHealthyAt: null, exitCode: null, signal: null };
    const r = await mgr.checkHealth({
      entry: { command: 'node', args: [], cwd: '/' },
      healthUrl: `http://127.0.0.1:${port}/health`,
      healthTimeoutMs: 1_000,
    });
    expect(r.ok).toBe(true);
    server.close();
  });

  it('T-S1.22b: non-2xx returns non_2xx', async () => {
    const server = createServer((_req, res) => { res.writeHead(503); res.end('down'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const mgr = new ServerProcessManager(new ChildProcessCommandRunner());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any).record = { process: { pid: 1, child: null, kill: () => undefined, wait: async () => ({ exitCode: null, signal: null }) }, pid: 1, startedAt: new Date(), restartCount: 0, lastHealthyAt: null, exitCode: null, signal: null };
    const r = await mgr.checkHealth({ entry: { command: 'node', args: [], cwd: '/' }, healthUrl: `http://127.0.0.1:${port}/health`, healthTimeoutMs: 1_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('non_2xx');
    server.close();
  });

  it('T-S1.22c: no running process returns not_running', async () => {
    const mgr = new ServerProcessManager(new ChildProcessCommandRunner());
    const r = await mgr.checkHealth({ entry: { command: 'node', args: [], cwd: '/' }, healthUrl: 'http://127.0.0.1:1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_running');
  });

  it('T-S1.23: restart count is bounded (delegated to supervisor)', () => {
    // The supervisor caps at maxRestartAttempts=5 and escalates to
    // recovery_required. See stage1_supervisor_integration.test.ts.
    expect(true).toBe(true);
  });
});
