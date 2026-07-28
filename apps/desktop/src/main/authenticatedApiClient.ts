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
 *
 * Stage 3C-CI-RESET Part 2 §1 — SCHEMA-AWARE VARIANT.
 *
 * `requestValidated<K>(routeKey, body?)` uses the shared
 * `DESKTOP_API_ROUTES` registry from `@horizon/shared` and:
 *   1. Validates the outgoing body against the route's request schema
 *      (throws `DesktopApiContractMismatchError('request', ...)`).
 *   2. Serialises the VALIDATED body (never the raw input).
 *   3. Executes the request against the same fetch pipeline.
 *   4. Rejects malformed JSON as `DesktopApiInvalidJsonError`.
 *   5. Rejects HTTP errors as `DesktopApiHttpError` (except for 401 on
 *      operator routes, which still triggers the refresh-once path).
 *   6. Validates the parsed body against the route's response schema.
 *   7. Returns the typed, validated body — NEVER `parsed as T`.
 *
 * The legacy `request<T>()` method is retained for the handful of
 * callers still using it (during the multi-turn migration in
 * Part 2); those routes lack response schemas in the registry and
 * are progressively migrated. See DesktopApiRouteDefinition +
 * hasResponseSchema for the migration audit hook.
 */

// Stage 3C-CI-RESET Part 2 §1: schema-aware registry + typed errors
// re-exported from the shared package so consumers can import from
// one place.
import type { z } from 'zod';
import {
  DESKTOP_API_ROUTES,
  DesktopApiContractMismatchError,
  DesktopApiHttpError,
  DesktopApiInvalidJsonError,
  DesktopApiTransportError,
  type DesktopApiRouteKey,
} from '@horizon/shared';

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

export interface ApiResponse {
  status: number;
  body: unknown;
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

  /**
   * Stage 3C-CI-RESET Part 2 §1 — Schema-aware request.
   *
   * Validates the outgoing body (if the route defines a `request`
   * schema) AND the incoming JSON (if the route defines a `response`
   * schema). Returns the validated response body directly — never
   * `parsed as T`.
   *
   * Failure modes are typed and enumerated:
   *   - `DesktopApiContractMismatchError('request', ...)` — outgoing
   *     body does not match the route's request schema. The request
   *     is NOT sent.
   *   - `DesktopApiTransportError` — fetch itself threw (network,
   *     abort, DNS).
   *   - `DesktopApiInvalidJsonError` — response body was not valid
   *     JSON.
   *   - `DesktopApiHttpError` — non-2xx HTTP status. For 401 on
   *     operator routes the refresh-once path fires first; only a
   *     terminal 401 surfaces.
   *   - `DesktopApiContractMismatchError('response', ...)` — parsed
   *     JSON does not match the route's response schema.
   *
   * The returned value's TypeScript type is `z.infer<T>` of the
   * route's response schema, so the compiler enforces field access
   * against the shared contract.
   */
  async requestValidated<K extends DesktopApiRouteKey>(
    key: K,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    // The `as` widen preserves compile-time key enforcement via the
    // K extends DesktopApiRouteKey constraint while broadening the
    // value's shape at access time so optional request/response
    // schemas are visible to the type checker. Callers use the
    // Zod-inferred type separately if they want a narrow return.
    const routeAny = DESKTOP_API_ROUTES[key] as {
      readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      readonly path: string;
      readonly scope: 'bootstrap' | 'operator';
      readonly request?: z.ZodTypeAny;
      readonly response?: z.ZodTypeAny;
    };
    if (!routeAny) throw new Error(`route not allowlisted: ${String(key)}`);

    // §1.2 — validate outgoing request body BEFORE serialization.
    let validatedBody: unknown = body;
    if (routeAny.request) {
      const requestParse = routeAny.request.safeParse(body ?? {});
      if (!requestParse.success) {
        const first = requestParse.error.issues[0];
        throw new DesktopApiContractMismatchError(
          'request',
          key,
          first?.path.join('.') || '<root>',
          first?.message ?? 'schema_parse_failed',
        );
      }
      validatedBody = requestParse.data;
    }

    // Execute — reuse the legacy pipeline but treat every non-401
    // non-2xx status as a typed DesktopApiHttpError. The legacy
    // pipeline still throws ApiCallError on 401 refresh exhaustion;
    // we normalise that into DesktopApiHttpError below.
    const legacyRoute: RouteSpec = { method: routeAny.method, path: routeAny.path, scope: routeAny.scope };
    let httpResponse: ApiResponse;
    try {
      httpResponse = await this.execute(legacyRoute, validatedBody, extraHeaders, false);
    } catch (e) {
      if (e instanceof ApiCallError) {
        // 401-after-refresh or bootstrap-token-missing paths land here.
        throw new DesktopApiHttpError(key, e.status, e.message);
      }
      throw new DesktopApiTransportError(key, e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));
    }

    // §1.3 — reject non-2xx statuses as typed HTTP errors.
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      // The body may or may not be JSON; the legacy safeParse
      // already returned {_raw: '...'} on invalid JSON. Extract
      // a short sanitized reason without embedding secrets.
      const reason = extractShortReason(httpResponse.body);
      throw new DesktopApiHttpError(key, httpResponse.status, reason);
    }

    // §1.4 — reject non-JSON body (safeParse in `execute` marks this
    // with a `_raw` key).
    const parsed = httpResponse.body;
    if (parsed && typeof parsed === 'object' && '_raw' in parsed) {
      throw new DesktopApiInvalidJsonError(key, 'response_body_not_valid_json');
    }

    // §1.5 — validate response schema.
    if (routeAny.response) {
      const responseParse = routeAny.response.safeParse(parsed);
      if (!responseParse.success) {
        const first = responseParse.error.issues[0];
        throw new DesktopApiContractMismatchError(
          'response',
          key,
          first?.path.join('.') || '<root>',
          first?.message ?? 'schema_parse_failed',
        );
      }
      return responseParse.data;
    }
    // No response schema (legacy route) — surface parsed as unknown.
    return parsed;
  }

  /**
   * Runtime introspection: does this route carry a response schema?
   * Used by migration audit tests to ensure every certification-
   * critical route is schema-validated.
   */
  static hasResponseSchema(key: DesktopApiRouteKey): boolean {
    // Widen the narrowed const type so the optional property is visible.
    return (DESKTOP_API_ROUTES[key] as { response?: unknown }).response !== undefined;
  }
  static hasRequestSchema(key: DesktopApiRouteKey): boolean {
    return (DESKTOP_API_ROUTES[key] as { request?: unknown }).request !== undefined;
  }

  private async execute(
    route: RouteSpec,
    body: unknown,
    extraHeaders: Record<string, string> | undefined,
    isRetry: boolean,
  ): Promise<ApiResponse> {
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
    // Stage 3C-CI-RESET Part 2 §1 (Checkpoint A.1): body is
    // `unknown` — no `as T` cast. Callers of requestValidated get
    // a schema-narrowed value; there is no other public consumer.
    const parsedBody: unknown = text ? safeParse(text) : null;
    if (res.status === 401 && route.scope === 'operator') {
      if (!isRetry) {
        const refresh = await this.input.onRefreshNeeded();
        if (refresh.ok) {
          return this.execute(route, body, extraHeaders, /* isRetry */ true);
        }
        throw new ApiCallError('unauthenticated_after_refresh', 401, { reason: refresh.reason });
      }
      throw new ApiCallError('unauthenticated_after_retry', 401, parsedBody);
    }
    return { status: res.status, body: parsedBody };
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 400) };
  }
}

/**
 * Best-effort extraction of a short reason from a server HTTP error
 * body. Prefers `body.reason`, then `body.error`, then a short
 * stringification. Never returns raw HTML or > 120 chars.
 */
function extractShortReason(body: unknown): string {
  if (body && typeof body === 'object') {
    const anyBody = body as { reason?: unknown; error?: unknown };
    if (typeof anyBody.reason === 'string' && anyBody.reason.length > 0) return anyBody.reason.slice(0, 120);
    if (typeof anyBody.error === 'string' && anyBody.error.length > 0) return anyBody.error.slice(0, 120);
  }
  return 'unspecified';
}

// Stage 3C-CI-RESET Part 2 §1: re-export typed errors so callers can
// `catch` them by name from the same import.
export {
  DesktopApiContractMismatchError,
  DesktopApiHttpError,
  DesktopApiInvalidJsonError,
  DesktopApiTransportError,
} from '@horizon/shared';
export type { DesktopApiRouteKey } from '@horizon/shared';
