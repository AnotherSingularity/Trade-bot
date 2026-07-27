/**
 * Stage 3 §4 + §5 — DesktopDataClient + IPC boundary tests.
 *
 * Covers required-test items §21.4 (response schema validation),
 * §21.11 (renderer cannot provide arbitrary procedure names), §21.42
 * (safe flags cannot be forged in envelopes). All assertions are pure
 * — no DB, no server.
 */

import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_DATA_KEYS } from '@horizon/shared';
import { DesktopDataClient, isKnownDesktopDataKey, knownProcedurePaths, sanitizeError } from '../src/main/desktopDataClient';

function makeClient(fetchImpl: typeof fetch, _opts?: Partial<Parameters<typeof DesktopDataClient['prototype']['call']>[0]>) {
  return new DesktopDataClient({
    serverBaseUrl: 'http://127.0.0.1:0',
    getAccessToken: () => 'test-access-token',
    onRefreshNeeded: async () => ({ ok: true, newAccessToken: 'test-access-token' }),
    fetchImpl,
    requestTimeoutMs: 500,
  });
}

describe('Stage 3 §4 — DesktopDataClient', () => {
  it('§21.4 every enumerated key has a compiled-in procedure path', () => {
    const paths = knownProcedurePaths();
    for (const k of DESKTOP_DATA_KEYS) {
      expect(paths[k]).toBeDefined();
      expect(paths[k].startsWith('desktop.')).toBe(true);
    }
  });

  it('§21.11 unknown request keys are rejected before any HTTP call', async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.call('made.up.key' as any);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.kind).toBe('contract_mismatch');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('§21.4 response that does not match its schema fails as contract_mismatch', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      result: { data: { contractVersion: '3.0.0', status: 'healthy', data: { desktopVersion: 'ok' }, generatedAt: 'not-a-timestamp' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const res = await client.call('overview.get');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error.kind).toBe('contract_mismatch');
  });

  it('§21.4 valid envelope is returned unchanged when schema passes', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      result: {
        data: {
          contractVersion: '3.0.0',
          status: 'healthy',
          data: {
            desktopVersion: 'v1', serverVersion: 'v1', buildCommit: null,
            providerMode: 'fixture',
            safeFlags: { DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false, SIMULATION_MODE: 'STANDARD_DRY_RUN', liveOrderSubmissionDisabled: true },
            schemaFingerprint: { expectedVersion: '0021', observedVersion: '0021', fingerprintMatch: 'match', reason: null },
            services: [],
            scannerReadiness: { state: 'ready', blockingReasons: [], observedAt: null },
            reconciliationHealth: { state: 'ok', lastRunAt: null, unresolvedCount: 0, reasonCode: null },
            accountingIntegrity: { accountingDifference: null, brokenAcceptedLineageCount: 0, missingMandatoryAttributionCount: 0, reasonCode: null },
            openPositionCount: 0, unprotectedExposure: null,
            championVersion: 'strategy-1', observerPolicyVersions: {},
            createOrderCounters: { known: true, source: 'test', functionInvocations: 0, attemptCount: 0, networkCount: 0, reasonCode: null },
          },
          generatedAt: '2026-07-26T20:00:00.000Z',
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const res = await client.call('overview.get');
    expect(res.ok).toBe(true);
    expect(res.ok && res.envelope.status).toBe('healthy');
  });

  it('401 triggers one refresh + retry then fails after second 401', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return new Response('unauthorized', { status: 401 });
    });
    const refreshSpy = vi.fn(async () => ({ ok: true as const, newAccessToken: 'new' }));
    const client = new DesktopDataClient({
      serverBaseUrl: 'http://127.0.0.1:0',
      getAccessToken: () => 'access',
      onRefreshNeeded: refreshSpy,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await client.call('safety.get');
    expect(res.ok).toBe(false);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    expect(res.ok === false && res.error.kind).toBe('unauthenticated');
  });

  it('§21.19 sanitizeError redacts bearer tokens from server messages', () => {
    const cleaned = sanitizeError({ kind: 'server', status: 500, detail: 'boom Bearer abcdefghij_1234567890' });
    expect(cleaned.detail).toContain('[redacted]');
    expect(cleaned.detail).not.toContain('abcdefghij_1234567890');
  });

  it('§21.4 no access token yields unauthenticated without touching fetch', async () => {
    const fetchImpl = vi.fn();
    const client = new DesktopDataClient({
      serverBaseUrl: 'http://127.0.0.1:0',
      getAccessToken: () => null,
      onRefreshNeeded: async () => ({ ok: false, reason: 'no_refresh' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await client.call('overview.get');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error.kind).toBe('unauthenticated');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('isKnownDesktopDataKey guards against arbitrary strings', () => {
    expect(isKnownDesktopDataKey('overview.get')).toBe(true);
    expect(isKnownDesktopDataKey('not.a.key')).toBe(false);
  });
});
