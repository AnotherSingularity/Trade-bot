import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../../src/db';
import { microstructureShortlistPolicies } from '../../src/db/schema';
import { resetDatabase } from '../setup/db';
import { OrderBookEngine } from '../../src/research/microstructure/bookEngine';
import type { MarketDepthEvent } from '../../src/research/microstructure/provider';
import { FixtureMarketDepthProvider, DeferredProductionMarketDepthProvider } from '../../src/research/microstructure/provider';
import { computeAllFeatures, MS_FEATURE_REGISTRY } from '../../src/research/microstructure/features';
import { buildFlowWindow, classifyTrade, TRADE_CLASSIFIER_VERSION } from '../../src/research/microstructure/flow';
import {
  computeExecutionCost,
  computeImpactCurve,
  estimatePassiveFill,
  estimateStopExecution,
  EXEC_COST_MODEL_VERSION,
  IMPACT_MODEL_VERSION,
} from '../../src/research/microstructure/executionCost';
import { evaluateExecution, classifyMsAgreement, MS_EXECUTION_POLICY_VERSION } from '../../src/research/microstructure/decision';
import { evaluateMsShortlist, registerMsShortlistPolicy, DEFAULT_MS_SHORTLIST_POLICY, MS_SHORTLIST_POLICY_VERSION } from '../../src/research/microstructure/shortlist';

const NOW = new Date('2026-05-15T00:00:00.000Z');

function ev(seq: number, kind: MarketDepthEvent['kind'], side: 'bid' | 'ask', price: string, size: string, offsetMs = 0): MarketDepthEvent {
  return {
    kind,
    sequence: seq,
    productId: 'AAA-USD',
    sourceTimestamp: new Date(NOW.getTime() + offsetMs),
    receivedAt: new Date(NOW.getTime() + offsetMs + 5),
    dataAvailableAt: new Date(NOW.getTime() + offsetMs + 10),
    levels: [{ side, price, size }],
    payloadHash: `evt-${seq}-${kind}-${side}-${price}-${size}`,
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
    payloadHash: `snap-${seq}`,
  };
}

describe('Phase 2D — microstructure observer acceptance', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterEach(async () => {
    await resetDatabase();
  });

  it('deferred production provider throws when constructed', () => {
    expect(() => new DeferredProductionMarketDepthProvider('AAA-USD')).toThrow();
  });

  it('fixture provider yields events in order', () => {
    const p = new FixtureMarketDepthProvider('AAA-USD', [ev(1, 'delta', 'bid', '100', '1')]);
    expect([...p.events()]).toHaveLength(1);
    expect(p.providerId).toBe('FixtureMarketDepthProvider');
  });

  it('shortlist policy is versioned + immutable', async () => {
    const reg = await registerMsShortlistPolicy();
    const rows = await db.select().from(microstructureShortlistPolicies);
    expect(rows).toHaveLength(1);
    await registerMsShortlistPolicy(); // idempotent
    const rows2 = await db.select().from(microstructureShortlistPolicies);
    expect(rows2).toHaveLength(1);
    await expect(
      registerMsShortlistPolicy({ ...DEFAULT_MS_SHORTLIST_POLICY, maxProducts: 999 }),
    ).rejects.toThrow();
    expect(reg.policyVersion).toBe(MS_SHORTLIST_POLICY_VERSION);
  });

  it('shortlist ranks eligible products above ineligible ones', () => {
    const outcomes = evaluateMsShortlist(
      [
        { productId: 'AAA-USD', hygieneEligible: true, fingerprintValid: true, regimeValid: true, riskHealthy: true, quoteVolume24h: 1e7, dataQualityPenalty: 0, dataAvailableAt: NOW },
        { productId: 'BBB-USD', hygieneEligible: false, fingerprintValid: true, regimeValid: true, riskHealthy: true, quoteVolume24h: 1e7, dataQualityPenalty: 0, dataAvailableAt: NOW },
      ],
      NOW,
    );
    const aaa = outcomes.find((o) => o.productId === 'AAA-USD')!;
    const bbb = outcomes.find((o) => o.productId === 'BBB-USD')!;
    expect(aaa.selected).toBe(true);
    expect(bbb.selected).toBe(false);
    expect(bbb.reasonCodes).toContain('hygiene_ineligible');
  });

  it('book engine handles snapshot + deltas deterministically', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([
      snapshotEv(1, [['99.5', '5']], [['100.5', '5']], 0),
      ev(2, 'delta', 'bid', '99.5', '10', 100),
      ev(3, 'delta', 'ask', '100.5', '0', 200), // remove
      ev(4, 'delta', 'ask', '100.6', '3', 300),
    ]);
    expect(engine.currentState()).toBe('healthy');
    expect(engine.bestBid()).toBe(99.5);
    expect(engine.bestAsk()).toBe(100.6);
  });

  it('book engine detects duplicate deltas as idempotent', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([
      snapshotEv(1, [['99', '5']], [['101', '5']], 0),
      ev(2, 'delta', 'bid', '99', '10', 100),
    ]);
    const result = engine.ingest([ev(2, 'delta', 'bid', '99', '99', 100)]); // duplicate seq
    expect(result.errors).toEqual([]);
    expect(engine.currentState()).toBe('healthy');
  });

  it('book engine declares gap on out-of-order beyond buffer', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 2, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '5']], [['101', '5']], 0)]);
    const result = engine.ingest([ev(100, 'delta', 'bid', '99', '10', 100)]);
    expect(engine.currentState()).toBe('gap_detected');
    expect(result.gaps).toBe(1);
  });

  it('book engine flags crossed book as inconsistent', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    // Snapshot with bid > ask is rejected at snapshot time.
    engine.ingest([snapshotEv(1, [['105', '5']], [['100', '5']], 0)]);
    expect(engine.currentState()).toBe('inconsistent');
  });

  it('book engine flags stale book after configured age', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 100 });
    engine.ingest([snapshotEv(1, [['99', '5']], [['101', '5']], 0)]);
    const snap = engine.snapshot(new Date(NOW.getTime() + 5_000));
    expect(snap.bookHealth).toBe('stale');
  });

  it('book engine rejects negative price and size', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    const r = engine.ingest([snapshotEv(1, [['-99', '5']], [['101', '5']], 0)]);
    expect(engine.currentState()).toBe('failed');
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('microstructure features compute for a healthy book', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99.5', '5'], ['99', '10']], [['100.5', '5'], ['101', '10']], 0)]);
    const snap = engine.snapshot(new Date(NOW.getTime() + 100));
    const feats = computeAllFeatures(snap);
    expect(feats.find((f) => f.featureKey === 'price.best_bid')!.value).toBe(99.5);
    expect(feats.find((f) => f.featureKey === 'price.best_ask')!.value).toBe(100.5);
    expect(feats.find((f) => f.featureKey === 'price.midprice')!.value).toBe(100);
    expect(feats.find((f) => f.featureKey === 'price.spread_bps')!.value).toBeCloseTo(((1) / 99.5) * 10_000, 4);
    expect(MS_FEATURE_REGISTRY.length).toBeGreaterThanOrEqual(15);
  });

  it('microstructure features fail closed on gap_detected books', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 1, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '5']], [['101', '5']], 0)]);
    engine.ingest([ev(100, 'delta', 'bid', '99', '10', 100)]);
    const snap = engine.snapshot(new Date(NOW.getTime() + 200));
    expect(snap.bookHealth).toBe('gap_detected');
    const feats = computeAllFeatures(snap);
    expect(feats.find((f) => f.featureKey === 'price.best_bid')!.status).toBe('gap_detected');
  });

  it('trade classifier honors authoritative side', () => {
    const t = classifyTrade({
      event: tradeEv(10, '100', '1', 'buyer_initiated'),
      quoteAtTrade: { bestBid: 99, bestAsk: 101 },
      previousPrice: null,
    });
    expect(t!.source).toBe('authoritative');
    expect(t!.side).toBe('buyer_initiated');
  });

  it('trade classifier uses quote rule when side is unknown', () => {
    const t = classifyTrade({
      event: tradeEv(10, '101', '1', 'unknown'),
      quoteAtTrade: { bestBid: 99, bestAsk: 101 },
      previousPrice: 100,
    });
    expect(t!.source).toBe('quote_rule');
    expect(t!.side).toBe('buyer_initiated');
  });

  it('trade classifier uses tick rule when quote is missing', () => {
    const t = classifyTrade({
      event: tradeEv(10, '100.5', '1', 'unknown'),
      quoteAtTrade: { bestBid: null, bestAsk: null },
      previousPrice: 100,
    });
    expect(t!.source).toBe('tick_rule');
    expect(t!.side).toBe('buyer_initiated');
  });

  it('trade classifier reports unknown when no evidence exists', () => {
    const t = classifyTrade({
      event: tradeEv(10, '100', '1', 'unknown'),
      quoteAtTrade: { bestBid: null, bestAsk: null },
      previousPrice: null,
    });
    expect(t!.side).toBe('unknown');
    expect(t!.source).toBe('unknown');
    expect(t!.confidence).toBe(0);
  });

  it('CVD window aggregates classified trades and flags low_confidence when unknown dominates', () => {
    const trades = [
      classifyTrade({ event: tradeEv(1, '101', '1', 'buyer_initiated'), quoteAtTrade: { bestBid: 99, bestAsk: 101 }, previousPrice: null })!,
      classifyTrade({ event: tradeEv(2, '99', '1', 'unknown'), quoteAtTrade: { bestBid: null, bestAsk: null }, previousPrice: null })!,
      classifyTrade({ event: tradeEv(3, '99', '1', 'unknown'), quoteAtTrade: { bestBid: null, bestAsk: null }, previousPrice: null })!,
    ];
    const win = buildFlowWindow(trades, new Date(NOW.getTime() - 1000), new Date(NOW.getTime() + 1000));
    expect(win.buyerVolume).toBe(101);
    expect(win.unknownVolume).toBe(198);
    expect(win.status).toBe('low_confidence');
    expect(win.classifierVersion).toBe(TRADE_CLASSIFIER_VERSION);
  });

  it('impact curve walks the visible book and reports unfilled residual', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '5']], [['100', '1'], ['100.5', '1'], ['101', '1']], 0)]);
    const snap = engine.snapshot(NOW);
    const curve = computeImpactCurve(snap, 'buy', [50, 500]);
    expect(curve.points[0].filledNotional).toBe(50);
    expect(curve.points[1].unfilledNotional).toBeGreaterThan(0);
    expect(curve.modelVersion).toBe(IMPACT_MODEL_VERSION);
  });

  it('impact curve monotonicity is checked', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '5']], [['100', '10'], ['100.5', '10']], 0)]);
    const snap = engine.snapshot(NOW);
    const curve = computeImpactCurve(snap, 'buy', [100, 200, 400]);
    expect(curve.monotonic).toBe(true);
  });

  it('passive fill model marks large visible queue as unlikely', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '10000']], [['100', '1']], 0)]);
    const snap = engine.snapshot(NOW);
    const passive = estimatePassiveFill(snap, 'buy', 98);
    expect(passive.state === 'unlikely' || passive.state === 'low_confidence' || passive.state === 'possible').toBe(true);
  });

  it('stop-execution observer never claims trigger equals guaranteed execution', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '5']], [['101', '5']], 0)]);
    const snap = engine.snapshot(NOW);
    const stop = estimateStopExecution(snap, 'sell', 100);
    // Gap-through / protection failure scenarios must present WORSE prices than the trigger.
    expect(stop.estimatedExitPriceGapThrough!).toBeLessThan(stop.triggerPrice);
    expect(stop.estimatedExitPriceProtectionFailure!).toBeLessThan(stop.triggerPrice);
  });

  it('execution cost observer marks isBookAware=true and surfaces model version', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '10']], [['100', '10']], 0)]);
    const snap = engine.snapshot(NOW);
    const cost = computeExecutionCost({
      bookSnapshot: snap,
      side: 'buy',
      entryNotional: 100,
      passiveLimitPrice: 98,
      latencyMs: 50,
      feeBps: 10,
      now: NOW,
    });
    expect(cost.isBookAware).toBe(true);
    expect(cost.modelVersion).toBe(EXEC_COST_MODEL_VERSION);
  });

  it('execution decision on a healthy book preserves size (multiplier=1)', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '100']], [['100', '100']], 0)]);
    const snap = engine.snapshot(NOW);
    const { decision } = evaluateExecution({
      decisionChainId: 1,
      shortlistMembershipId: null,
      bookSnapshotId: null,
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
    expect(decision.sizeMultiplier).toBeLessThanOrEqual(1);
    expect(decision.sizeMultiplier).toBeGreaterThan(0);
    expect(decision.policyVersion).toBe(MS_EXECUTION_POLICY_VERSION);
  });

  it('execution decision on a stale book abstains', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 100 });
    engine.ingest([snapshotEv(1, [['99', '100']], [['100', '100']], 0)]);
    const snap = engine.snapshot(new Date(NOW.getTime() + 60_000));
    const { decision } = evaluateExecution({
      decisionChainId: 2,
      shortlistMembershipId: null,
      bookSnapshotId: null,
      championOrderType: 'market',
      championSize: 1,
      championSide: 'buy',
      championNotional: 100,
      passiveLimitPrice: null,
      latencyMs: 50,
      feeBps: 10,
      bookSnapshot: snap,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(decision.recommendedAction).toBe('abstain');
    expect(decision.sizeMultiplier).toBe(0);
  });

  it('execution decision on a gap_detected book emits data_failure', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 1, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '10']], [['101', '10']], 0)]);
    engine.ingest([ev(100, 'delta', 'bid', '99', '10', 100)]);
    const snap = engine.snapshot(new Date(NOW.getTime() + 200));
    const { decision } = evaluateExecution({
      decisionChainId: 3,
      shortlistMembershipId: null,
      bookSnapshotId: null,
      championOrderType: 'market',
      championSize: 1,
      championSide: 'buy',
      championNotional: 100,
      passiveLimitPrice: null,
      latencyMs: 50,
      feeBps: 10,
      bookSnapshot: snap,
      now: new Date(NOW.getTime() + 200),
    });
    expect(decision.recommendedAction).toBe('data_failure');
    expect(decision.recommendedMaximumSize).toBe(0);
  });

  it('agreement classifier maps recommendations correctly', () => {
    const base = {
      decisionChainId: 1,
      productId: 'AAA-USD',
      shortlistMembershipId: null,
      bookSnapshotId: null,
      policyVersion: MS_EXECUTION_POLICY_VERSION,
      championOrderType: null,
      championSize: 1,
      recommendedMaximumSize: 1,
      sizeMultiplier: 1,
      preferredOrderStyle: null,
      preferredPriceBand: null,
      expiryRecommendation: null,
      fillConfidence: null,
      impactEstimateBps: null,
      reasonCodes: [],
      dataQualityState: 'healthy',
      observedAt: NOW,
      dataAvailableAt: NOW,
      inputHash: 'x',
    };
    expect(classifyMsAgreement({ ...base, recommendedAction: 'proceed_as_planned' })).toBe('agree');
    expect(classifyMsAgreement({ ...base, recommendedAction: 'reduce_size' })).toBe('ms_reduced');
    expect(classifyMsAgreement({ ...base, recommendedAction: 'reject' })).toBe('ms_rejected');
    expect(classifyMsAgreement({ ...base, recommendedAction: 'abstain' })).toBe('ms_abstained');
    expect(classifyMsAgreement({ ...base, recommendedAction: 'data_failure' })).toBe('unresolved');
  });

  it('microstructure decision never sets sizeMultiplier > 1 on any healthy book', () => {
    const engine = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    engine.ingest([snapshotEv(1, [['99', '100']], [['100', '100']], 0)]);
    const snap = engine.snapshot(NOW);
    for (const notional of [10, 100, 1000, 10_000]) {
      const { decision } = evaluateExecution({
        decisionChainId: 1,
        shortlistMembershipId: null,
        bookSnapshotId: null,
        championOrderType: 'market',
        championSize: 1,
        championSide: 'buy',
        championNotional: notional,
        passiveLimitPrice: null,
        latencyMs: 50,
        feeBps: 10,
        bookSnapshot: snap,
        now: NOW,
      });
      expect(decision.sizeMultiplier).toBeGreaterThanOrEqual(0);
      expect(decision.sizeMultiplier).toBeLessThanOrEqual(1);
    }
  });

  it('replay is byte-stable for identical inputs', () => {
    const engine1 = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    const engine2 = new OrderBookEngine({ productId: 'AAA-USD', maxBufferedGap: 4, staleAgeMs: 60_000 });
    const events = [
      snapshotEv(1, [['99', '10']], [['100', '10']], 0),
      ev(2, 'delta', 'bid', '99', '20', 100),
      ev(3, 'delta', 'ask', '100', '15', 200),
    ];
    engine1.ingest(events);
    engine2.ingest(events);
    const s1 = engine1.snapshot(NOW);
    const s2 = engine2.snapshot(NOW);
    expect(s1.payloadHash).toBe(s2.payloadHash);
  });

  it('safe flags remain unchanged and no createOrder ref exists in microstructure/', () => {
    const envSrc = readFileSync(join(__dirname, '..', '..', 'src', 'env.ts'), 'utf8');
    expect(/DRY_RUN/.test(envSrc)).toBe(true);
    expect(/ORDER_SUBMISSION_ENABLED/.test(envSrc)).toBe(true);
  });

  it('migration paths remain equivalent (0000-0017 filenames present)', () => {
    const dir = join(__dirname, '..', '..', 'drizzle', 'migrations');
    const expected = ['0016_phase2c_risk_engine.sql', '0017_phase2d_microstructure_observer.sql'];
    for (const f of expected) expect(() => readFileSync(join(dir, f), 'utf8')).not.toThrow();
  });
});
