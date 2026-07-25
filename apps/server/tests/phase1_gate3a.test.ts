import { beforeEach, describe, expect, it } from 'vitest';
import { Money } from '@horizon/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db';
import {
  cashLedger,
  fills as fillsTable,
  orderIntents,
  positions,
  roundTrips,
} from '../src/db/schema';
import {
  applyEntryEconomicStateTx,
  applyExitEconomicStateTx,
  type NormalizedFill,
} from '../src/db/tx';
import {
  createDecisionChain,
  startScanRun,
  transitionChainStatus,
} from '../src/db/lineage';
import {
  classifyDust,
  DUST_POLICY_VERSION,
} from '../src/trading/dustPolicy';
import { verifyExitConfigMatches } from '../src/trading/exitAttemptAllocator';
import {
  ensureInitialFund,
  insertOrderIntent,
  updateBotConfig,
} from '../src/db/queries';
import { resetDatabase } from './setup/db';

/**
 * Phase 1.1 Gate 3A — the 20 required tests for exit + recovery
 * completion. All tests are deterministic — no Coinbase mocks needed;
 * we drive the atomic apply functions directly with synthetic fills.
 */

let __seq = 900_000;
const nextSuffix = () => String(__seq++);

async function newChain(): Promise<number> {
  const scan = await startScanRun({ triggerType: 'test', scannerVersion: 'test' });
  const now = new Date();
  const chain = await createDecisionChain({
    scanRunId: scan.id,
    productId: 'AAVE-USD',
    strategyVersion: 'test',
    observedAt: now,
    dataAvailableAt: now,
    decisionStartedAt: now,
  });
  return chain.id;
}

async function newEntryIntent(chainId: number, overrides: Partial<Parameters<typeof insertOrderIntent>[0]> = {}) {
  const id = await insertOrderIntent({
    clientOrderId: `entry-${nextSuffix()}`,
    productId: 'AAVE-USD', token: 'AAVE', side: 'BUY',
    orderType: 'market_ioc', quoteSize: '100.00000000',
    mode: 'macro', purpose: 'entry',
    state: 'submitted', dryRun: true,
    decisionChainId: chainId,
    ...overrides,
  });
  return id;
}

async function newExitIntent(positionId: number, chainId: number, generation = 1, overrides: Partial<Parameters<typeof insertOrderIntent>[0]> = {}) {
  const id = await insertOrderIntent({
    clientOrderId: `exit-${nextSuffix()}`,
    productId: 'AAVE-USD', token: 'AAVE', side: 'SELL',
    orderType: 'market_ioc', baseSize: '1.00000000',
    mode: 'macro', purpose: 'manual_exit',
    positionId, state: 'submitted', dryRun: true,
    attemptGeneration: generation,
    decisionChainId: chainId,
    entryDecisionChainId: chainId,
    ...overrides,
  });
  return id;
}

function synthFill(side: 'BUY' | 'SELL', overrides: Partial<NormalizedFill> = {}): NormalizedFill {
  return {
    exchangeFillId: overrides.exchangeFillId ?? `f-${side}-${nextSuffix()}`,
    exchangeOrderId: overrides.exchangeOrderId ?? `o-${side}-${nextSuffix()}`,
    token: 'AAVE', side,
    filledSize: '0.50000000',
    fillPrice: '100.00',
    fee: '0.30000000',
    feeCurrency: 'USD',
    tradeTime: new Date('2026-03-01T00:00:00Z'),
    rawResponse: '{}',
    ...overrides,
  };
}

async function openPosition(chainId: number, filledBase = '1.00000000') {
  const intentId = await newEntryIntent(chainId);
  const result = await applyEntryEconomicStateTx({
    intentId,
    fillsToApply: [
      synthFill('BUY', { filledSize: filledBase, fillPrice: '100', fee: '0.6' }),
    ],
    mode: 'macro', takeProfitPct: 8, stopLossPct: 3, allocationPct: 5,
    claudeReason: 't', claudeModel: 't', claudeConfidence: 0.8,
    strategyVersion: 'test', protectionMode: 'polling_fallback',
    dryRun: true, intentEndState: 'filled',
    entryDecisionChainId: chainId,
  });
  const [pos] = await db.select().from(positions).where(eq(positions.id, result.positionId));
  return { intentId, position: pos };
}

async function reloadPosition(id: number) {
  const [row] = await db.select().from(positions).where(eq(positions.id, id));
  return row;
}

beforeEach(async () => {
  await resetDatabase();
  await ensureInitialFund(true, 10_000);
  await updateBotConfig({ reconciliationStatus: 'ok' });
});

// ═══════════════════════════════════════════════════════════════════════════
// Execution + recovery (tests 1-20)
// ═══════════════════════════════════════════════════════════════════════════

describe('Gate 3A execution + recovery', () => {
  it('1. zero-fill entry changes no cash or position', async () => {
    const chain = await newChain();
    const intentId = await newEntryIntent(chain);
    await expect(
      applyEntryEconomicStateTx({
        intentId,
        fillsToApply: [
          synthFill('BUY', { filledSize: '0', fillPrice: '100', fee: '0' }),
        ],
        mode: 'macro', takeProfitPct: 8, stopLossPct: 3, allocationPct: 5,
        claudeReason: 't', claudeModel: 't', claudeConfidence: 0.8,
        strategyVersion: 't', protectionMode: 'polling_fallback',
        dryRun: true, intentEndState: 'filled',
      }),
    ).rejects.toThrow(/zero filled size/);
    const posRows = await db.select().from(positions);
    expect(posRows).toHaveLength(0);
    const ledger = await db.select().from(cashLedger).where(eq(cashLedger.orderIntentId, intentId));
    expect(ledger).toHaveLength(0);
  });

  it('2. partial entry debits exact applied fills', async () => {
    const chain = await newChain();
    const intentId = await newEntryIntent(chain);
    await applyEntryEconomicStateTx({
      intentId,
      fillsToApply: [
        synthFill('BUY', { filledSize: '0.4', fillPrice: '100', fee: '0.24' }),
      ],
      mode: 'macro', takeProfitPct: 8, stopLossPct: 3, allocationPct: 5,
      claudeReason: 't', claudeModel: 't', claudeConfidence: 0.8,
      strategyVersion: 't', protectionMode: 'polling_fallback',
      dryRun: true, intentEndState: 'partially_filled',
    });
    const ledger = await db.select().from(cashLedger).where(eq(cashLedger.orderIntentId, intentId));
    const total = ledger.reduce((s, r) => s.add(Money.fromString(r.deltaUsd)), Money.zero());
    // -40 (buy_cost) + -0.24 (buy_fee) = -40.24
    expect(total.toDecimalString(2)).toBe('-40.24');
  });

  it('3. partial entry then cancellation → exact partial position remains', async () => {
    const chain = await newChain();
    const { position } = await openPosition(chain, '0.4');
    // "Cancellation of remainder" = intent state moves to canceled; position
    // stays as-is with the 0.4 filled.
    await db.update(orderIntents).set({ state: 'canceled' }).where(eq(orderIntents.id, position.entryOrderIntentId));
    const reloaded = await reloadPosition(position.id);
    expect(reloaded.filledQuantity).toBe('0.40000000');
    expect(reloaded.status).toBe('open');
  });

  it('4. later entry fill updates the SAME position (no second position)', async () => {
    const chain = await newChain();
    const intentId = await newEntryIntent(chain);
    await applyEntryEconomicStateTx({
      intentId,
      fillsToApply: [synthFill('BUY', { filledSize: '0.4', fillPrice: '100', fee: '0.24' })],
      mode: 'macro', takeProfitPct: 8, stopLossPct: 3, allocationPct: 5,
      claudeReason: null, claudeModel: null, claudeConfidence: null,
      strategyVersion: 't', protectionMode: 'polling_fallback',
      dryRun: true, intentEndState: 'partially_filled',
    });
    // Now a later fill arrives (e.g. via reconciler) — apply again with BOTH fills.
    await applyEntryEconomicStateTx({
      intentId,
      fillsToApply: [
        synthFill('BUY', { exchangeFillId: 'fill-existing-should-dedupe', filledSize: '0.4', fillPrice: '100', fee: '0.24' }),
        synthFill('BUY', { filledSize: '0.6', fillPrice: '101', fee: '0.36' }),
      ],
      mode: 'macro', takeProfitPct: 8, stopLossPct: 3, allocationPct: 5,
      claudeReason: null, claudeModel: null, claudeConfidence: null,
      strategyVersion: 't', protectionMode: 'polling_fallback',
      dryRun: true, intentEndState: 'filled',
    });
    // Should still be one position for the same intent.
    const posRows = await db.select().from(positions).where(eq(positions.entryOrderIntentId, intentId));
    expect(posRows).toHaveLength(1);
  });

  it('5. duplicate entry fill replay changes nothing (idempotent)', async () => {
    const chain = await newChain();
    const { intentId, position } = await openPosition(chain);
    const before = (await db.select().from(cashLedger).where(eq(cashLedger.orderIntentId, intentId))).length;
    await applyEntryEconomicStateTx({
      intentId,
      fillsToApply: [
        synthFill('BUY', { exchangeFillId: (await db.select().from(fillsTable).where(eq(fillsTable.orderIntentId, intentId)))[0].exchangeFillId, filledSize: '1', fillPrice: '100', fee: '0.6' }),
      ],
      mode: 'macro', takeProfitPct: 8, stopLossPct: 3, allocationPct: 5,
      claudeReason: null, claudeModel: null, claudeConfidence: null,
      strategyVersion: 't', protectionMode: 'polling_fallback',
      dryRun: true, intentEndState: 'filled',
    });
    const after = (await db.select().from(cashLedger).where(eq(cashLedger.orderIntentId, intentId))).length;
    expect(after).toBe(before);
    void position;
  });

  it('6. partial exit credits exact applied proceeds', async () => {
    const chain = await newChain();
    const { position } = await openPosition(chain, '1');
    const exitId = await newExitIntent(position.id, chain, 1, { baseSize: '0.4' });
    await applyExitEconomicStateTx({
      intentId: exitId,
      position,
      fillsToApply: [synthFill('SELL', { filledSize: '0.4', fillPrice: '105', fee: '0.252' })],
      exitReason: 'manual',
      dryRun: true,
    });
    const ledger = await db.select().from(cashLedger).where(eq(cashLedger.orderIntentId, exitId));
    const total = ledger.reduce((s, r) => s.add(Money.fromString(r.deltaUsd)), Money.zero());
    // +42 (proceeds) - 0.252 (fee) = 41.748
    expect(total.toDecimalString(3)).toBe('41.748');
  });

  it('7. partial exit preserves exact residual base quantity', async () => {
    const chain = await newChain();
    const { position } = await openPosition(chain, '1');
    const exitId = await newExitIntent(position.id, chain, 1, { baseSize: '0.4' });
    const result = await applyExitEconomicStateTx({
      intentId: exitId, position,
      fillsToApply: [synthFill('SELL', { filledSize: '0.4', fillPrice: '105', fee: '0.252' })],
      exitReason: 'manual', dryRun: true,
    });
    expect(result.kind).toBe('partial');
    if (result.kind !== 'partial') return;
    expect(result.residualBaseSize).toBe('0.60000000');
    const p = await reloadPosition(position.id);
    expect(p.residualBaseSize).toBe('0.60000000');
    expect(p.status).toBe('open');
    expect(p.lifecycleState).toBe('partially_closing');
  });

  it('8. partial exit does NOT finalize the round trip', async () => {
    const chain = await newChain();
    const { position } = await openPosition(chain, '1');
    const exitId = await newExitIntent(position.id, chain, 1, { baseSize: '0.4' });
    await applyExitEconomicStateTx({
      intentId: exitId, position,
      fillsToApply: [synthFill('SELL', { filledSize: '0.4', fillPrice: '105', fee: '0.252' })],
      exitReason: 'manual', dryRun: true,
    });
    const rts = await db.select().from(roundTrips).where(eq(roundTrips.positionId, position.id));
    expect(rts).toHaveLength(0);
  });

  it('9. final exit closes position exactly once + creates exactly one round trip', async () => {
    const chain = await newChain();
    const { position } = await openPosition(chain, '1');
    // Partial exit: 0.4
    const exit1 = await newExitIntent(position.id, chain, 1, { baseSize: '0.4' });
    await applyExitEconomicStateTx({
      intentId: exit1, position,
      fillsToApply: [synthFill('SELL', { filledSize: '0.4', fillPrice: '105', fee: '0.252' })],
      exitReason: 'manual', dryRun: true,
    });
    // Full close of remainder: 0.6
    const exit2 = await newExitIntent(position.id, chain, 2, { baseSize: '0.6' });
    const closeResult = await applyExitEconomicStateTx({
      intentId: exit2, position,
      fillsToApply: [synthFill('SELL', { filledSize: '0.6', fillPrice: '106', fee: '0.3816' })],
      exitReason: 'manual', dryRun: true,
    });
    expect(closeResult.kind).toBe('closed');
    const rts = await db.select().from(roundTrips).where(eq(roundTrips.positionId, position.id));
    expect(rts).toHaveLength(1);
    // Round-trip aggregates BOTH exit fills.
    const totalExit = Number(rts[0].exitValueGross);
    expect(totalExit).toBeCloseTo(0.4 * 105 + 0.6 * 106, 4);
  });

  it('10. multiple exit attempts remain ONE position lifecycle (one round trip)', async () => {
    const chain = await newChain();
    const { position } = await openPosition(chain, '1');
    // Two exit attempts (different generations), both close portions.
    const exit1 = await newExitIntent(position.id, chain, 1, { baseSize: '0.3' });
    await applyExitEconomicStateTx({
      intentId: exit1, position,
      fillsToApply: [synthFill('SELL', { filledSize: '0.3', fillPrice: '105', fee: '0.189' })],
      exitReason: 'manual', dryRun: true,
    });
    const exit2 = await newExitIntent(position.id, chain, 2, { baseSize: '0.7' });
    await applyExitEconomicStateTx({
      intentId: exit2, position,
      fillsToApply: [synthFill('SELL', { filledSize: '0.7', fillPrice: '105', fee: '0.441' })],
      exitReason: 'manual', dryRun: true,
    });
    const rts = await db.select().from(roundTrips).where(eq(roundTrips.positionId, position.id));
    expect(rts).toHaveLength(1);
    const p = await reloadPosition(position.id);
    expect(p.status).toBe('closed');
  });

  it('11. failed exit reports failure (kind=partial or classifier error) and does NOT close', async () => {
    const chain = await newChain();
    const { position } = await openPosition(chain, '1');
    const exitId = await newExitIntent(position.id, chain, 1, { baseSize: '1' });
    // Zero fills should throw.
    await expect(
      applyExitEconomicStateTx({
        intentId: exitId, position,
        fillsToApply: [synthFill('SELL', { filledSize: '0', fillPrice: '100', fee: '0' })],
        exitReason: 'manual', dryRun: true,
      }),
    ).rejects.toThrow(/zero filled size/);
    const p = await reloadPosition(position.id);
    expect(p.status).toBe('open');
  });

  it('12. dust residual follows the documented policy', async () => {
    const dust = classifyDust({
      residualBase: Money.fromString('0.00000001'),
      baseIncrement: '0.00000001',
    });
    expect(dust.isDust).toBe(true);
    expect(dust.dustReason).toBe('below_increment_multiplier');
    expect(dust.policyVersion).toBe(DUST_POLICY_VERSION);
    const notDust = classifyDust({
      residualBase: Money.fromString('0.5'),
      baseIncrement: '0.00000001',
    });
    expect(notDust.isDust).toBe(false);
  });

  it('12b. dust-close on partial-exit near-zero remainder marks position dust_residual', async () => {
    const chain = await newChain();
    const { position } = await openPosition(chain, '1');
    const exitId = await newExitIntent(position.id, chain, 1, { baseSize: '0.99999999' });
    const result = await applyExitEconomicStateTx({
      intentId: exitId, position,
      fillsToApply: [synthFill('SELL', { filledSize: '0.99999999', fillPrice: '105', fee: '0.63' })],
      exitReason: 'manual', dryRun: true,
      dustThresholdBase: Money.fromString('0.00000001'),
    });
    expect(result.kind).toBe('dust_closed');
    if (result.kind !== 'dust_closed') return;
    const p = await reloadPosition(position.id);
    expect(p.lifecycleState).toBe('dust_residual');
    expect(p.dustQuantity).toBe('0.00000001');
    expect(p.dustReason).toBe('below_dust_threshold');
    expect(p.dustPolicyVersion).toBe('v1');
  });

  it('13. restart recovers partial entry (idempotent re-apply)', async () => {
    const chain = await newChain();
    const intentId = await newEntryIntent(chain);
    // Initial partial fill via reconciler-style path.
    await applyEntryEconomicStateTx({
      intentId,
      fillsToApply: [synthFill('BUY', { exchangeFillId: 'fill-recover', filledSize: '0.4', fillPrice: '100', fee: '0.24' })],
      mode: 'macro', takeProfitPct: 8, stopLossPct: 3, allocationPct: 5,
      claudeReason: null, claudeModel: null, claudeConfidence: null,
      strategyVersion: 'reconciler', protectionMode: 'polling_fallback',
      dryRun: true, intentEndState: 'partially_filled',
    });
    // Restart — re-apply same fills.
    await applyEntryEconomicStateTx({
      intentId,
      fillsToApply: [synthFill('BUY', { exchangeFillId: 'fill-recover', filledSize: '0.4', fillPrice: '100', fee: '0.24' })],
      mode: 'macro', takeProfitPct: 8, stopLossPct: 3, allocationPct: 5,
      claudeReason: null, claudeModel: null, claudeConfidence: null,
      strategyVersion: 'reconciler', protectionMode: 'polling_fallback',
      dryRun: true, intentEndState: 'partially_filled',
    });
    const posRows = await db.select().from(positions).where(eq(positions.entryOrderIntentId, intentId));
    expect(posRows).toHaveLength(1);
    const ledger = await db.select().from(cashLedger).where(eq(cashLedger.orderIntentId, intentId));
    expect(ledger).toHaveLength(2); // buy_cost + buy_fee, exactly once
  });

  it('14. restart recovers partial exit (idempotent re-apply)', async () => {
    const chain = await newChain();
    const { position } = await openPosition(chain, '1');
    const exitId = await newExitIntent(position.id, chain, 1, { baseSize: '0.4' });
    const fill = synthFill('SELL', { exchangeFillId: 'exit-recover', filledSize: '0.4', fillPrice: '105', fee: '0.252' });
    await applyExitEconomicStateTx({
      intentId: exitId, position, fillsToApply: [fill],
      exitReason: 'manual', dryRun: true,
    });
    await applyExitEconomicStateTx({
      intentId: exitId, position, fillsToApply: [fill],
      exitReason: 'manual', dryRun: true,
    });
    const ledger = await db.select().from(cashLedger).where(eq(cashLedger.orderIntentId, exitId));
    expect(ledger).toHaveLength(2); // sell_proceeds + sell_fee once
    const p = await reloadPosition(position.id);
    expect(p.residualBaseSize).toBe('0.60000000');
    expect(p.status).toBe('open');
  });

  it('15. delayed fill discovery applies exactly once', async () => {
    const chain = await newChain();
    const { position } = await openPosition(chain, '1');
    const exitId = await newExitIntent(position.id, chain, 1, { baseSize: '1' });
    // First discovery: 0.3
    await applyExitEconomicStateTx({
      intentId: exitId, position,
      fillsToApply: [synthFill('SELL', { exchangeFillId: 'e1', filledSize: '0.3', fillPrice: '105', fee: '0.189' })],
      exitReason: 'reconciled', dryRun: true,
    });
    // Second discovery: 0.3 + 0.7 (0.3 is the same as before)
    await applyExitEconomicStateTx({
      intentId: exitId, position,
      fillsToApply: [
        synthFill('SELL', { exchangeFillId: 'e1', filledSize: '0.3', fillPrice: '105', fee: '0.189' }),
        synthFill('SELL', { exchangeFillId: 'e2', filledSize: '0.7', fillPrice: '105', fee: '0.441' }),
      ],
      exitReason: 'reconciled', dryRun: true,
    });
    const fills = await db.select().from(fillsTable).where(eq(fillsTable.orderIntentId, exitId));
    expect(fills).toHaveLength(2);
    const ledger = await db.select().from(cashLedger).where(eq(cashLedger.orderIntentId, exitId));
    // 2 fills × (proceeds + fee) = 4 ledger rows, exactly once.
    expect(ledger).toHaveLength(4);
  });

  it('16. reconciliation preserves Gate 2 lineage (chain + entry chain intact)', async () => {
    const chain = await newChain();
    const { position } = await openPosition(chain, '1');
    const exitId = await newExitIntent(position.id, chain, 1, { baseSize: '1' });
    await applyExitEconomicStateTx({
      intentId: exitId, position,
      fillsToApply: [synthFill('SELL', { filledSize: '1', fillPrice: '105', fee: '0.63' })],
      exitReason: 'reconciled', dryRun: true,
    });
    const [rt] = await db.select().from(roundTrips).where(eq(roundTrips.positionId, position.id));
    expect(rt.entryDecisionChainId).toBe(chain);
    expect(rt.finalExitDecisionChainId).toBe(chain);
    expect(rt.finalExitOrderIntentId).toBe(exitId);
  });

  it('17. reconciliation cannot manufacture a new authorization chain', async () => {
    // The exit-recovery path in continuousReconciler uses the ORIGINAL
    // intent's decisionChainId; no new chain is ever created for a recovered
    // exit. We assert the property by inspecting the exit intent post-apply.
    const chain = await newChain();
    const { position } = await openPosition(chain, '1');
    const exitId = await newExitIntent(position.id, chain, 1, { baseSize: '1' });
    await applyExitEconomicStateTx({
      intentId: exitId, position,
      fillsToApply: [synthFill('SELL', { filledSize: '1', fillPrice: '105', fee: '0.63' })],
      exitReason: 'reconciled', dryRun: true,
    });
    const [intent] = await db.select().from(orderIntents).where(eq(orderIntents.id, exitId));
    expect(intent.decisionChainId).toBe(chain);
  });

  it('18. ledger + position + intent rollback together (throw at after_position)', async () => {
    const chain = await newChain();
    const intentId = await newEntryIntent(chain);
    await expect(
      applyEntryEconomicStateTx({
        intentId,
        fillsToApply: [synthFill('BUY', { filledSize: '1', fillPrice: '100', fee: '0.6' })],
        mode: 'macro', takeProfitPct: 8, stopLossPct: 3, allocationPct: 5,
        claudeReason: null, claudeModel: null, claudeConfidence: null,
        strategyVersion: 't', protectionMode: 'polling_fallback',
        dryRun: true, intentEndState: 'filled',
        __testHook: (stage) => { if (stage === 'after_position') throw new Error('injected'); },
      }),
    ).rejects.toThrow('injected');
    expect(await db.select().from(fillsTable).where(eq(fillsTable.orderIntentId, intentId))).toHaveLength(0);
    expect(await db.select().from(cashLedger).where(eq(cashLedger.orderIntentId, intentId))).toHaveLength(0);
    expect(await db.select().from(positions).where(eq(positions.entryOrderIntentId, intentId))).toHaveLength(0);
  });

  it('19. contradictory duplicate fill fails closed (fill uniqueness enforced)', async () => {
    // Two distinct fill IDs claiming the same exchangeFillId won't collide
    // (idempotent). But INSERTING a second row with the same exchangeFillId
    // via raw INSERT is rejected by the UNIQUE index — that's the "contradictory
    // duplicate fail-closed" guarantee.
    const chain = await newChain();
    const { intentId } = await openPosition(chain, '0.5');
    let dupErr: unknown;
    try {
      // Insert with same exchangeFillId as the entry fill but different price → UNIQUE rejects.
      const [existing] = await db.select().from(fillsTable).where(eq(fillsTable.orderIntentId, intentId));
      await db.insert(fillsTable).values({
        exchangeFillId: existing.exchangeFillId, // duplicate!
        orderIntentId: intentId, exchangeOrderId: 'x',
        token: 'AAVE', side: 'BUY',
        filledSize: '999', fillPrice: '999', fee: '999',
        feeCurrency: 'USD', tradeTime: new Date(),
      });
    } catch (e) {
      dupErr = e;
    }
    const { isDuplicateKeyError } = await import('../src/db/tx');
    expect(isDuplicateKeyError(dupErr)).toBe(true);
  });

  it('20. impossible residual (over-sell) is impossible — position not over-drawn', async () => {
    const chain = await newChain();
    const { position } = await openPosition(chain, '1');
    const exitId = await newExitIntent(position.id, chain, 1, { baseSize: '2' });
    // Attempt to sell MORE base than filled (base=2 vs filled=1).
    const result = await applyExitEconomicStateTx({
      intentId: exitId, position,
      fillsToApply: [
        synthFill('SELL', { exchangeFillId: 'e-over', filledSize: '2', fillPrice: '105', fee: '1.26' }),
      ],
      exitReason: 'manual', dryRun: true,
    });
    // Residual comes out negative → clamps to 0 and closes. This represents
    // an "over-sell" event which would be flagged as inconsistent in
    // partial-fill classification. Position is closed (not left in a
    // negative-quantity state).
    expect(['closed', 'dust_closed']).toContain(result.kind);
    const p = await reloadPosition(position.id);
    expect(Number(p.residualBaseSize)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Config verification (exit-attempt allocator §G)
// ═══════════════════════════════════════════════════════════════════════════

describe('Gate 3A §G exit-attempt config verification', () => {
  it('verifyExitConfigMatches returns ok for a matching intent', async () => {
    const chain = await newChain();
    const { position } = await openPosition(chain, '1');
    const exitId = await newExitIntent(position.id, chain, 1, { baseSize: '0.5' });
    const [intent] = await db.select().from(orderIntents).where(eq(orderIntents.id, exitId));
    const v = verifyExitConfigMatches(intent, {
      positionId: position.id, purpose: 'manual_exit', side: 'SELL',
      baseSize: intent.baseSize ?? undefined, orderType: 'market_ioc', mode: 'macro',
    });
    expect(v.ok).toBe(true);
  });

  it('verifyExitConfigMatches returns not ok when baseSize differs', async () => {
    const chain = await newChain();
    const { position } = await openPosition(chain, '1');
    const exitId = await newExitIntent(position.id, chain, 1, { baseSize: '0.5' });
    const [intent] = await db.select().from(orderIntents).where(eq(orderIntents.id, exitId));
    const v = verifyExitConfigMatches(intent, {
      positionId: position.id, purpose: 'manual_exit', side: 'SELL',
      baseSize: '1.00000000', orderType: 'market_ioc', mode: 'macro',
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.mismatches.some((m) => m.includes('baseSize'))).toBe(true);
  });
});

// Suppress unused-import warnings.
void transitionChainStatus;
void and;
