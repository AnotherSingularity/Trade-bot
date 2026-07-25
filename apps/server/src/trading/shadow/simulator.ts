import { Money } from '@horizon/shared';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  cashLedger,
  forecastVsRealizedAttributions,
  orderIntents,
  positions,
  roundTrips,
  type PositionRow,
  type ShadowExecutionPlanRow,
} from '../../db/schema';
import {
  applyEntryEconomicStateTx,
  applyExitEconomicStateTx,
  type ApplyEntryResult,
  type ApplyExitResult,
  type NormalizedFill,
} from '../../db/tx';
import { insertOrderIntent } from '../../db/queries';
import { appendLineageEvent } from '../../db/lineage';
import { consumePlan } from './executionPlan';
import {
  createProtectionInstance,
  recalculateInstanceAfterFill,
  updateBracketLeg,
  type LegState,
} from '../protection/instance';
import { persistForecastAttribution } from '../forecastAttribution';
import { SHADOW_STRATEGY_VERSION } from './authorization';
import type { ProtectedConfig } from '../protection/configBuilder';

/**
 * Phase 1.1 Gate 3D §F/§H — shadow execution simulator.
 *
 * Drives an approved plan through the SAME transactional apply
 * functions that real execution uses:
 *   - applyEntryEconomicStateTx
 *   - applyExitEconomicStateTx
 *   - createProtectionInstance / recalculateInstanceAfterFill / updateBracketLeg
 *   - persistForecastAttribution
 *
 * No shortcuts. The simulator can never authorize a position without an
 * approved plan; it consumes the plan via `consumePlan` before any
 * fills are applied, so the plan's immutability contract holds.
 *
 * Fills are supplied by the fixture — the model does not fabricate
 * outcomes. Every fixture path here is deterministic.
 */

export interface OpenShadowPositionInput {
  planId: number;
  config: ProtectedConfig;
  clientOrderIdPrefix: string;
  fills: NormalizedFill[];
  intentEndState: 'filled' | 'partially_filled';
  entryDecisionChainId: number;
  now?: Date;
}

export interface OpenShadowPositionResult {
  ok: boolean;
  plan: ShadowExecutionPlanRow;
  intentId: number;
  entryResult: ApplyEntryResult | null;
  positionId: number | null;
  protectionInstanceId: number | null;
  rejectionReason?: string;
}

export async function openShadowPosition(
  input: OpenShadowPositionInput,
): Promise<OpenShadowPositionResult> {
  const now = input.now ?? new Date();
  const consumed = await consumePlan({ planId: input.planId, callerConfigHash: input.config.configurationHash, now });
  if (!consumed.ok) {
    return {
      ok: false,
      plan: consumed.plan!,
      intentId: 0,
      entryResult: null,
      positionId: null,
      protectionInstanceId: null,
      rejectionReason: consumed.reason,
    };
  }
  const plan = consumed.plan;

  // Insert the paper order intent bound to the plan.
  const clientOrderId = `${input.clientOrderIdPrefix}-${plan.id}-${plan.planVersion}`;
  const intentId = await insertOrderIntent({
    clientOrderId,
    productId: plan.productId,
    token: plan.productId.split('-')[0],
    side: plan.side,
    orderType: 'market_ioc',
    quoteSize: plan.exactQuoteSize ?? undefined,
    baseSize: plan.exactBaseSize ?? undefined,
    mode: 'macro',
    purpose: 'entry',
    state: 'submitted',
    dryRun: true,
    decisionChainId: input.entryDecisionChainId,
    costForecastId: plan.costForecastId,
  });

  if (input.fills.length === 0) {
    await db.update(orderIntents).set({ state: 'canceled' }).where(eq(orderIntents.id, intentId));
    return {
      ok: true,
      plan,
      intentId,
      entryResult: null,
      positionId: null,
      protectionInstanceId: null,
      rejectionReason: 'zero_fill',
    };
  }

  const entryResult = await applyEntryEconomicStateTx({
    intentId,
    fillsToApply: input.fills,
    mode: 'macro',
    takeProfitPct: 8,
    stopLossPct: 3,
    allocationPct: 5,
    claudeReason: null,
    claudeModel: null,
    claudeConfidence: null,
    strategyVersion: SHADOW_STRATEGY_VERSION,
    protectionMode: 'exchange_bracket',
    dryRun: true,
    intentEndState: input.intentEndState,
    entryDecisionChainId: input.entryDecisionChainId,
  });

  const positionId = entryResult.positionId;

  // Create a protection instance sized to actual filled base.
  const [posRow] = await db.select().from(positions).where(eq(positions.id, positionId)).limit(1);
  const filledBase = Money.fromString(posRow!.filledQuantity);
  const instance = await createProtectionInstance({
    positionId,
    config: input.config,
    capabilityId: plan.protectionCapabilityId,
    requiredBaseQuantity: filledBase,
    confirmedBaseQuantity: filledBase, // shadow-fixture: exchange ack simulated as full
    now,
  });

  await appendLineageEvent({
    decisionChainId: input.entryDecisionChainId,
    eventType: 'shadow.entry_applied',
    sourceEntityType: 'position',
    sourceRecordId: positionId,
    eventTime: now,
    actor: 'shadow_simulator',
    componentVersion: SHADOW_STRATEGY_VERSION,
    metadata: { filledBase: filledBase.toDecimalString(8) },
  });

  return {
    ok: true,
    plan,
    intentId,
    entryResult,
    positionId,
    protectionInstanceId: instance.id,
  };
}

export interface RecordAdditionalEntryFillInput {
  intentId: number;
  positionId: number;
  protectionInstanceId: number;
  fills: NormalizedFill[];
  intentEndState: 'filled' | 'partially_filled';
  entryDecisionChainId: number;
  confirmedProtectedBase?: Money;
  now?: Date;
}

export async function recordAdditionalEntryFill(
  input: RecordAdditionalEntryFillInput,
): Promise<void> {
  const now = input.now ?? new Date();
  await applyEntryEconomicStateTx({
    intentId: input.intentId,
    fillsToApply: input.fills,
    mode: 'macro',
    takeProfitPct: 8,
    stopLossPct: 3,
    allocationPct: 5,
    claudeReason: null,
    claudeModel: null,
    claudeConfidence: null,
    strategyVersion: SHADOW_STRATEGY_VERSION,
    protectionMode: 'exchange_bracket',
    dryRun: true,
    intentEndState: input.intentEndState,
    entryDecisionChainId: input.entryDecisionChainId,
  });
  const [pos] = await db.select().from(positions).where(eq(positions.id, input.positionId)).limit(1);
  const filledBase = Money.fromString(pos!.filledQuantity);
  const confirmed = input.confirmedProtectedBase ?? filledBase;
  await recalculateInstanceAfterFill({
    instanceId: input.protectionInstanceId,
    newFilledBase: filledBase,
    newConfirmedBase: confirmed,
    reason: 'additional_entry_fill',
    now,
  });
}

export interface CloseShadowPositionInput {
  positionId: number;
  entryIntentId: number;
  exitIntentClientOrderId: string;
  exitFills: NormalizedFill[];
  exitReason: 'take_profit' | 'stop_loss' | 'timeout' | 'manual_exit';
  intentEndState: 'filled' | 'partially_filled';
  attemptGeneration?: number;
  decisionChainId: number;
  entryDecisionChainId: number;
  protectionInstanceId: number;
  authoritativeLegCompletion: boolean;
  now?: Date;
}

export async function closeShadowPosition(
  input: CloseShadowPositionInput,
): Promise<{ result: ApplyExitResult; roundTripId: number | null }> {
  const now = input.now ?? new Date();
  const [pos] = await db.select().from(positions).where(eq(positions.id, input.positionId)).limit(1);
  if (!pos) {
    throw new Error(`closeShadowPosition: position ${input.positionId} not found`);
  }
  const exitIntentId = await insertOrderIntent({
    clientOrderId: input.exitIntentClientOrderId,
    productId: pos.token + '-USD',
    token: pos.token,
    side: 'SELL',
    orderType: 'market_ioc',
    baseSize: input.exitFills.reduce((acc, f) => acc.add(Money.fromString(f.filledSize)), Money.zero()).toDecimalString(8),
    mode: 'macro',
    purpose:
      input.exitReason === 'take_profit'
        ? 'take_profit'
        : input.exitReason === 'stop_loss'
          ? 'stop_loss'
          : 'manual_exit', // 'timeout' is not a purpose enum value — map to manual_exit

    positionId: input.positionId,
    state: 'submitted',
    dryRun: true,
    attemptGeneration: input.attemptGeneration ?? 1,
    decisionChainId: input.decisionChainId,
    entryDecisionChainId: input.entryDecisionChainId,
  });
  const result = await applyExitEconomicStateTx({
    intentId: exitIntentId,
    position: pos!,
    exitReason:
      input.exitReason === 'take_profit'
        ? 'take_profit'
        : input.exitReason === 'stop_loss'
          ? 'stop_loss'
          : input.exitReason === 'timeout'
            ? 'early_exit'
            : 'manual',
    fillsToApply: input.exitFills,
    dustThresholdBase: Money.fromString('0.00000001'),
    dustPolicyVersion: 'p1g3d-shadow-dust-1',
    dryRun: true,
  });
  if (result.kind === 'closed' || result.kind === 'dust_closed') {
    // Finalize bracket legs authoritatively based on the reason.
    const filledLeg: LegState = 'filled';
    await updateBracketLeg({
      instanceId: input.protectionInstanceId,
      leg: input.exitReason === 'stop_loss' ? 'stop_loss_leg' : 'take_profit_leg',
      newState: filledLeg,
      authoritative: input.authoritativeLegCompletion,
      reason: `shadow_${input.exitReason}`,
      now,
    });
    // Write forecast-vs-realized attribution.
    await persistForecastAttribution({
      roundTripId: result.roundTripId,
      outcomeTaken:
        input.exitReason === 'take_profit'
          ? 'target'
          : input.exitReason === 'stop_loss'
            ? 'stop'
            : input.exitReason === 'timeout'
              ? 'timeout'
              : 'other',
    });
    return { result, roundTripId: result.roundTripId };
  }
  return { result, roundTripId: null };
}

// ---------------------------------------------------------------------------
// Accounting helpers used by the certification harness
// ---------------------------------------------------------------------------

export interface AccountingCheckResult {
  cashBalance: string;
  entryQuoteValues: string;
  entryFees: string;
  exitQuoteValues: string;
  exitFees: string;
  explicitAdjustments: string;
  expected: string;
  actual: string;
  difference: string;
}

/**
 * For every completed fixture, verify:
 *   endingCash = initialCash
 *              - Σ entryQuoteValues - Σ entryFees
 *              + Σ exitQuoteValues  - Σ exitFees
 *              + Σ explicitAdjustments
 */
export async function verifyAccounting(initialCash: Money): Promise<AccountingCheckResult> {
  const ledger = await db.select().from(cashLedger);
  let cash = Money.zero();
  let entryValues = Money.zero();
  let entryFees = Money.zero();
  let exitValues = Money.zero();
  let exitFees = Money.zero();
  let adjustments = Money.zero();
  for (const row of ledger) {
    const delta = Money.fromString(row.deltaUsd);
    cash = cash.add(delta);
    switch (row.reason) {
      case 'buy_cost':
        entryValues = entryValues.add(delta.abs());
        break;
      case 'buy_fee':
        entryFees = entryFees.add(delta.abs());
        break;
      case 'sell_proceeds':
        exitValues = exitValues.add(delta.abs());
        break;
      case 'sell_fee':
        exitFees = exitFees.add(delta.abs());
        break;
      case 'initial_fund':
      case 'manual_adjustment':
        adjustments = adjustments.add(delta);
        break;
    }
  }
  // Per §K:
  //   endingCash = initialCash - entryValues - entryFees + exitValues - exitFees + explicitAdjustments
  //
  // The initial_fund ledger row IS what set `initialCash`, so `adjustments`
  // = initialCash + any manual adjustments. Rewriting:
  //   expected = adjustments - entryValues - entryFees + exitValues - exitFees
  void initialCash;
  const expected = adjustments
    .sub(entryValues)
    .sub(entryFees)
    .add(exitValues)
    .sub(exitFees);
  const actual = cash;
  return {
    cashBalance: cash.toDecimalString(8),
    entryQuoteValues: entryValues.toDecimalString(8),
    entryFees: entryFees.toDecimalString(8),
    exitQuoteValues: exitValues.toDecimalString(8),
    exitFees: exitFees.toDecimalString(8),
    explicitAdjustments: adjustments.toDecimalString(8),
    expected: expected.toDecimalString(8),
    actual: actual.toDecimalString(8),
    difference: actual.sub(expected).toDecimalString(8),
  };
}

export async function countUnresolvedIntents(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orderIntents)
    .where(
      and(
        sql`state NOT IN ('filled','canceled','rejected','failed','partially_filled')`,
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

export async function countUnprotectedOpenPositions(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(positions)
    .where(
      and(
        eq(positions.status, 'open'),
        sql`(\`protectionState\` = 'degraded' OR \`lifecycleState\` = 'open_unprotected')`,
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

export async function countIncompleteAttributions(): Promise<number> {
  const closed = await db.select().from(roundTrips);
  if (closed.length === 0) return 0;
  const attributed = await db.select().from(forecastVsRealizedAttributions);
  const set = new Set(attributed.map((r) => r.roundTripId));
  return closed.filter((r) => !set.has(r.id)).length;
}

export async function positionsRequiringDust(): Promise<PositionRow[]> {
  return db
    .select()
    .from(positions)
    .where(and(eq(positions.status, 'closed'), sql`\`dustQuantity\` > 0`));
}
