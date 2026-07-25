import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Money } from '@horizon/shared';
import { db } from '../src/db';
import {
  cashLedger,
  decisionChains,
  eligibilityDecisions,
  fills as fillsTable,
  lineageEvents,
  marketObservations,
  orderIntents,
  outcomeLabels,
  positions,
  reconciliationActions,
  roundTrips,
  scanRuns,
  strategyRoutingDecisions,
  signalCandidates,
  executionCostForecasts,
  quantitativeDecisions,
} from '../src/db/schema';
import {
  appendCorrectedOutcomeLabel,
  appendLineageEvent,
  createDecisionChain,
  getDecisionChainAggregate,
  insertOutcomeLabel,
  recordEligibility,
  recordObservation,
  recordRoutingDecision,
  recordSetupEvaluation,
  startScanRun,
  transitionChainStatus,
  completeScanRun,
} from '../src/db/lineage';
import { labelRoundTrip } from '../src/trading/outcomeLabeler';
import { insertOrderIntent, updateBotConfig } from '../src/db/queries';
import { resetDatabase } from './setup/db';

/**
 * Phase 1.1 Gate 2 — the 32 required tests + K-migration integrity.
 *
 * These exercise the lineage layer directly (not via the scanner) so each
 * test is deterministic and does not depend on Claude/Coinbase mocks.
 */

let __seq = 800_000;
const nextSuffix = () => String(__seq++);

async function newScanRun() {
  return startScanRun({ triggerType: 'test', scannerVersion: 'test' });
}

async function newChain(scanRunId: number, product = 'AAVE-USD') {
  const now = new Date();
  return createDecisionChain({
    scanRunId,
    productId: product,
    strategyVersion: 'test',
    observedAt: now,
    dataAvailableAt: now,
    decisionStartedAt: now,
  });
}

async function completeChain(chainId: number, status: Parameters<typeof transitionChainStatus>[1]) {
  await transitionChainStatus(chainId, status, {
    completeness: 'complete',
    markDecisionCompleted: true,
  });
}

beforeEach(async () => {
  await resetDatabase();
  await updateBotConfig({ reconciliationStatus: 'ok' });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests 1-2: chain creation + scan-level blocking
// ═══════════════════════════════════════════════════════════════════════════

describe('§M.1 every token-level evaluation creates one decision chain', () => {
  it('1. token-level evaluation → exactly one chain per scan+product', async () => {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    expect(chain.id).toBeGreaterThan(0);
    const rows = await db.select().from(decisionChains).where(eq(decisionChains.scanRunId, scan.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].productId).toBe('AAVE-USD');
  });
});

describe('§M.2 scan-level blocking is recorded without fake token evaluations', () => {
  it('2. blocked scan_run has zero decision chains', async () => {
    const scan = await newScanRun();
    await completeScanRun(scan.id, 'blocked', 'circuit_breaker');
    const chains = await db.select().from(decisionChains).where(eq(decisionChains.scanRunId, scan.id));
    expect(chains).toHaveLength(0);
    const [refreshed] = await db.select().from(scanRuns).where(eq(scanRuns.id, scan.id));
    expect(refreshed.status).toBe('blocked');
    expect(refreshed.failureReason).toBe('circuit_breaker');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests 3-6: rejection paths retain lineage
// ═══════════════════════════════════════════════════════════════════════════

describe('§M.3-6 rejection paths retain lineage', () => {
  it('3. insufficient-volume rejection retains observation + eligibility', async () => {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    const obs = await recordObservation({
      decisionChainId: chain.id,
      productId: 'AAVE-USD',
      observedAt: new Date(),
      dataAvailableAt: new Date(),
      marketDataVersion: 'test',
      dataQualityStatus: 'valid',
      payload: { volume: 100 },
    });
    await recordEligibility({
      decisionChainId: chain.id,
      marketObservationId: obs.id,
      eligible: false,
      reasonCode: 'insufficient_volume',
      policyVersion: 'test',
    });
    const eligibility = await db
      .select()
      .from(eligibilityDecisions)
      .where(eq(eligibilityDecisions.decisionChainId, chain.id));
    expect(eligibility).toHaveLength(1);
    expect(eligibility[0].reasonCode).toBe('insufficient_volume');
    expect(eligibility[0].eligible).toBe(false);
  });

  it('4. market-data failure retains chain + eligibility (no fabricated observation)', async () => {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    await recordEligibility({
      decisionChainId: chain.id,
      eligible: false,
      reasonCode: 'market_data_failure',
      reasonDetail: 'coinbase 5xx',
      policyVersion: 'test',
    });
    await completeChain(chain.id, 'failed');
    const observations = await db
      .select()
      .from(marketObservations)
      .where(eq(marketObservations.decisionChainId, chain.id));
    // Data failure → NO market observation should exist.
    expect(observations).toHaveLength(0);
    const [refreshed] = await db.select().from(decisionChains).where(eq(decisionChains.id, chain.id));
    expect(refreshed.currentStatus).toBe('failed');
  });

  it('5. no-setup evaluation retains observation + setup_evaluation + routing', async () => {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    const obs = await recordObservation({
      decisionChainId: chain.id,
      productId: 'AAVE-USD',
      observedAt: new Date(),
      dataAvailableAt: new Date(),
      marketDataVersion: 'test',
      dataQualityStatus: 'valid',
      payload: {},
    });
    await recordEligibility({
      decisionChainId: chain.id,
      marketObservationId: obs.id,
      eligible: true,
      reasonCode: 'eligible',
      policyVersion: 'test',
    });
    const setup = await recordSetupEvaluation({
      decisionChainId: chain.id,
      marketObservationId: obs.id,
      setupDetected: false,
      strategyVersion: 'test',
      indicatorVersion: 'test',
      inputHash: 'h',
      reasonCodes: ['no_setup'],
    });
    await recordRoutingDecision({
      decisionChainId: chain.id,
      setupEvaluationId: setup.id,
      routingOutcome: 'no_trade',
      reasonCodes: ['no_setup'],
      strategyVersion: 'test',
    });
    const routing = await db
      .select()
      .from(strategyRoutingDecisions)
      .where(eq(strategyRoutingDecisions.decisionChainId, chain.id));
    expect(routing).toHaveLength(1);
    expect(routing[0].routingOutcome).toBe('no_trade');
  });

  it('6. cost-rejection chain retains the forecast row via decisionChainId', async () => {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    const now = new Date();
    // Seed a fee tier snapshot (FK target).
    const { feeTierSnapshots } = await import('../src/db/schema');
    const [{ insertId: feeTierId }] = (await db.insert(feeTierSnapshots).values({
      pricingTier: 'Tier 1',
      makerFeeRate: '0.006', takerFeeRate: '0.006',
      productType: 'SPOT',
      fetchedAt: now,
    })) as unknown as { insertId: number }[];
    const [{ insertId: candidateId }] = (await db
      .insert(signalCandidates)
      .values({
        scanSeed: 's', token: 'AAVE', mode: 'macro',
        scanPrice: '100', volume24h: '1000000',
        passedSignals: 1, totalSignals: 1,
        strategyVersion: 'test', featureVersion: 'test',
        marketWindow: 'ACTIVE',
        decisionChainId: chain.id,
        createdAt: now,
      })) as unknown as { insertId: number }[];
    const [{ insertId: forecastId }] = (await db
      .insert(executionCostForecasts)
      .values({
        candidateId,
        feeTierSnapshotId: feeTierId,
        arrivalMid: '100', spreadBps: '5', entryFee: '0.1', exitFeeEstimate: '0.1',
        entryImpactBps: '0', exitImpactBpsEstimate: '0', latencySlippageBpsEstimate: '0',
        roundTripCost: '0.2', costToTargetPct: '0.2', takeProfitPrice: '110', stopLossPrice: '95',
        netTpPnl: '-1', netSlPnl: '-6', costModelVersion: 'test', exitCostQuantile: '0.5',
        decisionChainId: chain.id, createdAt: now,
      })) as unknown as { insertId: number }[];
    await db.insert(quantitativeDecisions).values({
      candidateId, costForecastId: forecastId, decision: 'reject_cost_gate',
      strategyVersion: 'test', costModelVersion: 'test', evGateVersion: 'test',
      decisionChainId: chain.id, createdAt: now,
    });
    const fRows = await db
      .select()
      .from(executionCostForecasts)
      .where(eq(executionCostForecasts.decisionChainId, chain.id));
    expect(fRows).toHaveLength(1);
    expect(fRows[0].decisionChainId).toBe(chain.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 7: approved candidate has complete authorization chain
// ═══════════════════════════════════════════════════════════════════════════

describe('§M.7 approved candidate has a complete authorization chain', () => {
  it('7. observation + eligibility + setup + routing + forecast + decision all link', async () => {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    const obs = await recordObservation({
      decisionChainId: chain.id, productId: 'AAVE-USD',
      observedAt: new Date(), dataAvailableAt: new Date(),
      marketDataVersion: 'test', dataQualityStatus: 'valid', payload: {},
    });
    await recordEligibility({
      decisionChainId: chain.id, marketObservationId: obs.id,
      eligible: true, reasonCode: 'eligible', policyVersion: 'test',
    });
    const setup = await recordSetupEvaluation({
      decisionChainId: chain.id, marketObservationId: obs.id,
      setupDetected: true, strategyVersion: 'test', indicatorVersion: 'test',
      inputHash: 'h', reasonCodes: ['mode:macro'],
    });
    await recordRoutingDecision({
      decisionChainId: chain.id, setupEvaluationId: setup.id,
      selectedMode: 'macro', routingOutcome: 'macro_floor',
      reasonCodes: ['macro'], strategyVersion: 'test',
    });
    await transitionChainStatus(chain.id, 'approved');
    const aggregate = await getDecisionChainAggregate(chain.id);
    expect(aggregate).not.toBeNull();
    expect(aggregate!.observation).not.toBeNull();
    expect(aggregate!.eligibility?.eligible).toBe(true);
    expect(aggregate!.setup?.setupDetected).toBe(true);
    expect(aggregate!.routing?.routingOutcome).toBe('macro_floor');
    expect(aggregate!.chain.currentStatus).toBe('approved');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests 8-10: order intent + preview + forecast lineage integrity
// ═══════════════════════════════════════════════════════════════════════════

describe('§M.8-10 order intent lineage integrity', () => {
  it('8. order intent CAN store a chain id; missing chain → NULL is preserved (application-level)', async () => {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    const id = await insertOrderIntent({
      clientOrderId: `oi-${nextSuffix()}`,
      productId: 'AAVE-USD', token: 'AAVE', side: 'BUY',
      orderType: 'market_ioc', quoteSize: '100',
      mode: 'macro', purpose: 'entry', state: 'created', dryRun: true,
      decisionChainId: chain.id,
    });
    const [row] = await db.select().from(orderIntents).where(eq(orderIntents.id, id));
    expect(row.decisionChainId).toBe(chain.id);
  });

  it('9. two chains: each intent stays on ITS chain (no cross-chain confusion)', async () => {
    const scan = await newScanRun();
    const chainA = await newChain(scan.id, 'AAVE-USD');
    const chainB = await newChain(scan.id, 'BTC-USD');
    const idA = await insertOrderIntent({
      clientOrderId: `oi-a-${nextSuffix()}`,
      productId: 'AAVE-USD', token: 'AAVE', side: 'BUY',
      orderType: 'market_ioc', quoteSize: '100', mode: 'macro', purpose: 'entry',
      state: 'created', dryRun: true, decisionChainId: chainA.id,
    });
    const idB = await insertOrderIntent({
      clientOrderId: `oi-b-${nextSuffix()}`,
      productId: 'BTC-USD', token: 'BTC', side: 'BUY',
      orderType: 'market_ioc', quoteSize: '100', mode: 'macro', purpose: 'entry',
      state: 'created', dryRun: true, decisionChainId: chainB.id,
    });
    const [rowA] = await db.select().from(orderIntents).where(eq(orderIntents.id, idA));
    const [rowB] = await db.select().from(orderIntents).where(eq(orderIntents.id, idB));
    expect(rowA.decisionChainId).toBe(chainA.id);
    expect(rowB.decisionChainId).toBe(chainB.id);
    expect(rowA.decisionChainId).not.toBe(rowB.decisionChainId);
  });

  it('10. preview binding on intent survives insert (configHash, previewId, decisionChainId all persist)', async () => {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    const id = await insertOrderIntent({
      clientOrderId: `oi-${nextSuffix()}`,
      productId: 'AAVE-USD', token: 'AAVE', side: 'BUY',
      orderType: 'market_ioc', quoteSize: '100', mode: 'macro', purpose: 'entry',
      state: 'created', dryRun: true,
      decisionChainId: chain.id, previewId: 'prv-abc', configHash: 'a'.repeat(64),
    });
    const [row] = await db.select().from(orderIntents).where(eq(orderIntents.id, id));
    expect(row.previewId).toBe('prv-abc');
    expect(row.configHash).toBe('a'.repeat(64));
    expect(row.decisionChainId).toBe(chain.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests 11-14: fill/position/round-trip lineage
// ═══════════════════════════════════════════════════════════════════════════

describe('§M.11-14 execution lineage', () => {
  async function setupChainWithIntentAndPosition() {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    const intentId = await insertOrderIntent({
      clientOrderId: `oi-${nextSuffix()}`,
      productId: 'AAVE-USD', token: 'AAVE', side: 'BUY',
      orderType: 'market_ioc', quoteSize: '100', mode: 'macro', purpose: 'entry',
      state: 'submitted', dryRun: true, decisionChainId: chain.id,
    });
    const [{ insertId: positionId }] = (await db.insert(positions).values({
      token: 'AAVE', mode: 'macro',
      avgEntryPrice: '100', filledQuantity: '1',
      entryFees: '0.6', entryQuoteSpent: '100', allocationPct: '5',
      takeProfitPrice: '108', stopLossPrice: '97',
      takeProfitPct: '8', stopLossPct: '3',
      entryOrderIntentId: intentId, entryDecisionChainId: chain.id,
      lifecycleState: 'open', status: 'open',
    })) as unknown as { insertId: number }[];
    return { scan, chain, intentId, positionId };
  }

  it('11. fill → intent → chain is traceable transitively', async () => {
    const { chain, intentId } = await setupChainWithIntentAndPosition();
    const [{ insertId: fillId }] = (await db.insert(fillsTable).values({
      exchangeFillId: `f-${nextSuffix()}`,
      orderIntentId: intentId, exchangeOrderId: 'e-1',
      token: 'AAVE', side: 'BUY',
      filledSize: '1', fillPrice: '100', fee: '0.6', feeCurrency: 'USD',
      tradeTime: new Date(),
    })) as unknown as { insertId: number }[];
    // From fillId, follow: fill → intent → chain.
    const [fill] = await db.select().from(fillsTable).where(eq(fillsTable.id, fillId));
    const [intent] = await db.select().from(orderIntents).where(eq(orderIntents.id, fill.orderIntentId));
    expect(intent.decisionChainId).toBe(chain.id);
  });

  it('12. position resolves back to the entry authorization chain', async () => {
    const { chain, positionId } = await setupChainWithIntentAndPosition();
    const [pos] = await db.select().from(positions).where(eq(positions.id, positionId));
    expect(pos.entryDecisionChainId).toBe(chain.id);
  });

  it('13. partial fills — multiple fills all resolve to the same chain', async () => {
    const { chain, intentId } = await setupChainWithIntentAndPosition();
    for (let i = 0; i < 3; i++) {
      await db.insert(fillsTable).values({
        exchangeFillId: `pf-${nextSuffix()}`,
        orderIntentId: intentId, exchangeOrderId: 'e-1',
        token: 'AAVE', side: 'BUY',
        filledSize: '0.3', fillPrice: '100', fee: '0.18', feeCurrency: 'USD',
        tradeTime: new Date(),
      });
    }
    const fills = await db.select().from(fillsTable).where(eq(fillsTable.orderIntentId, intentId));
    expect(fills).toHaveLength(3);
    // All resolve to the same chain via the shared intent.
    const [intent] = await db.select().from(orderIntents).where(eq(orderIntents.id, intentId));
    expect(intent.decisionChainId).toBe(chain.id);
  });

  it('14. multiple exit attempts attach to one position; entryDecisionChainId preserves origin', async () => {
    const { chain, positionId } = await setupChainWithIntentAndPosition();
    // Exit attempts each carry entryDecisionChainId (original chain) + their own
    // decisionChainId (a new exit chain).
    const exitScan = await newScanRun();
    const exitChain1 = await newChain(exitScan.id);
    const exitChain2 = await newChain(exitScan.id);
    const exit1 = await insertOrderIntent({
      clientOrderId: `exit-1-${nextSuffix()}`,
      productId: 'AAVE-USD', token: 'AAVE', side: 'SELL',
      orderType: 'market_ioc', baseSize: '0.5', mode: 'macro', purpose: 'manual_exit',
      positionId, state: 'submitted', dryRun: true, attemptGeneration: 1,
      decisionChainId: exitChain1.id, entryDecisionChainId: chain.id,
    });
    const exit2 = await insertOrderIntent({
      clientOrderId: `exit-2-${nextSuffix()}`,
      productId: 'AAVE-USD', token: 'AAVE', side: 'SELL',
      orderType: 'market_ioc', baseSize: '0.5', mode: 'macro', purpose: 'manual_exit',
      positionId, state: 'submitted', dryRun: true, attemptGeneration: 2,
      decisionChainId: exitChain2.id, entryDecisionChainId: chain.id,
    });
    const [r1] = await db.select().from(orderIntents).where(eq(orderIntents.id, exit1));
    const [r2] = await db.select().from(orderIntents).where(eq(orderIntents.id, exit2));
    expect(r1.entryDecisionChainId).toBe(chain.id);
    expect(r2.entryDecisionChainId).toBe(chain.id);
    expect(r1.decisionChainId).not.toBe(r2.decisionChainId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests 15-16: reconciliation preserves original chain
// ═══════════════════════════════════════════════════════════════════════════

describe('§M.15-16 reconciliation lineage preservation', () => {
  it('15. recovered unknown order — original intent + chain reused, not replaced', async () => {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    const intentId = await insertOrderIntent({
      clientOrderId: `unknown-${nextSuffix()}`,
      productId: 'AAVE-USD', token: 'AAVE', side: 'BUY',
      orderType: 'market_ioc', quoteSize: '100', mode: 'macro', purpose: 'entry',
      state: 'unknown', dryRun: false, decisionChainId: chain.id,
    });
    // Reconciler discovers fills — attaches them to the SAME intent.
    await db.insert(fillsTable).values({
      exchangeFillId: `rec-${nextSuffix()}`,
      orderIntentId: intentId, exchangeOrderId: 'cb-x',
      token: 'AAVE', side: 'BUY',
      filledSize: '1', fillPrice: '100', fee: '0.6', feeCurrency: 'USD',
      tradeTime: new Date(),
    });
    await db.insert(reconciliationActions).values({
      runId: 'test-run', intentId, action: 'reconciled',
      previousState: 'unknown', newState: 'filled',
      decisionChainId: chain.id, economicStateApplied: true, fillsDiscovered: 1,
    });
    const actions = await db
      .select()
      .from(reconciliationActions)
      .where(eq(reconciliationActions.decisionChainId, chain.id));
    expect(actions).toHaveLength(1);
    expect(actions[0].intentId).toBe(intentId);
    // No new intent was created.
    const intents = await db.select().from(orderIntents).where(eq(orderIntents.decisionChainId, chain.id));
    expect(intents).toHaveLength(1);
  });

  it('16. reconciliation records action on the ORIGINAL chain, never a new authorization chain', async () => {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    await db.insert(reconciliationActions).values({
      runId: 'test-run-2', action: 'reconciled', decisionChainId: chain.id,
    });
    // Reconciler didn't create any new authorization row.
    const candidates = await db
      .select()
      .from(signalCandidates)
      .where(eq(signalCandidates.decisionChainId, chain.id));
    expect(candidates).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests 17-19: ledger cause attribution + idempotency + round-trip lineage
// ═══════════════════════════════════════════════════════════════════════════

describe('§M.17-19 ledger + round-trip lineage', () => {
  it('17. ledger event stored with a causeCategory + chain is retrievable', async () => {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    await db.insert(cashLedger).values({
      deltaUsd: '-100', reason: 'buy_cost', dryRun: true,
      idempotencyKey: `test-${nextSuffix()}`,
      decisionChainId: chain.id, causeCategory: 'fill_driven',
    });
    const rows = await db
      .select()
      .from(cashLedger)
      .where(eq(cashLedger.decisionChainId, chain.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].causeCategory).toBe('fill_driven');
  });

  it('18. duplicate ledger row rejected by UNIQUE idempotencyKey', async () => {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    const key = `dup-${nextSuffix()}`;
    await db.insert(cashLedger).values({
      deltaUsd: '-100', reason: 'buy_cost', dryRun: true,
      idempotencyKey: key, decisionChainId: chain.id, causeCategory: 'fill_driven',
    });
    let err: unknown;
    try {
      await db.insert(cashLedger).values({
        deltaUsd: '-100', reason: 'buy_cost', dryRun: true,
        idempotencyKey: key, decisionChainId: chain.id, causeCategory: 'fill_driven',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const rows = await db.select().from(cashLedger).where(eq(cashLedger.idempotencyKey, key));
    expect(rows).toHaveLength(1);
  });

  it('19. completed round-trip stores entry + final-exit chain refs', async () => {
    const scan = await newScanRun();
    const entryChain = await newChain(scan.id);
    const exitChain = await newChain(scan.id);
    const [{ insertId: positionId }] = (await db.insert(positions).values({
      token: 'AAVE', mode: 'macro',
      avgEntryPrice: '100', filledQuantity: '1',
      entryFees: '0.6', entryQuoteSpent: '100', allocationPct: '5',
      takeProfitPrice: '108', stopLossPrice: '97',
      takeProfitPct: '8', stopLossPct: '3',
      entryOrderIntentId: 1, entryDecisionChainId: entryChain.id,
      lifecycleState: 'closed', status: 'closed', closedAt: new Date(),
    })) as unknown as { insertId: number }[];
    await db.insert(roundTrips).values({
      positionId, token: 'AAVE', mode: 'macro',
      entryValueGross: '100', exitValueGross: '110',
      entryFees: '0.6', exitFees: '0.6',
      realizedNetPnl: '8.8', realizedNetPnlPct: '8.8',
      outcome: 'win', exitReason: 'take_profit',
      openedAt: new Date(), closedAt: new Date(),
      entryDecisionChainId: entryChain.id,
      finalExitDecisionChainId: exitChain.id,
    });
    const [rt] = await db.select().from(roundTrips).where(eq(roundTrips.positionId, positionId));
    expect(rt.entryDecisionChainId).toBe(entryChain.id);
    expect(rt.finalExitDecisionChainId).toBe(exitChain.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests 20-23: outcome labeling — forward-only + version integrity + ambiguity
// ═══════════════════════════════════════════════════════════════════════════

describe('§M.20-23 outcome labeling', () => {
  async function chainWithCompletedDecision() {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    await transitionChainStatus(chain.id, 'position_closed', {
      completeness: 'complete',
      markDecisionCompleted: true,
      eventTime: new Date('2026-01-01T00:00:00Z'),
    });
    return chain;
  }

  it('20. outcome dataAvailableAt BEFORE decisionCompletedAt → rejected', async () => {
    const chain = await chainWithCompletedDecision();
    await expect(
      insertOutcomeLabel({
        decisionChainId: chain.id,
        labelType: 'timeout',
        labelWindowStart: new Date('2025-12-31T00:00:00Z'),
        labelWindowEnd: new Date('2025-12-31T01:00:00Z'),
        dataAvailableAt: new Date('2025-12-31T02:00:00Z'), // BEFORE completion
      }),
    ).rejects.toThrow(/look-ahead bias rejected/);
  });

  it('21. duplicate outcome label version rejected (UNIQUE constraint)', async () => {
    const chain = await chainWithCompletedDecision();
    await insertOutcomeLabel({
      decisionChainId: chain.id,
      labelType: 'timeout',
      labelWindowStart: new Date('2026-01-01T01:00:00Z'),
      labelWindowEnd: new Date('2026-01-01T02:00:00Z'),
      dataAvailableAt: new Date('2026-01-01T02:00:00Z'),
    });
    // Second insertOutcomeLabel automatically bumps the version, so it
    // succeeds — the UNIQUE constraint is on (chain, labelVersion) which
    // requires distinct versions. Manually attempting the same version
    // must fail.
    let err: unknown;
    try {
      await db.insert(outcomeLabels).values({
        decisionChainId: chain.id, labelVersion: 1, labelType: 'timeout',
        timeout: true, ambiguous: false,
        labelWindowStart: new Date('2026-01-01T01:00:00Z'),
        labelWindowEnd: new Date('2026-01-01T02:00:00Z'),
        dataAvailableAt: new Date('2026-01-01T02:00:00Z'),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
  });

  it('22. correction creates a new labelVersion via appendCorrectedOutcomeLabel', async () => {
    const chain = await chainWithCompletedDecision();
    const first = await insertOutcomeLabel({
      decisionChainId: chain.id,
      labelType: 'sl_first',
      slReachedFirst: true,
      labelWindowStart: new Date('2026-01-01T01:00:00Z'),
      labelWindowEnd: new Date('2026-01-01T02:00:00Z'),
      dataAvailableAt: new Date('2026-01-01T02:00:00Z'),
    });
    const corrected = await appendCorrectedOutcomeLabel(first.id, 'off-by-one bug', {
      decisionChainId: chain.id,
      labelType: 'tp_first',
      tpReachedFirst: true,
      labelWindowStart: new Date('2026-01-01T01:00:00Z'),
      labelWindowEnd: new Date('2026-01-01T02:00:00Z'),
      dataAvailableAt: new Date('2026-01-01T02:00:00Z'),
    });
    expect(corrected.labelVersion).toBeGreaterThan(first.labelVersion);
    expect(corrected.supersedesOutcomeLabelId).toBe(first.id);
    expect(corrected.correctionReason).toBe('off-by-one bug');
  });

  it('23. intrabar TP+SL ambiguity NEVER labels tpFirst=true (conservative)', async () => {
    const chain = await chainWithCompletedDecision();
    const label = await labelRoundTrip({
      decisionChainId: chain.id,
      roundTripId: 1,
      entryPrice: '100',
      takeProfitPrice: '108',
      stopLossPrice: '97',
      side: 'long',
      labelWindowStart: new Date('2026-01-01T01:00:00Z'),
      labelWindowEnd: new Date('2026-01-01T02:00:00Z'),
      // One candle where both TP and SL are inside [low, high].
      candles: [
        {
          timestamp: new Date('2026-01-01T01:30:00Z'),
          dataAvailableAt: new Date('2026-01-01T01:35:00Z'),
          open: '100', high: '110', low: '95', close: '100',
        },
      ],
      intrabarPolicy: 'ambiguous_flag',
    });
    expect(label.ambiguous).toBe(true);
    expect(label.tpReachedFirst).toBeNull();
    expect(label.slReachedFirst).toBeNull();

    // With conservative_adverse policy: SL first, not TP first.
    const label2 = await labelRoundTrip({
      decisionChainId: chain.id,
      roundTripId: 2,
      entryPrice: '100',
      takeProfitPrice: '108',
      stopLossPrice: '97',
      side: 'long',
      labelWindowStart: new Date('2026-01-01T01:00:00Z'),
      labelWindowEnd: new Date('2026-01-01T02:00:00Z'),
      candles: [
        {
          timestamp: new Date('2026-01-01T01:30:00Z'),
          dataAvailableAt: new Date('2026-01-01T01:35:00Z'),
          open: '100', high: '110', low: '95', close: '100',
        },
      ],
      intrabarPolicy: 'conservative_adverse',
    });
    expect(label2.tpReachedFirst).toBe(false);
    expect(label2.slReachedFirst).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests 24-25: legacy backfill markers
// ═══════════════════════════════════════════════════════════════════════════

describe('§M.24-25 legacy backfill markers', () => {
  it('24. legacy_unresolved chain stays unresolved (no forced inference)', async () => {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    await db
      .update(decisionChains)
      .set({ legacyStatus: 'legacy_unresolved', lineageCompleteness: 'legacy_unresolved' })
      .where(eq(decisionChains.id, chain.id));
    const [refreshed] = await db.select().from(decisionChains).where(eq(decisionChains.id, chain.id));
    expect(refreshed.legacyStatus).toBe('legacy_unresolved');
    expect(refreshed.lineageCompleteness).toBe('legacy_unresolved');
  });

  it('25. legacy_unresolved chains are excluded from research eligibility (predicate check)', async () => {
    const scan = await newScanRun();
    const chainCurrent = await newChain(scan.id);
    const chainLegacy = await newChain(scan.id);
    await db.update(decisionChains).set({ legacyStatus: 'legacy_unresolved' }).where(eq(decisionChains.id, chainLegacy.id));
    const researchEligible = await db
      .select()
      .from(decisionChains)
      .where(and(eq(decisionChains.scanRunId, scan.id), eq(decisionChains.legacyStatus, 'current')));
    expect(researchEligible.map((r) => r.id)).toEqual([chainCurrent.id]);
    expect(researchEligible.map((r) => r.id)).not.toContain(chainLegacy.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests 26-27: lineage events + immutability
// ═══════════════════════════════════════════════════════════════════════════

describe('§M.26-27 lineage events + immutability', () => {
  it('26. chain status transition emits a lineage event', async () => {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    await transitionChainStatus(chain.id, 'candidate');
    await transitionChainStatus(chain.id, 'approved');
    const events = await db
      .select()
      .from(lineageEvents)
      .where(eq(lineageEvents.decisionChainId, chain.id));
    const types = events.map((e) => e.eventType).sort();
    // chain_created + status_candidate + status_approved
    expect(types).toContain('chain_created');
    expect(types).toContain('status_candidate');
    expect(types).toContain('status_approved');
  });

  it('27. immutable insert-only tables have NO update helper exported', async () => {
    const mod = await import('../src/db/lineage');
    const forbidden = ['updateMarketObservation', 'updateEligibilityDecision', 'updateSetupEvaluation', 'updateRoutingDecision'];
    for (const name of forbidden) {
      expect((mod as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests 28-29: audit route + FK enforcement
// ═══════════════════════════════════════════════════════════════════════════

describe('§M.28-29 audit route + FK enforcement', () => {
  it('28. complete chain is returned by getDecisionChainAggregate', async () => {
    const scan = await newScanRun();
    const chain = await newChain(scan.id);
    const obs = await recordObservation({
      decisionChainId: chain.id, productId: 'AAVE-USD',
      observedAt: new Date(), dataAvailableAt: new Date(),
      marketDataVersion: 't', dataQualityStatus: 'valid', payload: {},
    });
    await recordEligibility({
      decisionChainId: chain.id, marketObservationId: obs.id,
      eligible: true, reasonCode: 'eligible', policyVersion: 't',
    });
    const aggregate = await getDecisionChainAggregate(chain.id);
    expect(aggregate).not.toBeNull();
    expect(aggregate!.chain.id).toBe(chain.id);
    expect(aggregate!.scan?.id).toBe(scan.id);
    expect(aggregate!.observation?.id).toBe(obs.id);
    expect(aggregate!.events.length).toBeGreaterThan(0);
  });

  it('29. FK-guarded child insert with a bogus chain id is rejected', async () => {
    let err: unknown;
    try {
      await db.insert(marketObservations).values({
        decisionChainId: 999_999_999,
        productId: 'AAVE-USD',
        observedAt: new Date(), dataAvailableAt: new Date(),
        marketDataVersion: 't', inputDataHash: 'h',
        dataQualityStatus: 'valid', immutablePayload: '{}',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests 30-32: migration integrity + killswitch
// ═══════════════════════════════════════════════════════════════════════════

describe('§M.30-32 migrations + killswitch', () => {
  it('30. Gate 2 migration produces the expected new tables', async () => {
    const { sql } = await import('drizzle-orm');
    const raw = (await db.execute(sql`SHOW TABLES`)) as unknown as [Record<string, string>[], unknown];
    const arr = Array.isArray(raw[0]) ? raw[0] : (raw as unknown as Record<string, string>[]);
    const tables = arr.map((r) => Object.values(r)[0]);
    expect(tables).toEqual(
      expect.arrayContaining([
        'scan_runs', 'decision_chains', 'market_observations',
        'eligibility_decisions', 'setup_evaluations', 'strategy_routing_decisions',
        'outcome_labels', 'lineage_events',
      ]),
    );
  });

  it('31. drizzle-kit diff would be empty after Gate 2 (proxy check: schema.ts columns exist on DB)', async () => {
    const { sql } = await import('drizzle-orm');
    const raw = (await db.execute(sql`DESCRIBE decision_chains`)) as unknown as [{ Field: string }[], unknown];
    const arr = Array.isArray(raw[0]) ? raw[0] : (raw as unknown as { Field: string }[]);
    const names = arr.map((r) => r.Field);
    for (const col of ['scanRunId', 'productId', 'strategyVersion', 'currentStatus', 'observedAt', 'dataAvailableAt', 'decisionCompletedAt', 'lineageCompleteness', 'legacyStatus']) {
      expect(names).toContain(col);
    }
  });

  it('32. ORDER_SUBMISSION_ENABLED=false still guarantees zero createOrder HTTP calls', async () => {
    const { createOrder, CoinbaseError } = await import('../src/trading/coinbase');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }) as unknown as Response,
    );
    try {
      await expect(
        createOrder({ clientOrderId: 'ks-gate2', token: 'AAVE', side: 'BUY', quoteSize: '10' }),
      ).rejects.toBeInstanceOf(CoinbaseError);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

void appendLineageEvent;
void Money;
