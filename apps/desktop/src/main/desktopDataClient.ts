/**
 * Stage 3 §4 — Electron main-process desktop data client.
 *
 * Owns the operator access + refresh credentials and calls the server's
 * canonical `desktop.*` tRPC namespace. Compile-time list of procedure
 * paths — the renderer never chooses a procedure name. Every response
 * is validated against the shared envelope schema before it leaves the
 * main process; a schema mismatch fails closed with `contract_mismatch`.
 */

import {
  DESKTOP_DATA_KEYS,
  DESKTOP_DATA_RESPONSE_SCHEMAS,
  DesktopDataRequestSchema,
  type DesktopDataRequest,
  type DesktopDataRequestKey,
  type DesktopDataResponse,
} from '@horizon/shared';

// The tRPC HTTP handler expects `desktop.overview.get` etc.
const PROCEDURE_PATHS: Record<DesktopDataRequestKey, { path: string; mutation: boolean }> = {
  'overview.get':          { path: 'desktop.overview.get',          mutation: false },
  'portfolio.get':         { path: 'desktop.portfolio.get',         mutation: false },
  'positions.list':        { path: 'desktop.positions.list',        mutation: false },
  'positions.get':         { path: 'desktop.positions.get',         mutation: false },
  'decisions.list':        { path: 'desktop.decisions.list',        mutation: false },
  'decisions.get':         { path: 'desktop.decisions.get',         mutation: false },
  'universe.list':         { path: 'desktop.universe.list',         mutation: false },
  'fingerprints.list':     { path: 'desktop.fingerprints.list',     mutation: false },
  'regimes.get':           { path: 'desktop.regimes.get',           mutation: false },
  'risk.get':              { path: 'desktop.risk.get',              mutation: false },
  'microstructure.get':    { path: 'desktop.microstructure.get',    mutation: false },
  'context.get':           { path: 'desktop.context.get',           mutation: false },
  'validation.get':        { path: 'desktop.validation.get',        mutation: false },
  'costs.get':             { path: 'desktop.costs.get',             mutation: false },
  'protection.get':        { path: 'desktop.protection.get',        mutation: false },
  'reconciliation.list':   { path: 'desktop.reconciliation.list',   mutation: false },
  'incidents.list':        { path: 'desktop.incidents.list',        mutation: false },
  'incidents.acknowledge': { path: 'desktop.incidents.acknowledge', mutation: true  },
  'reports.get':           { path: 'desktop.reports.get',           mutation: false },
  'reports.enqueue':       { path: 'desktop.reports.enqueue',       mutation: true  },
  'reports.status':        { path: 'desktop.reports.status',        mutation: false },
  'reports.list':          { path: 'desktop.reports.list',          mutation: false },
  'reports.verify':        { path: 'desktop.reports.verify',        mutation: false },
  'configuration.get':     { path: 'desktop.configuration.get',     mutation: false },
  'system.get':            { path: 'desktop.system.get',            mutation: false },
  'safety.get':            { path: 'desktop.safety.get',            mutation: false },
};

// Exhaustiveness — every declared key must have a compiled-in path.
for (const k of DESKTOP_DATA_KEYS) {
  if (!PROCEDURE_PATHS[k]) throw new Error(`desktopDataClient: missing PROCEDURE_PATHS entry for ${k}`);
}

export type RefreshOutcome = { ok: true; newAccessToken: string } | { ok: false; reason: string };

export interface DesktopDataClientInput {
  serverBaseUrl: string;
  getAccessToken: () => string | null;
  onRefreshNeeded: () => Promise<RefreshOutcome>;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export type DesktopDataClientError =
  | { kind: 'unauthenticated'; reason: string }
  | { kind: 'network'; detail: string }
  | { kind: 'server'; status: number; detail: string }
  | { kind: 'contract_mismatch'; detail: string }
  | { kind: 'timeout' };

export type DesktopDataClientResult<K extends DesktopDataRequestKey> =
  | { ok: true; envelope: DesktopDataResponse<K> }
  | { ok: false; error: DesktopDataClientError };

// Stage 3C-E.1.24 — reduced from 8s to 3s so the renderer
// transitions to `api_failure` within the observation window
// used by behavioural T42 (SIGSTOP → observe for 8s). Under a
// suspended server the socket never responds; the AbortController
// fires at DEFAULT_TIMEOUT_MS. With 8s and a 1s poll cadence,
// the state could still be pending when the test snapshots the
// DOM. 3s leaves headroom for poll + timeout + effect + render
// well inside 8s. Real network latency under DRY_RUN is well
// below 3s.
const DEFAULT_TIMEOUT_MS = 3_000;

export class DesktopDataClient {
  private readonly baseUrl: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly input: DesktopDataClientInput) {
    this.baseUrl = input.serverBaseUrl.replace(/\/$/, '');
    this.f = input.fetchImpl ?? fetch;
    this.timeoutMs = input.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Sole entry point. Validates the request against the discriminated
   * union, sends to the compiled-in tRPC path, then validates the
   * response envelope. No arbitrary paths, no renderer-controlled
   * procedure names.
   */
  async call<K extends DesktopDataRequestKey>(
    key: K,
    input?: unknown,
  ): Promise<DesktopDataClientResult<K>> {
    const parsedRequest = DesktopDataRequestSchema.safeParse(input === undefined ? { key } : { key, input });
    if (!parsedRequest.success) {
      return {
        ok: false,
        error: { kind: 'contract_mismatch', detail: `request_schema:${parsedRequest.error.issues[0]?.message ?? 'invalid'}` },
      };
    }
    const req = parsedRequest.data as DesktopDataRequest;
    const spec = PROCEDURE_PATHS[req.key as K];
    if (!spec) {
      return { ok: false, error: { kind: 'contract_mismatch', detail: `unknown_procedure_key:${req.key}` } };
    }
    return this.execute(req.key as K, spec, 'input' in req ? req.input : undefined, /* isRetry */ false);
  }

  private async execute<K extends DesktopDataRequestKey>(
    key: K,
    spec: (typeof PROCEDURE_PATHS)[DesktopDataRequestKey],
    input: unknown,
    isRetry: boolean,
  ): Promise<DesktopDataClientResult<K>> {
    const access = this.input.getAccessToken();
    if (!access) return { ok: false, error: { kind: 'unauthenticated', reason: 'no_access_token' } };

    const url = spec.mutation
      ? `${this.baseUrl}/trpc/${spec.path}`
      : `${this.baseUrl}/trpc/${spec.path}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.f(url, {
        method: spec.mutation ? 'POST' : 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${access}`,
          ...(spec.mutation ? { 'content-type': 'application/json' } : {}),
        },
        body: spec.mutation ? JSON.stringify(input ?? {}) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return isAbort
        ? { ok: false, error: { kind: 'timeout' } }
        : { ok: false, error: { kind: 'network', detail: String(err).slice(0, 200) } };
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) {
      if (!isRetry) {
        const refresh = await this.input.onRefreshNeeded();
        if (refresh.ok) return this.execute(key, spec, input, /* isRetry */ true);
        return { ok: false, error: { kind: 'unauthenticated', reason: refresh.reason } };
      }
      return { ok: false, error: { kind: 'unauthenticated', reason: 'unauthenticated_after_refresh' } };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      return { ok: false, error: { kind: 'server', status: res.status, detail: `body_parse:${String(err).slice(0, 200)}` } };
    }

    // tRPC responses wrap the payload in `{ result: { data: X } }` (or
    // `{ result: { data: { json: X } } }` when using superjson). The
    // server doesn't configure superjson so we expect the plain form.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyJson = json as any;
    if (anyJson?.error) {
      const message = String(anyJson.error?.message ?? anyJson.error?.data?.code ?? 'trpc_error');
      const httpStatus = Number(anyJson.error?.data?.httpStatus ?? res.status);
      if (httpStatus === 401 || message === 'UNAUTHORIZED' || anyJson.error?.data?.code === 'UNAUTHORIZED') {
        if (!isRetry) {
          const refresh = await this.input.onRefreshNeeded();
          if (refresh.ok) return this.execute(key, spec, input, /* isRetry */ true);
          return { ok: false, error: { kind: 'unauthenticated', reason: refresh.reason } };
        }
        return { ok: false, error: { kind: 'unauthenticated', reason: 'unauthenticated_after_refresh' } };
      }
      return { ok: false, error: { kind: 'server', status: httpStatus, detail: sanitize(message) } };
    }

    const data = anyJson?.result?.data;
    if (data === undefined) {
      return { ok: false, error: { kind: 'contract_mismatch', detail: 'missing_result_data' } };
    }

    const schema = DESKTOP_DATA_RESPONSE_SCHEMAS[key];
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      return {
        ok: false,
        error: { kind: 'contract_mismatch', detail: `response_schema:${parsed.error.issues[0]?.message ?? 'invalid'}` },
      };
    }
    return { ok: true, envelope: parsed.data as DesktopDataResponse<K> };
  }
}

/** Redact common secrets that might leak into a server error message. */
function sanitize(message: string): string {
  const truncated = message.slice(0, 200);
  return truncated
    .replace(/Bearer [A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/token[=: ]\s*[A-Za-z0-9._-]{10,}/gi, 'token=[redacted]')
    .replace(/password[=: ]\s*\S+/gi, 'password=[redacted]');
}

/**
 * Convenience — the compiled-in procedure map, exported for tests to
 * assert that every enumerated key has a path.
 */
export function knownProcedurePaths(): Record<DesktopDataRequestKey, string> {
  const out = {} as Record<DesktopDataRequestKey, string>;
  for (const k of DESKTOP_DATA_KEYS) out[k] = PROCEDURE_PATHS[k].path;
  return out;
}

export function isKnownDesktopDataKey(key: string): key is DesktopDataRequestKey {
  return (DESKTOP_DATA_KEYS as readonly string[]).includes(key);
}

/**
 * Central sanitize helper — used by the IPC handler to sanitize a
 * business error before sending to the renderer.
 */
export function sanitizeError(e: DesktopDataClientError): { code: string; detail: string | null } {
  switch (e.kind) {
    case 'unauthenticated': return { code: 'unauthenticated', detail: e.reason };
    case 'network':         return { code: 'network_error', detail: null };
    case 'server':          return { code: `server_${e.status}`, detail: sanitize(e.detail).slice(0, 200) };
    case 'contract_mismatch': return { code: 'contract_mismatch', detail: e.detail.slice(0, 200) };
    case 'timeout':         return { code: 'timeout', detail: null };
  }
}
