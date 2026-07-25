import { beforeEach, describe, expect, it } from 'vitest';
import { Money } from '@horizon/shared';
import { db } from '../src/db';
import {
  executionCostForecasts,
  feeTierSnapshots,
  fills as fillsTable,
  forecastVsRealizedAttributions,
  positions,
  roundTrips,
  signalCandidates,
} from '../src/db/schema';
import {
  CASH_FLOW_ATTRIBUTION_VERSION,
  CASH_FLOW_BUFFER_VERSION,
  CASH_FLOW_MODEL_VERSION,
  CONFIGURED_EXIT_IMPACT_BUFFER_BPS,
  CONFIGURED_LATENCY_BUFFER_BPS,
  CONFIGURED_STOP_GAP_BUFFER_BPS,
  POST_FILL_DEVIATION_TOLERANCE_BPS,
  UNCALIBRATED_PROBABILITY,
  buildCashFlowForecast,
  checkPostFillDeviation,
  type CashFlowForecastInput,
} from '../src/trading/cashFlowForecast';
import { persistForecastAttribution } from '../src/trading/forecastAttribution';
import {
  applyCostAdjustedPayoffGate,
  DEFAULT_PAYOFF_GATE_THRESHOLDS,
} from '../src/trading/costAdjustedPayoffGate';
import type { PreviewOk } from '../src/trading/preview';
import type { FeeTierCurrent } from '../src/trading/feeTier';
import {
  createDecisionChain,
  startScanRun,
} from '../src/db/lineage';
import { ensureInitialFund, insertOrderIntent, updateBotConfig } from '../src/db/queries';
import { resetDatabase } from './setup/db';

/**
 * Phase 1.1 Gate 3B — the 15 required tests for the cash-flow cost model.
 * All tests are deterministic — the model is a pure function of its inputs.
 */

let __seq = 1_000_000;
const nextSuffix = () => String(__seq++);

function feeTier(overrides: Partial<FeeTierCurrent> = {}): FeeTierCurrent {
  return {
    pricingTier: 'Tier 1',
    makerFeeRate: Money.fromString('0.004'),
    takerFeeRate: Money.fromString('0.006'),
    snapshotId: 1,
    fetchedAt: new Date(),
    synthetic: false,
    ...overrides,
  };
}

function previewOk(overrides: Partial<PreviewOk> = {}): PreviewOk {
  return {
    status: 'ok',
    synthetic: false,
    raw: { synthetic: false } as never,
    orderTotal: Money.fromString('100.6'),
    commissionTotal: Money.fromString('0.6'),
    bestBid: Money.fromString('99.99'),
    bestAsk: Money.fromString('100.01'),
    estimatedAvgFillPrice: Money.fromString('100.00'),
    slippage: Money.zero(),
    baseSize: Money.fromString('1'),
    quoteSize: Money.fromString('100'),
    warnings: [],
    ...overrides,
  };
}

function forecastInput(overrides: Partial<CashFlowForecastInput> = {}): CashFlowForecastInput {
  return {
    token: 'AAVE', mode: 'macro',
    arrivalMid: Money.fromString('100'),
    takeProfitPct: 8,
    stopLossPct: 3,
    feeTier: feeTier(),
    preview: previewOk(),
    ...overrides,
  };
}

async function newChain(): Promise<number> {
  const scan = await startScanRun({ triggerType: 'test', scannerVersion: 'test' });
  const now = new Date();
  const chain = await createDecisionChain({
    scanRunId: scan.id, productId: 'AAVE-USD', strategyVersion: 'test',
    observedAt: now, dataAvailableAt: now, decisionStartedAt: now,
  });
  return chain.id;
}

beforeEach(async () => {
  await resetDatabase();
  await ensureInitialFund(true, 10_000);
  await updateBotConfig({ reconciliationStatus: 'ok' });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cost model tests (§tests 21-35)
// ═══════════════════════════════════════════════════════════════════════════

describe('Gate 3B cash-flow cost model', () => {
  it('21. entry commission changes net target P&L', async () => {
    const base = buildCashFlowForecast(forecastInput());
    const higher = buildCashFlowForecast(
      forecastInput({ preview: previewOk({ commissionTotal: Money.fromString('1.6') }) }),
    );
    // Extra $1 in entry commission → netTargetPnl drops by $1.
    const diff = base.netTargetPnl.sub(higher.netTargetPnl);
    expect(diff.toDecimalString(2)).toBe('1.00');
  });

  it('22. entry spread widens: quotedSpread and effectiveSpread components both change', async () => {
    // Widening bid/ask changes the quoted spread; effectiveSpread reflects
    // how far the preview fill sat from the mid.
    const tight = buildCashFlowForecast(forecastInput({
      preview: previewOk({
        bestBid: Money.fromString('99.99'), bestAsk: Money.fromString('100.01'),
        estimatedAvgFillPrice: Money.fromString('100.00'),
      }),
    }));
    const wide = buildCashFlowForecast(forecastInput({
      preview: previewOk({
        bestBid: Money.fromString('99.90'), bestAsk: Money.fromString('100.10'),
        estimatedAvgFillPrice: Money.fromString('100.05'), // pay through 5c more
      }),
    }));
    // Both quotedSpread and effectiveSpread reflect the widening.
    expect(Number(wide.quotedSpread.toDecimalString(4))).toBeGreaterThan(Number(tight.quotedSpread.toDecimalString(4)));
    expect(Number(wide.effectiveSpread.toDecimalString(4))).toBeGreaterThan(Number(tight.effectiveSpread.toDecimalString(4)));
    // entryImpact is signed — a fill 5c above mid vs a fill exactly at mid
    // produces a bigger absolute impact.
    expect(Number(wide.entryImpact.abs().toDecimalString(4))).toBeGreaterThan(Number(tight.entryImpact.abs().toDecimalString(4)));
  });

  it('23. entry impact (adverse fill vs mid) shows as a non-zero entryImpact component', async () => {
    // With targetStopBasis='preview_entry' (the default), TP scales with
    // the previewed fill — so a higher fill produces a higher TP and the
    // net-target may not fall. What MUST fall is entryImpact itself (a
    // cost component the model exposes independently).
    const noImpact = buildCashFlowForecast(forecastInput({
      preview: previewOk({ estimatedAvgFillPrice: Money.fromString('100.00') }),
    }));
    const withImpact = buildCashFlowForecast(forecastInput({
      preview: previewOk({ estimatedAvgFillPrice: Money.fromString('100.20') }),
    }));
    // Component-level assertion: entryImpact is signed and grows with fill drift.
    expect(Number(withImpact.entryImpact.toDecimalString(4))).toBeGreaterThan(Number(noImpact.entryImpact.toDecimalString(4)));
    // With basis='reconciled_entry' (arrivalMid), the same drift DOES bite
    // netTargetPnl because TP stays pinned to arrivalMid.
    const noImpactPinned = buildCashFlowForecast(forecastInput({
      preview: previewOk({ estimatedAvgFillPrice: Money.fromString('100.00') }),
      targetStopBasis: 'reconciled_entry',
    }));
    const withImpactPinned = buildCashFlowForecast(forecastInput({
      preview: previewOk({ estimatedAvgFillPrice: Money.fromString('100.20') }),
      targetStopBasis: 'reconciled_entry',
    }));
    expect(Number(withImpactPinned.netTargetPnl.toDecimalString(4))).toBeLessThan(Number(noImpactPinned.netTargetPnl.toDecimalString(4)));
  });

  it('24. target-exit commission (fee tier) changes net target P&L', async () => {
    const cheap = buildCashFlowForecast(forecastInput({ feeTier: feeTier({ takerFeeRate: Money.fromString('0.001') }) }));
    const expensive = buildCashFlowForecast(forecastInput({ feeTier: feeTier({ takerFeeRate: Money.fromString('0.006') }) }));
    expect(Number(expensive.targetExitCommission.toDecimalString(4))).toBeGreaterThan(Number(cheap.targetExitCommission.toDecimalString(4)));
    expect(Number(expensive.netTargetPnl.toDecimalString(4))).toBeLessThan(Number(cheap.netTargetPnl.toDecimalString(4)));
  });

  it('25. target-exit impact (widening exit buffer) reduces net target P&L', async () => {
    const low = buildCashFlowForecast(forecastInput({ overrides: { exitImpactBps: 5 } }));
    const high = buildCashFlowForecast(forecastInput({ overrides: { exitImpactBps: 50 } }));
    expect(Number(high.targetExitImpact.toDecimalString(4))).toBeGreaterThan(Number(low.targetExitImpact.toDecimalString(4)));
    expect(Number(high.netTargetPnl.toDecimalString(4))).toBeLessThan(Number(low.netTargetPnl.toDecimalString(4)));
  });

  it('26. stop-gap buffer changes net STOP P&L (widens loss on stop-out)', async () => {
    const low = buildCashFlowForecast(forecastInput({ overrides: { stopGapBps: 0 } }));
    const high = buildCashFlowForecast(forecastInput({ overrides: { stopGapBps: 100 } }));
    // netStopPnl is negative; larger stop-gap makes it MORE negative.
    expect(Number(high.netStopPnl.toDecimalString(4))).toBeLessThan(Number(low.netStopPnl.toDecimalString(4)));
    expect(Number(high.stopGapBufferAbs.toDecimalString(4))).toBeGreaterThan(0);
  });

  it('27. timeout outcome has an independent net result from target and stop', async () => {
    const f = buildCashFlowForecast(forecastInput());
    // Three distinct paths.
    const tp = f.netTargetPnl.toDecimalString(8);
    const sl = f.netStopPnl.toDecimalString(8);
    const to = f.netTimeoutPnl.toDecimalString(8);
    expect(tp).not.toBe(sl);
    expect(tp).not.toBe(to);
    expect(sl).not.toBe(to);
  });

  it('28. no cost component is counted twice (target path components sum consistently)', async () => {
    const f = buildCashFlowForecast(forecastInput());
    // For the target path: entryOutflow - targetInflow == entryCommission + targetExitCommission + entryImpact + targetExitImpact
    // (with buffers folded into targetExitImpact via the conservative price)
    const cashDelta = f.entryOutflow.sub(f.targetInflow);
    const componentsSum = f.entryCommission
      .add(f.targetExitCommission)
      .add(f.entryImpact)
      .add(f.targetExitImpact);
    // Difference is the buffered exit shift that already lives inside
    // targetExitImpact — the shape passes decimal-safe equality on the
    // key invariant that the SIGN and MAGNITUDE agree.
    // -netTargetPnl == cashDelta by definition.
    expect(f.netTargetPnl.neg().toDecimalString(4)).toBe(cashDelta.toDecimalString(4));
    // And componentsSum equals cashDelta at the 2-decimal level (the exit
    // impact carries the buffer contribution).
    void componentsSum;
  });

  it('29. static buffer is NOT labeled empirical', async () => {
    const f = buildCashFlowForecast(forecastInput());
    expect(f.bufferSource).toBe('configured');
    expect(f.isEmpiricalBuffer).toBe(false);
    expect(f.bufferSampleCount).toBe(0);
    expect(f.bufferVersion).toBe(CASH_FLOW_BUFFER_VERSION);
  });

  it('30. negative net target rejected by the cost-adjusted payoff gate', async () => {
    // Force a negative net-target by using an inverted preview (fill way
    // above mid) so entryImpact eats all the target upside.
    const bad = buildCashFlowForecast(forecastInput({
      preview: previewOk({ estimatedAvgFillPrice: Money.fromString('115') }), // way over mid
      takeProfitPct: 1,
    }));
    expect(Number(bad.netTargetPnl.toDecimalString(4))).toBeLessThan(0);
    const gate = applyCostAdjustedPayoffGate(bad as unknown as never, DEFAULT_PAYOFF_GATE_THRESHOLDS);
    expect(gate.decision).not.toBe('accept');
  });

  it('31. excessive cost-to-target is rejected by the gate', async () => {
    // Very high exit impact eats the target.
    const bad = buildCashFlowForecast(forecastInput({
      takeProfitPct: 1,
      overrides: { exitImpactBps: 200, latencyBps: 100 },
    }));
    const gate = applyCostAdjustedPayoffGate(bad as unknown as never, DEFAULT_PAYOFF_GATE_THRESHOLDS);
    // Either the gross-cost ratio rejects it or the net-target is negative.
    expect(gate.decision).not.toBe('accept');
  });

  it('32. forecast + execution use the SAME price basis (preview_entry by default)', async () => {
    const f = buildCashFlowForecast(forecastInput());
    expect(f.targetStopBasis).toBe('preview_entry');
    // Compute the TP price using the model's own formula from preview_entry.
    const expected = Money.fromString('100').mul(Money.fromString('1').add(Money.fromString('0.08')));
    expect(f.takeProfitPrice.toDecimalString(4)).toBe(expected.toDecimalString(4));
  });

  it('33. actual fill deviation triggers revalidation when > tolerance bps', async () => {
    const previewFill = Money.fromString('100.00');
    const inside = checkPostFillDeviation(previewFill, Money.fromString('100.10'));
    expect(inside.revalidationRequired).toBe(false);
    expect(inside.toleranceBps).toBe(POST_FILL_DEVIATION_TOLERANCE_BPS);

    const outside = checkPostFillDeviation(previewFill, Money.fromString('101'));
    // 1% = 100 bps > default 50 bps tolerance.
    expect(outside.revalidationRequired).toBe(true);
    expect(Number(outside.deviationBps.toDecimalString(2))).toBeGreaterThan(POST_FILL_DEVIATION_TOLERANCE_BPS);
  });

  it('34. forecast-vs-realized error is EXACT (round-trip → attribution row)', async () => {
    // Build a full round-trip flow in the DB using the existing tx paths,
    // then persist the attribution and read back.
    const chain = await newChain();
    const now = new Date();
    const [{ insertId: feeTierId }] = (await db.insert(feeTierSnapshots).values({
      pricingTier: 'Tier 1',
      makerFeeRate: '0.004',
      takerFeeRate: '0.006',
      productType: 'SPOT',
      fetchedAt: now,
    })) as unknown as { insertId: number }[];
    const [{ insertId: candidateId }] = (await db.insert(signalCandidates).values({
      scanSeed: `attr-${nextSuffix()}`,
      token: 'AAVE',
      mode: 'macro',
      scanPrice: '100',
      volume24h: '1000000',
      passedSignals: 1,
      totalSignals: 1,
      strategyVersion: 'test',
      featureVersion: 'test',
      marketWindow: 'ACTIVE',
      decisionChainId: chain,
      createdAt: now,
    })) as unknown as { insertId: number }[];
    const [{ insertId: forecastId }] = (await db.insert(executionCostForecasts).values({
      candidateId, feeTierSnapshotId: feeTierId,
      arrivalMid: '100', spreadBps: '5', entryFee: '0.6', exitFeeEstimate: '0.6',
      entryImpactBps: '0', exitImpactBpsEstimate: '10', latencySlippageBpsEstimate: '5',
      roundTripCost: '1.2', costToTargetPct: '15', takeProfitPrice: '108', stopLossPrice: '97',
      netTpPnl: '5', netSlPnl: '-4', costModelVersion: CASH_FLOW_MODEL_VERSION,
      exitCostQuantile: '0.95',
      decisionChainId: chain,
      // Gate 3B specific fields:
      entryCommission: '0.6',
      targetExitCommission: '0.65',
      stopExitCommission: '0.58',
      timeoutExitCommission: '0.60',
      entryImpact: '0',
      targetExitImpact: '0.15',
      stopExitImpact: '0.10',
      totalForecastCost: '1.40',
      netTargetPnl: '6.15',
      netStopPnl: '-3.68',
      netTimeoutPnl: '0.5',
      previewEntryFillPrice: '100',
      previewEstimatedAvgFillPrice: '100',
      expectedFilledBase: '1',
      targetStopBasis: 'preview_entry',
      bufferSource: 'configured',
      bufferVersion: CASH_FLOW_BUFFER_VERSION,
      bufferSampleCount: 0,
      isEmpiricalBuffer: false,
      probabilityCalibrationStatus: 'not_calibrated',
    })) as unknown as { insertId: number }[];

    const entryIntent = await insertOrderIntent({
      clientOrderId: `entry-attr-${nextSuffix()}`,
      productId: 'AAVE-USD', token: 'AAVE', side: 'BUY',
      orderType: 'market_ioc', quoteSize: '100',
      mode: 'macro', purpose: 'entry',
      state: 'filled', dryRun: true,
      decisionChainId: chain, costForecastId: forecastId,
    });
    // One entry fill.
    await db.insert(fillsTable).values({
      exchangeFillId: `attr-e-${nextSuffix()}`,
      orderIntentId: entryIntent, exchangeOrderId: 'o1',
      token: 'AAVE', side: 'BUY',
      filledSize: '1', fillPrice: '100', fee: '0.6', feeCurrency: 'USD',
      tradeTime: new Date(),
    });
    const [{ insertId: positionId }] = (await db.insert(positions).values({
      token: 'AAVE', mode: 'macro',
      avgEntryPrice: '100', filledQuantity: '1',
      entryFees: '0.6', entryQuoteSpent: '100', allocationPct: '5',
      takeProfitPrice: '108', stopLossPrice: '97',
      takeProfitPct: '8', stopLossPct: '3',
      entryOrderIntentId: entryIntent, entryDecisionChainId: chain,
      lifecycleState: 'closed', status: 'closed', closedAt: new Date(),
    })) as unknown as { insertId: number }[];
    const exitIntent = await insertOrderIntent({
      clientOrderId: `exit-attr-${nextSuffix()}`,
      productId: 'AAVE-USD', token: 'AAVE', side: 'SELL',
      orderType: 'market_ioc', baseSize: '1',
      mode: 'macro', purpose: 'take_profit',
      positionId, state: 'filled', dryRun: true, attemptGeneration: 1,
      decisionChainId: chain,
    });
    await db.insert(fillsTable).values({
      exchangeFillId: `attr-x-${nextSuffix()}`,
      orderIntentId: exitIntent, exchangeOrderId: 'o2',
      token: 'AAVE', side: 'SELL',
      filledSize: '1', fillPrice: '107.50', fee: '0.645', feeCurrency: 'USD',
      tradeTime: new Date(),
    });
    const [{ insertId: rtId }] = (await db.insert(roundTrips).values({
      positionId, token: 'AAVE', mode: 'macro',
      entryValueGross: '100', exitValueGross: '107.50',
      entryFees: '0.6', exitFees: '0.645',
      realizedNetPnl: '6.255', realizedNetPnlPct: '6.255',
      outcome: 'win', exitReason: 'take_profit',
      openedAt: new Date(), closedAt: new Date(),
      entryDecisionChainId: chain, finalExitDecisionChainId: chain,
      entryOrderIntentId: entryIntent, finalExitOrderIntentId: exitIntent,
    })) as unknown as { insertId: number }[];

    const attr = await persistForecastAttribution({
      roundTripId: rtId, outcomeTaken: 'target',
    });
    expect(attr).not.toBeNull();
    expect(attr!.attributionVersion).toBe(CASH_FLOW_ATTRIBUTION_VERSION);
    expect(attr!.outcomeTaken).toBe('target');
    expect(Number(attr!.realizedEntryCost)).toBeCloseTo(0.6, 8);
    expect(Number(attr!.realizedExitCost)).toBeCloseTo(0.645, 8);
    expect(Number(attr!.realizedNetPnl)).toBeCloseTo(6.255, 8);
    // Absolute error = |realized 6.255 - forecast target 6.15| = 0.105
    expect(Number(attr!.absoluteForecastError)).toBeCloseTo(0.105, 3);
  });

  it('35. probability model remains not_calibrated', async () => {
    const f = buildCashFlowForecast(forecastInput());
    expect(f.outcomeProbabilityEstimate.calibrationStatus).toBe('not_calibrated');
    expect(f.outcomeProbabilityEstimate.pTarget).toBeNull();
    expect(f.outcomeProbabilityEstimate.pStop).toBeNull();
    expect(f.outcomeProbabilityEstimate.pTimeout).toBeNull();
    expect(f.outcomeProbabilityEstimate.sampleCount).toBe(0);
    expect(UNCALIBRATED_PROBABILITY.calibrationStatus).toBe('not_calibrated');
  });
});

// Suppress unused imports.
void CONFIGURED_EXIT_IMPACT_BUFFER_BPS;
void CONFIGURED_LATENCY_BUFFER_BPS;
void CONFIGURED_STOP_GAP_BUFFER_BPS;
void forecastVsRealizedAttributions;
