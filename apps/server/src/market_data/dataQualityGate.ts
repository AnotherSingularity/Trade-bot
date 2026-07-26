import { eq } from 'drizzle-orm';
import { db } from '../db';
import {
  marketDataGaps,
  productMarketStates,
  type ProductMarketStateRow,
} from '../db/schema';
import { getLatestFinalizedCandle } from './candleAssembler';

/**
 * Phase 1.2 §G — data-quality gate.
 *
 * Called by the live scanner BEFORE any setup evaluation.  A product
 * only becomes evaluable when every check passes:
 *   - ticker fresh
 *   - required candle history complete
 *   - product status valid
 *   - timestamp ordering valid
 *   - connection healthy (supervisor-side check)
 *   - no unresolved relevant gap
 *   - decimal values valid
 *   - observation lineage created (persisted product_market_states row)
 *
 * Any failure records the rejection in the caller's Gate 2 chain (the
 * caller does the recording; this module returns the verdict).
 *
 * The last known price is NEVER substituted after data becomes stale.
 */

export const DATA_QUALITY_VERSION = 'p1_2-quality-1';

export type QualityVerdict = ProductMarketStateRow['dataQualityState'];

export interface QualityCheckInput {
  productId: string;
  now: Date;
  tickerStaleMs?: number;
  candleStaleMs?: number;
  minFinalizedCandles?: number;
  supervisorHealthy: boolean;
}

export interface QualityCheckResult {
  verdict: QualityVerdict;
  reason: string;
  productState: ProductMarketStateRow | null;
}

export async function evaluateDataQuality(
  input: QualityCheckInput,
): Promise<QualityCheckResult> {
  if (!input.supervisorHealthy) {
    return respond('connection_degraded', 'supervisor_not_healthy', await loadState(input.productId));
  }
  const state = await loadState(input.productId);
  if (!state) {
    return respond('product_unavailable', 'no_product_state_row', null);
  }
  if (state.statusState !== 'online') {
    return respond('product_unavailable', `product_status=${state.statusState}`, state);
  }
  // Ticker freshness.
  const tickerStaleMs = input.tickerStaleMs ?? 30_000;
  if (!state.lastTickerAt) return respond('stale', 'no_ticker_yet', state);
  if (input.now.getTime() - state.lastTickerAt.getTime() > tickerStaleMs) {
    return respond('stale', `ticker_stale_${input.now.getTime() - state.lastTickerAt.getTime()}ms`, state);
  }
  // Candle freshness + minimum history.
  const candleStaleMs = input.candleStaleMs ?? 600_000; // one full 5-minute bucket + slack
  if (!state.lastCandleAt) return respond('incomplete_history', 'no_candle_yet', state);
  if (input.now.getTime() - state.lastCandleAt.getTime() > candleStaleMs) {
    return respond('stale', `candle_stale_${input.now.getTime() - state.lastCandleAt.getTime()}ms`, state);
  }
  const latest = await getLatestFinalizedCandle(input.productId);
  if (!latest) return respond('incomplete_history', 'no_finalized_candle', state);
  const minFinalized = input.minFinalizedCandles ?? 26; // covers the widest current indicator window
  const { sql: sqlTag } = await import('drizzle-orm');
  const finalizedCountRow = (await db.execute(
    sqlTag`SELECT COUNT(*) AS c FROM candle_observations WHERE productId = ${input.productId} AND finalized = 1`,
  )) as unknown as [{ c: number }[], unknown];
  const arr = Array.isArray(finalizedCountRow[0]) ? finalizedCountRow[0] : (finalizedCountRow as unknown as { c: number }[]);
  const finalizedCount = Number(arr[0]?.c ?? 0);
  if (finalizedCount < minFinalized) {
    return respond('incomplete_history', `only ${finalizedCount}/${minFinalized} finalized candles`, state);
  }
  // Ordering: last candle bucket must be no more than one granularity behind now.
  if (state.currentCandleStart && state.currentCandleStart.getTime() < latest.bucketStart.getTime()) {
    return respond('desynchronized', 'currentCandleStart precedes latest finalized bucket', state);
  }
  // Any unresolved gap on this product blocks evaluation.
  const openGaps = await db
    .select()
    .from(marketDataGaps)
    .where(eq(marketDataGaps.productId, input.productId));
  const relevantOpen = openGaps.filter((g) => g.state === 'open');
  if (relevantOpen.length > 0) {
    return respond('gap_detected', `${relevantOpen.length} open gap(s)`, state);
  }
  // Decimal sanity on latest price.
  if (state.latestPrice && !/^\d+(\.\d+)?$/.test(state.latestPrice)) {
    return respond('invalid_value', 'latestPrice not decimal', state);
  }
  return respond('healthy', 'ok', state);
}

async function loadState(productId: string): Promise<ProductMarketStateRow | null> {
  const [row] = await db
    .select()
    .from(productMarketStates)
    .where(eq(productMarketStates.productId, productId))
    .limit(1);
  return row ?? null;
}

function respond(
  verdict: QualityVerdict,
  reason: string,
  productState: ProductMarketStateRow | null,
): QualityCheckResult {
  return { verdict, reason, productState };
}
