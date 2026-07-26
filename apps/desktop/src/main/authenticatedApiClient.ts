/**
 * Stage 2 §10 — Authenticated server API client (main process).
 *
 * Two-tier authorization:
 *   - Bootstrap-scoped routes (readiness, counters, scanner-readiness,
 *     reconciliation, auth/state) carry `X-Horizon-Bootstrap-Token`.
 *   - Operator-scoped routes carry `Authorization: Bearer <access>`.
 *
 * A single AuthenticatedApiClient instance:
 *   - Enforces a compiled-in route allowlist. Attempts to call a route
 *     outside the allowlist throw synchronously — no silent 404s.
 *   - Retries once (and only once) after a `401 access_expired` on an
 *     operator-scoped call, first invoking a caller-supplied refresh
 *     callback, then re-issuing the request with the new access token.
 *     No further retries.
 *
 * Callers never see the tokens. The client accepts token providers
 * (functions returning the current values) so rotation can happen
 * atomically without leaking references.
 */

export type ApiScope = 'bootstrap' | 'operator';

export interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  scope: ApiScope;
}

// Compiled-in allowlist. Every server URL the desktop main process
// is permitted to construct is enumerated here. New routes must be
// added explicitly — arbitrary URL construction is not possible.
export const API_ROUTES = {
  systemReadiness:        { method: 'GET',  path: '/api/system/readiness',                 scope: 'bootstrap' },
  createOrderCounters:    { method: 'GET',  path: '/api/desktop/create-order-counters',    scope: 'bootstrap' },
  scannerReadiness:       { method: 'GET',  path: '/api/desktop/scanner-readiness',        scope: 'bootstrap' },
  reconciliationStatus:   { method: 'GET',  path: '/api/desktop/reconciliation/status',    scope: 'bootstrap' },
  authState:              { method: 'GET',  path: '/api/operator-auth/state',              scope: 'bootstrap' },
  observerPolicyVersions: { method: 'GET',  path: '/api/desktop/observer-policy-versions', scope: 'operator'  },
  championConfiguration:  { method: 'GET',  path: '/api/desktop/champion-configuration',   scope: 'operator'  },
  authSetup:              { method: 'POST', path: '/api/operator-auth/setup',              scope: 'bootstrap' },
  authLogin:              { method: 'POST', path: '/api/operator-auth/login',              scope: 'bootstrap' },
  authRefresh:            { method: 'POST', path: '/api/operator-auth/refresh',            scope: 'bootstrap' },
  authLogout:             { method: 'POST', path: '/api/operator-auth/logout',             scope: 'operator'  },
  authLock:               { method: 'POST', path: '/api/operator-auth/lock',               scope: 'operator'  },
  authChangePassword:     { method: 'POST', path: '/api/operator-auth/change-password',    scope: 'operator'  },
  authRevokeAll:          { method: 'POST', path: '/api/operator-auth/revoke-all',         scope: 'operator'  },
  authSession:            { method: 'GET',  path: '/api/operator-auth/session',            scope: 'operator'  },
} as const satisfies Record<string, RouteSpec>;

export type ApiRouteKey = keyof typeof API_ROUTES;

export interface AuthenticatedApiClientInput {
  serverBaseUrl: string;
  getBootstrapToken: () => string | null;
  getAccessToken: () => string | null;
  onRefreshNeeded: () => Promise<{ ok: true; newAccessToken: string } | { ok: false; reason: string }>;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export class ApiCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export class AuthenticatedApiClient {
  private readonly baseUrl: string;
  private readonly f: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly input: AuthenticatedApiClientInput) {
    this.baseUrl = input.serverBaseUrl.replace(/\/$/, '');
    this.f = input.fetchImpl ?? fetch;
    this.requestTimeoutMs = input.requestTimeoutMs ?? 8_000;
  }

  async request<T = unknown>(
    key: ApiRouteKey,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<ApiResponse<T>> {
    const route = API_ROUTES[key];
    if (!route) throw new Error(`route not allowlisted: ${key}`);
    return this.execute<T>(route, body, extraHeaders, /* isRetry */ false);
  }

  private async execute<T>(
    route: RouteSpec,
    body: unknown,
    extraHeaders: Record<string, string> | undefined,
    isRetry: boolean,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(extraHeaders ?? {}),
    };
    if (route.scope === 'bootstrap') {
      const t = this.input.getBootstrapToken();
      if (!t) throw new Error(`bootstrap token unavailable for ${route.path}`);
      headers['x-horizon-bootstrap-token'] = t;
    } else {
      const t = this.input.getAccessToken();
      if (!t) throw new ApiCallError('unauthenticated', 401, { reason: 'no_access_token' });
      headers['authorization'] = `Bearer ${t}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let res: Response;
    try {
      res = await this.f(`${this.baseUrl}${route.path}`, {
        method: route.method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    const parsed = text ? safeParse(text) : null;
    if (res.status === 401 && route.scope === 'operator') {
      if (!isRetry) {
        const refresh = await this.input.onRefreshNeeded();
        if (refresh.ok) {
          return this.execute<T>(route, body, extraHeaders, /* isRetry */ true);
        }
        throw new ApiCallError('unauthenticated_after_refresh', 401, { reason: refresh.reason });
      }
      throw new ApiCallError('unauthenticated_after_retry', 401, parsed);
    }
    return { status: res.status, body: parsed as T };
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 400) };
  }
}
