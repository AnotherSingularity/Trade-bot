import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import {
  marketDataEvents,
  type MarketDataEventRow,
} from '../db/schema';

/**
 * Phase 1.2 §C — MarketEventEnvelope normalization.
 *
 * Every WebSocket or REST observation entering Horizon is normalized
 * into this envelope BEFORE being consumed by anything else. The
 * envelope preserves:
 *   - Coinbase's original `sourceTimestamp`
 *   - our local `receivedAt` and `dataAvailableAt` (which is never
 *     earlier than `receivedAt`)
 *   - a deterministic `payloadHash` used to dedupe exact replays
 *   - the sanitized `normalizedPayload` (JSON string; unknown fields
 *     preserved as-is)
 *
 * A malformed message is recorded with `validationStatus='rejected_malformed'`
 * — never treated as valid market state. An unknown message type is
 * recorded with `validationStatus='rejected_unknown'` — again, not
 * treated as market state. Exact repeats hit the UNIQUE(payloadHash)
 * index and land as `validationStatus='duplicate'` in the return.
 */

export const MARKET_ENVELOPE_SCHEMA_VERSION = 'p1_2-envelope-1';

export interface RawMarketMessage {
  source: string;                    // 'coinbase-ws' | 'coinbase-rest'
  channel: string;                   // 'ticker' | 'candles' | 'heartbeats' | ...
  eventType: string;                 // 'update' | 'snapshot' | 'heartbeat' | ...
  productId?: string | null;
  sourceTimestamp: Date;
  receivedAt: Date;
  connectionId?: number | null;
  sequenceNumber?: number | null;
  /** Arbitrary payload. Unknown fields MUST be preserved. */
  payload: unknown;
}

export type EnvelopeResult =
  | { status: 'inserted'; envelope: MarketDataEventRow }
  | { status: 'duplicate'; envelope: MarketDataEventRow }
  | { status: 'malformed'; envelope: MarketDataEventRow; reason: string }
  | { status: 'unknown'; envelope: MarketDataEventRow; reason: string };

const KNOWN_CHANNELS = new Set(['heartbeats', 'status', 'ticker', 'candles', 'market_trades']);
const KNOWN_EVENT_TYPES = new Set(['update', 'snapshot', 'heartbeat', 'status', 'trade']);

export async function acceptMarketMessage(msg: RawMarketMessage): Promise<EnvelopeResult> {
  const now = new Date();
  const dataAvailableAt = msg.receivedAt.getTime() > now.getTime() ? now : msg.receivedAt;
  const payloadJson = safeSerialize(msg.payload);
  const invalidTs = Number.isNaN(msg.sourceTimestamp.getTime());
  const tsKey = invalidTs ? '__invalid_ts__' : msg.sourceTimestamp.toISOString();
  const payloadHash = createHash('sha256')
    .update(
      [
        msg.source,
        msg.channel,
        msg.productId ?? '',
        tsKey,
        msg.sequenceNumber ?? '',
        payloadJson,
      ].join('|'),
    )
    .digest('hex');

  // Detect duplicates via unique index.
  const existing = await db
    .select()
    .from(marketDataEvents)
    .where(eq(marketDataEvents.payloadHash, payloadHash))
    .limit(1);
  if (existing.length > 0) {
    return { status: 'duplicate', envelope: existing[0] };
  }

  let validationStatus: MarketDataEventRow['validationStatus'] = 'valid';
  let failureReason: string | null = null;
  if (!KNOWN_CHANNELS.has(msg.channel)) {
    validationStatus = 'rejected_unknown';
    failureReason = `unknown channel: ${msg.channel}`;
  } else if (!KNOWN_EVENT_TYPES.has(msg.eventType)) {
    validationStatus = 'rejected_unknown';
    failureReason = `unknown eventType: ${msg.eventType}`;
  } else if (payloadJson.length === 0 || payloadJson === 'null') {
    validationStatus = 'rejected_malformed';
    failureReason = 'empty payload';
  } else if (invalidTs) {
    validationStatus = 'rejected_malformed';
    failureReason = 'invalid sourceTimestamp';
  }

  // For persistence: replace invalid sourceTimestamp with receivedAt so the
  // DB never sees a NaN. The rejected_malformed status preserves the audit trail.
  const persistedSourceTs = invalidTs ? msg.receivedAt : msg.sourceTimestamp;
  const eventId = `${msg.channel}:${msg.productId ?? '_'}:${tsKey}:${msg.sequenceNumber ?? '_'}`;

  const [{ insertId }] = (await db.insert(marketDataEvents).values({
    eventId,
    source: msg.source,
    channel: msg.channel,
    productId: msg.productId ?? null,
    sourceTimestamp: persistedSourceTs,
    receivedAt: msg.receivedAt,
    dataAvailableAt,
    connectionId: msg.connectionId ?? null,
    sequenceNumber: msg.sequenceNumber ?? null,
    eventType: msg.eventType,
    schemaVersion: MARKET_ENVELOPE_SCHEMA_VERSION,
    payloadHash,
    normalizedPayload: payloadJson,
    validationStatus,
    failureReason,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(marketDataEvents)
    .where(eq(marketDataEvents.id, insertId))
    .limit(1);
  if (validationStatus === 'rejected_malformed') {
    return { status: 'malformed', envelope: row!, reason: failureReason! };
  }
  if (validationStatus === 'rejected_unknown') {
    return { status: 'unknown', envelope: row!, reason: failureReason! };
  }
  return { status: 'inserted', envelope: row! };
}

function safeSerialize(value: unknown): string {
  if (value == null) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    return `"__unserializable__"`;
  }
}

/** For tests / diagnostics — dedupe a specific hash. */
export async function findEnvelopeByHash(hash: string): Promise<MarketDataEventRow | null> {
  const [row] = await db
    .select()
    .from(marketDataEvents)
    .where(eq(marketDataEvents.payloadHash, hash))
    .limit(1);
  return row ?? null;
}

/** Read the last envelope per (channel, product) — used by health checks. */
export async function lastEnvelope(
  channel: string,
  productId: string | null,
): Promise<MarketDataEventRow | null> {
  const rows = await db
    .select()
    .from(marketDataEvents)
    .where(
      productId
        ? and(eq(marketDataEvents.channel, channel), eq(marketDataEvents.productId, productId))
        : eq(marketDataEvents.channel, channel),
    )
    .orderBy(marketDataEvents.sourceTimestamp)
    .limit(1);
  return rows[0] ?? null;
}
