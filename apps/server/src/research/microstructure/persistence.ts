import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  executionCostObserverSnapshots,
  marketImpactCurves,
  microstructureFeatureDefinitions,
  microstructureFeatureValues,
  orderBookEvents,
  orderBookGaps,
  orderBookLevels,
  orderBookSessions,
  orderBookSnapshots,
  passiveFillEstimates,
  tradeFlowWindows,
  type ExecutionCostObserverSnapshotRow,
  type MarketImpactCurveRow,
  type MicrostructureFeatureDefinitionRow,
  type MicrostructureFeatureValueRow,
  type OrderBookEventRow,
  type OrderBookGapRow,
  type OrderBookLevelRow,
  type OrderBookSessionRow,
  type OrderBookSnapshotRow,
  type PassiveFillEstimateRow,
  type TradeFlowWindowRow,
} from '../../db/schema';
import type { BookSnapshot } from './bookEngine';
import type { ExecutionCostObserverResult, ImpactCurveResult, PassiveFillResult } from './executionCost';
import type { MsFeatureDef, MsFeatureResult } from './features';
import { MS_FEATURE_MODEL_VERSION, MS_FEATURE_REGISTRY } from './features';
import type { FlowWindow } from './flow';
import type { MarketDepthEvent } from './provider';

/**
 * Phase 2D §M — persistence surface for the microstructure observer.
 *
 * Every write is idempotent given the same input:
 *
 *   - Book events are keyed by (sessionId, sequence, eventType, payloadHash)
 *     via the unique index in migration 0017.
 *   - Book snapshots are keyed by (sessionId, sequence).
 *   - Book levels are keyed by (snapshotId, side, levelIndex).
 *   - Feature definitions are keyed by (featureKey, featureVersion).
 *   - Feature values are keyed by (snapshotId, featureKey, featureVersion).
 *   - Trade-flow windows are keyed by (sessionId, windowStart, windowEnd).
 *
 * Deterministic replay may call the same persistence helper twice with the
 * same input and MUST get the same row back — never a duplicate.
 */

// ---------------------------------------------------------------------------
// Feature definitions
// ---------------------------------------------------------------------------

function featureDefinitionHash(d: MsFeatureDef): string {
  return createHash('sha256')
    .update(JSON.stringify({ k: d.key, v: d.version, f: d.family, u: d.unit, desc: d.description }))
    .digest('hex');
}

export async function registerMsFeatureDefinition(def: MsFeatureDef): Promise<MicrostructureFeatureDefinitionRow> {
  const hash = featureDefinitionHash(def);
  const existing = await db
    .select()
    .from(microstructureFeatureDefinitions)
    .where(and(eq(microstructureFeatureDefinitions.featureKey, def.key), eq(microstructureFeatureDefinitions.featureVersion, def.version)))
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].implementationHash !== hash) {
      throw new Error(`ms feature ${def.key}@${def.version} implementationHash drift — bump version`);
    }
    return existing[0];
  }
  await db.insert(microstructureFeatureDefinitions).values({
    featureKey: def.key,
    featureVersion: def.version,
    family: def.family,
    description: def.description,
    unit: def.unit,
    implementationHash: hash,
    status: 'observer',
  });
  const [row] = await db
    .select()
    .from(microstructureFeatureDefinitions)
    .where(and(eq(microstructureFeatureDefinitions.featureKey, def.key), eq(microstructureFeatureDefinitions.featureVersion, def.version)))
    .limit(1);
  return row;
}

export async function registerAllMsFeatureDefinitions(): Promise<MicrostructureFeatureDefinitionRow[]> {
  const rows: MicrostructureFeatureDefinitionRow[] = [];
  for (const def of MS_FEATURE_REGISTRY) rows.push(await registerMsFeatureDefinition(def));
  return rows;
}

// ---------------------------------------------------------------------------
// Book session
// ---------------------------------------------------------------------------

export interface PersistBookSessionInput {
  productId: string;
  providerId: string;
  providerVersion: string;
  startedAt: Date;
  state?: OrderBookSessionRow['state'];
}

export async function persistOrderBookSession(input: PersistBookSessionInput): Promise<OrderBookSessionRow> {
  const [{ insertId }] = (await db.insert(orderBookSessions).values({
    productId: input.productId,
    providerId: input.providerId,
    providerVersion: input.providerVersion,
    startedAt: input.startedAt,
    state: input.state ?? 'synchronizing',
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(orderBookSessions).where(eq(orderBookSessions.id, insertId)).limit(1);
  return row;
}

export async function updateOrderBookSessionState(
  sessionId: number,
  patch: {
    state?: OrderBookSessionRow['state'];
    latestSnapshotId?: number | null;
    initialSnapshotId?: number | null;
    endedAt?: Date | null;
    sequenceNext?: number | null;
  },
): Promise<void> {
  await db.update(orderBookSessions).set(patch).where(eq(orderBookSessions.id, sessionId));
}

// ---------------------------------------------------------------------------
// Book events
// ---------------------------------------------------------------------------

function eventTypeColumn(kind: MarketDepthEvent['kind']): 'snapshot' | 'delta' | 'trade' | 'heartbeat' | 'gap' {
  return kind;
}

function eventSideColumn(ev: MarketDepthEvent): 'bid' | 'ask' | 'trade' | 'none' {
  if (ev.kind === 'trade') return 'trade';
  if (ev.levels && ev.levels.length === 1) return ev.levels[0].side;
  return 'none';
}

export async function persistOrderBookEvent(sessionId: number, ev: MarketDepthEvent): Promise<OrderBookEventRow> {
  const eventType = eventTypeColumn(ev.kind);
  const side = eventSideColumn(ev);
  const price =
    ev.kind === 'trade' && ev.trade
      ? ev.trade.price
      : ev.levels && ev.levels.length === 1
        ? ev.levels[0].price
        : null;
  const size =
    ev.kind === 'trade' && ev.trade
      ? ev.trade.size
      : ev.levels && ev.levels.length === 1
        ? ev.levels[0].size
        : null;
  const aggregatedLevelCount = ev.levels ? ev.levels.length : null;
  // Idempotent via (sessionId, sequence, eventType, payloadHash) unique index.
  const existing = await db
    .select()
    .from(orderBookEvents)
    .where(
      and(
        eq(orderBookEvents.sessionId, sessionId),
        eq(orderBookEvents.sequence, ev.sequence),
        eq(orderBookEvents.eventType, eventType),
        eq(orderBookEvents.payloadHash, ev.payloadHash),
      ),
    )
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(orderBookEvents).values({
    sessionId,
    sequence: ev.sequence,
    eventType,
    side,
    price,
    size,
    aggregatedLevelCount,
    payloadHash: ev.payloadHash,
    sourceTimestamp: ev.sourceTimestamp,
    receivedAt: ev.receivedAt,
    dataAvailableAt: ev.dataAvailableAt,
  });
  const [row] = await db
    .select()
    .from(orderBookEvents)
    .where(
      and(
        eq(orderBookEvents.sessionId, sessionId),
        eq(orderBookEvents.sequence, ev.sequence),
        eq(orderBookEvents.eventType, eventType),
        eq(orderBookEvents.payloadHash, ev.payloadHash),
      ),
    )
    .limit(1);
  return row;
}

export async function persistOrderBookEvents(
  sessionId: number,
  events: readonly MarketDepthEvent[],
): Promise<OrderBookEventRow[]> {
  const rows: OrderBookEventRow[] = [];
  for (const ev of events) rows.push(await persistOrderBookEvent(sessionId, ev));
  return rows;
}

// ---------------------------------------------------------------------------
// Book gaps
// ---------------------------------------------------------------------------

export interface PersistOrderBookGapInput {
  sessionId: number;
  expectedSequence: number;
  observedSequence: number;
  missingCount: number;
  detectedAt: Date;
  resolvedAt?: Date | null;
  resolution?: OrderBookGapRow['resolution'];
}

export async function persistOrderBookGap(input: PersistOrderBookGapInput): Promise<OrderBookGapRow> {
  // Idempotent: same (sessionId, expectedSequence, observedSequence).
  const existing = await db
    .select()
    .from(orderBookGaps)
    .where(
      and(
        eq(orderBookGaps.sessionId, input.sessionId),
        eq(orderBookGaps.expectedSequence, input.expectedSequence),
        eq(orderBookGaps.observedSequence, input.observedSequence),
      ),
    )
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(orderBookGaps).values({
    sessionId: input.sessionId,
    expectedSequence: input.expectedSequence,
    observedSequence: input.observedSequence,
    missingCount: input.missingCount,
    detectedAt: input.detectedAt,
    resolvedAt: input.resolvedAt ?? null,
    resolution: input.resolution ?? 'pending',
  });
  const [row] = await db
    .select()
    .from(orderBookGaps)
    .where(
      and(
        eq(orderBookGaps.sessionId, input.sessionId),
        eq(orderBookGaps.expectedSequence, input.expectedSequence),
        eq(orderBookGaps.observedSequence, input.observedSequence),
      ),
    )
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Book snapshot + levels
// ---------------------------------------------------------------------------

function cumulativeQuote(levels: readonly { price: number; size: number }[]): number {
  let total = 0;
  for (const l of levels) total += l.price * l.size;
  return total;
}

export interface PersistBookSnapshotResult {
  snapshot: OrderBookSnapshotRow;
  levels: OrderBookLevelRow[];
}

export async function persistBookSnapshot(sessionId: number, snap: BookSnapshot): Promise<PersistBookSnapshotResult> {
  // Idempotent via unique (sessionId, sequence).
  const existing = await db
    .select()
    .from(orderBookSnapshots)
    .where(and(eq(orderBookSnapshots.sessionId, sessionId), eq(orderBookSnapshots.sequence, snap.sequence)))
    .limit(1);
  let snapshotRow: OrderBookSnapshotRow;
  if (existing.length > 0) {
    snapshotRow = existing[0];
  } else {
    const mid = snap.bids[0] && snap.asks[0] ? (snap.bids[0].price + snap.asks[0].price) / 2 : null;
    const spread = snap.bids[0] && snap.asks[0] ? snap.asks[0].price - snap.bids[0].price : null;
    const spreadBps = mid != null && spread != null && mid > 0 ? (spread / snap.bids[0].price) * 10_000 : null;
    const bidDepthQuote = cumulativeQuote(snap.bids);
    const askDepthQuote = cumulativeQuote(snap.asks);
    await db.insert(orderBookSnapshots).values({
      sessionId,
      sequence: snap.sequence,
      bestBid: snap.bids[0] != null ? snap.bids[0].price.toString() : null,
      bestAsk: snap.asks[0] != null ? snap.asks[0].price.toString() : null,
      midprice: mid != null ? mid.toString() : null,
      quotedSpread: spread != null ? spread.toString() : null,
      spreadBps: spreadBps != null ? spreadBps.toFixed(6) : null,
      bidLevels: snap.bids.length,
      askLevels: snap.asks.length,
      bidDepthQuote: bidDepthQuote.toFixed(10),
      askDepthQuote: askDepthQuote.toFixed(10),
      bookHealth: snap.bookHealth,
      staleAgeMs: snap.staleAgeMs != null ? Math.floor(snap.staleAgeMs) : null,
      payloadHash: snap.payloadHash,
      observedAt: snap.observedAt,
      dataAvailableAt: snap.dataAvailableAt,
    });
    const [row] = await db
      .select()
      .from(orderBookSnapshots)
      .where(and(eq(orderBookSnapshots.sessionId, sessionId), eq(orderBookSnapshots.sequence, snap.sequence)))
      .limit(1);
    snapshotRow = row;
  }
  const existingLevels = await db
    .select()
    .from(orderBookLevels)
    .where(eq(orderBookLevels.snapshotId, snapshotRow.id));
  if (existingLevels.length > 0) return { snapshot: snapshotRow, levels: existingLevels };
  const inserts: Array<{ side: 'bid' | 'ask'; levelIndex: number; price: string; size: string; cumulativeSize: string; cumulativeQuote: string }> = [];
  let cSize = 0;
  let cQuote = 0;
  for (let i = 0; i < snap.bids.length; i += 1) {
    const l = snap.bids[i];
    cSize += l.size;
    cQuote += l.price * l.size;
    inserts.push({
      side: 'bid',
      levelIndex: i,
      price: l.price.toString(),
      size: l.size.toString(),
      cumulativeSize: cSize.toFixed(10),
      cumulativeQuote: cQuote.toFixed(10),
    });
  }
  cSize = 0;
  cQuote = 0;
  for (let i = 0; i < snap.asks.length; i += 1) {
    const l = snap.asks[i];
    cSize += l.size;
    cQuote += l.price * l.size;
    inserts.push({
      side: 'ask',
      levelIndex: i,
      price: l.price.toString(),
      size: l.size.toString(),
      cumulativeSize: cSize.toFixed(10),
      cumulativeQuote: cQuote.toFixed(10),
    });
  }
  for (const ins of inserts) {
    await db.insert(orderBookLevels).values({ snapshotId: snapshotRow.id, ...ins });
  }
  const levels = await db
    .select()
    .from(orderBookLevels)
    .where(eq(orderBookLevels.snapshotId, snapshotRow.id));
  return { snapshot: snapshotRow, levels };
}

// ---------------------------------------------------------------------------
// Feature values
// ---------------------------------------------------------------------------

export async function persistFeatureValue(
  snapshotId: number,
  result: MsFeatureResult,
  observedAt: Date,
  dataAvailableAt: Date,
): Promise<MicrostructureFeatureValueRow> {
  const inputHash = createHash('sha256')
    .update(JSON.stringify({ s: snapshotId, k: result.featureKey, v: result.featureVersion }))
    .digest('hex');
  const existing = await db
    .select()
    .from(microstructureFeatureValues)
    .where(
      and(
        eq(microstructureFeatureValues.snapshotId, snapshotId),
        eq(microstructureFeatureValues.featureKey, result.featureKey),
        eq(microstructureFeatureValues.featureVersion, result.featureVersion),
      ),
    )
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(microstructureFeatureValues).values({
    snapshotId,
    featureKey: result.featureKey,
    featureVersion: result.featureVersion,
    status: result.status,
    value: result.value != null && Number.isFinite(result.value) ? result.value.toFixed(12) : null,
    confidence: result.confidence != null ? result.confidence.toFixed(4) : null,
    sampleCount: result.sampleCount,
    inputHash,
    observedAt,
    dataAvailableAt,
    failureReason: result.failureReason,
    diagnostics: result.diagnostics ? JSON.stringify(result.diagnostics) : null,
  });
  const [row] = await db
    .select()
    .from(microstructureFeatureValues)
    .where(
      and(
        eq(microstructureFeatureValues.snapshotId, snapshotId),
        eq(microstructureFeatureValues.featureKey, result.featureKey),
        eq(microstructureFeatureValues.featureVersion, result.featureVersion),
      ),
    )
    .limit(1);
  return row;
}

export async function persistFeatureValues(
  snapshotId: number,
  results: readonly MsFeatureResult[],
  observedAt: Date,
  dataAvailableAt: Date,
): Promise<MicrostructureFeatureValueRow[]> {
  const rows: MicrostructureFeatureValueRow[] = [];
  for (const r of results) rows.push(await persistFeatureValue(snapshotId, r, observedAt, dataAvailableAt));
  return rows;
}

// ---------------------------------------------------------------------------
// Trade-flow window
// ---------------------------------------------------------------------------

export async function persistTradeFlowWindow(sessionId: number, w: FlowWindow): Promise<TradeFlowWindowRow> {
  const existing = await db
    .select()
    .from(tradeFlowWindows)
    .where(
      and(
        eq(tradeFlowWindows.sessionId, sessionId),
        eq(tradeFlowWindows.windowStart, w.windowStart),
        eq(tradeFlowWindows.windowEnd, w.windowEnd),
      ),
    )
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(tradeFlowWindows).values({
    sessionId,
    windowStart: w.windowStart,
    windowEnd: w.windowEnd,
    buyerVolume: w.buyerVolume.toFixed(10),
    sellerVolume: w.sellerVolume.toFixed(10),
    unknownVolume: w.unknownVolume.toFixed(10),
    cvd: w.cvd.toFixed(10),
    imbalance: w.imbalance != null ? w.imbalance.toFixed(6) : null,
    classifierVersion: w.classifierVersion,
    windowPolicyVersion: w.windowPolicyVersion,
    status: w.status,
    dataAvailableAt: w.dataAvailableAt,
  });
  const [row] = await db
    .select()
    .from(tradeFlowWindows)
    .where(
      and(
        eq(tradeFlowWindows.sessionId, sessionId),
        eq(tradeFlowWindows.windowStart, w.windowStart),
        eq(tradeFlowWindows.windowEnd, w.windowEnd),
      ),
    )
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Passive fill estimate
// ---------------------------------------------------------------------------

export async function persistPassiveFillEstimate(snapshotId: number, r: PassiveFillResult): Promise<PassiveFillEstimateRow> {
  await db.insert(passiveFillEstimates).values({
    bookSnapshotId: snapshotId,
    side: r.side,
    limitPrice: r.limitPrice.toString(),
    visibleSizeAhead: r.visibleSizeAhead != null ? r.visibleSizeAhead.toFixed(10) : null,
    state: r.state,
    confidence: r.confidence.toFixed(4),
    modelVersion: r.modelVersion,
    diagnostics: r.reason,
  });
  const rows = await db
    .select()
    .from(passiveFillEstimates)
    .where(eq(passiveFillEstimates.bookSnapshotId, snapshotId));
  return rows[rows.length - 1];
}

// ---------------------------------------------------------------------------
// Market impact curve
// ---------------------------------------------------------------------------

export async function persistMarketImpactCurve(snapshotId: number, r: ImpactCurveResult): Promise<MarketImpactCurveRow[]> {
  const inserted: MarketImpactCurveRow[] = [];
  for (const p of r.points) {
    // Idempotent: skip if same (snapshotId, side, notional) exists.
    const existing = await db
      .select()
      .from(marketImpactCurves)
      .where(
        and(
          eq(marketImpactCurves.bookSnapshotId, snapshotId),
          eq(marketImpactCurves.side, r.side),
          eq(marketImpactCurves.notional, p.notional.toFixed(10)),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      inserted.push(existing[0]);
      continue;
    }
    await db.insert(marketImpactCurves).values({
      bookSnapshotId: snapshotId,
      side: r.side,
      notional: p.notional.toFixed(10),
      filledNotional: p.filledNotional.toFixed(10),
      unfilledNotional: p.unfilledNotional.toFixed(10),
      avgFillPrice: p.avgFillPrice != null ? p.avgFillPrice.toString() : null,
      impactBps: p.impactBps != null ? p.impactBps.toFixed(6) : null,
      extrapolated: p.extrapolated,
      monotonic: r.monotonic,
      modelVersion: r.modelVersion,
    });
    const [row] = await db
      .select()
      .from(marketImpactCurves)
      .where(
        and(
          eq(marketImpactCurves.bookSnapshotId, snapshotId),
          eq(marketImpactCurves.side, r.side),
          eq(marketImpactCurves.notional, p.notional.toFixed(10)),
        ),
      )
      .limit(1);
    inserted.push(row);
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Execution cost snapshot
// ---------------------------------------------------------------------------

export async function persistExecutionCostObserverSnapshot(
  snapshotId: number,
  r: ExecutionCostObserverResult,
): Promise<ExecutionCostObserverSnapshotRow> {
  // Idempotent via inputHash: skip if a row with the same inputHash exists for this snapshot.
  const existing = await db
    .select()
    .from(executionCostObserverSnapshots)
    .where(
      and(
        eq(executionCostObserverSnapshots.bookSnapshotId, snapshotId),
        eq(executionCostObserverSnapshots.inputHash, r.inputHash),
      ),
    )
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(executionCostObserverSnapshots).values({
    bookSnapshotId: snapshotId,
    entryNotional: r.entryNotional.toFixed(10),
    marketableVWAP: r.marketableVWAP != null ? r.marketableVWAP.toString() : null,
    passiveLimitPrice: r.passiveLimitPrice != null ? r.passiveLimitPrice.toString() : null,
    estimatedSpreadCost: r.estimatedSpreadCost != null ? r.estimatedSpreadCost.toFixed(10) : null,
    estimatedImpact: r.estimatedImpact != null ? r.estimatedImpact.toFixed(10) : null,
    estimatedLatencyCost: r.estimatedLatencyCost != null ? r.estimatedLatencyCost.toFixed(10) : null,
    estimatedFee: r.estimatedFee != null ? r.estimatedFee.toFixed(10) : null,
    estimatedFillProbability: r.estimatedFillProbability != null ? r.estimatedFillProbability.toFixed(4) : null,
    estimatedUnfilledProbability: r.estimatedUnfilledProbability != null ? r.estimatedUnfilledProbability.toFixed(4) : null,
    estimatedPartialFillProbability: r.estimatedPartialFillProbability != null ? r.estimatedPartialFillProbability.toFixed(4) : null,
    estimatedQueueUncertainty: r.estimatedQueueUncertainty != null ? r.estimatedQueueUncertainty.toFixed(4) : null,
    estimatedStopExecutionCost: r.estimatedStopExecutionCost != null ? r.estimatedStopExecutionCost.toFixed(10) : null,
    isBookAware: r.isBookAware,
    modelVersion: r.modelVersion,
    inputHash: r.inputHash,
    observedAt: r.observedAt,
    dataAvailableAt: r.dataAvailableAt,
  });
  const [row] = await db
    .select()
    .from(executionCostObserverSnapshots)
    .where(
      and(
        eq(executionCostObserverSnapshots.bookSnapshotId, snapshotId),
        eq(executionCostObserverSnapshots.inputHash, r.inputHash),
      ),
    )
    .limit(1);
  return row;
}

void MS_FEATURE_MODEL_VERSION;
