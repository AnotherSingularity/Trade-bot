/**
 * Stage 3C-CI-RESET Part 2 §1 — Shared, schema-aware desktop API route registry.
 *
 * Every HTTP call the desktop main process makes to the server is
 * enumerated here with:
 *   - method + path + auth scope
 *   - request schema (Zod) — undefined for GET-only routes with no body
 *   - response schema (Zod) — validated after JSON parse
 *
 * Rules the AuthenticatedApiClient must honour (see runtime enforcement
 * in apps/desktop/src/main/authenticatedApiClient.ts):
 *   1. Callers pass a route key, never an arbitrary path.
 *   2. If the route has a `request` schema, the outgoing body is
 *      validated before serialization.
 *   3. If the route has a `response` schema, the parsed JSON is
 *      validated before returning to the caller.
 *   4. A schema mismatch on either side is a typed
 *      `contract_mismatch` error, never a silent `parsed as T`.
 *
 * The audit (§P1.1) established that this registry replaces the
 * pre-RESET pattern where `AuthenticatedApiClient.request<T>` cast
 * arbitrary JSON to `T` without validation. That pattern produced
 * both the FIX9 (`error` vs `reason`) and FIX10 (`installationId: null`)
 * regressions.
 */
import { z } from 'zod';
import {
  AuthOperationResponseSchema,
  OperatorAuthStateServerResponseSchema,
  OperatorChangePasswordRequestSchema,
  OperatorEmptyRequestSchema,
  OperatorLoginRequestSchema,
  OperatorLoginServerResponseSchema,
  OperatorRefreshRequestSchema,
  OperatorRefreshServerResponseSchema,
  OperatorSetupRequestSchema,
  OperatorSetupServerResponseSchema,
} from './operatorAuth';

export type DesktopApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type DesktopApiScope = 'bootstrap' | 'operator';

/**
 * A single registered route. Both schemas are optional at the type
 * level because a handful of legacy routes still lack one; callers
 * of AuthenticatedApiClient can query `hasResponseSchema(key)` to
 * decide whether to validate. Runtime tests below enforce that the
 * enumerated auth+status routes DO carry both.
 */
export interface DesktopApiRouteDefinition {
  readonly method: DesktopApiMethod;
  readonly path: string;
  readonly scope: DesktopApiScope;
  readonly request?: z.ZodTypeAny;
  readonly response?: z.ZodTypeAny;
}

// ---------------------------------------------------------------------------
// Response schemas for routes NOT already declared in operatorAuth.ts.
// ---------------------------------------------------------------------------

/**
 * Bootstrap-scope: server readiness gate. Every field is optional
 * because the server surfaces different levels of detail as
 * subsystems come online.
 */
export const SystemReadinessResponseSchema = z.object({
  ready: z.boolean(),
  services: z.record(z.string(), z.string()).optional(),
  schemaVersion: z.string().optional(),
  message: z.string().optional(),
}).passthrough();

/**
 * Bootstrap-scope: authoritative CreateOrder counters. The renderer
 * safety gauge relies on these values being zero.
 */
export const CreateOrderCountersServerResponseSchema = z.object({
  functionInvocations: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative(),
  networkCount: z.number().int().nonnegative(),
}).strict();

/**
 * Bootstrap-scope: scanner readiness.
 */
export const ScannerReadinessServerResponseSchema = z.object({
  state: z.enum(['ready', 'blocked', 'unknown']),
  blockingReasons: z.array(z.string()),
}).strict();

/**
 * Bootstrap-scope: reconciliation status envelope. Kept permissive
 * (passthrough) because the reconciliation payload spans many
 * observer results; the schema-aware validator asserts SHAPE, not
 * every subfield.
 */
export const ReconciliationStatusServerResponseSchema = z.object({
  lastRunAt: z.string().nullable(),
  status: z.string(),
}).passthrough();

/**
 * Operator-scope: observer policy versions. Map of observer name →
 * currently-active policy version string.
 */
export const ObserverPolicyVersionsServerResponseSchema = z.record(z.string(), z.string());

/**
 * Operator-scope: champion configuration snapshot.
 */
export const ChampionConfigurationServerResponseSchema = z.object({
  version: z.string(),
}).passthrough();

/**
 * Operator-scope: sanitized current session summary. Never carries
 * a raw token — the server projects it before responding.
 */
export const OperatorSessionServerResponseSchema = z.object({
  sessionId: z.number().int().positive(),
  accountId: z.number().int().positive(),
  issuedAt: z.string(),
  accessExpiresAt: z.string(),
  absoluteExpiresAt: z.string(),
}).strict();

// ---------------------------------------------------------------------------
// The registry. Every entry is `as const` so a route key mismatch
// with a caller becomes a compile-time error.
// ---------------------------------------------------------------------------

export const DESKTOP_API_ROUTES = {
  // -------------------------------------------------------------
  // System + counters (bootstrap-scope; renderer-safe payloads)
  // -------------------------------------------------------------
  systemReadiness: {
    method: 'GET',
    path: '/api/system/readiness',
    scope: 'bootstrap',
    response: SystemReadinessResponseSchema,
  },
  createOrderCounters: {
    method: 'GET',
    path: '/api/desktop/create-order-counters',
    scope: 'bootstrap',
    response: CreateOrderCountersServerResponseSchema,
  },
  scannerReadiness: {
    method: 'GET',
    path: '/api/desktop/scanner-readiness',
    scope: 'bootstrap',
    response: ScannerReadinessServerResponseSchema,
  },
  reconciliationStatus: {
    method: 'GET',
    path: '/api/desktop/reconciliation/status',
    scope: 'bootstrap',
    response: ReconciliationStatusServerResponseSchema,
  },

  // -------------------------------------------------------------
  // Operator auth surface
  // -------------------------------------------------------------
  authState: {
    method: 'GET',
    path: '/api/operator-auth/state',
    scope: 'bootstrap',
    response: OperatorAuthStateServerResponseSchema,
  },
  authSetup: {
    method: 'POST',
    path: '/api/operator-auth/setup',
    scope: 'bootstrap',
    request: OperatorSetupRequestSchema,
    response: OperatorSetupServerResponseSchema,
  },
  authLogin: {
    method: 'POST',
    path: '/api/operator-auth/login',
    scope: 'bootstrap',
    request: OperatorLoginRequestSchema,
    response: OperatorLoginServerResponseSchema,
  },
  authRefresh: {
    method: 'POST',
    path: '/api/operator-auth/refresh',
    scope: 'bootstrap',
    request: OperatorRefreshRequestSchema,
    response: OperatorRefreshServerResponseSchema,
  },
  authLogout: {
    method: 'POST',
    path: '/api/operator-auth/logout',
    scope: 'operator',
    request: OperatorEmptyRequestSchema,
    response: AuthOperationResponseSchema,
  },
  authLock: {
    method: 'POST',
    path: '/api/operator-auth/lock',
    scope: 'operator',
    request: OperatorEmptyRequestSchema,
    response: AuthOperationResponseSchema,
  },
  authChangePassword: {
    method: 'POST',
    path: '/api/operator-auth/change-password',
    scope: 'operator',
    request: OperatorChangePasswordRequestSchema,
    response: AuthOperationResponseSchema,
  },
  authRevokeAll: {
    method: 'POST',
    path: '/api/operator-auth/revoke-all',
    scope: 'operator',
    request: OperatorEmptyRequestSchema,
    response: AuthOperationResponseSchema,
  },
  authSession: {
    method: 'GET',
    path: '/api/operator-auth/session',
    scope: 'operator',
    response: OperatorSessionServerResponseSchema,
  },

  // -------------------------------------------------------------
  // Operator-scope desktop configuration reads
  // -------------------------------------------------------------
  observerPolicyVersions: {
    method: 'GET',
    path: '/api/desktop/observer-policy-versions',
    scope: 'operator',
    response: ObserverPolicyVersionsServerResponseSchema,
  },
  championConfiguration: {
    method: 'GET',
    path: '/api/desktop/champion-configuration',
    scope: 'operator',
    response: ChampionConfigurationServerResponseSchema,
  },
} as const satisfies Record<string, DesktopApiRouteDefinition>;

export type DesktopApiRouteKey = keyof typeof DESKTOP_API_ROUTES;

/** All registered route keys, as a runtime-readable array. */
export const DESKTOP_API_ROUTE_KEYS: readonly DesktopApiRouteKey[] =
  Object.keys(DESKTOP_API_ROUTES) as DesktopApiRouteKey[];

/**
 * Typed contract-mismatch error thrown by the AuthenticatedApiClient
 * when a route's response fails Zod validation. The `route` and
 * `issuePath` fields are safe to persist to evidence; the raw body
 * is NOT included because the server may return sensitive detail
 * on some paths.
 */
export class DesktopApiContractMismatchError extends Error {
  constructor(
    public readonly kind: 'request' | 'response',
    public readonly route: DesktopApiRouteKey,
    public readonly issuePath: string,
    public readonly issueMessage: string,
  ) {
    super(`desktop_api_${kind}_contract_mismatch:${route}:${issuePath}:${issueMessage}`);
    this.name = 'DesktopApiContractMismatchError';
  }
}

/**
 * Additional typed errors surfaced by the schema-aware client. Every
 * error carries the route key + status so evidence collection can
 * classify without stringifying the raw body.
 */
export class DesktopApiHttpError extends Error {
  constructor(
    public readonly route: DesktopApiRouteKey,
    public readonly status: number,
    public readonly reason: string,
  ) {
    super(`desktop_api_http_error:${route}:${status}:${reason}`);
    this.name = 'DesktopApiHttpError';
  }
}

export class DesktopApiInvalidJsonError extends Error {
  constructor(
    public readonly route: DesktopApiRouteKey,
    public readonly detail: string,
  ) {
    super(`desktop_api_invalid_json:${route}:${detail}`);
    this.name = 'DesktopApiInvalidJsonError';
  }
}

export class DesktopApiTransportError extends Error {
  constructor(
    public readonly route: DesktopApiRouteKey,
    public readonly detail: string,
  ) {
    super(`desktop_api_transport_error:${route}:${detail}`);
    this.name = 'DesktopApiTransportError';
  }
}
