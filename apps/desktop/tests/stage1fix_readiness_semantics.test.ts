import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerProcessManager } from '../src/main/serverProcess';
import { ChildProcessCommandRunner } from '../src/main/commandRunner';

// Stage 1-FIX §F — HTTP-200 alone does not establish readiness.

const servers: ReturnType<typeof createServer>[] = [];

afterEach(() => {
  for (const s of servers) s.close();
  servers.length = 0;
});

async function stub(status: number, body: string): Promise<{ url: string; server: ReturnType<typeof createServer> }> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  servers.push(server);
  return { url: `http://127.0.0.1:${port}/api/system/readiness`, server };
}

function primedManager(): ServerProcessManager {
  const mgr = new ServerProcessManager(new ChildProcessCommandRunner());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mgr as any).record = {
    process: { pid: 1, child: null, kill: () => undefined, wait: async () => ({ exitCode: null, signal: null }) },
    pid: 1, startedAt: new Date(), restartCount: 0, lastHealthyAt: null, exitCode: null, signal: null,
  };
  return mgr;
}

describe('stage1-fix §F — server readiness semantics', () => {
  it('FIX-F1: HTTP 200 with ready=false is NOT ready (mariadb component failure)', async () => {
    const { url } = await stub(200, JSON.stringify({
      ready: false,
      components: {
        process: { ok: true },
        mariadb: { ok: false, detail: 'unreachable' },
        redis: { ok: true },
        migration: { ok: true },
        fingerprint: { ok: true },
        reconciliation: { ok: true },
        createOrderBarrier: { ok: true },
      },
    }));
    const mgr = primedManager();
    const r = await mgr.checkHealth({ entry: { command: 'node', args: [], cwd: '/' }, healthUrl: url });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('not_ready');
      expect(r.detail).toMatch(/mariadb/);
    }
  });

  it('FIX-F2: HTTP 200 with ready=false — redis component failure', async () => {
    const { url } = await stub(200, JSON.stringify({
      ready: false,
      components: {
        process: { ok: true }, mariadb: { ok: true },
        redis: { ok: false, detail: 'unreachable' },
        migration: { ok: true }, fingerprint: { ok: true }, reconciliation: { ok: true }, createOrderBarrier: { ok: true },
      },
    }));
    const r = await primedManager().checkHealth({ entry: { command: 'node', args: [], cwd: '/' }, healthUrl: url });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/redis/);
  });

  it('FIX-F3: HTTP 200 with schema fingerprint mismatch — NOT ready', async () => {
    const { url } = await stub(200, JSON.stringify({
      ready: false,
      components: {
        process: { ok: true }, mariadb: { ok: true }, redis: { ok: true },
        migration: { ok: true },
        fingerprint: { ok: false, detail: 'applied=15 expected>=21' },
        reconciliation: { ok: true }, createOrderBarrier: { ok: true },
      },
    }));
    const r = await primedManager().checkHealth({ entry: { command: 'node', args: [], cwd: '/' }, healthUrl: url });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/fingerprint/);
  });

  it('FIX-F4: HTTP 200 with reconciliation failure — NOT ready', async () => {
    const { url } = await stub(200, JSON.stringify({
      ready: false,
      components: {
        process: { ok: true }, mariadb: { ok: true }, redis: { ok: true },
        migration: { ok: true }, fingerprint: { ok: true },
        reconciliation: { ok: false, detail: 'unresolved_actions=3' },
        createOrderBarrier: { ok: true },
      },
    }));
    const r = await primedManager().checkHealth({ entry: { command: 'node', args: [], cwd: '/' }, healthUrl: url });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/reconciliation/);
  });

  it('FIX-F5: HTTP 200 with barrier counter non-zero — NOT ready', async () => {
    const { url } = await stub(200, JSON.stringify({
      ready: false,
      components: {
        process: { ok: true }, mariadb: { ok: true }, redis: { ok: true },
        migration: { ok: true }, fingerprint: { ok: true }, reconciliation: { ok: true },
        createOrderBarrier: { ok: false, detail: 'attempts=1' },
      },
    }));
    const r = await primedManager().checkHealth({ entry: { command: 'node', args: [], cwd: '/' }, healthUrl: url });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/createOrderBarrier/);
  });

  it('FIX-F6: HTTP 200 with all components ok → ready', async () => {
    const { url } = await stub(200, JSON.stringify({
      ready: true,
      components: {
        process: { ok: true }, mariadb: { ok: true }, redis: { ok: true },
        migration: { ok: true }, fingerprint: { ok: true }, reconciliation: { ok: true },
        createOrderBarrier: { ok: true },
      },
    }));
    const r = await primedManager().checkHealth({ entry: { command: 'node', args: [], cwd: '/' }, healthUrl: url });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.readiness?.ready).toBe(true);
  });

  it('FIX-F7: legacy /health (non-readiness JSON body) is accepted as generic 200', async () => {
    const { url } = await stub(200, JSON.stringify({ status: 'ok', version: '2.0.0' }));
    const r = await primedManager().checkHealth({ entry: { command: 'node', args: [], cwd: '/' }, healthUrl: url });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.readiness).toBeUndefined();
  });
});
