/**
 * Phase 1.1 Gate 3D §J — lowest-level zero-order barrier.
 *
 * Instruments `globalThis.fetch` to:
 *   1. Count every outbound request by (method, path).
 *   2. Hard-refuse a POST to `/api/v3/brokerage/orders` regardless of caller.
 *
 * The barrier is stronger than the Gate 1 `createOrder` killswitch because
 * it lives at the transport layer — a bug in ANY caller (retry wrapper,
 * alias, alternate client) that tries to POST /orders is rejected here,
 * before a socket is opened.
 *
 * `installFetchBarrier()` is idempotent. `resetHttpCounters()` zeros the
 * request counters (used by the certification harness). The barrier
 * never throws in normal operation — it only rejects the one endpoint.
 */

export interface HttpCounters {
  totalRequestCount: number;
  createOrderAttemptCount: number;
  createOrderNetworkCount: number;
  byPath: Record<string, number>;
  byMethod: Record<string, number>;
}

const COUNTERS: HttpCounters = {
  totalRequestCount: 0,
  createOrderAttemptCount: 0,
  createOrderNetworkCount: 0,
  byPath: {},
  byMethod: {},
};

let INSTALLED = false;
let ORIGINAL_FETCH: typeof globalThis.fetch | null = null;

export class BlockedCreateOrderRequest extends Error {
  constructor(url: string) {
    super(`fetchBarrier: POST ${url} rejected — CreateOrder is disabled at the transport layer`);
    this.name = 'BlockedCreateOrderRequest';
  }
}

function urlOfInput(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  const req = input as { url?: string };
  return req.url ?? String(input);
}

function methodOfInit(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === 'object' && input !== null && 'method' in input) {
    const req = input as { method?: string };
    if (req.method) return req.method.toUpperCase();
  }
  return 'GET';
}

function pathOfUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

const CREATE_ORDER_PATH_RE = /\/api\/v3\/brokerage\/orders(?:\/?|\?.*)$/;

export function isCreateOrderRequest(method: string, path: string): boolean {
  return method === 'POST' && CREATE_ORDER_PATH_RE.test(path);
}

export function installFetchBarrier(): void {
  if (INSTALLED) return;
  ORIGINAL_FETCH = globalThis.fetch.bind(globalThis);
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    const url = urlOfInput(input);
    const method = methodOfInit(input, init);
    const path = pathOfUrl(url);
    COUNTERS.totalRequestCount++;
    COUNTERS.byMethod[method] = (COUNTERS.byMethod[method] ?? 0) + 1;
    COUNTERS.byPath[path] = (COUNTERS.byPath[path] ?? 0) + 1;
    if (isCreateOrderRequest(method, path)) {
      COUNTERS.createOrderAttemptCount++;
      throw new BlockedCreateOrderRequest(url);
    }
    return ORIGINAL_FETCH!(input, init);
  };
  globalThis.fetch = wrapped;
  INSTALLED = true;
}

export function uninstallFetchBarrier(): void {
  if (!INSTALLED || !ORIGINAL_FETCH) return;
  globalThis.fetch = ORIGINAL_FETCH;
  ORIGINAL_FETCH = null;
  INSTALLED = false;
}

export function httpCounters(): Readonly<HttpCounters> {
  return {
    totalRequestCount: COUNTERS.totalRequestCount,
    createOrderAttemptCount: COUNTERS.createOrderAttemptCount,
    createOrderNetworkCount: COUNTERS.createOrderNetworkCount,
    byPath: { ...COUNTERS.byPath },
    byMethod: { ...COUNTERS.byMethod },
  };
}

export function resetHttpCounters(): void {
  COUNTERS.totalRequestCount = 0;
  COUNTERS.createOrderAttemptCount = 0;
  COUNTERS.createOrderNetworkCount = 0;
  COUNTERS.byPath = {};
  COUNTERS.byMethod = {};
}

/**
 * The certification harness may separately count network-completed
 * CreateOrder requests (e.g. if a test somehow disabled the barrier).
 * The barrier itself increments only the ATTEMPT counter. Both must be
 * zero for `mechanically_ready_for_shadow`.
 */
export function recordCreateOrderNetworkCompletion(): void {
  COUNTERS.createOrderNetworkCount++;
}
