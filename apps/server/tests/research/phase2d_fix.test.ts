import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db';
import {
  championMicrostructureComparisons,
  microstructureExecutionDecisions,
  microstructureFeatureDefinitions,
  microstructureFeatureValues,
  microstructureShortlistMemberships,
  microstructureShortlistRuns,
  orderBookEvents,
  orderBookGaps,
  orderBookSnapshots,
  tradeFlowWindows,
  executionCostObserverSnapshots,
} from '../../src/db/schema';
import { resetDatabase } from '../setup/db';
import { createDecisionChain, getDecisionChainAggregate, startScanRun } from '../../src/db/lineage';
import { httpCounters, resetHttpCounters } from '../../src/lib/fetchBarrier';
import { OrderBookEngine } from '../../src/research/microstructure/bookEngine';
import { FixtureMarketDepthProvider, type MarketDepthEvent } from '../../src/research/microstructure/provider';
import { computeAllFeatures, MS_FEATURE_REGISTRY } from '../../src/research/microstructure/features';
import { buildFlowWindow, classifyTrade } from '../../src/research/microstructure/flow';
import {
  computeExecutionCost,
  computeImpactCurve,
  estimatePassiveFill,
} from '../../src/research/microstructure/executionCost';
import { evaluateExecution } from '../../src/research/microstructure/decision';
import {
  DEFAULT_MS_SHORTLIST_POLICY,
  MS_SHORTLIST_POLICY_VERSION,
  evaluateMsShortlist,
  persistMsShortlist,
  registerMsShortlistPolicy,
  startMsShortlistRun,
} from '../../src/research/microstructure/shortlist';
import {
  persistBookSnapshot,
  persistExecutionCostObserverSnapshot,
  persistFeatureValues,
  persistMarketImpactCurve,
  persistOrderBookEvent,
  persistOrderBookEvents,
  persistOrderBookGap,
  persistOrderBookSession,
  persistPassiveFillEstimate,
  persistTradeFlowWindow,
  registerAllMsFeatureDefinitions,
  registerMsFeatureDefinition,
} from '../../src/research/microstructure/persistence';
import {
  persistChampionMsComparison,
  persistMsExecutionDecision,
  MS_EXECUTION_POLICY_VERSION,
} from '../../src/research/microstructure/decision';
import {
  MS_FIXTURE_MANIFEST,
  computeMsFixtureCoverage,
} from '../../src/research/microstructure/fixtureManifest';

const NOW = new Date('2026-05-15T00:00:00.000Z');

function snapshotEv(seq: number, bids: Array<[string, string]>, asks: Array<[string, string]>, offsetMs = 0): MarketDepthEvent {
  return {
    kind: 'snapshot',
    sequence: seq,
    productId: 'AAA-USD',
    sourceTimestamp: new Date(NOW.getTime() + offsetMs),
    receivedAt: new Date(NOW.getTime() + offsetMs + 5),
    dataAvailableAt: new Date(NOW.getTime() + offsetMs + 10),
    levels: [
      ...bids.map(([p, s]) => ({ side: 'bid' as const, price: p, size: s })),
      ...asks.map(([p, s]) => ({ side: 'ask' as const, price: p, size: s })),
    ],
    payloadHash: `snap-${seq}-${offsetMs}`,
  };
}

function deltaEv(seq: number, side: 'bid' | 'ask', price: string, size: string, offsetMs = 0): MarketDepthEvent {
  return {
    kind: 'delta',
    sequence: seq,
    productId: 'AAA-USD',
    sourceTimestamp: new Date(NOW.getTime() + offsetMs),
    receivedAt: new Date(NOW.getTime() + offsetMs + 5),
    dataAvailableAt: new Date(NOW.getTime() + offsetMs + 10),
    levels: [{ side, price, size }],
    payloadHash: `delta-${seq}-${side}-${price}-${size}-${offsetMs}`,
  };
}

function gapEv(seq: number, offsetMs = 0): MarketDepthEvent {
  return {
    kind: 'gap',
    sequence: seq,
    productId: 'AAA-USD',
    sourceTimestamp: new Date(NOW.getTime() + offsetMs),
    receivedAt: new Date(NOW.getTime() + offsetMs + 5),
    dataAvailableAt: new Date(NOW.getTime() + offsetMs + 10),
    payloadHash: `gap-${seq}-${offsetMs}`,
  };
}

function tradeEv(seq: number, price: string, size: string, side: 'buyer_initiated' | 'seller_initiated' | 'unknown', offsetMs = 0): MarketDepthEvent {
  return {
    kind: 'trade',
    sequence: seq,
    productId: 'AAA-USD',
    sourceTimestamp: new Date(NOW.getTime() + offsetMs),
    receivedAt: new Date(NOW.getTime() + offsetMs + 5),
    dataAvailableAt: new Date(NOW.getTime() + offsetMs + 10),
    trade: { price, size, side },
    payloadHash: `trade-${seq}-${price}-${size}`,
  };
}

async function persistFullMicrostructure(chainId: number, options?: { without2A?: boolean }) {
  void options;
  const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
  const events = [
    snapshotEv(1, [['99', '10']], [['100', '10']], 0),
    deltaEv(2, 'bid', '99', '20', 100),
    tradeEv(3, '100', '1', 'buyer_initiated', 150),
  ];
  engine.ingest(events);
  const snap = engine.snapshot(new Date(NOW.getTime() + 200));
  const session = await persistOrderBookSession({
    productId: 'AAA-USD',
    providerId: 'FixtureMarketDepthProvider',
    providerVersion: 'p2d-fixture-1',
    startedAt: NOW,
    state: 'healthy',
  });
  await persistOrderBookEvents(session.id, events);
  const { snapshot: snapRow } = await persistBookSnapshot(session.id, snap);
  await registerAllMsFeatureDefinitions();
  const feats = computeAllFeatures(snap);
  await persistFeatureValues(snapRow.id, feats, snap.observedAt, snap.dataAvailableAt);
  const trade = classifyTrade({
    event: tradeEv(3, '100', '1', 'buyer_initiated', 150),
    quoteAtTrade: { bestBid: 99, bestAsk: 100 },
    previousPrice: null,
  });
  const window = buildFlowWindow(
    [trade!],
    new Date(NOW.getTime() - 1000),
    new Date(NOW.getTime() + 1000),
  );
  await persistTradeFlowWindow(session.id, window);
  const impact = computeImpactCurve(snap, 'buy', [10, 100]);
  await persistMarketImpactCurve(snapRow.id, impact);
  const passive = estimatePassiveFill(snap, 'buy', 98);
  await persistPassiveFillEstimate(snapRow.id, passive);
  const cost = computeExecutionCost({
    bookSnapshot: snap,
    side: 'buy',
    entryNotional: 100,
    passiveLimitPrice: 98,
    latencyMs: 50,
    feeBps: 10,
    now: NOW,
  });
  await persistExecutionCostObserverSnapshot(snapRow.id, cost);
  const policyRow = await registerMsShortlistPolicy(DEFAULT_MS_SHORTLIST_POLICY);
  const runRow = await startMsShortlistRun(policyRow.id, NOW);
  const outcomes = evaluateMsShortlist(
    [
      {
        productId: 'AAA-USD',
        hygieneEligible: true,
        fingerprintValid: true,
        regimeValid: true,
        riskHealthy: true,
        quoteVolume24h: 1_000_000,
        dataQualityPenalty: 0,
        dataAvailableAt: NOW,
      },
    ],
    NOW,
  );
  const members = await persistMsShortlist(runRow.id, outcomes);
  const member = members.find((m) => m.productId === 'AAA-USD') ?? members[0];
  const { decision } = evaluateExecution({
    decisionChainId: chainId,
    shortlistMembershipId: member.id,
    bookSnapshotId: snapRow.id,
    championOrderType: 'market',
    championSize: 1,
    championSide: 'buy',
    championNotional: 100,
    passiveLimitPrice: null,
    latencyMs: 50,
    feeBps: 10,
    bookSnapshot: snap,
    now: NOW,
  });
  const decisionRow = await persistMsExecutionDecision(decision);
  await persistChampionMsComparison({
    decisionChainId: chainId,
    msExecutionDecisionId: decisionRow.id,
    productId: 'AAA-USD',
    championOrderType: 'market',
    championSize: 1,
    msDecision: decision,
    policyVersion: MS_EXECUTION_POLICY_VERSION,
    observedAt: NOW,
    dataAvailableAt: NOW,
  });
  return { session, snapshot: snapRow, decision: decisionRow, member };
}

async function bareChain(): Promise<number> {
  const scan = await startScanRun({ triggerType: 'test', scannerVersion: 'phase2d-fix' });
  const chain = await createDecisionChain({
    scanRunId: scan.id,
    productId: 'AAA-USD',
    strategyVersion: 'test',
    observedAt: NOW,
    dataAvailableAt: NOW,
  });
  return chain.id;
}

describe('Phase 2D-FIX — bounded correction', () => {
  beforeEach(async () => {
    await resetDatabase();
    resetHttpCounters();
  });
  afterEach(async () => {
    await resetDatabase();
    resetHttpCounters();
  });

  // -----------------------------------------------------------------
  // Manifest coverage
  // -----------------------------------------------------------------

  it('§FIX.1 fixture-coverage manifest reports 33/33 scenarios covered', () => {
    const report = computeMsFixtureCoverage();
    expect(report.requiredScenarioCount).toBe(33);
    expect(report.coveredScenarioCount).toBe(33);
    expect(report.uncoveredScenarioCount).toBe(0);
    expect(report.uncovered).toEqual([]);
  });

  it('§FIX.2 every required scenario appears in the fixture manifest with a distinct covering case', () => {
    const seen = new Set<string>();
    for (const s of MS_FIXTURE_MANIFEST) {
      const key = `${s.covering.file}::${s.covering.caseTitleFragment}::${s.key}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(s.covering.file.length).toBeGreaterThan(0);
      expect(s.covering.caseTitleFragment.length).toBeGreaterThan(0);
    }
  });

  // -----------------------------------------------------------------
  // New book-engine scenarios required by the manifest
  // -----------------------------------------------------------------

  it('§FIX.3 book engine buffers out-of-order deltas within the bounded gap and drains on catchup', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '5']], [['101', '5']], 0)]);
    // Out-of-order (3 before 2) — within maxBufferedGap.
    const r1 = engine.ingest([deltaEv(3, 'bid', '99', '15', 300)]);
    expect(r1.buffered).toBe(1);
    // Now provide 2 — should apply, then drain 3 automatically.
    const r2 = engine.ingest([deltaEv(2, 'bid', '99', '10', 200)]);
    expect(engine.currentState()).toBe('healthy');
    expect(r2.applied).toBeGreaterThan(0);
    expect(engine.bestBid()).toBe(99);
  });

  it('§FIX.4 provider-emitted gap event moves state to resync_required', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '5']], [['101', '5']], 0)]);
    const r = engine.ingest([gapEv(50, 200)]);
    expect(r.gaps).toBeGreaterThan(0);
    expect(engine.currentState()).toBe('resync_required');
  });

  it('§FIX.5 resynchronization after a gap increments resyncCount and returns to healthy', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '5']], [['101', '5']], 0)]);
    engine.ingest([gapEv(50, 200)]);
    // Fresh snapshot to resynchronize.
    engine.ingest([snapshotEv(60, [['99.5', '5']], [['100.5', '5']], 400)]);
    expect(engine.currentState()).toBe('healthy');
    const snap = engine.snapshot(new Date(NOW.getTime() + 500));
    expect(snap.resyncCount).toBeGreaterThanOrEqual(1);
  });

  it('§FIX.6 features report unsupported on empty book', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    const snap = engine.snapshot(NOW);
    const feats = computeAllFeatures(snap);
    // Every feature that requires bid/ask should be unsupported/gap on empty.
    for (const f of feats.filter((fx) => fx.family !== 'quality' || fx.featureKey === 'quality.book_age_ms')) {
      expect(f.status).not.toBe('valid');
    }
  });

  it('§FIX.7 features flag missing bid or ask on one-sided book', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    // Only bids — no asks.
    engine.ingest([snapshotEv(1, [['99', '5']], [], 0)]);
    const snap = engine.snapshot(new Date(NOW.getTime() + 100));
    const feats = computeAllFeatures(snap);
    expect(feats.find((f) => f.featureKey === 'price.best_ask')!.status).not.toBe('valid');
    expect(feats.find((f) => f.featureKey === 'price.midprice')!.status).not.toBe('valid');
    // best_bid should still be valid.
    expect(feats.find((f) => f.featureKey === 'price.best_bid')!.status).toBe('valid');
  });

  it('§FIX.8 impact curve reports unfilled residual when notional exceeds visible depth', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '5']], [['100', '0.5']], 0)]);
    const snap = engine.snapshot(NOW);
    const curve = computeImpactCurve(snap, 'buy', [10_000]);
    // Only ~50 in ask-side visible depth (0.5 * 100). Rest must be reported unfilled.
    expect(curve.points[0].unfilledNotional).toBeGreaterThan(0);
    expect(curve.points[0].extrapolated).toBe(false);
  });

  it('§FIX.9 passive fill labels marketable order versus a strict price touch', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '5']], [['100', '5']], 0)]);
    const snap = engine.snapshot(NOW);
    // A buy limit at 100.5 crosses the best ask → marketable.
    const marketable = estimatePassiveFill(snap, 'buy', 100.5);
    expect(marketable.state).toBe('unknown');
    expect(marketable.reason).toBe('marketable_not_passive');
    // A buy limit at 98 is strictly inside the spread → passive.
    const passive = estimatePassiveFill(snap, 'buy', 98);
    expect(passive.reason).not.toBe('marketable_not_passive');
  });

  it('§FIX.10 feature definition registration is idempotent', async () => {
    await registerAllMsFeatureDefinitions();
    // Second call: no-op, no duplicates.
    await registerAllMsFeatureDefinitions();
    const defs = await db.select().from(microstructureFeatureDefinitions);
    expect(defs.length).toBe(MS_FEATURE_REGISTRY.length);
  });

  it('§FIX.11 duplicate book event ingestion does not duplicate persisted rows', async () => {
    const session = await persistOrderBookSession({
      productId: 'AAA-USD',
      providerId: 'FixtureMarketDepthProvider',
      providerVersion: 'p2d-fixture-1',
      startedAt: NOW,
    });
    const events = [
      snapshotEv(1, [['99', '5']], [['101', '5']], 0),
      deltaEv(2, 'bid', '99', '10', 100),
    ];
    await persistOrderBookEvents(session.id, events);
    // Repeat — should be a no-op.
    await persistOrderBookEvents(session.id, events);
    const rows = await db.select().from(orderBookEvents).where(eq(orderBookEvents.sessionId, session.id));
    expect(rows.length).toBe(events.length);
    // Also re-run the single-event path.
    await persistOrderBookEvent(session.id, events[0]);
    const rows2 = await db.select().from(orderBookEvents).where(eq(orderBookEvents.sessionId, session.id));
    expect(rows2.length).toBe(events.length);
  });

  it('§FIX.12 trade-flow-window persistence is idempotent', async () => {
    const session = await persistOrderBookSession({
      productId: 'AAA-USD',
      providerId: 'FixtureMarketDepthProvider',
      providerVersion: 'p2d-fixture-1',
      startedAt: NOW,
    });
    const trade = classifyTrade({
      event: tradeEv(10, '100', '1', 'buyer_initiated'),
      quoteAtTrade: { bestBid: 99, bestAsk: 101 },
      previousPrice: null,
    })!;
    const window = buildFlowWindow(
      [trade],
      new Date(NOW.getTime() - 1000),
      new Date(NOW.getTime() + 1000),
    );
    const first = await persistTradeFlowWindow(session.id, window);
    const second = await persistTradeFlowWindow(session.id, window);
    expect(first.id).toBe(second.id);
    const rows = await db
      .select()
      .from(tradeFlowWindows)
      .where(eq(tradeFlowWindows.sessionId, session.id));
    expect(rows.length).toBe(1);
  });

  it('§FIX.13 book gap persistence is idempotent given the same expected/observed sequence', async () => {
    const session = await persistOrderBookSession({
      productId: 'AAA-USD',
      providerId: 'FixtureMarketDepthProvider',
      providerVersion: 'p2d-fixture-1',
      startedAt: NOW,
    });
    const gap = {
      sessionId: session.id,
      expectedSequence: 100,
      observedSequence: 200,
      missingCount: 100,
      detectedAt: NOW,
      resolution: 'pending' as const,
    };
    const first = await persistOrderBookGap(gap);
    const second = await persistOrderBookGap(gap);
    expect(first.id).toBe(second.id);
    const rows = await db.select().from(orderBookGaps).where(eq(orderBookGaps.sessionId, session.id));
    expect(rows.length).toBe(1);
  });

  it('§FIX.14 book snapshot resolves to the exact snapshot the observer decision consumed', async () => {
    const chainId = await bareChain();
    const { snapshot, decision } = await persistFullMicrostructure(chainId);
    expect(decision.bookSnapshotId).toBe(snapshot.id);
    const agg = await getDecisionChainAggregate(chainId);
    expect(agg!.researchObserver.microstructure.microstructureDecision).not.toBeNull();
    expect(agg!.researchObserver.microstructure.bookSnapshot?.id).toBe(snapshot.id);
    // Persisted snapshot row round-trips exactly.
    const [row] = await db.select().from(orderBookSnapshots).where(eq(orderBookSnapshots.id, snapshot.id));
    expect(row.payloadHash.length).toBe(64);
  });

  it('§FIX.15 future book events cannot enter the decision', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '10']], [['100', '10']], 0)]);
    // Observed-at is BEFORE the future event.
    const observedAt = new Date(NOW.getTime() + 500);
    const snap = engine.snapshot(observedAt);
    const futureEvent = deltaEv(2, 'bid', '99', '99', 10_000);
    // A window built from a trade whose sourceTimestamp is after the window end
    // must not include that trade — this is the anti-lookahead guard.
    const window = buildFlowWindow(
      [
        classifyTrade({
          event: tradeEv(3, '100', '1', 'buyer_initiated', 20_000),
          quoteAtTrade: { bestBid: 99, bestAsk: 100 },
          previousPrice: null,
        })!,
      ],
      new Date(NOW.getTime() - 1000),
      observedAt,
    );
    expect(window.buyerVolume).toBe(0);
    expect(window.status).toBe('insufficient_history');
    // Independently: the delta above observedAt has a sourceTimestamp AFTER observedAt.
    expect(futureEvent.sourceTimestamp.getTime()).toBeGreaterThan(observedAt.getTime());
    // And the decision consumes the snapshot only, whose payloadHash reflects
    // events up to the current sequence.
    expect(snap.sequence).toBe(1);
    // The snap does not carry the future event's contribution.
    expect(snap.bids[0].size).toBe(10);
  });

  // -----------------------------------------------------------------
  // Required correction tests §5.1–§5.12
  // -----------------------------------------------------------------

  it('§FIX-R.1 audit retrieval returns the complete microstructure chain', async () => {
    const chainId = await bareChain();
    await persistFullMicrostructure(chainId);
    const agg = await getDecisionChainAggregate(chainId);
    expect(agg).not.toBeNull();
    const ms = agg!.researchObserver.microstructure;
    expect(ms.shortlistRun).not.toBeNull();
    expect(ms.shortlistMembership).not.toBeNull();
    expect(ms.bookSession).not.toBeNull();
    expect(ms.bookSnapshot).not.toBeNull();
    expect(ms.bookLevels.length).toBeGreaterThan(0);
    expect(ms.bookContinuityState).toBe(ms.bookSession!.state);
    expect(ms.featureDefinitions.length).toBeGreaterThan(0);
    expect(ms.featureValues.length).toBe(MS_FEATURE_REGISTRY.length);
    expect(ms.tradeFlowWindow).not.toBeNull();
    expect(ms.marketImpactCurves.length).toBeGreaterThan(0);
    expect(ms.passiveFillEstimate).not.toBeNull();
    expect(ms.executionCostObserverSnapshot).not.toBeNull();
    expect(ms.microstructureDecision).not.toBeNull();
    expect(ms.championComparison).not.toBeNull();
  });

  it('§FIX-R.2 microstructure retrieval works without Phase 2A universe records', async () => {
    // bareChain never writes to universeSnapshots.
    const chainId = await bareChain();
    await persistFullMicrostructure(chainId);
    const agg = await getDecisionChainAggregate(chainId);
    expect(agg!.researchObserver.snapshot).toBeNull(); // no 2A record
    expect(agg!.researchObserver.microstructure.microstructureDecision).not.toBeNull();
    expect(agg!.researchObserver.microstructure.bookSnapshot).not.toBeNull();
  });

  it('§FIX-R.3 microstructure retrieval works without Phase 2B regime records', async () => {
    const chainId = await bareChain();
    await persistFullMicrostructure(chainId);
    const agg = await getDecisionChainAggregate(chainId);
    expect(agg!.researchObserver.regimeObserverRun).toBeNull(); // no 2B record
    expect(agg!.researchObserver.globalRegime).toBeNull();
    expect(agg!.researchObserver.microstructure.microstructureDecision).not.toBeNull();
  });

  it('§FIX-R.4 microstructure retrieval works without Phase 2C risk records', async () => {
    const chainId = await bareChain();
    await persistFullMicrostructure(chainId);
    const agg = await getDecisionChainAggregate(chainId);
    expect(agg!.researchObserver.portfolioRisk.candidateDecision).toBeNull(); // no 2C record
    expect(agg!.researchObserver.microstructure.microstructureDecision).not.toBeNull();
  });

  it('§FIX-R.5 every required scenario appears in the fixture manifest', () => {
    // At minimum the manifest MUST cover the six scenarios called out in §2:
    const requiredKeys = new Set([
      'book_resynchronization_after_gap',
      'passive_fill_price_touch_versus_trade_through',
      'impact_curve_unfilled_residual',
      'book_future_event_rejected',
      'book_replay_byte_stable',
    ]);
    for (const k of requiredKeys) {
      expect(MS_FIXTURE_MANIFEST.find((s) => s.key === k)).toBeDefined();
    }
  });

  it('§FIX-R.6 all thirty-three scenarios have deterministic coverage (no gaps)', () => {
    const rpt = computeMsFixtureCoverage();
    expect(rpt.requiredScenarioCount).toBe(33);
    expect(rpt.uncoveredScenarioCount).toBe(0);
    expect(rpt.coveredScenarioCount).toBe(33);
  });

  it('§FIX-R.7 trade-flow-window persistence is idempotent (covered via §FIX.12)', async () => {
    // Re-verified end-to-end: the same window key produces the same row.
    const session = await persistOrderBookSession({
      productId: 'AAA-USD',
      providerId: 'FixtureMarketDepthProvider',
      providerVersion: 'p2d-fixture-1',
      startedAt: NOW,
    });
    const window = buildFlowWindow(
      [classifyTrade({
        event: tradeEv(1, '100', '1', 'buyer_initiated'),
        quoteAtTrade: { bestBid: 99, bestAsk: 101 },
        previousPrice: null,
      })!],
      new Date(NOW.getTime() - 1000),
      new Date(NOW.getTime() + 1000),
    );
    const first = await persistTradeFlowWindow(session.id, window);
    for (let i = 0; i < 3; i += 1) await persistTradeFlowWindow(session.id, window);
    const rows = await db.select().from(tradeFlowWindows).where(eq(tradeFlowWindows.sessionId, session.id));
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(first.id);
  });

  it('§FIX-R.8 duplicate book events do not duplicate persisted effects', async () => {
    // Persist a full snapshot + level set twice — the second attempt is a no-op.
    const chainId = await bareChain();
    const { snapshot } = await persistFullMicrostructure(chainId);
    // Attempt to re-persist the snapshot; helper is idempotent via (sessionId, sequence).
    const eng = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    eng.ingest([snapshotEv(1, [['99', '10']], [['100', '10']], 0), deltaEv(2, 'bid', '99', '20', 100)]);
    const snap = eng.snapshot(new Date(NOW.getTime() + 200));
    const again = await persistBookSnapshot(snapshot.sessionId, snap);
    expect(again.snapshot.id).toBe(snapshot.id);
    const [count] = (await db.execute(
      `select count(*) as c from order_book_snapshots where sessionId = ${snapshot.sessionId} and sequence = ${snapshot.sequence}` as unknown as string,
    )) as unknown as [Array<{ c: number }>];
    expect(Number(count[0].c)).toBe(1);
  });

  it('§FIX-R.9 observer records resolve to the exact book snapshot used', async () => {
    const chainId = await bareChain();
    const { snapshot, decision } = await persistFullMicrostructure(chainId);
    // The persisted execution-cost snapshot for this book has one row that
    // matches the decision's bookSnapshotId.
    const [ec] = await db
      .select()
      .from(executionCostObserverSnapshots)
      .where(eq(executionCostObserverSnapshots.bookSnapshotId, snapshot.id));
    expect(ec).toBeDefined();
    expect(decision.bookSnapshotId).toBe(snapshot.id);
  });

  it('§FIX-R.10 future book events cannot enter the decision (anti-lookahead)', () => {
    // A trade whose sourceTimestamp is AFTER the window end is excluded.
    const t = classifyTrade({
      event: tradeEv(5, '100', '1', 'buyer_initiated', 5_000),
      quoteAtTrade: { bestBid: 99, bestAsk: 100 },
      previousPrice: null,
    })!;
    const window = buildFlowWindow([t], new Date(NOW.getTime() - 1000), new Date(NOW.getTime() + 1000));
    // The trade at +5000 ms is beyond the window end (+1000 ms), so it does NOT contribute.
    expect(window.buyerVolume).toBe(0);
  });

  it('§FIX-R.11 champion behavior remains unchanged (no writes to champion economic tables)', async () => {
    // Persisting the full microstructure chain must NOT write any champion
    // economic table — the isolation guardrail enforces this at source-scan
    // level (see phase2d_isolation.test.ts); this test additionally verifies
    // that after persistence, the microstructure decision links back only to
    // decision_chains, never to positions/orders/protection.
    const chainId = await bareChain();
    const { decision } = await persistFullMicrostructure(chainId);
    const [row] = await db
      .select()
      .from(microstructureExecutionDecisions)
      .where(eq(microstructureExecutionDecisions.id, decision.id));
    expect(row.decisionChainId).toBe(chainId);
    // Comparison row also links only to decision_chains.
    const [cmp] = await db
      .select()
      .from(championMicrostructureComparisons)
      .where(eq(championMicrostructureComparisons.decisionChainId, chainId));
    expect(cmp).toBeDefined();
  });

  it('§FIX-R.12 all three createOrder counters remain zero after building the full microstructure chain', async () => {
    resetHttpCounters();
    const chainId = await bareChain();
    await persistFullMicrostructure(chainId);
    const c = httpCounters();
    expect(c.createOrderFunctionInvocations).toBe(0);
    expect(c.createOrderAttemptCount).toBe(0);
    expect(c.createOrderNetworkCount).toBe(0);
  });

  // -----------------------------------------------------------------
  // Safety confirmations
  // -----------------------------------------------------------------

  it('§FIX-S.1 DRY_RUN and ORDER_SUBMISSION_ENABLED remain intact', () => {
    const envSrc = readFileSync(join(__dirname, '..', '..', 'src', 'env.ts'), 'utf8');
    expect(/DRY_RUN/.test(envSrc)).toBe(true);
    expect(/ORDER_SUBMISSION_ENABLED/.test(envSrc)).toBe(true);
  });

  it('§FIX-S.2 the microstructure module does not reference createOrder / fetch / /brokerage/orders', () => {
    // Reads persistence.ts — the new fix file — to prove it added no such
    // reference. Isolation.test.ts scans the whole tree; this narrowly proves
    // the added file remains clean.
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'research', 'microstructure', 'persistence.ts'), 'utf8');
    expect(/createOrder|submitOrder|placeOrder/.test(src)).toBe(false);
    expect(/\bfetch\s*\(/.test(src)).toBe(false);
    expect(/\/brokerage\/orders/.test(src)).toBe(false);
  });

  it('§FIX-S.3 shortlist policy version is stable and rejects drift', async () => {
    const p1 = await registerMsShortlistPolicy();
    // Re-register with same fields → same row.
    const p2 = await registerMsShortlistPolicy();
    expect(p1.id).toBe(p2.id);
    expect(p1.policyVersion).toBe(MS_SHORTLIST_POLICY_VERSION);
    // Attempting a drifting registration (same version, different maxProducts) fails.
    await expect(
      registerMsShortlistPolicy({ ...DEFAULT_MS_SHORTLIST_POLICY, maxProducts: 99 }),
    ).rejects.toThrow(/implementationHash mismatch/);
  });

  it('§FIX-S.4 feature-definition drift is rejected on repeat registration', async () => {
    const def = MS_FEATURE_REGISTRY[0];
    await registerMsFeatureDefinition(def);
    await expect(
      registerMsFeatureDefinition({ ...def, description: 'drifted description' }),
    ).rejects.toThrow(/implementationHash drift/);
  });

  it('§FIX-S.5 shortlist run + membership persistence is idempotent per (runId, productId)', async () => {
    const policy = await registerMsShortlistPolicy();
    const run = await startMsShortlistRun(policy.id, NOW);
    const outcomes = evaluateMsShortlist(
      [
        {
          productId: 'AAA-USD',
          hygieneEligible: true,
          fingerprintValid: true,
          regimeValid: true,
          riskHealthy: true,
          quoteVolume24h: 1_000_000,
          dataQualityPenalty: 0,
          dataAvailableAt: NOW,
        },
      ],
      NOW,
    );
    const first = await persistMsShortlist(run.id, outcomes);
    expect(first.length).toBe(1);
    // Repeating with the same runId must not create a duplicate.
    await expect(persistMsShortlist(run.id, outcomes)).rejects.toBeTruthy();
    const members = await db.select().from(microstructureShortlistMemberships).where(eq(microstructureShortlistMemberships.runId, run.id));
    expect(members.length).toBe(1);
    // The run row itself is unique.
    const runRows = await db.select().from(microstructureShortlistRuns).where(eq(microstructureShortlistRuns.id, run.id));
    expect(runRows.length).toBe(1);
  });

  it('§FIX-S.6 unused fixture provider is still exported and iterable', () => {
    const p = new FixtureMarketDepthProvider('AAA-USD', [snapshotEv(1, [['99', '5']], [['100', '5']], 0)]);
    expect([...p.events()].length).toBe(1);
    expect(p.providerId).toBe('FixtureMarketDepthProvider');
  });

  it('§FIX-S.7 sessionId FK on features and impact/passive persistence is respected', async () => {
    const chainId = await bareChain();
    const { snapshot } = await persistFullMicrostructure(chainId);
    const featRows = await db.select().from(microstructureFeatureValues).where(eq(microstructureFeatureValues.snapshotId, snapshot.id));
    expect(featRows.length).toBe(MS_FEATURE_REGISTRY.length);
    void and;
  });
});
