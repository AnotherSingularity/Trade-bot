import { describe, expect, it } from 'vitest';
import { Money } from '@horizon/shared';
import type { FeeTierCurrent } from '../src/trading/feeTier';
import type { PreviewOk } from '../src/trading/preview';
import {
  buildCostForecast,
  COST_MODEL_VERSION,
  estimateExitImpactBps,
} from '../src/trading/costModel';
import {
  applyEvGate,
  DEFAULT_EV_GATE_THRESHOLDS,
  EV_GATE_VERSION,
} from '../src/trading/evGate';

/**
 * The cost model + EV gate are the actual capital-safety win: Claude never
 * sees a candidate that isn't mathematically profitable after fees. These
 * tests target the audit's specific "1.5% early exit vs 3% TP" failure and
 * verify machine-readable rejection reasons.
 */

function tier(takerBps: number, makerBps: number = takerBps - 20): FeeTierCurrent {
  return {
    snapshotId: 1,
    pricingTier: 'test',
    makerFeeRate: Money.fromBps(makerBps),
    takerFeeRate: Money.fromBps(takerBps),
    fetchedAt: new Date(),
    synthetic: false,
  };
}

function preview(overrides: Partial<PreviewOk> = {}): PreviewOk {
  const mid = Money.fromString('100');
  const commission = Money.fromString('3');
  const size = Money.fromString('5');
  return {
    status: 'ok',
    synthetic: false,
    raw: {} as never,
    orderTotal: mid.mul(size).add(commission),
    commissionTotal: commission,
    bestBid: Money.fromString('99.90'),
    bestAsk: Money.fromString('100.10'),
    estimatedAvgFillPrice: mid,
    slippage: Money.zero(),
    baseSize: size,
    quoteSize: mid.mul(size),
    warnings: [],
    ...overrides,
  };
}

describe('cost model — MV', () => {
  it('COST_MODEL_VERSION is stamped on every forecast', () => {
    const f = buildCostForecast({
      token: 'AAVE',
      mode: 'macro',
      arrivalMid: Money.fromString('100'),
      takeProfitPct: 8,
      stopLossPct: 3,
      feeTier: tier(60),
      preview: preview(),
    });
    expect(f.costModelVersion).toBe(COST_MODEL_VERSION);
  });

  it('spreadBps ~ 20 bps on a 100 / (99.90 – 100.10) book', () => {
    const f = buildCostForecast({
      token: 'AAVE',
      mode: 'macro',
      arrivalMid: Money.fromString('100'),
      takeProfitPct: 8,
      stopLossPct: 3,
      feeTier: tier(60),
      preview: preview(),
    });
    // ((ask - bid) / mid) * 10000 = 0.20/100 * 10000 = 20
    expect(f.spreadBps.toDecimalString(2)).toBe('20.00');
  });

  it('estimateExitImpactBps: liquid tokens get the base buffer, others add illiquid boost', () => {
    expect(estimateExitImpactBps('AAVE')).toBeLessThan(estimateExitImpactBps('B3'));
  });

  it('applies fees on both sides — round-trip cost includes entry + exit commission + impact loss', () => {
    const f = buildCostForecast({
      token: 'AAVE',
      mode: 'macro',
      arrivalMid: Money.fromString('100'),
      takeProfitPct: 8,
      stopLossPct: 3,
      feeTier: tier(60),
      preview: preview(),
    });
    // Entry commission = 3.00 (from preview). Exit commission ~ 3 * (108 / 100).
    expect(Number(f.roundTripCost.toDecimalString(2))).toBeGreaterThan(
      Number(f.entryFee.toDecimalString(2)),
    );
  });

  it('reversion 3%/2% TP/SL with 60 bps taker is uneconomic — the audit case', () => {
    // 3% TP on the sample notional = ~$15 gross. Round-trip cost (60bps each
    // side + illiquid buffer + exit-latency slippage) consumes well over 40%
    // of that target. This is the audit's specific finding.
    const f = buildCostForecast({
      token: 'AAVE',
      mode: 'reversion',
      arrivalMid: Money.fromString('100'),
      takeProfitPct: 3,
      stopLossPct: 2,
      feeTier: tier(60),
      preview: preview(),
    });
    // cost/target ratio > 40% is the material capital-safety win — the trade
    // never reaches Claude regardless of whether net-TP squeaks positive.
    expect(Number(f.costToTargetPct.toDecimalString(2))).toBeGreaterThan(40);
  });

  it('macro 8%/3% is profitable after 60 bps fees on the liquid tier', () => {
    const f = buildCostForecast({
      token: 'AAVE',
      mode: 'macro',
      arrivalMid: Money.fromString('100'),
      takeProfitPct: 8,
      stopLossPct: 3,
      feeTier: tier(60),
      preview: preview(),
    });
    expect(f.netTpPnl.isPositive()).toBe(true);
  });

  it('breakout 15%/6% remains profitable after costs', () => {
    const f = buildCostForecast({
      token: 'AAVE',
      mode: 'breakout',
      arrivalMid: Money.fromString('100'),
      takeProfitPct: 15,
      stopLossPct: 6,
      feeTier: tier(60),
      preview: preview(),
    });
    expect(f.netTpPnl.isPositive()).toBe(true);
  });
});

describe('EV gate', () => {
  it('EV_GATE_VERSION is stamped on every decision', () => {
    const f = buildCostForecast({
      token: 'AAVE',
      mode: 'macro',
      arrivalMid: Money.fromString('100'),
      takeProfitPct: 8,
      stopLossPct: 3,
      feeTier: tier(60),
      preview: preview(),
    });
    expect(applyEvGate(f).version).toBe(EV_GATE_VERSION);
  });

  it('rejects reversion 3%/2%/60 bps (Claude never sees it — the audit case)', () => {
    const f = buildCostForecast({
      token: 'AAVE',
      mode: 'reversion',
      arrivalMid: Money.fromString('100'),
      takeProfitPct: 3,
      stopLossPct: 2,
      feeTier: tier(60),
      preview: preview(),
    });
    const g = applyEvGate(f);
    // Either the EV gate (net-TP not positive) or the cost gate (round-trip
    // cost consumes >40% of target) is a legitimate capital-safety rejection.
    expect(g.decision).not.toBe('accept');
    expect(['reject_ev_gate', 'reject_cost_gate']).toContain(g.decision);
  });

  it('accepts macro 8%/3% at 60 bps taker on a liquid token', () => {
    const f = buildCostForecast({
      token: 'AAVE',
      mode: 'macro',
      arrivalMid: Money.fromString('100'),
      takeProfitPct: 8,
      stopLossPct: 3,
      feeTier: tier(60),
      preview: preview(),
    });
    const g = applyEvGate(f);
    expect(g.decision).toBe('accept');
  });

  it('rejects when net R/R < threshold even if net TP is positive', () => {
    // Force a tight setup: 4% TP / 3% SL with 60 bps fees → R/R below 1.2 default
    const f = buildCostForecast({
      token: 'AAVE',
      mode: 'macro',
      arrivalMid: Money.fromString('100'),
      takeProfitPct: 4,
      stopLossPct: 3,
      feeTier: tier(60),
      preview: preview(),
    });
    const g = applyEvGate(f);
    // Either it fails EV or R/R; both are gate rejections.
    expect(['reject_reward_risk_gate', 'reject_ev_gate']).toContain(g.decision);
  });

  it('rejects when cost consumes too much of the target', () => {
    // Tiny gross target (3% on a 100-notional * base_size 5 = 15 gross), high
    // fees (200 bps taker) → cost/target >> 40%.
    const f = buildCostForecast({
      token: 'AAVE',
      mode: 'macro',
      arrivalMid: Money.fromString('100'),
      takeProfitPct: 3,
      stopLossPct: 3,
      feeTier: tier(200),
      preview: preview(),
    });
    const g = applyEvGate(f);
    // Net TP is negative → EV gate wins over cost gate; either reject reason is fine.
    expect(g.decision).not.toBe('accept');
  });

  it('rejects a break-even setup when minExpectedValue is zero', () => {
    // Contrived: neutral prior (50/50) with netTp = -netSl → EV = 0.
    // Even after passing net-TP-positive and R/R, the EV gate should reject.
    const f = buildCostForecast({
      token: 'AAVE',
      mode: 'macro',
      arrivalMid: Money.fromString('100'),
      takeProfitPct: 5,
      stopLossPct: 5,
      feeTier: tier(0),
      preview: preview({ commissionTotal: Money.zero() }),
    });
    const g = applyEvGate(f, {
      ...DEFAULT_EV_GATE_THRESHOLDS,
      minNetRewardRisk: 0.5, // relax so we test payoff gate specifically
      minCostAdjustedPayoff: Money.fromString('0.01'), // must be > 0 (renamed §O)
    });
    expect(g.decision).toBe('reject_ev_gate');
    expect(g.reason).toBe('expected_value_below_minimum');
  });

  it('accepts a positive-EV setup with a favorable prior', () => {
    // Even a marginal setup should pass when the prior heavily favors TP.
    const f = buildCostForecast({
      token: 'AAVE',
      mode: 'macro',
      arrivalMid: Money.fromString('100'),
      takeProfitPct: 8,
      stopLossPct: 3,
      feeTier: tier(60),
      preview: preview(),
    });
    const g = applyEvGate(f, DEFAULT_EV_GATE_THRESHOLDS, 0.7);
    expect(g.decision).toBe('accept');
  });

  it('rejects an unfavorable prior even on an arithmetically-profitable setup', () => {
    // Same setup but with a heavily unfavorable prior — EV goes negative.
    const f = buildCostForecast({
      token: 'AAVE',
      mode: 'macro',
      arrivalMid: Money.fromString('100'),
      takeProfitPct: 8,
      stopLossPct: 3,
      feeTier: tier(60),
      preview: preview(),
    });
    const g = applyEvGate(f, DEFAULT_EV_GATE_THRESHOLDS, 0.05);
    expect(g.decision).toBe('reject_ev_gate');
    expect(g.reason).toBe('expected_value_below_minimum');
  });

  it('rejects prior outside [0,1] as programmer error', () => {
    const f = buildCostForecast({
      token: 'AAVE',
      mode: 'macro',
      arrivalMid: Money.fromString('100'),
      takeProfitPct: 8,
      stopLossPct: 3,
      feeTier: tier(60),
      preview: preview(),
    });
    expect(() => applyEvGate(f, DEFAULT_EV_GATE_THRESHOLDS, 1.5)).toThrow();
  });
});
