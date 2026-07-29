/**
 * Stage 9 §preflight — Coinbase read-only preflight tests.
 *
 * Pure. Every branch covered — happy path + each rejection code.
 */
import { describe, expect, it } from 'vitest';
import {
  COINBASE_FORBIDDEN_ENDPOINTS,
  COINBASE_HOST_ALLOWLIST,
  COINBASE_READ_ONLY_ENDPOINTS,
  runCoinbaseReadOnlyPreflight,
  synthesizeAwaitingCredentialsInput,
} from '../src/preflight/coinbaseReadOnly';

const NOW = '2026-07-29T22:00:00Z';
const SHA = '0'.repeat(40);

describe('runCoinbaseReadOnlyPreflight — credential-absent smoke', () => {
  it('returns coinbase_preflight_awaiting_credentials when credentials absent', () => {
    const r = runCoinbaseReadOnlyPreflight(synthesizeAwaitingCredentialsInput(SHA, NOW));
    expect(r.verdict).toBe('coinbase_preflight_awaiting_credentials');
    expect(r.credentialSource).toBe('absent');
    expect(r.createOrderCounters.functionInvocations).toBe(0);
    expect(r.createOrderCounters.attemptCount).toBe(0);
    expect(r.createOrderCounters.networkCount).toBe(0);
  });

  it('client-shape checks all pass on the synthesized shape', () => {
    const r = runCoinbaseReadOnlyPreflight(synthesizeAwaitingCredentialsInput(SHA, NOW));
    const critical = r.checks.filter((c) => !c.ok && c.severity === 'critical');
    expect(critical, `unexpected critical failures: ${critical.map((c) => c.id).join(',')}`).toHaveLength(0);
  });
});

describe('runCoinbaseReadOnlyPreflight — client-shape rejections', () => {
  const base = synthesizeAwaitingCredentialsInput(SHA, NOW);
  it('rejects baseUrl outside allowlist', () => {
    const r = runCoinbaseReadOnlyPreflight({
      ...base,
      clientDescription: { ...base.clientDescription, baseUrl: 'https://malicious.example.com' },
    });
    expect(r.verdict).toBe('coinbase_preflight_failed_host_allowlist');
  });
  it('rejects http (non-TLS) baseUrl', () => {
    const r = runCoinbaseReadOnlyPreflight({
      ...base,
      clientDescription: { ...base.clientDescription, baseUrl: 'http://api.coinbase.com' },
    });
    expect(r.verdict).toBe('coinbase_preflight_failed_tls');
  });
  it('rejects timeoutMs out of range', () => {
    const r = runCoinbaseReadOnlyPreflight({
      ...base,
      clientDescription: { ...base.clientDescription, timeoutMs: 300_000 },
    });
    expect(r.verdict).toBe('coinbase_preflight_failed_rate_limits');
  });
  it('rejects excessive maxRequestsPerSecond', () => {
    const r = runCoinbaseReadOnlyPreflight({
      ...base,
      clientDescription: { ...base.clientDescription, maxRequestsPerSecond: 1000 },
    });
    expect(r.verdict).toBe('coinbase_preflight_failed_rate_limits');
  });
  it('rejects websocket ping too short', () => {
    const r = runCoinbaseReadOnlyPreflight({
      ...base,
      clientDescription: { ...base.clientDescription, websocketPingIntervalMs: 1_000 },
    });
    expect(r.verdict).toBe('coinbase_preflight_failed_heartbeat');
  });
});

describe('runCoinbaseReadOnlyPreflight — counter + order-post barrier', () => {
  const base = synthesizeAwaitingCredentialsInput(SHA, NOW);
  it('fails immediately if Create Order counters are non-zero', () => {
    const r = runCoinbaseReadOnlyPreflight({
      ...base,
      observedCreateOrderCounters: { functionInvocations: 1, attemptCount: 0, networkCount: 0 },
    });
    expect(r.verdict).toBe('coinbase_preflight_failed_create_order_counter_nonzero');
  });
  it('order_post_barrier check passes because forbidden endpoints exist', () => {
    const r = runCoinbaseReadOnlyPreflight(base);
    const barrier = r.checks.find((c) => c.id === 'order_post_barrier');
    expect(barrier?.ok).toBe(true);
  });
  it('rate_limits check accepts up to 30 requests/sec', () => {
    const r = runCoinbaseReadOnlyPreflight({
      ...base,
      clientDescription: { ...base.clientDescription, maxRequestsPerSecond: 30 },
    });
    expect(r.verdict).toBe('coinbase_preflight_awaiting_credentials');
  });
});

describe('runCoinbaseReadOnlyPreflight — live observations flow', () => {
  const withCreds = {
    ...synthesizeAwaitingCredentialsInput(SHA, NOW),
    credentialSource: 'env' as const,
    localVsCoinbaseSkewSeconds: 0.3,
    liveObservations: {
      accountsFetched: true,
      productsFetched: 452,
      wsConnected: true,
      wsHeartbeatsObserved: 120,
      wsReconnectsSuccessful: 2,
      restRateLimitedResponses: 0,
      feeTierFetched: true,
      spreadObserved: true,
      minimumNotionalKnown: true,
      incrementsKnown: true,
      productStatusChecked: 452,
      restrictedProductsFiltered: 12,
      quarantinedListingsFiltered: 3,
    },
  };
  it('passes when every live observation is present', () => {
    const r = runCoinbaseReadOnlyPreflight(withCreds);
    expect(r.verdict, `${r.verdict}: ${r.detail}`).toBe('coinbase_preflight_passed');
  });
  it('rejects when the account read fails', () => {
    const r = runCoinbaseReadOnlyPreflight({
      ...withCreds,
      liveObservations: { ...withCreds.liveObservations, accountsFetched: false },
    });
    expect(r.verdict).toBe('coinbase_preflight_failed_account_read');
  });
  it('rejects when fee tier fetch fails', () => {
    const r = runCoinbaseReadOnlyPreflight({
      ...withCreds,
      liveObservations: { ...withCreds.liveObservations, feeTierFetched: false },
    });
    expect(r.verdict).toBe('coinbase_preflight_failed_fee_info');
  });
  it('rejects when websocket fails to connect', () => {
    const r = runCoinbaseReadOnlyPreflight({
      ...withCreds,
      liveObservations: { ...withCreds.liveObservations, wsConnected: false },
    });
    expect(r.verdict).toBe('coinbase_preflight_failed_websocket_lifecycle');
  });
  it('rejects on clock drift > 2s', () => {
    const r = runCoinbaseReadOnlyPreflight({
      ...withCreds,
      localVsCoinbaseSkewSeconds: 5,
    });
    expect(r.verdict).toBe('coinbase_preflight_failed_clock_sync');
  });
});

describe('endpoint contracts', () => {
  it('allowlist is a non-empty frozen tuple', () => {
    expect(COINBASE_HOST_ALLOWLIST.length).toBeGreaterThan(0);
    expect(() => (COINBASE_HOST_ALLOWLIST as string[]).push('foo')).toThrow();
  });
  it('read-only endpoints are all GET', () => {
    for (const ep of COINBASE_READ_ONLY_ENDPOINTS) expect(ep.startsWith('GET '), ep).toBe(true);
  });
  it('forbidden endpoints are all POST / DELETE', () => {
    for (const ep of COINBASE_FORBIDDEN_ENDPOINTS) {
      const method = ep.split(' ')[0];
      expect(['POST', 'DELETE'], `${ep} uses unexpected method`).toContain(method);
    }
  });
  it('read-only and forbidden sets are disjoint', () => {
    for (const ep of COINBASE_FORBIDDEN_ENDPOINTS) {
      expect(COINBASE_READ_ONLY_ENDPOINTS).not.toContain(ep);
    }
  });
});
