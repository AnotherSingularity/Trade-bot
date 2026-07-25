import { CoinbaseError } from './coinbase';
import type { CoinbaseFill, CoinbaseOrder } from './coinbase';

/**
 * Exhaustive Coinbase cursor pagination (Phase 1.1.b §B).
 *
 * Coinbase Advanced Trade uses `cursor` pagination on `list_orders` and
 * `list_fills`: each response carries a `cursor` string that is empty when
 * there are no more pages, plus a `has_next` boolean. Any of the following
 * are cause for treating the search result as INCOMPLETE, NOT ABSENT:
 *
 *   • The paginator hits the max-page safety limit before Coinbase says done.
 *   • The wall-clock timeout fires between pages.
 *   • The same cursor value repeats (cursor loop — a malformed API response).
 *   • The next-cursor field is missing when has_next=true.
 *   • Any request throws a CoinbaseError classed as retryable_transport or
 *     unknown.
 *
 * The only positive result that authorizes "not found on exchange" is
 * `complete_not_found`. A `complete_found` result is authoritative "here it
 * is." Every `incomplete_*` result MUST be surfaced as an unresolved
 * reconciliation outcome, not converted into assumed rejection.
 *
 * This module wraps the raw fetch layer that lives in coinbase.ts. It does
 * NOT touch `createOrder` — pagination is a read concern.
 */

export type PaginationResultKind =
  | 'complete_found'
  | 'complete_not_found'
  | 'incomplete_timeout'
  | 'incomplete_cursor_loop'
  | 'incomplete_api_error'
  | 'incomplete_malformed_response'
  | 'incomplete_max_pages';

/** Common pagination result envelope. */
export interface PaginationResult<T> {
  kind: PaginationResultKind;
  items: T[];
  pagesFetched: number;
  cursorHistory: string[]; // for diagnostics — never has secrets
  incompleteDetail?: string;
}

/** Fetcher signature that pagination() calls once per page. */
export type PageFetcher<T> = (
  cursor: string | null,
  signal: AbortSignal,
) => Promise<{
  items: T[];
  nextCursor: string | null;
  hasNext: boolean;
}>;

export interface PaginateOptions {
  /**
   * Wall-clock deadline in ms for the WHOLE pagination sequence — not
   * per-page. Once exceeded, the paginator returns `incomplete_timeout`
   * with everything fetched so far.
   */
  totalTimeoutMs?: number;
  /**
   * Safety limit — if we hit this without Coinbase saying done, return
   * `incomplete_max_pages`. Prevents runaway loops on malformed responses.
   * The Coinbase Advanced Trade default page size is 100; a real
   * exhaustive fetch for a single order's fills should NEVER need 200
   * pages. Callers may raise the ceiling for `list_orders` sweeps.
   */
  maxPages?: number;
  /**
   * Deduplication key extractor. Duplicate items across pages are elided
   * on this key (e.g. `order_id` for orders, `trade_id` for fills).
   */
  dedupeKey: (item: unknown) => string;
}

const DEFAULT_TOTAL_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PAGES = 200;

/**
 * Exhaustively paginates via `fetcher`. Returns a PaginationResult whose
 * `kind` encodes exactly how the sequence terminated. `items` is deduped
 * by the caller-supplied key.
 *
 * Deduplication rule: the FIRST occurrence of a given key wins. A later
 * page that returns the same record does not overwrite; this is safe
 * because Coinbase's list endpoints return immutable snapshots.
 */
export async function paginate<T>(
  fetcher: PageFetcher<T>,
  opts: PaginateOptions,
): Promise<PaginationResult<T>> {
  const totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const controller = new AbortController();
  const deadline = Date.now() + totalTimeoutMs;
  const timer = setTimeout(() => controller.abort(), totalTimeoutMs);

  const seen = new Set<string>();
  const items: T[] = [];
  const cursorHistory: string[] = [];
  let cursor: string | null = null;
  let pagesFetched = 0;

  try {
    while (true) {
      if (Date.now() >= deadline) {
        return {
          kind: 'incomplete_timeout',
          items,
          pagesFetched,
          cursorHistory,
          incompleteDetail: `total timeout ${totalTimeoutMs}ms exceeded after ${pagesFetched} pages`,
        };
      }
      if (pagesFetched >= maxPages) {
        return {
          kind: 'incomplete_max_pages',
          items,
          pagesFetched,
          cursorHistory,
          incompleteDetail: `max ${maxPages} pages fetched without exhausting cursor`,
        };
      }

      let page: {
        items: T[];
        nextCursor: string | null;
        hasNext: boolean;
      };
      try {
        page = await fetcher(cursor, controller.signal);
      } catch (err) {
        // Aborted → timeout; classify by CoinbaseError.class otherwise.
        if (err instanceof CoinbaseError) {
          if (err.class === 'retryable_transport' || err.class === 'unknown') {
            return {
              kind: 'incomplete_api_error',
              items,
              pagesFetched,
              cursorHistory,
              incompleteDetail: `${err.code}: ${err.message}`,
            };
          }
          // non_retryable_validation, definitely_rejected, etc. — the CALL
          // failed permanently, but the search is still not authoritative
          // absence. Surface as incomplete_api_error and let the caller
          // decide (e.g. 404 on the order id might mean "gone", but for
          // reconciliation we prefer to keep the intent unknown rather
          // than silently mark not-submitted).
          return {
            kind: 'incomplete_api_error',
            items,
            pagesFetched,
            cursorHistory,
            incompleteDetail: `${err.code}: ${err.message}`,
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          kind: 'incomplete_api_error',
          items,
          pagesFetched,
          cursorHistory,
          incompleteDetail: msg,
        };
      }
      pagesFetched++;

      for (const it of page.items ?? []) {
        const k = opts.dedupeKey(it as unknown);
        if (!seen.has(k)) {
          seen.add(k);
          items.push(it);
        }
      }

      // Coinbase semantics:
      //   hasNext=false → done, regardless of cursor value.
      //   hasNext=true + nextCursor='' → malformed response.
      //   hasNext=true + repeated cursor → cursor loop.
      if (!page.hasNext) {
        // Terminal — cursor exhausted cleanly.
        return {
          kind: 'complete_found', // items may be empty; caller distinguishes
          items,
          pagesFetched,
          cursorHistory,
        };
      }
      const next = page.nextCursor;
      if (next === null || next === '') {
        return {
          kind: 'incomplete_malformed_response',
          items,
          pagesFetched,
          cursorHistory,
          incompleteDetail: 'has_next=true but next cursor is missing/empty',
        };
      }
      if (cursorHistory.includes(next)) {
        return {
          kind: 'incomplete_cursor_loop',
          items,
          pagesFetched,
          cursorHistory,
          incompleteDetail: `cursor ${next.slice(0, 24)}… repeated`,
        };
      }
      cursorHistory.push(next);
      cursor = next;
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convenience wrapper: turn a `paginate` result into a "found | not-found |
 * incomplete" verdict for a single-target search (e.g. "find this specific
 * order by clientOrderId"). Only converts `complete_found` with a match to
 * `complete_found`; empty match set becomes `complete_not_found`. Every
 * `incomplete_*` bubbles up unchanged — NEVER converted to
 * `complete_not_found`.
 */
export function classifySingleTargetSearch<T>(
  result: PaginationResult<T>,
  predicate: (item: T) => boolean,
): {
  kind: PaginationResultKind;
  match: T | null;
  raw: PaginationResult<T>;
} {
  if (result.kind === 'complete_found') {
    const match = result.items.find(predicate) ?? null;
    return {
      kind: match ? 'complete_found' : 'complete_not_found',
      match,
      raw: result,
    };
  }
  return { kind: result.kind, match: null, raw: result };
}

// ---------------------------------------------------------------------------
// Concrete paginators for Coinbase order/fill APIs.
// ---------------------------------------------------------------------------

/**
 * Adapter type — a paginator needs a way to reach the Coinbase raw request
 * layer. Passed by callers so this module doesn't have to import request()
 * directly (avoids a circular import and lets tests inject a fake).
 */
export interface CoinbasePaginationAdapter {
  requestPage: <R>(path: string, signal: AbortSignal) => Promise<R>;
}

/** List orders across all pages, filtered by product/status/date. */
export async function paginateListOrders(
  adapter: CoinbasePaginationAdapter,
  filters: {
    productId?: string;
    orderStatus?: string; // comma-separated
    startDate?: string; // ISO
    endDate?: string; // ISO
    limit?: number; // per-page, default 100
  },
  opts?: Partial<PaginateOptions>,
): Promise<PaginationResult<CoinbaseOrder>> {
  const limit = filters.limit ?? 100;
  const base = `/api/v3/brokerage/orders/historical/batch?limit=${limit}`;
  const buildPath = (cursor: string | null) => {
    const params: string[] = [];
    if (filters.productId) params.push(`product_id=${encodeURIComponent(filters.productId)}`);
    if (filters.orderStatus) params.push(`order_status=${encodeURIComponent(filters.orderStatus)}`);
    if (filters.startDate) params.push(`start_date=${encodeURIComponent(filters.startDate)}`);
    if (filters.endDate) params.push(`end_date=${encodeURIComponent(filters.endDate)}`);
    if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
    return params.length ? `${base}&${params.join('&')}` : base;
  };
  return paginate<CoinbaseOrder>(
    async (cursor, signal) => {
      const data = await adapter.requestPage<{
        orders: CoinbaseOrder[];
        has_next?: boolean;
        cursor?: string;
      }>(buildPath(cursor), signal);
      return {
        items: data.orders ?? [],
        nextCursor: data.cursor ?? null,
        hasNext: data.has_next === true,
      };
    },
    { dedupeKey: (o) => (o as CoinbaseOrder).order_id, ...opts },
  );
}

/** List all fills across all pages for a single order id. */
export async function paginateListFillsForOrder(
  adapter: CoinbasePaginationAdapter,
  filters: {
    orderId: string;
    limit?: number;
  },
  opts?: Partial<PaginateOptions>,
): Promise<PaginationResult<CoinbaseFill>> {
  const limit = filters.limit ?? 250;
  const base = `/api/v3/brokerage/orders/historical/fills?order_id=${encodeURIComponent(
    filters.orderId,
  )}&limit=${limit}`;
  return paginate<CoinbaseFill>(
    async (cursor, signal) => {
      const path = cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
      const data = await adapter.requestPage<{
        fills: CoinbaseFill[];
        has_next?: boolean;
        cursor?: string;
      }>(path, signal);
      return {
        items: data.fills ?? [],
        nextCursor: data.cursor ?? null,
        hasNext: data.has_next === true,
      };
    },
    { dedupeKey: (f) => (f as CoinbaseFill).trade_id, ...opts },
  );
}
