import { eq } from 'drizzle-orm';
import { db } from '../db';
import {
  candleObservations,
  marketDataGaps,
  productMarketStates,
  type ProductMarketStateRow,
} from '../db/schema';
import { applyCandleUpdate } from './candleAssembler';

/**
 * Phase 1.2 §E — historical bootstrap.
 *
 * At startup Horizon must:
 *   1. Fetch product metadata (id, status, increments, min size).
 *   2. Verify product status.
 *   3. Verify increments and min sizes match Horizon's expectations.
 *   4. Fetch candle history for the windows required by current
 *      indicators (Coinbase's REST candles endpoint returns at most
 *      350 buckets per call).
 *   5. Validate ordering and duplicate timestamps.
 *   6. Detect missing intervals.
 *   7. Record source and availability times.
 *   8. Connect WebSockets.
 *   9. Merge live candle updates into the current bucket.
 *  10. Permit scanning ONLY after the product reaches `healthy`.
 *
 * The bootstrap accepts an injectable `MarketDataRestClient` so tests
 * can drive deterministic fixtures; production uses a real Coinbase
 * REST adapter that the fetch barrier still governs at the transport
 * layer (only POST /orders is blocked; GETs are allowed).
 *
 * The bootstrap NEVER fabricates zero-volume candles for periods
 * without authoritative data. Missing intervals become gap rows and
 * the product stays `incomplete_history` until the operator ships fresh
 * data.
 */

export const BOOTSTRAP_VERSION = 'p1_2-bootstrap-1';

export interface ProductMetadata {
  productId: string;
  status: 'online' | 'offline' | 'delisted';
  baseIncrement: string;
  quoteIncrement: string;
  baseMinSize: string;
  baseMaxSize: string;
}

export interface RestCandle {
  bucketStart: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface MarketDataRestClient {
  fetchProductMetadata(productId: string): Promise<ProductMetadata>;
  fetchCandles(
    productId: string,
    granularitySeconds: number,
    startInclusive: Date,
    endExclusive: Date,
  ): Promise<RestCandle[]>;
}

export interface BootstrapInput {
  productId: string;
  granularitySeconds: number;
  bucketsRequired: number;
  now: Date;
  restClient: MarketDataRestClient;
  /** Minimum buckets required before the product may be evaluated. */
  minBucketsForScanner?: number;
}

export type BootstrapVerdict =
  | 'healthy'
  | 'stale'
  | 'incomplete_history'
  | 'gap_detected'
  | 'invalid_value'
  | 'product_unavailable';

export interface BootstrapResult {
  verdict: BootstrapVerdict;
  reason: string;
  candlesFetched: number;
  gapsDetected: number;
  state: ProductMarketStateRow;
}

export async function bootstrapProduct(input: BootstrapInput): Promise<BootstrapResult> {
  const meta = await input.restClient.fetchProductMetadata(input.productId);
  if (meta.status !== 'online') {
    await upsertProductState(input.productId, {
      statusState: meta.status === 'delisted' ? 'delisted' : 'offline',
      dataQualityState: 'product_unavailable',
      updatedAt: input.now,
    });
    return {
      verdict: 'product_unavailable',
      reason: `product status=${meta.status}`,
      candlesFetched: 0,
      gapsDetected: 0,
      state: (await getProductState(input.productId))!,
    };
  }
  if (
    !isPositiveDecimal(meta.baseIncrement) ||
    !isPositiveDecimal(meta.quoteIncrement) ||
    !isPositiveDecimal(meta.baseMinSize)
  ) {
    await upsertProductState(input.productId, {
      statusState: 'online',
      dataQualityState: 'invalid_value',
      updatedAt: input.now,
    });
    return {
      verdict: 'invalid_value',
      reason: 'invalid product increments',
      candlesFetched: 0,
      gapsDetected: 0,
      state: (await getProductState(input.productId))!,
    };
  }
  // Fetch history in windows of at most 350 buckets per call.
  const windowSpanSeconds = input.granularitySeconds * input.bucketsRequired;
  const historyStart = new Date(input.now.getTime() - windowSpanSeconds * 1000);
  const candles = await fetchCandlesPaged(
    input.restClient,
    input.productId,
    input.granularitySeconds,
    historyStart,
    input.now,
  );
  // Validate ordering + dedupe.
  const seen = new Set<number>();
  const ordered: RestCandle[] = [];
  for (const c of candles) {
    const key = c.bucketStart.getTime();
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(c);
  }
  ordered.sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime());
  // Detect gaps.
  let gaps = 0;
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1].bucketStart.getTime();
    const curr = ordered[i].bucketStart.getTime();
    const expected = prev + input.granularitySeconds * 1000;
    if (curr !== expected) {
      gaps++;
      await db.insert(marketDataGaps).values({
        channel: 'candles',
        productId: input.productId,
        detectedAt: input.now,
        lastKnownEventAt: ordered[i - 1].bucketStart,
        gapType: 'bootstrap_missing_interval',
        state: 'open',
      });
    }
  }
  // Persist as finalized candles.
  for (const c of ordered) {
    await applyCandleUpdate({
      productId: input.productId,
      granularitySeconds: input.granularitySeconds,
      bucketStart: c.bucketStart,
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      finalized: true,
      sourceTimestamp: c.bucketStart,
      receivedAt: input.now,
    });
  }
  const minBuckets = input.minBucketsForScanner ?? Math.floor(input.bucketsRequired * 0.9);
  let verdict: BootstrapVerdict;
  let reason: string;
  if (ordered.length < minBuckets) {
    verdict = 'incomplete_history';
    reason = `only ${ordered.length}/${input.bucketsRequired} buckets available`;
  } else if (gaps > 0) {
    verdict = 'gap_detected';
    reason = `${gaps} gap(s) detected`;
  } else {
    verdict = 'healthy';
    reason = 'ok';
  }
  await upsertProductState(input.productId, {
    statusState: 'online',
    candleState: verdict === 'healthy' ? 'healthy' : verdict === 'gap_detected' ? 'gap_detected' : 'incomplete_history',
    dataQualityState: verdict,
    lastCandleAt: ordered.length > 0 ? ordered[ordered.length - 1].bucketStart : null,
    updatedAt: input.now,
  });
  return {
    verdict,
    reason,
    candlesFetched: ordered.length,
    gapsDetected: gaps,
    state: (await getProductState(input.productId))!,
  };
}

async function fetchCandlesPaged(
  client: MarketDataRestClient,
  productId: string,
  granularitySeconds: number,
  startInclusive: Date,
  endExclusive: Date,
): Promise<RestCandle[]> {
  const MAX_PER_CALL = 350;
  const perCallSpanMs = MAX_PER_CALL * granularitySeconds * 1000;
  const results: RestCandle[] = [];
  let cursor = startInclusive.getTime();
  while (cursor < endExclusive.getTime()) {
    const windowEnd = new Date(Math.min(cursor + perCallSpanMs, endExclusive.getTime()));
    const chunk = await client.fetchCandles(productId, granularitySeconds, new Date(cursor), windowEnd);
    results.push(...chunk);
    cursor = windowEnd.getTime();
  }
  return results;
}

function isPositiveDecimal(s: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(s)) return false;
  return Number(s) > 0;
}

async function upsertProductState(
  productId: string,
  patch: Partial<ProductMarketStateRow>,
): Promise<void> {
  const existing = await getProductState(productId);
  if (existing) {
    await db.update(productMarketStates).set(patch).where(eq(productMarketStates.productId, productId));
  } else {
    await db.insert(productMarketStates).values({
      productId,
      tickerState: patch.tickerState ?? 'unknown',
      candleState: patch.candleState ?? 'unknown',
      tradeState: patch.tradeState ?? 'unknown',
      statusState: patch.statusState ?? 'unknown',
      dataQualityState: patch.dataQualityState ?? 'incomplete_history',
      dataVersion: 'p1_2-1',
      latestPrice: patch.latestPrice ?? null,
      lastTickerAt: patch.lastTickerAt ?? null,
      lastCandleAt: patch.lastCandleAt ?? null,
      lastTradeAt: patch.lastTradeAt ?? null,
      lastStatusAt: patch.lastStatusAt ?? null,
      currentCandleStart: patch.currentCandleStart ?? null,
    });
  }
}

export async function getProductState(productId: string): Promise<ProductMarketStateRow | null> {
  const [row] = await db
    .select()
    .from(productMarketStates)
    .where(eq(productMarketStates.productId, productId))
    .limit(1);
  return row ?? null;
}

/** Test double — a deterministic REST client. */
export class InMemoryRestClient implements MarketDataRestClient {
  constructor(
    private products: Map<string, ProductMetadata>,
    private candles: Map<string, RestCandle[]>,
  ) {}
  async fetchProductMetadata(productId: string): Promise<ProductMetadata> {
    const m = this.products.get(productId);
    if (!m) throw new Error(`no metadata for ${productId}`);
    return m;
  }
  async fetchCandles(
    productId: string,
    _granularitySeconds: number,
    startInclusive: Date,
    endExclusive: Date,
  ): Promise<RestCandle[]> {
    const list = this.candles.get(productId) ?? [];
    return list.filter(
      (c) =>
        c.bucketStart.getTime() >= startInclusive.getTime() &&
        c.bucketStart.getTime() < endExclusive.getTime(),
    );
  }
}
// Keep granularitySeconds referenced.
void candleObservations;
