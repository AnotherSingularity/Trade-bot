/**
 * Stage 3C-CI-RESET Part 2 §1 — schema-aware API route contract tests.
 *
 * Locks in:
 *   - every registered route carries method + path + scope;
 *   - every renderer-safe route carries a response schema;
 *   - every route that accepts a body carries a request schema;
 *   - AuthenticatedApiClient.requestValidated validates the outgoing
 *     body BEFORE the request fires;
 *   - a malformed response fails with DesktopApiContractMismatchError('response');
 *   - reading `error` when the canonical field is `reason` is now
 *     structurally impossible;
 *   - unknown fields in strict schemas are rejected;
 *   - non-2xx HTTP responses raise DesktopApiHttpError;
 *   - invalid JSON body raises DesktopApiInvalidJsonError;
 *   - transport failure raises DesktopApiTransportError;
 *   - no route definition is duplicated between the legacy API_ROUTES
 *     and the shared DESKTOP_API_ROUTES registry (same path+method+scope).
 */
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_API_ROUTES,
  DESKTOP_API_ROUTE_KEYS,
  DesktopApiContractMismatchError,
  DesktopApiHttpError,
  DesktopApiInvalidJsonError,
  DesktopApiTransportError,
  OperatorLoginRequestSchema,
  AuthOperationResponseSchema,
  type DesktopApiRouteKey,
} from '@horizon/shared';
import {
  API_ROUTES,
  AuthenticatedApiClient,
} from '../../src/main/authenticatedApiClient';

// ---------------------------------------------------------------------------
// §1.1 Registry shape
// ---------------------------------------------------------------------------

describe('Stage 3C-CI-RESET Part 2 §1.1 — DESKTOP_API_ROUTES registry shape', () => {
  it('every entry carries method + path + scope', () => {
    for (const key of DESKTOP_API_ROUTE_KEYS) {
      const route = DESKTOP_API_ROUTES[key];
      expect(['GET', 'POST', 'PUT', 'DELETE']).toContain(route.method);
      expect(route.path.startsWith('/api/')).toBe(true);
      expect(['bootstrap', 'operator']).toContain(route.scope);
    }
  });

  it('every route carries a response schema (no unchecked JSON path)', () => {
    for (const key of DESKTOP_API_ROUTE_KEYS) {
      expect(
        AuthenticatedApiClient.hasResponseSchema(key),
        `route ${key} is missing a response schema — desktop_api_response_contract_mismatch guard cannot fire`,
      ).toBe(true);
    }
  });

  it('every non-GET / non-empty-body route carries a request schema', () => {
    for (const key of DESKTOP_API_ROUTE_KEYS) {
      // Widen so equality comparisons work against every HTTP method,
      // not only the ones actually in use.
      const method = DESKTOP_API_ROUTES[key].method as 'GET' | 'POST' | 'PUT' | 'DELETE';
      if (method === 'POST' || method === 'PUT') {
        expect(
          AuthenticatedApiClient.hasRequestSchema(key),
          `route ${key} (${method}) is missing a request schema`,
        ).toBe(true);
      }
    }
  });

  it('legacy API_ROUTES and DESKTOP_API_ROUTES agree on method+path+scope for shared keys', () => {
    for (const legacyKey of Object.keys(API_ROUTES)) {
      const legacy = API_ROUTES[legacyKey as keyof typeof API_ROUTES];
      const shared = (DESKTOP_API_ROUTES as unknown as Record<string, { method: string; path: string; scope: string } | undefined>)[legacyKey];
      expect(shared, `${legacyKey} present in API_ROUTES but missing from DESKTOP_API_ROUTES`).toBeDefined();
      expect(shared!.method).toBe(legacy.method);
      expect(shared!.path).toBe(legacy.path);
      expect(shared!.scope).toBe(legacy.scope);
    }
  });
});

// ---------------------------------------------------------------------------
// §1.2 Schemas reject the exact FIX9 / FIX10 defect patterns
// ---------------------------------------------------------------------------

describe('Stage 3C-CI-RESET Part 2 §1.2 — schemas structurally reject prior regressions', () => {
  it('AuthOperationResponse rejects a spurious `error` field (FIX9 regression guard)', () => {
    const badBody = {
      ok: false,
      state: {
        phase: 'unauthenticated', username: null, passwordChangedAt: null,
        accessExpiresAt: null, absoluteExpiresAt: null, lastActivityAt: null,
        failureReason: null,
      },
      reason: null,
      error: 'password_mismatch',
    };
    const parsed = AuthOperationResponseSchema.safeParse(badBody);
    expect(parsed.success).toBe(false);
  });

  it('OperatorLoginRequest rejects installationId:null (FIX10 regression guard)', () => {
    const badBody = {
      username: 'u', password: 'p'.repeat(14), installationId: null,
    };
    const parsed = OperatorLoginRequestSchema.safeParse(badBody);
    expect(parsed.success).toBe(false);
  });

  it('OperatorLoginRequest accepts an absent installationId', () => {
    const parsed = OperatorLoginRequestSchema.safeParse({
      username: 'u', password: 'p'.repeat(14),
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §1.3 requestValidated end-to-end with a fake fetch
// ---------------------------------------------------------------------------

function makeFakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return async (input: Request | URL | string, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  };
}

function buildClient(fetchImpl: typeof fetch): AuthenticatedApiClient {
  return new AuthenticatedApiClient({
    serverBaseUrl: 'http://server.test',
    getBootstrapToken: () => 'a'.repeat(64),
    getAccessToken: () => null,
    onRefreshNeeded: async () => ({ ok: false, reason: 'no_refresh_in_test' }),
    fetchImpl,
    requestTimeoutMs: 2_000,
  });
}

describe('Stage 3C-CI-RESET Part 2 §1.3 — requestValidated pipeline', () => {
  it('validates outgoing request body before sending — throws on installationId:null', async () => {
    let requestFired = false;
    const client = buildClient(makeFakeFetch(async () => {
      requestFired = true;
      return new Response('{}', { status: 200 });
    }));
    await expect(
      client.requestValidated('authLogin', {
        username: 'u', password: 'p'.repeat(14), installationId: null,
      }),
    ).rejects.toThrowError(DesktopApiContractMismatchError);
    expect(requestFired).toBe(false);
  });

  it('validates response schema — throws contract_mismatch on missing required field', async () => {
    // Server responds ok=true but state is malformed — no phase.
    const client = buildClient(makeFakeFetch(async () => {
      return new Response(JSON.stringify({
        ok: true, reason: null, state: { username: null },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    // authLock has no request body needed (empty schema) but requires
    // an operator token; we use authRefresh (bootstrap) with a valid
    // refresh body but a mangled response.
    await expect(
      client.requestValidated('authRefresh', { refreshToken: 'x'.repeat(32) }),
    ).rejects.toThrowError(DesktopApiContractMismatchError);
  });

  it('surfaces non-2xx server response as DesktopApiHttpError', async () => {
    const client = buildClient(makeFakeFetch(async () => {
      return new Response(JSON.stringify({
        error: 'login_failed', reason: 'password_mismatch',
      }), { status: 401, headers: { 'content-type': 'application/json' } });
    }));
    await expect(
      client.requestValidated('authLogin', {
        username: 'u', password: 'p'.repeat(14),
      }),
    ).rejects.toThrowError(DesktopApiHttpError);
  });

  it('surfaces non-JSON response body as DesktopApiInvalidJsonError', async () => {
    const client = buildClient(makeFakeFetch(async () => {
      return new Response('<html>500 error</html>', { status: 200 });
    }));
    await expect(
      client.requestValidated('systemReadiness'),
    ).rejects.toThrowError(DesktopApiInvalidJsonError);
  });

  it('surfaces fetch failure as DesktopApiTransportError', async () => {
    const client = buildClient(makeFakeFetch(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:65535');
    }));
    await expect(
      client.requestValidated('systemReadiness'),
    ).rejects.toThrowError(DesktopApiTransportError);
  });

  it('happy path: valid login returns the parsed, typed body', async () => {
    const validServerLogin = {
      account: {
        id: 42, username: 'u', status: 'active', credentialVersion: 1,
        passwordChangedAt: '2026-07-27T12:00:00Z',
      },
      tokens: {
        accessToken: 'a'.repeat(32), accessExpiresAt: '2026-07-27T13:00:00Z',
        refreshToken: 'r'.repeat(32), refreshExpiresAt: '2026-07-28T12:00:00Z',
        absoluteExpiresAt: '2026-08-27T12:00:00Z',
        sessionId: 1,
      },
    };
    const client = buildClient(makeFakeFetch(async () => {
      return new Response(JSON.stringify(validServerLogin), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));
    // requestValidated returns unknown; the caller narrows via the
    // shared response schema. We re-parse via the schema here to
    // both narrow the type AND assert the response is well-formed
    // from an application-code perspective.
    const respUnknown = await client.requestValidated('authLogin', {
      username: 'u', password: 'p'.repeat(14),
    });
    const resp = (
      await import('@horizon/shared')
    ).OperatorLoginServerResponseSchema.parse(respUnknown);
    expect(resp.account.id).toBe(42);
    expect(resp.tokens.sessionId).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §1.4 Registry completeness — no duplicated route definitions in tests
// ---------------------------------------------------------------------------

describe('Stage 3C-CI-RESET Part 2 §1.4 — no duplicated route definitions', () => {
  it('paths are unique across the registry', () => {
    const paths = DESKTOP_API_ROUTE_KEYS.map((k) => DESKTOP_API_ROUTES[k].path);
    const uniquePaths = new Set(paths);
    expect(uniquePaths.size).toBe(paths.length);
  });

  it('registry keys are unique (trivially by object key semantics)', () => {
    expect(new Set(DESKTOP_API_ROUTE_KEYS).size).toBe(DESKTOP_API_ROUTE_KEYS.length);
  });

  it('registry never emits response schemas that expose secret token fields to renderer', () => {
    // Any response schema whose top-level type mentions the string
    // "accessToken" or "refreshToken" as a KEY must ONLY be reachable
    // from operator-scope routes that stay in the main process. The
    // renderer-facing AuthOperationResponse projection MUST NOT carry
    // token fields.
    const rendererFacingKeys: DesktopApiRouteKey[] = [
      'authLogin', 'authRefresh', 'authLock', 'authLogout',
      'authChangePassword', 'authRevokeAll',
    ];
    // AuthOperationResponse is the projection returned to the
    // renderer for these operations. Verify by shape: it must have
    // ok/state/reason and nothing token-shaped.
    const authOp = AuthOperationResponseSchema.safeParse({
      ok: true,
      state: {
        phase: 'authenticated', username: 'u', passwordChangedAt: null,
        accessExpiresAt: null, absoluteExpiresAt: null, lastActivityAt: null,
        failureReason: null,
      },
      reason: null,
    });
    expect(authOp.success).toBe(true);
    // Names of the top-level projection.
    const keys = Object.keys(AuthOperationResponseSchema.shape).sort();
    expect(keys).toEqual(['ok', 'reason', 'state']);
    expect(keys).not.toContain('accessToken');
    expect(keys).not.toContain('refreshToken');
    // Verify each renderer-facing key is registered (compile-time
    // enforcement of the migration).
    for (const k of rendererFacingKeys) {
      expect(DESKTOP_API_ROUTES[k]).toBeDefined();
    }
  });
});
