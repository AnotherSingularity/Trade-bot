import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db';
import {
  executionCostForecasts,
  quantitativeDecisions,
  signalCandidates,
} from '../src/db/schema';
import {
  insertExecutionCostForecast,
  insertQuantitativeDecision,
  insertSignalCandidate,
} from '../src/db/queries';
import { STRATEGY_VERSION } from '@horizon/shared';
import { COST_MODEL_VERSION } from '../src/trading/costModel';
import { EV_GATE_VERSION } from '../src/trading/evGate';

/**
 * Immutable decision snapshots: every candidate — accepted OR rejected — must
 * land in signal_candidates + quantitative_decisions with strategy / cost-model
 * / EV-gate version fields populated so slice-3 reconciliation can attribute
 * outcomes to the exact code era that produced the decision.
 */

async function reset() {
  // FKs: quantitative_decisions -> signal_candidates & execution_cost_forecasts;
  //      execution_cost_forecasts -> signal_candidates & fee_tier_snapshots.
  await db.delete(quantitativeDecisions);
  await db.delete(executionCostForecasts);
  await db.delete(signalCandidates);
}

describe('decision snapshots', () => {
  beforeEach(async () => {
    await reset();
  });

  it('inserts a signal candidate row with all version fields', async () => {
    const row = await insertSignalCandidate({
      scanSeed: '2026-07-25T00:00:00Z',
      token: 'AAVE',
      mode: 'macro',
      scanPrice: '100.00',
      volume24h: '5000000',
      changePct24h: '5.0000',
      rsi: '62.0000',
      macdHistogram: '0.10000000',
      emaTrend: 'bullish',
      bollingerPosition: 'inside',
      passedSignals: 4,
      totalSignals: 4,
      tokenWinRate: null,
      tokenTradeCount: null,
      strategyVersion: STRATEGY_VERSION,
      featureVersion: 'p1s1-1',
      regimeLabel: 'unclassified',
      regimeConfidence: null,
      marketWindow: 'PRIME',
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.strategyVersion).toBe(STRATEGY_VERSION);
    expect(row.featureVersion).toBe('p1s1-1');
  });

  it('records both accepted and rejected decisions with machine-readable reasons', async () => {
    const c1 = await insertSignalCandidate(baseCandidate({ token: 'AAVE' }));
    const c2 = await insertSignalCandidate(baseCandidate({ token: 'B3' }));

    await insertQuantitativeDecision({
      candidateId: c1.id,
      costForecastId: null,
      decision: 'accept',
      rejectionReason: null,
      rejectionDetail: null,
      netTpPnl: '10.00',
      netSlPnl: '-5.00',
      netRewardRisk: '2.0000',
      expectedValue: '2.5000',
      breakEvenWinProb: '0.3333',
      strategyVersion: STRATEGY_VERSION,
      costModelVersion: COST_MODEL_VERSION,
      evGateVersion: EV_GATE_VERSION,
    });

    await insertQuantitativeDecision({
      candidateId: c2.id,
      costForecastId: null,
      decision: 'reject_ev_gate',
      rejectionReason: 'net_tp_not_positive_after_costs',
      rejectionDetail: { netTpPnl: '-0.10', netSlPnl: '-2.00' },
      netTpPnl: '-0.10',
      netSlPnl: '-2.00',
      netRewardRisk: null,
      expectedValue: '-1.05',
      breakEvenWinProb: null,
      strategyVersion: STRATEGY_VERSION,
      costModelVersion: COST_MODEL_VERSION,
      evGateVersion: EV_GATE_VERSION,
    });

    const all = await db.select().from(quantitativeDecisions);
    expect(all).toHaveLength(2);
    const accepted = all.find((d) => d.decision === 'accept');
    const rejected = all.find((d) => d.decision === 'reject_ev_gate');
    expect(accepted?.rejectionReason).toBeNull();
    expect(rejected?.rejectionReason).toBe('net_tp_not_positive_after_costs');
    // mysql2 returns json columns as raw strings — parse before asserting.
    const detail =
      typeof rejected?.rejectionDetail === 'string'
        ? JSON.parse(rejected.rejectionDetail)
        : rejected?.rejectionDetail;
    expect(detail).toMatchObject({ netTpPnl: '-0.10' });
    // Every decision carries the three version stamps.
    for (const d of all) {
      expect(d.strategyVersion).toBe(STRATEGY_VERSION);
      expect(d.costModelVersion).toBe(COST_MODEL_VERSION);
      expect(d.evGateVersion).toBe(EV_GATE_VERSION);
    }
  });

  it('links a decision to its cost forecast when one exists', async () => {
    // fee_tier_snapshots has an FK, so make a real snapshot first.
    const { feeTierSnapshots } = await import('../src/db/schema');
    const ft = await db.insert(feeTierSnapshots).values({
      pricingTier: 'test',
      makerFeeRate: '0.00400000',
      takerFeeRate: '0.00600000',
      productType: 'SPOT',
    });
    const ftId = (ft as unknown as { insertId: number }[])[0].insertId;

    const cand = await insertSignalCandidate(baseCandidate({ token: 'AAVE' }));
    const forecast = await insertExecutionCostForecast({
      candidateId: cand.id,
      feeTierSnapshotId: ftId,
      previewOrderTotal: '500.00',
      previewCommissionTotal: '3.00',
      previewBestBid: '99.90',
      previewBestAsk: '100.10',
      previewEstimatedAvgFillPrice: '100.00',
      previewBaseSize: '5.00',
      previewQuoteSize: '500.00',
      arrivalMid: '100.00',
      spreadBps: '20.0000',
      entryFee: '3.00',
      exitFeeEstimate: '3.20',
      entryImpactBps: '0.0000',
      exitImpactBpsEstimate: '10.0000',
      latencySlippageBpsEstimate: '5.0000',
      roundTripCost: '7.50',
      costToTargetPct: '50.0000',
      takeProfitPrice: '103.00',
      stopLossPrice: '98.00',
      netTpPnl: '-0.50',
      netSlPnl: '-3.20',
      netRewardRisk: null,
      breakEvenWinProb: null,
      costModelVersion: COST_MODEL_VERSION,
      exitCostQuantile: '0.9500',
      previewWarnings: null,
      previewRawResponse: null,
    });

    const decision = await insertQuantitativeDecision({
      candidateId: cand.id,
      costForecastId: forecast.id,
      decision: 'reject_cost_gate',
      rejectionReason: 'round_trip_cost_consumes_too_much_of_target',
      rejectionDetail: { costToTargetPct: 50 },
      netTpPnl: '-0.50',
      netSlPnl: '-3.20',
      netRewardRisk: null,
      expectedValue: '-1.85',
      breakEvenWinProb: null,
      strategyVersion: STRATEGY_VERSION,
      costModelVersion: COST_MODEL_VERSION,
      evGateVersion: EV_GATE_VERSION,
    });
    expect(decision.costForecastId).toBe(forecast.id);
  });

  it('immutability: attempting to overwrite a candidate row inserts a new one (not an UPDATE)', async () => {
    // The tables are append-only in intent — we don't expose an update path.
    // This test guards against future accidental helpers by asserting that our
    // insert helpers always produce a fresh id.
    const a = await insertSignalCandidate(baseCandidate({ token: 'AAVE' }));
    const b = await insertSignalCandidate(baseCandidate({ token: 'AAVE' }));
    expect(a.id).not.toBe(b.id);
    const rows = await db.select().from(signalCandidates);
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function baseCandidate(o: Partial<Parameters<typeof insertSignalCandidate>[0]>) {
  return {
    scanSeed: '2026-07-25T00:00:00Z',
    token: 'AAVE',
    mode: 'macro' as const,
    scanPrice: '100.00',
    volume24h: '5000000',
    changePct24h: '5.0000',
    rsi: '62.0000',
    macdHistogram: '0.10000000',
    emaTrend: 'bullish',
    bollingerPosition: 'inside',
    passedSignals: 4,
    totalSignals: 4,
    tokenWinRate: null,
    tokenTradeCount: null,
    strategyVersion: STRATEGY_VERSION,
    featureVersion: 'p1s1-1',
    regimeLabel: 'unclassified',
    regimeConfidence: null,
    marketWindow: 'PRIME' as const,
    ...o,
  };
}
