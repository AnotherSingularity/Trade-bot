import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DesktopStatusSource, toCountersEnvelope } from '../src/main/desktopStatusSource';

describe('stage1 §12 — authoritative desktop status', () => {
  it('T-S1.28: hardcoded schema version is removed — comes from fingerprintVersion input', async () => {
    const src = new DesktopStatusSource({
      serverHealthUrl: 'http://127.0.0.1:1',
      fingerprintVersion: '0020',
    });
    const snap = await src.sample();
    expect(snap.schemaVersion).toBe('0020');
  });

  it('T-S1.29: hardcoded counters are removed — unknown when unreachable', async () => {
    const src = new DesktopStatusSource({
      serverHealthUrl: 'http://127.0.0.1:1',
      serverCountersUrl: 'http://127.0.0.1:1/api/desktop/create-order-counters',
    });
    const snap = await src.sample();
    expect(snap.createOrderCounters.known).toBe(false);
    expect(snap.createOrderCounters.functionInvocations).toBeNull();
  });

  it('T-S1.30 (§12): known=true only when server returns valid numbers', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"functionInvocations":0,"attemptCount":0,"networkCount":0}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const src = new DesktopStatusSource({
      serverHealthUrl: `http://127.0.0.1:${port}`,
      serverCountersUrl: `http://127.0.0.1:${port}/counters`,
    });
    const snap = await src.sample();
    expect(snap.createOrderCounters.known).toBe(true);
    expect(snap.createOrderCounters.functionInvocations).toBe(0);
    server.close();
  });

  it('T-S1.30b: invalid response payload yields unknown', async () => {
    const server = createServer((_req, res) => { res.writeHead(200); res.end('{"functionInvocations":"nope"}'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const src = new DesktopStatusSource({
      serverHealthUrl: `http://127.0.0.1:${port}`,
      serverCountersUrl: `http://127.0.0.1:${port}/counters`,
    });
    const snap = await src.sample();
    expect(snap.createOrderCounters.known).toBe(false);
    server.close();
  });

  it('T-S1.envelope: toCountersEnvelope wraps authoritative counters', () => {
    const env = toCountersEnvelope({ known: true, functionInvocations: 0, attemptCount: 0, networkCount: 0, source: 'test' });
    expect(env.known).toBe(true);
    expect(env.source).toBe('test');
    expect(env.values).toEqual({ functionInvocations: 0, attemptCount: 0, networkCount: 0 });
  });

  it('T-S1.envelope2: unknown envelope still emits zeros for backward-compat', () => {
    const env = toCountersEnvelope({ known: false, functionInvocations: null, attemptCount: null, networkCount: null, source: 'not_configured' });
    expect(env.known).toBe(false);
    expect(env.values).toEqual({ functionInvocations: 0, attemptCount: 0, networkCount: 0 });
  });
});
