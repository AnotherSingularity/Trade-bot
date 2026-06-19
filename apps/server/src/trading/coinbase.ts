import { createHmac, createSign, randomBytes } from 'node:crypto';
import { ENV } from '../env';
import { QUOTE_CURRENCY } from '@horizon/shared';

/**
 * Coinbase Advanced Trade API client.
 *
 * Authenticates with CDP-format ES256 JWTs (per request). When credentials are
 * not configured the public market-data endpoints still work; private endpoints
 * throw a descriptive error so the rest of the system degrades gracefully.
 */

const API_HOST = 'api.coinbase.com';
const BASE_URL = `https://${API_HOST}`;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Builds a short-lived ES256 JWT for a single REST request, as required by the
 * Coinbase Advanced Trade (CDP) API.
 */
export function buildJwt(method: string, requestPath: string): string {
  if (!ENV.coinbaseKeyName || !ENV.coinbasePrivateKey) {
    throw new Error('Coinbase credentials not configured');
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
  const payload = {
    sub: keyName,
    iss: 'cdp',
    nbf: now,
    exp: now + 120,
    uri,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign('SHA256');
  signer.update(signingInput);
  signer.end();
  // dsaEncoding 'ieee-p1363' yields the raw r||s signature ES256 expects.
  const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64url(signature)}`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const jwt = buildJwt(method, path);
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Coinbase ${method} ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Public types (subset of the Coinbase response shapes we consume)
// ---------------------------------------------------------------------------

export interface CoinbaseProduct {
  product_id: string;
  price: string;
  volume_24h: string;
  price_percentage_change_24h: string;
  base_increment: string;
  quote_increment: string;
  status: string;
}

export interface CoinbaseCandle {
  start: string; // unix seconds
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

export interface CoinbaseOrderResponse {
  success: boolean;
  order_id?: string;
  error_response?: { message?: string };
}

function productId(token: string): string {
  return `${token}-${QUOTE_CURRENCY}`;
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

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

/**
 * Fetches historical candles, returning closing prices oldest-first (ready for
 * the indicator functions).
 */
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
  // Coinbase returns newest-first; reverse to oldest-first.
  const candles = [...(data.candles ?? [])].reverse();
  return {
    candles,
    closes: candles.map((c) => Number(c.close)),
    volumes: candles.map((c) => Number(c.volume)),
  };
}

// ---------------------------------------------------------------------------
// Account / portfolio
// ---------------------------------------------------------------------------

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

export interface MarketOrderParams {
  token: string;
  side: 'BUY' | 'SELL';
  /** For BUY: quote (USD) amount to spend. For SELL: base size to sell. */
  amount: number;
}

export async function placeMarketOrder(params: MarketOrderParams): Promise<CoinbaseOrderResponse> {
  const clientOrderId = randomBytes(16).toString('hex');
  const config =
    params.side === 'BUY'
      ? { market_market_ioc: { quote_size: params.amount.toString() } }
      : { market_market_ioc: { base_size: params.amount.toString() } };

  return request<CoinbaseOrderResponse>('POST', '/api/v3/brokerage/orders', {
    client_order_id: clientOrderId,
    product_id: productId(params.token),
    side: params.side,
    order_configuration: config,
  });
}

/** Lightweight connectivity probe used by Settings → Test Connection. */
export async function testConnection(): Promise<{ connected: boolean; message: string }> {
  if (!ENV.coinbaseConfigured) {
    return { connected: false, message: 'Coinbase credentials not configured' };
  }
  try {
    const accounts = await getAccounts();
    return { connected: true, message: `Connected — ${accounts.length} accounts` };
  } catch (err) {
    return { connected: false, message: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// Exported for potential webhook signature verification (not used yet).
export function hmacSignature(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}
