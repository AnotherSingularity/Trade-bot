import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import {
  candleObservations,
  marketDataGaps,
  type CandleObservationRow,
} from '../db/schema';

/**
 * Phase 1.2 §F — deterministic candle assembler.
 *
 * Rules:
 *   1. Five-minute candle identity is Coinbase's bucket start.
 *   2. Same-bucket updates rewrite THE SAME row until finalized.
 *   3. Once finalized, the row is IMMUTABLE. A late update creates a
 *      new version with `supersedesCandleId` pointing back.
 *   4. Duplicate messages (same bucket + same OHLCV + not finalized)
 *      produce no duplicate row.
 *   5. Out-of-order updates apply deterministically (older
 *      `sourceTimestamp` cannot overwrite newer content).
 *   6. A missing bucket creates a `market_data_gaps` row with
 *      `gapType='missing_candle_bucket'`.
 *
 * Scanner consumption is deliberately explicit:
 *   `getLatestFinalizedCandle(productId)` — the strategy's current
 *   candle semantics (last finalized bucket) are preserved unchanged
 *   for Phase 1.2. `getFormingCandle(productId)` exists for
 *   documentation but is not used by the current strategy.
 */

export const CANDLE_ASSEMBLER_VERSION = 'p1_2-candles-1';

export interface IncomingCandle {
  productId: string;
  granularitySeconds: number;
  bucketStart: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  finalized: boolean;
  sourceEventId?: number | null;
  sourceTimestamp: Date;
  receivedAt: Date;
}

export type ApplyResult =
  | { status: 'inserted'; candle: CandleObservationRow }
  | { status: 'updated'; candle: CandleObservationRow }
  | { status: 'noop_duplicate'; candle: CandleObservationRow }
  | { status: 'out_of_order_skipped'; candle: CandleObservationRow; reason: string }
  | { status: 'corrected'; candle: CandleObservationRow; supersedes: CandleObservationRow };

export async function applyCandleUpdate(input: IncomingCandle): Promise<ApplyResult> {
  const dataAvailableAt = input.receivedAt;
  const existing = await currentBucket(input.productId, input.granularitySeconds, input.bucketStart);
  if (!existing) {
    const [{ insertId }] = (await db.insert(candleObservations).values({
      productId: input.productId,
      granularitySeconds: input.granularitySeconds,
      bucketStart: input.bucketStart,
      open: input.open,
      high: input.high,
      low: input.low,
      close: input.close,
      volume: input.volume,
      finalized: input.finalized,
      finalizedAt: input.finalized ? input.sourceTimestamp : null,
      sourceEventId: input.sourceEventId ?? null,
      sourceTimestamp: input.sourceTimestamp,
      receivedAt: input.receivedAt,
      dataAvailableAt,
      version: 1,
    })) as unknown as { insertId: number }[];
    const [row] = await db
      .select()
      .from(candleObservations)
      .where(eq(candleObservations.id, insertId))
      .limit(1);
    return { status: 'inserted', candle: row! };
  }
  // Same content → dedup. Decimals may arrive from mysql2 padded to
  // the column scale; compare numerically. Booleans may arrive as 0/1.
  const existingFinalized = Boolean(existing.finalized);
  const decEq = (a: string, b: string) => Number(a) === Number(b);
  const same =
    decEq(existing.open, input.open) &&
    decEq(existing.high, input.high) &&
    decEq(existing.low, input.low) &&
    decEq(existing.close, input.close) &&
    decEq(existing.volume, input.volume) &&
    existingFinalized === Boolean(input.finalized);
  if (same) return { status: 'noop_duplicate', candle: existing };
  if (existingFinalized) {
    // Late correction to a finalized bucket → new version.
    const [{ insertId }] = (await db.insert(candleObservations).values({
      productId: input.productId,
      granularitySeconds: input.granularitySeconds,
      bucketStart: input.bucketStart,
      open: input.open,
      high: input.high,
      low: input.low,
      close: input.close,
      volume: input.volume,
      finalized: input.finalized,
      finalizedAt: input.finalized ? input.sourceTimestamp : null,
      sourceEventId: input.sourceEventId ?? null,
      sourceTimestamp: input.sourceTimestamp,
      receivedAt: input.receivedAt,
      dataAvailableAt,
      version: existing.version + 1,
      supersedesCandleId: existing.id,
      correctionReason: 'late_update_after_finalization',
    })) as unknown as { insertId: number }[];
    const [row] = await db
      .select()
      .from(candleObservations)
      .where(eq(candleObservations.id, insertId))
      .limit(1);
    return { status: 'corrected', candle: row!, supersedes: existing };
  }
  // Out-of-order guard.
  if (input.sourceTimestamp.getTime() < existing.sourceTimestamp.getTime()) {
    return {
      status: 'out_of_order_skipped',
      candle: existing,
      reason: `incoming ${input.sourceTimestamp.toISOString()} older than existing ${existing.sourceTimestamp.toISOString()}`,
    };
  }
  await db
    .update(candleObservations)
    .set({
      open: input.open,
      high: input.high,
      low: input.low,
      close: input.close,
      volume: input.volume,
      finalized: input.finalized,
      finalizedAt: input.finalized ? input.sourceTimestamp : existing.finalizedAt,
      sourceEventId: input.sourceEventId ?? existing.sourceEventId,
      sourceTimestamp: input.sourceTimestamp,
      receivedAt: input.receivedAt,
      dataAvailableAt,
    })
    .where(eq(candleObservations.id, existing.id));
  const [row] = await db
    .select()
    .from(candleObservations)
    .where(eq(candleObservations.id, existing.id))
    .limit(1);
  return { status: 'updated', candle: row! };
}

async function currentBucket(
  productId: string,
  granularitySeconds: number,
  bucketStart: Date,
): Promise<CandleObservationRow | null> {
  const rows = await db
    .select()
    .from(candleObservations)
    .where(
      and(
        eq(candleObservations.productId, productId),
        eq(candleObservations.granularitySeconds, granularitySeconds),
        eq(candleObservations.bucketStart, bucketStart),
      ),
    );
  if (rows.length === 0) return null;
  // The "current" bucket is the highest version (may be a correction).
  return rows.sort((a, b) => b.version - a.version)[0];
}

export async function getLatestFinalizedCandle(
  productId: string,
  granularitySeconds = 300,
): Promise<CandleObservationRow | null> {
  const rows = await db
    .select()
    .from(candleObservations)
    .where(
      and(
        eq(candleObservations.productId, productId),
        eq(candleObservations.granularitySeconds, granularitySeconds),
        eq(candleObservations.finalized, true),
      ),
    )
    .orderBy(candleObservations.bucketStart);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

export async function getFormingCandle(
  productId: string,
  granularitySeconds = 300,
): Promise<CandleObservationRow | null> {
  const rows = await db
    .select()
    .from(candleObservations)
    .where(
      and(
        eq(candleObservations.productId, productId),
        eq(candleObservations.granularitySeconds, granularitySeconds),
        eq(candleObservations.finalized, false),
      ),
    )
    .orderBy(candleObservations.bucketStart);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

/**
 * Detect a missing bucket between the last finalized bucket and the
 * newly-received `nextBucketStart`. If `next` is not exactly one
 * granularity step past the last, insert a `market_data_gaps` row.
 */
export async function detectMissingBucket(
  productId: string,
  granularitySeconds: number,
  nextBucketStart: Date,
): Promise<void> {
  const last = await getLatestFinalizedCandle(productId, granularitySeconds);
  if (!last) return;
  const expected = new Date(last.bucketStart.getTime() + granularitySeconds * 1000);
  if (expected.getTime() < nextBucketStart.getTime()) {
    await db.insert(marketDataGaps).values({
      channel: 'candles',
      productId,
      detectedAt: new Date(),
      lastKnownEventAt: last.bucketStart,
      gapType: 'missing_candle_bucket',
      state: 'open',
    });
  }
}
