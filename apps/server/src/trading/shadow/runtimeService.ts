import { Money } from '@horizon/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  orderIntents,
  positions,
  protectionCapabilities,
  shadowExecutionPlans,
  type ProtectionCapabilityRow,
  type ProtectionPolicyVersionRow,
  type ShadowExecutionPlanRow,
} from '../../db/schema';
import { appendLineageEvent, createDecisionChain, startScanRun } from '../../db/lineage';
import { assertMode, isShadowLive, simulationMode } from '../../lib/operatingMode';
import type { CashFlowForecastInput } from '../cashFlowForecast';
import { authorizeShadowEntry, SHADOW_STRATEGY_VERSION } from './authorization';
import {
  closeShadowPosition,
  openShadowPosition,
  recordAdditionalEntryFill,
} from './simulator';
import { revalidateAfterEntryFill } from './postFillRevalidation';
import type { NormalizedFill } from '../../db/tx';
import type { ProtectedConfig } from '../protection/configBuilder';

/**
 * Phase 1.1 Gate 3D-FIX §B/§C/§D/§E — the ONE runtime service the
 * scheduled scanner + manual scanner + entry executor + exit engine +
 * reconciler MUST call in SHADOW_LIVE.
 *
 * Every function here asserts `simulationMode() === 'SHADOW_LIVE'` at
 * entry. Callers that construct trade parameters and hand them to the
 * legacy executor path are blocked source-level in `executor.openPosition`
 * (see `assertRuntimeShadowOrLegacyBypass`).
 *
 * The interface deliberately does NOT accept freely constructed trade
 * parameters at execution time. `runtimeShadowExecute` requires a
 * `planId + configHash` pair — nothing else. Size, TP, SL and every
 * other economic knob are inherited from the plan.
 */

// ---------------------------------------------------------------------------
// Scan — produces an approved plan (or a rejection).
// ---------------------------------------------------------------------------

export interface RuntimeShadowScanInput {
  productId: string;
  costForecastInput: CashFlowForecastInput;
  forecastRow: {
    costForecastId: number;
    feeTierSnapshotId: number;
    approvedPreviewId: number;
    quantitativeDecisionId?: number | null;
  };
  protectionPolicy: ProtectionPolicyVersionRow;
  protectionCapability?: ProtectionCapabilityRow | null;
  configBuilderOverrides: {
    productId: string;
    side: 'BUY' | 'SELL';
    entryOrderType: 'market_ioc' | 'limit' | 'stop_limit' | 'bracket_tp' | 'bracket_sl';
    timeInForce: 'IOC' | 'GTC' | 'FOK' | 'GTD';
    protectionType: ProtectionCapabilityRow['protectionType'];
    entryOrderIntentId: number;
  };
  /** Existing decisionChainId (from Gate 2 lineage) OR null to create one. */
  decisionChainId?: number;
  planLifetimeMs?: number;
  now?: Date;
}

export interface RuntimeShadowScanResult {
  ok: boolean;
  decisionChainId: number;
  planId: number | null;
  config: ProtectedConfig | null;
  reason: string;
}

export async function runtimeShadowScan(
  input: RuntimeShadowScanInput,
): Promise<RuntimeShadowScanResult> {
  assertMode('SHADOW_LIVE');
  const now = input.now ?? new Date();

  const chainId = input.decisionChainId ?? (await createRuntimeChain(input.productId, now));

  const auth = await authorizeShadowEntry({
    decisionChainId: chainId,
    operatingMode: 'shadow_live',
    costForecastInput: input.costForecastInput,
    forecastRow: input.forecastRow,
    protectionPolicy: input.protectionPolicy,
    protectionCapability: input.protectionCapability,
    configBuilderOverrides: input.configBuilderOverrides,
    planLifetimeMs: input.planLifetimeMs,
    now,
  });

  if (auth.verdict !== 'authorized' || !auth.plan) {
    return {
      ok: false,
      decisionChainId: chainId,
      planId: null,
      config: auth.config,
      reason: auth.reason,
    };
  }

  return {
    ok: true,
    decisionChainId: chainId,
    planId: auth.plan.id,
    config: auth.config,
    reason: 'authorized',
  };
}

async function createRuntimeChain(productId: string, now: Date): Promise<number> {
  const scan = await startScanRun({
    triggerType: 'runtime_shadow_scan',
    scannerVersion: SHADOW_STRATEGY_VERSION,
  });
  const chain = await createDecisionChain({
    scanRunId: scan.id,
    productId,
    strategyVersion: SHADOW_STRATEGY_VERSION,
    observedAt: now,
    dataAvailableAt: now,
    decisionStartedAt: now,
  });
  return chain.id;
}

// ---------------------------------------------------------------------------
// Execute — the runtime executor for SHADOW_LIVE.
// ---------------------------------------------------------------------------

export interface RuntimeShadowExecuteInput {
  planId: number;
  configHash: string;
  /** Simulated fills for the entry. Fixture-supplied; NEVER fabricated. */
  entryFills: NormalizedFill[];
  intentEndState: 'filled' | 'partially_filled';
  now?: Date;
}

export interface RuntimeShadowExecuteResult {
  ok: boolean;
  planId: number;
  positionId: number | null;
  intentId: number;
  protectionInstanceId: number | null;
  reason: string;
}

/**
 * The RUNTIME executor entry point. Accepts ONLY `{ planId, configHash,
 * entryFills }`. It cannot recalculate size, substitute an order type,
 * reconstruct TP or SL, or fall back to the legacy dry-run executor.
 * Every economic knob comes from the persisted plan.
 */
export async function runtimeShadowExecute(
  input: RuntimeShadowExecuteInput,
): Promise<RuntimeShadowExecuteResult> {
  assertMode('SHADOW_LIVE');
  const now = input.now ?? new Date();

  const [plan] = await db
    .select()
    .from(shadowExecutionPlans)
    .where(eq(shadowExecutionPlans.id, input.planId))
    .limit(1);
  if (!plan) {
    return {
      ok: false,
      planId: input.planId,
      positionId: null,
      intentId: 0,
      protectionInstanceId: null,
      reason: 'plan_not_found',
    };
  }
  if (plan.status !== 'approved') {
    return {
      ok: false,
      planId: input.planId,
      positionId: null,
      intentId: 0,
      protectionInstanceId: null,
      reason: `plan_status_${plan.status}`,
    };
  }
  if (plan.configurationHash !== input.configHash) {
    return {
      ok: false,
      planId: input.planId,
      positionId: null,
      intentId: 0,
      protectionInstanceId: null,
      reason: 'hash_mismatch',
    };
  }

  // Reconstruct the ProtectedConfig from the persisted plan — the
  // executor gets its inputs from the DB, NEVER from a caller-supplied
  // parameter.
  const [capability] = await db
    .select()
    .from(protectionCapabilities)
    .where(eq(protectionCapabilities.id, plan.protectionCapabilityId))
    .limit(1);
  if (!capability) {
    return {
      ok: false,
      planId: plan.id,
      positionId: null,
      intentId: 0,
      protectionInstanceId: null,
      reason: 'capability_missing',
    };
  }
  const config = configFromPlan(plan, capability);

  const opened = await openShadowPosition({
    planId: plan.id,
    config,
    clientOrderIdPrefix: 'runtime-shadow-entry',
    fills: input.entryFills,
    intentEndState: input.intentEndState,
    entryDecisionChainId: plan.decisionChainId,
    now,
  });

  if (!opened.ok || !opened.positionId) {
    return {
      ok: false,
      planId: plan.id,
      positionId: null,
      intentId: opened.intentId,
      protectionInstanceId: null,
      reason: opened.rejectionReason ?? 'entry_failed',
    };
  }

  // Post-fill revalidation runs against realized weighted fill.
  const realizedBase = input.entryFills.reduce(
    (acc, f) => acc.add(Money.fromString(f.filledSize)),
    Money.zero(),
  );
  const realizedQuote = input.entryFills.reduce(
    (acc, f) => acc.add(Money.fromString(f.filledSize).mul(Money.fromString(f.fillPrice))),
    Money.zero(),
  );
  const realizedFee = input.entryFills.reduce(
    (acc, f) => acc.add(Money.fromString(f.fee)),
    Money.zero(),
  );
  const realizedFill = realizedBase.isZero() ? Money.zero() : realizedQuote.div(realizedBase);
  await revalidateAfterEntryFill({
    executionPlanId: plan.id,
    orderIntentId: opened.intentId,
    positionId: opened.positionId,
    realizedEntryFillPrice: realizedFill,
    realizedEntryCommission: realizedFee,
    realizedFilledBase: realizedBase,
    now,
  });

  await appendLineageEvent({
    decisionChainId: plan.decisionChainId,
    eventType: 'shadow.runtime_execute',
    sourceEntityType: 'shadow_execution_plan',
    sourceRecordId: plan.id,
    eventTime: now,
    actor: 'runtime_shadow_executor',
    componentVersion: SHADOW_STRATEGY_VERSION,
    metadata: { intentId: opened.intentId, positionId: opened.positionId },
  });

  return {
    ok: true,
    planId: plan.id,
    positionId: opened.positionId,
    intentId: opened.intentId,
    protectionInstanceId: opened.protectionInstanceId,
    reason: 'ok',
  };
}

export interface RuntimeShadowAdditionalFillInput {
  intentId: number;
  positionId: number;
  protectionInstanceId: number;
  fills: NormalizedFill[];
  intentEndState: 'filled' | 'partially_filled';
  confirmedProtectedBase?: Money;
  now?: Date;
}

export async function runtimeShadowRecordAdditionalFill(
  input: RuntimeShadowAdditionalFillInput,
): Promise<void> {
  assertMode('SHADOW_LIVE');
  const [pos] = await db
    .select()
    .from(positions)
    .where(eq(positions.id, input.positionId))
    .limit(1);
  if (!pos) throw new Error(`runtimeShadowRecordAdditionalFill: position ${input.positionId} not found`);
  await recordAdditionalEntryFill({
    intentId: input.intentId,
    positionId: input.positionId,
    protectionInstanceId: input.protectionInstanceId,
    fills: input.fills,
    intentEndState: input.intentEndState,
    entryDecisionChainId: pos.entryDecisionChainId!,
    confirmedProtectedBase: input.confirmedProtectedBase,
    now: input.now,
  });
}

// ---------------------------------------------------------------------------
// Exit — the runtime exit engine for SHADOW_LIVE.
// ---------------------------------------------------------------------------

export interface RuntimeShadowExitInput {
  positionId: number;
  exitReason: 'take_profit' | 'stop_loss' | 'timeout' | 'manual_exit';
  exitFills: NormalizedFill[];
  intentEndState: 'filled' | 'partially_filled';
  attemptGeneration?: number;
  authoritativeLegCompletion: boolean;
  now?: Date;
}

export async function runtimeShadowExit(input: RuntimeShadowExitInput) {
  assertMode('SHADOW_LIVE');
  const [pos] = await db
    .select()
    .from(positions)
    .where(eq(positions.id, input.positionId))
    .limit(1);
  if (!pos) throw new Error(`runtimeShadowExit: position ${input.positionId} not found`);

  // Locate the entry intent + protection instance so the exit is fully bound.
  const [entryIntent] = await db
    .select()
    .from(orderIntents)
    .where(eq(orderIntents.id, pos.entryOrderIntentId))
    .limit(1);
  if (!entryIntent) throw new Error('runtimeShadowExit: entry intent missing');

  const { protectionInstances } = await import('../../db/schema');
  const [instance] = await db
    .select()
    .from(protectionInstances)
    .where(eq(protectionInstances.positionId, input.positionId))
    .limit(1);
  if (!instance) throw new Error('runtimeShadowExit: protection instance missing');

  const clientOrderId = `runtime-shadow-exit-${input.positionId}-${input.attemptGeneration ?? 1}`;

  return closeShadowPosition({
    positionId: input.positionId,
    entryIntentId: entryIntent.id,
    exitIntentClientOrderId: clientOrderId,
    exitFills: input.exitFills,
    exitReason: input.exitReason,
    intentEndState: input.intentEndState,
    attemptGeneration: input.attemptGeneration ?? 1,
    decisionChainId: entryIntent.decisionChainId ?? pos.entryDecisionChainId!,
    entryDecisionChainId: pos.entryDecisionChainId!,
    protectionInstanceId: instance.id,
    authoritativeLegCompletion: input.authoritativeLegCompletion,
    now: input.now,
  });
}

// ---------------------------------------------------------------------------
// Legacy-bypass guard — called by executor.openPosition (§F).
// ---------------------------------------------------------------------------

/**
 * Every legacy runtime call site that could create shadow economic state
 * MUST call this before writing. Under SHADOW_LIVE it forces the caller
 * to route through this module instead.
 */
export function assertRuntimeShadowOrLegacyBypass(kind: string): void {
  if (isShadowLive()) {
    throw new Error(
      `assertRuntimeShadowOrLegacyBypass: SHADOW_LIVE forbids legacy ${kind} — ` +
        `use runtimeShadowScan / runtimeShadowExecute / runtimeShadowExit instead`,
    );
  }
  // STANDARD_DRY_RUN and (future) live modes allow the legacy path.
  void simulationMode();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function configFromPlan(
  plan: ShadowExecutionPlanRow,
  capability: ProtectionCapabilityRow,
): ProtectedConfig {
  return {
    productId: plan.productId,
    side: plan.side,
    entryOrderType: plan.orderType,
    timeInForce: plan.timeInForce,
    protectionType: capability.protectionType,
    targetPrice: Money.fromString(plan.targetPrice),
    stopTriggerPrice: Money.fromString(plan.stopTriggerPrice),
    stopLimitPrice: plan.stopLimitPrice ? Money.fromString(plan.stopLimitPrice) : null,
    entryOrderIntentId: 0, // hash was computed at plan-approve time with 0; we pass 0 here
    decisionChainId: plan.decisionChainId,
    previewId: plan.approvedPreviewId,
    policyVersionId: plan.protectionPolicyVersionId,
    policyVersion: plan.protectionPolicyVersion,
    independentBaseQuantity: null,
    configurationHash: plan.configurationHash,
  };
}
