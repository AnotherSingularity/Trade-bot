/**
 * Stage 2 §10 — AuthenticatedApiClient: route allowlist, header selection,
 * bounded refresh retry.
 *
 * Stage 3C-CI-RESET Part 2 Checkpoint A.1: migrated to `requestValidated`
 * after the legacy generic `request<T>` was removed. Fake fetch bodies
 * are chosen to satisfy the shared response schema so the pipeline
 * exercises schema validation on the happy path AND surfaces the
 * exact typed errors on failure paths.
 */
import { describe, expect, it } from 'vitest';
import {
  API_ROUTES,
  AuthenticatedApiClient,
  DesktopApiHttpError,
  DesktopApiTransportError,
} from '../src/main/authenticatedApiClient';

function makeMockFetch(fn: (url: string, init: RequestInit) => Response): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => fn(String(input), init ?? {});
}

// systemReadiness requires {known:true, ready:boolean, ...} — the
// canonical fake body used by tests that only care about transport.
const READY_BODY_JSON = JSON.stringify({ known: true, ready: true });

describe('stage2 §10 authenticated api client', () => {
  it('C1: every allowlisted route has a scope tag', () => {
    for (const [, r] of Object.entries(API_ROUTES)) {
      expect(['bootstrap', 'operator']).toContain(r.scope);
    }
  });

  it('C2: bootstrap routes send X-Horizon-Bootstrap-Token', async () => {
    const captured: Record<string, string> = {};
    const client = new AuthenticatedApiClient({
      serverBaseUrl: 'http://127.0.0.1:1234',
      getBootstrapToken: () => 'the-bootstrap-token',
      getAccessToken: () => 'the-access-token',
      onRefreshNeeded: async () => ({ ok: true as const, newAccessToken: 'new' }),
      fetchImpl: makeMockFetch((_url, init) => {
        Object.assign(captured, init.headers);
        return new Response(READY_BODY_JSON, { status: 200 });
      }),
    });
    await client.requestValidated('systemReadiness');
    expect(captured['x-horizon-bootstrap-token']).toBe('the-bootstrap-token');
    expect(captured['authorization']).toBeUndefined();
  });

  it('C3: operator routes send Bearer access token', async () => {
    const captured: Record<string, string> = {};
    const client = new AuthenticatedApiClient({
      serverBaseUrl: 'http://127.0.0.1:1234',
      getBootstrapToken: () => 'the-bootstrap-token',
      getAccessToken: () => 'the-access-token',
      onRefreshNeeded: async () => ({ ok: true as const, newAccessToken: 'new' }),
      fetchImpl: makeMockFetch((_url, init) => {
        Object.assign(captured, init.headers);
        return new Response(JSON.stringify({
          known: true, source: 'compiled', values: { universe: 'v1' },
        }), { status: 200 });
      }),
    });
    await client.requestValidated('observerPolicyVersions');
    expect(captured['authorization']).toBe('Bearer the-access-token');
    expect(captured['x-horizon-bootstrap-token']).toBeUndefined();
  });

  it('C4: operator route with no access token throws DesktopApiHttpError (unauthenticated)', async () => {
    const client = new AuthenticatedApiClient({
      serverBaseUrl: 'http://127.0.0.1:1234',
      getBootstrapToken: () => 't',
      getAccessToken: () => null,
      onRefreshNeeded: async () => ({ ok: false as const, reason: 'no_token' }),
      fetchImpl: makeMockFetch(() => new Response('', { status: 200 })),
    });
    await expect(client.requestValidated('observerPolicyVersions'))
      .rejects.toBeInstanceOf(DesktopApiHttpError);
  });

  it('C5: 401 on operator route triggers exactly one refresh + one retry', async () => {
    let calls = 0;
    let refreshes = 0;
    const client = new AuthenticatedApiClient({
      serverBaseUrl: 'http://127.0.0.1:1234',
      getBootstrapToken: () => 't',
      getAccessToken: () => 'a',
      onRefreshNeeded: async () => { refreshes++; return { ok: true as const, newAccessToken: 'a2' }; },
      fetchImpl: makeMockFetch(() => {
        calls++;
        return new Response(JSON.stringify({ error: 'access_expired' }), { status: 401 });
      }),
    });
    await expect(client.requestValidated('observerPolicyVersions'))
      .rejects.toBeInstanceOf(DesktopApiHttpError);
    expect(calls).toBe(2);
    expect(refreshes).toBe(1);
  });

  it('C6: 401 after refresh does NOT trigger a second refresh (bounded)', async () => {
    let refreshes = 0;
    const client = new AuthenticatedApiClient({
      serverBaseUrl: 'http://127.0.0.1:1234',
      getBootstrapToken: () => 't',
      getAccessToken: () => 'a',
      onRefreshNeeded: async () => { refreshes++; return { ok: true as const, newAccessToken: 'a2' }; },
      fetchImpl: makeMockFetch(() => new Response('', { status: 401 })),
    });
    await expect(client.requestValidated('observerPolicyVersions'))
      .rejects.toBeInstanceOf(DesktopApiHttpError);
    expect(refreshes).toBe(1);
  });

  it('C7: attempting to call a non-allowlisted route rejects with allowlist error', async () => {
    const client = new AuthenticatedApiClient({
      serverBaseUrl: 'http://127.0.0.1',
      getBootstrapToken: () => 't',
      getAccessToken: () => 'a',
      onRefreshNeeded: async () => ({ ok: false as const, reason: 'x' }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((client as any).requestValidated('nonExistent'))
      .rejects.toThrow(/not allowlisted/);
  });

  it('C8: bootstrap route with missing bootstrap token throws DesktopApiTransportError', async () => {
    const client = new AuthenticatedApiClient({
      serverBaseUrl: 'http://127.0.0.1',
      getBootstrapToken: () => null,
      getAccessToken: () => 'a',
      onRefreshNeeded: async () => ({ ok: false as const, reason: 'x' }),
      fetchImpl: makeMockFetch(() => new Response('', { status: 200 })),
    });
    await expect(client.requestValidated('systemReadiness'))
      .rejects.toBeInstanceOf(DesktopApiTransportError);
  });
});
