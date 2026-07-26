import { createHash } from 'node:crypto';

/**
 * Immutable candle bar as consumed by research features. Prices are
 * numbers (not `Money`) because we operate on log-return statistics
 * where the scale invariance matters, not the exchange-safe rounding.
 * `dataAvailableAt` MUST be treated as the honesty barrier: features
 * are only permitted to see bars whose availability time is <= the
 * caller's evaluation time.
 */
export interface CandleBar {
  productId: string;
  bucketStart: Date;
  granularitySeconds: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  dataAvailableAt: Date;
  finalized: boolean;
}

export interface ProductStaticInputs {
  productId: string;
  baseCurrency: string;
  quoteCurrency: string;
  baseIncrement: number;
  quoteIncrement: number;
  baseMinimum: number;
  approximateSpreadBps?: number | null;
  quoteVolume24h?: number | null;
  tradeCount24h?: number | null;
}

export interface BenchmarkSeries {
  productId: string;
  bars: CandleBar[];
}

export interface FeatureInputBundle {
  productId: string;
  now: Date;
  bars: CandleBar[];
  staticInputs: ProductStaticInputs;
  benchmarks?: Record<string, BenchmarkSeries>;
  gapCount?: number;
}

/**
 * Compute a deterministic hash of an input bundle. We hash the fields
 * that materially affect the calculation — not `now` alone, because
 * different features may span different windows of the same bundle.
 */
export function hashCandleWindow(
  bars: readonly CandleBar[],
  extras: Record<string, unknown> = {},
): string {
  const seed = bars.map((b) => ({
    b: b.bucketStart.toISOString(),
    g: b.granularitySeconds,
    o: b.open,
    h: b.high,
    l: b.low,
    c: b.close,
    v: b.volume,
    a: b.dataAvailableAt.toISOString(),
    f: b.finalized,
  }));
  return createHash('sha256')
    .update(JSON.stringify({ seed, extras }))
    .digest('hex');
}

/**
 * Select finalized bars that are visible at the honesty barrier.
 * Anything with `dataAvailableAt > now` is silently excluded — the
 * caller decides whether the remaining count meets the minimum sample
 * threshold. Uses stable order by bucketStart ascending.
 */
export function visibleFinalizedBars(bars: readonly CandleBar[], now: Date): CandleBar[] {
  const eligible = bars.filter((b) => b.finalized && b.dataAvailableAt.getTime() <= now.getTime());
  return [...eligible].sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime());
}

/**
 * True if there is a bucket gap between consecutive bars. Assumes bars
 * are sorted ascending and share the same granularity.
 */
export function detectBucketGaps(bars: readonly CandleBar[]): number {
  if (bars.length < 2) return 0;
  const g = bars[0].granularitySeconds * 1000;
  let gaps = 0;
  for (let i = 1; i < bars.length; i += 1) {
    const delta = bars[i].bucketStart.getTime() - bars[i - 1].bucketStart.getTime();
    if (delta > g) gaps += Math.round(delta / g) - 1;
  }
  return gaps;
}

/**
 * Align two series to identical bucketStart timestamps. Missing
 * buckets on either side are DROPPED (never zero-filled). Both output
 * arrays are aligned index-by-index; the returned matched-timestamp
 * array is a diagnostic for the caller.
 */
export function alignedSeries(
  a: readonly CandleBar[],
  b: readonly CandleBar[],
): { aAligned: CandleBar[]; bAligned: CandleBar[]; matchedTimestamps: number[] } {
  const bMap = new Map<number, CandleBar>();
  for (const bar of b) bMap.set(bar.bucketStart.getTime(), bar);
  const aAligned: CandleBar[] = [];
  const bAligned: CandleBar[] = [];
  const matched: number[] = [];
  for (const bar of a) {
    const key = bar.bucketStart.getTime();
    const other = bMap.get(key);
    if (other) {
      aAligned.push(bar);
      bAligned.push(other);
      matched.push(key);
    }
  }
  return { aAligned, bAligned, matchedTimestamps: matched };
}
