import type { MarketDataRestClient, ProductMetadata, RestCandle } from './bootstrap';

/**
 * Phase 1.2-OPS §A — real Coinbase Advanced Trade REST client.
 *
 * Public market-data endpoints only. Uses the ambient `fetch`
 * (wrapped by `installFetchBarrier` in production so a bug in ANY
 * caller cannot slip a POST /api/v3/brokerage/orders through). Only
 * GET requests are issued from this module.
 *
 * The Coinbase public candles endpoint returns at most 350 buckets
 * per call — `bootstrap.ts` already respects that cap.
 */

export const COINBASE_REST_VERSION = 'p1_2-ops-coinbase-rest-1';
export const COINBASE_REST_BASE = 'https://api.coinbase.com';

interface CoinbaseProduct {
  product_id: string;
  status?: string;
  base_increment?: string;
  quote_increment?: string;
  base_min_size?: string;
  base_max_size?: string;
  trading_disabled?: boolean;
  is_disabled?: boolean;
}

interface CoinbaseCandlesResponse {
  candles?: Array<{
    start: string;      // Unix seconds as string
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  }>;
}

export class CoinbasePublicRestClient implements MarketDataRestClient {
  constructor(private readonly base: string = COINBASE_REST_BASE) {}

  async fetchProductMetadata(productId: string): Promise<ProductMetadata> {
    const url = `${this.base}/api/v3/brokerage/market/products/${encodeURIComponent(productId)}`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`fetchProductMetadata ${productId} ${res.status}`);
    }
    const body = (await res.json()) as CoinbaseProduct;
    const rawStatus = (body.status ?? '').toLowerCase();
    let status: ProductMetadata['status'];
    if (body.is_disabled || body.trading_disabled || rawStatus === 'delisted') {
      status = 'delisted';
    } else if (rawStatus === 'offline') {
      status = 'offline';
    } else {
      status = 'online';
    }
    return {
      productId: body.product_id ?? productId,
      status,
      baseIncrement: body.base_increment ?? '',
      quoteIncrement: body.quote_increment ?? '',
      baseMinSize: body.base_min_size ?? '',
      baseMaxSize: body.base_max_size ?? '',
    };
  }

  async fetchCandles(
    productId: string,
    granularitySeconds: number,
    startInclusive: Date,
    endExclusive: Date,
  ): Promise<RestCandle[]> {
    const granularity = mapGranularity(granularitySeconds);
    const startSec = Math.floor(startInclusive.getTime() / 1000);
    const endSec = Math.floor(endExclusive.getTime() / 1000);
    const url =
      `${this.base}/api/v3/brokerage/market/products/${encodeURIComponent(productId)}/candles` +
      `?start=${startSec}&end=${endSec}&granularity=${granularity}`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`fetchCandles ${productId} ${res.status}`);
    }
    const body = (await res.json()) as CoinbaseCandlesResponse;
    return (body.candles ?? [])
      .map((c) => ({
        bucketStart: new Date(Number(c.start) * 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }))
      .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime());
  }
}

function mapGranularity(seconds: number): string {
  switch (seconds) {
    case 60: return 'ONE_MINUTE';
    case 300: return 'FIVE_MINUTE';
    case 900: return 'FIFTEEN_MINUTE';
    case 1800: return 'THIRTY_MINUTE';
    case 3600: return 'ONE_HOUR';
    case 21600: return 'SIX_HOUR';
    case 86400: return 'ONE_DAY';
    default:
      throw new Error(`unsupported granularity: ${seconds}s`);
  }
}
