import { createHmac, createSign, randomBytes } from 'node:crypto';
import { ENV } from '../env';
import { Money, QUOTE_CURRENCY } from '@horizon/shared';

/**
 * Coinbase Advanced Trade API client — Phase 0 rebuild.
 *
 * Key corrections vs. the original implementation:
 *   • Create Order responses read `success_response.order_id` (nested), not a
 *     nonexistent top-level field. Reading top-level silently produced null
 *     order IDs and orphaned every live order.
 *   • Every request has a hard timeout (default 8s), enforced via AbortSignal.
 *   • Failure outcomes are classified so callers know whether they may retry.
 *   • Retries never invent a new clientOrderId; the caller passes an
 *     idempotency key and any retry re-uses it.
 */

const API_HOST = 'api.coinbase.com';
const BASE_URL = `https://${API_HOST}`;
const DEFAULT_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// JWT signing (unchanged — CDP ES256, per-request)
// ---------------------------------------------------------------------------

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function buildJwt(method: string, requestPath: string): string {
  if (!ENV.coinbaseKeyName || !ENV.coinbasePrivateKey) {
    throw new CoinbaseError({
      class: 'non_retryable_validation',
      code: 'not_configured',
      message: 'Coinbase credentials not configured',
    });
  }
  const keyName = ENV.coinbaseKeyName;
  const privateKey = ENV.coinbasePrivateKey.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const uri = `${method.toUpperCase()} ${API_HOST}${requestPath}`;

  const header = {
    alg: 'ES256',
    kid: keyName,
    typ: 'JWT',
    nonce: randomBytes(16).toString('hex'),
  };
  const payload = { sub: keyName, iss: 'cdp', nbf: now, exp: now + 120, uri };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign('SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64url(signature)}`;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * How an order-related failure should be interpreted by the state machine.
 *
 * `definitely_rejected`        — exchange said no; safe to move on.
 * `definitely_not_submitted`   — never left our process; safe to retry as-is.
 * `submitted`                  — accepted (nothing to do).
 * `unknown`                    — network timeout, 5xx, gateway error. May or
 *                                may not have reached the exchange. NEVER retry
 *                                with a new clientOrderId; must reconcile.
 * `retryable_transport`        — retriable HTTP layer (rate limit, transient).
 * `non_retryable_validation`   — bad input on our side; caller must fix.
 */
export type FailureClass =
  | 'definitely_rejected'
  | 'definitely_not_submitted'
  | 'submitted'
  | 'unknown'
  | 'retryable_transport'
  | 'non_retryable_validation';

export interface CoinbaseErrorPayload {
  class: FailureClass;
  code: string;
  message: string;
  httpStatus?: number;
  raw?: unknown;
}

export class CoinbaseError extends Error {
  readonly class: FailureClass;
  readonly code: string;
  readonly httpStatus?: number;
  readonly raw?: unknown;
  constructor(p: CoinbaseErrorPayload) {
    super(p.message);
    this.name = 'CoinbaseError';
    this.class = p.class;
    this.code = p.code;
    this.httpStatus = p.httpStatus;
    this.raw = p.raw;
  }
}

// ---------------------------------------------------------------------------
// Core request helper with timeout + classification
// ---------------------------------------------------------------------------

interface RequestOptions {
  timeoutMs?: number;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const jwt = buildJwt(method, path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : 'network error';
    const aborted = err instanceof Error && err.name === 'AbortError';
    // For POST calls to /orders, an aborted request is `unknown` (exchange may
    // or may not have received it). For read calls, treat as retryable transport.
    const isWrite = method.toUpperCase() === 'POST' && path.includes('/orders');
    throw new CoinbaseError({
      class: isWrite ? 'unknown' : 'retryable_transport',
      code: aborted ? 'timeout' : 'network',
      message: aborted ? `Request timed out after ${timeoutMs}ms` : msg,
    });
  }
  clearTimeout(timer);

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // fall through — some errors are HTML
  }

  if (!res.ok) {
    // Classify by HTTP status.
    let cls: FailureClass;
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      cls = 'non_retryable_validation';
    } else if (res.status === 401 || res.status === 403) {
      cls = 'non_retryable_validation';
    } else if (res.status === 408 || res.status === 429) {
      cls = 'retryable_transport';
    } else if (res.status >= 500) {
      // For order-write endpoints a 5xx after our request left the client is
      // genuinely ambiguous — treat as unknown so callers reconcile.
      cls =
        method.toUpperCase() === 'POST' && path.includes('/orders')
          ? 'unknown'
          : 'retryable_transport';
    } else {
      cls = 'non_retryable_validation';
    }
    throw new CoinbaseError({
      class: cls,
      code: `http_${res.status}`,
      message: `Coinbase ${method} ${path} → ${res.status} ${text.slice(0, 200)}`,
      httpStatus: res.status,
      raw: json ?? text,
    });
  }

  return json as T;
}

// ---------------------------------------------------------------------------
// Response types (subset that we actually consume; nested per Coinbase spec)
// ---------------------------------------------------------------------------

export interface CoinbaseProduct {
  product_id: string;
  price: string;
  volume_24h: string;
  price_percentage_change_24h: string;
  base_increment: string;
  quote_increment: string;
  base_min_size?: string;
  base_max_size?: string;
  quote_min_size?: string;
  quote_max_size?: string;
  status: string;
  trading_disabled?: boolean;
  cancel_only?: boolean;
  post_only?: boolean;
  limit_only?: boolean;
}

export interface CoinbaseCandle {
  start: string;
  low: string;
  high: string;
  open: string;
  close: string;
  volume: string;
}

export interface CoinbaseAccount {
  uuid: string;
  currency: string;
  available_balance: { value: string; currency: string };
}

/**
 * Create Order response. Success payload is NESTED under `success_response`,
 * not at the top level — this was the source of the null-order-id bug.
 */
export interface CoinbaseCreateOrderResponse {
  success: boolean;
  failure_reason?: string;
  order_id?: string; // top-level; NOT always populated in success payloads
  success_response?: {
    order_id: string;
    product_id: string;
    side: 'BUY' | 'SELL';
    client_order_id: string;
  };
  error_response?: {
    error?: string;
    message?: string;
    error_details?: string;
    preview_failure_reason?: string;
    new_order_failure_reason?: string;
  };
  order_configuration?: unknown;
}

export interface CoinbasePreviewResponse {
  order_total?: string;
  commission_total?: string;
  errs?: string[];
  warning?: string[];
  quote_size?: string;
  base_size?: string;
  best_bid?: string;
  best_ask?: string;
  slippage?: string;
  /**
   * Coinbase's Preview Order response uses `est_average_filled_price`
   * (documented). We keep `average_filled_price` for defensive fallback in
   * case the field name differs in some sandbox versions, but it must not be
   * relied upon.
   */
  est_average_filled_price?: string;
  average_filled_price?: string;
  preview_id?: string;
  order_configuration?: unknown;
  preview_failure_reason?: string;
  new_order_failure_reason?: string;
  is_max?: boolean;
  quote_increment_reduction?: string;
}

export type CoinbaseOrderStatus =
  | 'PENDING'
  | 'OPEN'
  | 'FILLED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'FAILED'
  | 'UNKNOWN_ORDER_STATUS';

export interface CoinbaseOrder {
  order_id: string;
  client_order_id?: string;
  product_id: string;
  side: 'BUY' | 'SELL';
  status: CoinbaseOrderStatus;
  filled_size?: string;
  average_filled_price?: string;
  total_fees?: string;
  completion_percentage?: string;
  reject_reason?: string;
  created_time?: string;
  filled_value?: string;
  number_of_fills?: string;
}

export interface CoinbaseFill {
  entry_id: string;
  trade_id: string;
  order_id: string;
  product_id: string;
  price: string;
  size: string;
  commission: string;
  side: 'BUY' | 'SELL';
  liquidity_indicator?: 'MAKER' | 'TAKER' | 'UNKNOWN_LIQUIDITY_INDICATOR';
  trade_time: string;
  size_in_quote?: boolean;
}

// ---------------------------------------------------------------------------
// Public API — typed methods
// ---------------------------------------------------------------------------

function productId(token: string): string {
  return `${token}-${QUOTE_CURRENCY}`;
}

export async function getProduct(token: string): Promise<CoinbaseProduct> {
  return request<CoinbaseProduct>('GET', `/api/v3/brokerage/products/${productId(token)}`);
}

export interface CandleGranularity {
  granularity:
    | 'ONE_MINUTE'
    | 'FIVE_MINUTE'
    | 'FIFTEEN_MINUTE'
    | 'ONE_HOUR'
    | 'SIX_HOUR'
    | 'ONE_DAY';
}

export async function getCandles(
  token: string,
  granularity: CandleGranularity['granularity'] = 'ONE_HOUR',
  limit = 100,
): Promise<{ closes: number[]; volumes: number[]; candles: CoinbaseCandle[] }> {
  const granSeconds: Record<CandleGranularity['granularity'], number> = {
    ONE_MINUTE: 60,
    FIVE_MINUTE: 300,
    FIFTEEN_MINUTE: 900,
    ONE_HOUR: 3600,
    SIX_HOUR: 21600,
    ONE_DAY: 86400,
  };
  const end = Math.floor(Date.now() / 1000);
  const start = end - granSeconds[granularity] * limit;
  const path = `/api/v3/brokerage/products/${productId(
    token,
  )}/candles?start=${start}&end=${end}&granularity=${granularity}&limit=${limit}`;
  const data = await request<{ candles: CoinbaseCandle[] }>('GET', path);
  const candles = [...(data.candles ?? [])].reverse();
  return {
    candles,
    closes: candles.map((c) => Number(c.close)),
    volumes: candles.map((c) => Number(c.volume)),
  };
}

export async function getAccounts(): Promise<CoinbaseAccount[]> {
  const data = await request<{ accounts: CoinbaseAccount[] }>(
    'GET',
    '/api/v3/brokerage/accounts?limit=250',
  );
  return data.accounts ?? [];
}

export async function getCashBalance(): Promise<number> {
  const accounts = await getAccounts();
  const usd = accounts.find((a) => a.currency === QUOTE_CURRENCY);
  return usd ? Number(usd.available_balance.value) : 0;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface MarketOrderIntent {
  clientOrderId: string; // MUST be supplied by caller (idempotency key)
  token: string;
  side: 'BUY' | 'SELL';
  /** For BUY: quote (USD) to spend. For SELL: base size. Exactly one is set. */
  quoteSize?: string;
  baseSize?: string;
}

function orderConfiguration(intent: MarketOrderIntent): unknown {
  if (intent.side === 'BUY') {
    if (!intent.quoteSize) {
      throw new CoinbaseError({
        class: 'non_retryable_validation',
        code: 'missing_quote_size',
        message: 'BUY market IOC requires quoteSize',
      });
    }
    return { market_market_ioc: { quote_size: intent.quoteSize } };
  }
  if (!intent.baseSize) {
    throw new CoinbaseError({
      class: 'non_retryable_validation',
      code: 'missing_base_size',
      message: 'SELL market IOC requires baseSize',
    });
  }
  return { market_market_ioc: { base_size: intent.baseSize } };
}

/**
 * Previews a market order without submitting it. Callers should invoke this
 * before `createOrder` to catch increment/min-size violations and to surface
 * expected fees + slippage.
 */
export async function previewOrder(intent: MarketOrderIntent): Promise<CoinbasePreviewResponse> {
  return request<CoinbasePreviewResponse>(
    'POST',
    '/api/v3/brokerage/orders/preview',
    {
      product_id: productId(intent.token),
      side: intent.side,
      order_configuration: orderConfiguration(intent),
    },
    { timeoutMs: 6_000 },
  );
}

export interface CreateOrderResult {
  success: boolean;
  exchangeOrderId?: string;
  clientOrderId: string;
  failureReason?: string;
  raw: CoinbaseCreateOrderResponse;
}

/**
 * Submits a market order. NEVER generates its own idempotency key — the caller
 * passes the pre-persisted `clientOrderId`, so any retry after an `unknown`
 * outcome reuses the same identity and Coinbase deduplicates.
 *
 * Reads the order id from the CORRECT nested location (`success_response.order_id`).
 *
 * PHASE 1 §Q KILLSWITCH — enforced HERE (not in the scanner or executor) so
 * that any code path that reaches this function is stopped before HTTP. This
 * is a second lock behind DRY_RUN; both must consent to reach the exchange.
 */
export async function createOrder(intent: MarketOrderIntent): Promise<CreateOrderResult> {
  if (!ENV.orderSubmissionEnabled) {
    throw new CoinbaseError({
      class: 'non_retryable_validation',
      code: 'order_submission_disabled',
      message:
        'ORDER_SUBMISSION_ENABLED=false — createOrder refused to POST /orders. ' +
        'This is the Phase 1 §Q double-lock; enable it explicitly to trade live.',
    });
  }
  const raw = await request<CoinbaseCreateOrderResponse>(
    'POST',
    '/api/v3/brokerage/orders',
    {
      client_order_id: intent.clientOrderId,
      product_id: productId(intent.token),
      side: intent.side,
      order_configuration: orderConfiguration(intent),
    },
    { timeoutMs: 10_000 },
  );

  if (raw.success) {
    const exchangeOrderId = raw.success_response?.order_id ?? raw.order_id;
    if (!exchangeOrderId) {
      // Coinbase said success but gave us no order id — treat as unknown.
      throw new CoinbaseError({
        class: 'unknown',
        code: 'missing_order_id',
        message: 'Coinbase reported success without an order_id',
        raw,
      });
    }
    return {
      success: true,
      exchangeOrderId,
      clientOrderId: intent.clientOrderId,
      raw,
    };
  }

  // Explicit failure payload.
  const reason =
    raw.error_response?.new_order_failure_reason ??
    raw.error_response?.preview_failure_reason ??
    raw.error_response?.message ??
    raw.failure_reason ??
    'unknown_failure';
  return {
    success: false,
    clientOrderId: intent.clientOrderId,
    failureReason: reason,
    raw,
  };
}

export async function getOrder(exchangeOrderId: string): Promise<CoinbaseOrder> {
  const data = await request<{ order: CoinbaseOrder }>(
    'GET',
    `/api/v3/brokerage/orders/historical/${exchangeOrderId}`,
  );
  return data.order;
}

/**
 * Looks up an order by our clientOrderId — used during reconciliation when we
 * lost the response but still have the idempotency key.
 */
export async function findOrderByClientId(clientOrderId: string): Promise<CoinbaseOrder | null> {
  const data = await request<{ orders: CoinbaseOrder[] }>(
    'GET',
    `/api/v3/brokerage/orders/historical/batch?limit=100&order_status=OPEN,FILLED,CANCELLED,EXPIRED,FAILED`,
  );
  const orders = data.orders ?? [];
  return orders.find((o) => o.client_order_id === clientOrderId) ?? null;
}

export async function listFillsForOrder(exchangeOrderId: string): Promise<CoinbaseFill[]> {
  const data = await request<{ fills: CoinbaseFill[] }>(
    'GET',
    `/api/v3/brokerage/orders/historical/fills?order_id=${encodeURIComponent(
      exchangeOrderId,
    )}&limit=250`,
  );
  return data.fills ?? [];
}

export async function cancelOrder(exchangeOrderId: string): Promise<boolean> {
  const data = await request<{ results?: { success: boolean; order_id: string }[] }>(
    'POST',
    '/api/v3/brokerage/orders/batch_cancel',
    { order_ids: [exchangeOrderId] },
    { timeoutMs: 6_000 },
  );
  return (data.results ?? []).some((r) => r.order_id === exchangeOrderId && r.success);
}

// ---------------------------------------------------------------------------
// Transaction summary (Phase 1 §A — authenticated fee tier)
// ---------------------------------------------------------------------------

/**
 * Subset of the `/transaction_summary` response we actually use. Coinbase
 * returns significantly more (per-portfolio breakdown, margin rates,
 * advanced-trade specific fields); the parser reads only what the cost model
 * needs and stores the raw response on the snapshot for future reference.
 */
export interface CoinbaseFeeTier {
  pricing_tier?: string;
  usd_from?: string;
  usd_to?: string;
  taker_fee_rate?: string;
  maker_fee_rate?: string;
  aop_from?: string;
  aop_to?: string;
}

export interface CoinbaseTransactionSummary {
  total_volume?: number | string;
  total_fees?: number | string;
  fee_tier?: CoinbaseFeeTier;
  margin_rate?: { value?: string };
  goods_and_services_tax?: unknown;
  advanced_trade_only_volume?: number | string;
  advanced_trade_only_fees?: number | string;
}

/**
 * Fetches the caller's current fee tier for `product_type` (SPOT). MUST be
 * called against an authenticated account — Coinbase's public help page is not
 * an authoritative source for personalized rates.
 */
export async function getTransactionSummary(
  productType: 'SPOT' | 'FUTURE' = 'SPOT',
): Promise<CoinbaseTransactionSummary> {
  return request<CoinbaseTransactionSummary>(
    'GET',
    `/api/v3/brokerage/transaction_summary?product_type=${productType}`,
    undefined,
    { timeoutMs: 8_000 },
  );
}

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

export async function testConnection(): Promise<{ connected: boolean; message: string }> {
  if (!ENV.coinbaseConfigured) {
    return { connected: false, message: 'Coinbase credentials not configured' };
  }
  try {
    const accounts = await getAccounts();
    return { connected: true, message: `Connected — ${accounts.length} accounts` };
  } catch (err) {
    return {
      connected: false,
      message: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

// ---------------------------------------------------------------------------
// Product validation + increment rounding (used before every entry)
// ---------------------------------------------------------------------------

/**
 * Rounds a Money value DOWN (toward zero) to the nearest multiple of `increment`.
 * All arithmetic is bigint-exact via Money.roundToIncrement — no Number/toFixed
 * anywhere on the path, so we cannot accidentally submit e.g. 0.10000001 due to
 * float drift (Phase 1.1.a §M).
 *
 * The Coinbase-facing wire format is a decimal string; callers get the
 * post-rounding value as `.toDecimalString(digits)`.
 */
export function roundToIncrement(value: Money, incrementStr: string): Money {
  if (!incrementStr || incrementStr === '0') return value;
  const inc = Money.fromString(incrementStr);
  if (!inc.isPositive()) return value;
  return value.roundToIncrement(inc, 'DOWN');
}

/**
 * Returns the number of decimal digits implied by `incrementStr` — e.g.
 * "0.01" → 2, "0.00000001" → 8, "1" → 0. Used to serialize a rounded Money
 * to a decimal string that carries exactly the exchange-required precision.
 */
export function decimalDigitsForIncrement(incrementStr: string): number {
  if (!incrementStr || !incrementStr.includes('.')) return 0;
  const frac = incrementStr.split('.')[1] ?? '';
  return frac.replace(/0+$/, '').length;
}

export function validateProductForTrading(product: CoinbaseProduct): void {
  if (product.trading_disabled) {
    throw new CoinbaseError({
      class: 'non_retryable_validation',
      code: 'trading_disabled',
      message: `${product.product_id} trading is disabled`,
    });
  }
  if (product.cancel_only) {
    throw new CoinbaseError({
      class: 'non_retryable_validation',
      code: 'cancel_only',
      message: `${product.product_id} is cancel-only`,
    });
  }
  if (product.status && product.status !== 'online') {
    throw new CoinbaseError({
      class: 'non_retryable_validation',
      code: `status_${product.status}`,
      message: `${product.product_id} status is ${product.status}`,
    });
  }
}

/**
 * For a BUY, validates the intended quote size against min/max quote limits
 * (Coinbase). For a SELL, validates base size against base limits. Also rounds
 * to the appropriate increment. Decimal-safe end-to-end: takes Money, returns
 * the decimal string Coinbase expects on the wire.
 */
export function normalizeBuyQuoteSize(product: CoinbaseProduct, quoteSize: Money): string {
  const rounded = roundToIncrement(quoteSize, product.quote_increment);
  const min = product.quote_min_size ? Money.fromString(product.quote_min_size) : Money.zero();
  const max = product.quote_max_size ? Money.fromString(product.quote_max_size) : null;
  if (rounded.lt(min)) {
    throw new CoinbaseError({
      class: 'non_retryable_validation',
      code: 'below_min_quote_size',
      message: `${product.product_id} BUY quote_size ${rounded.toDecimalString(8)} below min ${min.toDecimalString(
        8,
      )}`,
    });
  }
  if (max && rounded.gt(max)) {
    throw new CoinbaseError({
      class: 'non_retryable_validation',
      code: 'above_max_quote_size',
      message: `${product.product_id} BUY quote_size ${rounded.toDecimalString(8)} above max ${max.toDecimalString(
        8,
      )}`,
    });
  }
  return rounded.toDecimalString(decimalDigitsForIncrement(product.quote_increment));
}

export function normalizeSellBaseSize(product: CoinbaseProduct, baseSize: Money): string {
  const rounded = roundToIncrement(baseSize, product.base_increment);
  const min = product.base_min_size ? Money.fromString(product.base_min_size) : Money.zero();
  const max = product.base_max_size ? Money.fromString(product.base_max_size) : null;
  if (rounded.lt(min)) {
    throw new CoinbaseError({
      class: 'non_retryable_validation',
      code: 'below_min_base_size',
      message: `${product.product_id} SELL base_size ${rounded.toDecimalString(8)} below min ${min.toDecimalString(
        8,
      )}`,
    });
  }
  if (max && rounded.gt(max)) {
    throw new CoinbaseError({
      class: 'non_retryable_validation',
      code: 'above_max_base_size',
      message: `${product.product_id} SELL base_size ${rounded.toDecimalString(8)} above max ${max.toDecimalString(
        8,
      )}`,
    });
  }
  return rounded.toDecimalString(decimalDigitsForIncrement(product.base_increment));
}

// Exported for potential webhook signature verification (not used yet).
export function hmacSignature(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}
