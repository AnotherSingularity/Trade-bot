import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  executionCostForecasts,
  shadowExecutionPlans,
  type ExecutionCostForecastRow,
  type ProtectionCapabilityRow,
  type ProtectionPolicyVersionRow,
  type ShadowExecutionPlanRow,
} from '../../db/schema';
import { appendLineageEvent } from '../../db/lineage';
import {
  buildCashFlowForecast,
  CASH_FLOW_BUFFER_VERSION,
  CASH_FLOW_MODEL_VERSION,
  type CashFlowForecast,
  type CashFlowForecastInput,
} from '../cashFlowForecast';
import {
  applyCostAdjustedPayoffGate,
  DEFAULT_PAYOFF_GATE_THRESHOLDS,
  type PayoffGateResult,
} from '../costAdjustedPayoffGate';
import {
  buildProtectedConfig,
  type BuildProtectedConfigInput,
  type ProtectedConfig,
} from '../protection/configBuilder';
import {
  CONFIGURED_GAP_RISK_POLICY,
  evaluateProtectionCapability,
  type CapabilityVerdict,
  type OperatingMode,
} from '../protection/capabilityGate';
import { currentCapability } from '../protection/policy';

/**
 * Phase 1.1 Gate 3D §B — shadow authorization pipeline.
 *
 * In SHADOW_LIVE, the scanner pipeline runs:
 *
 *   market observation
 *   → eligibility
 *   → setup evaluation
 *   → strategy routing
 *   → Coinbase preview                      (caller)
 *   → Gate 3B cash-flow forecast            (this module)
 *   → costAdjustedPayoffGate                (this module)
 *   → quantitative decision                 (caller — annotated with the plan)
 *   → Claude review                         (caller — sees the approved plan only)
 *   → protection capability evaluation      (this module)
 *   → approved shadow execution plan        (this module — immutable row)
 *   → paper order intent                    (caller — consumes the plan)
 *
 * Absolute rules:
 *   1. The Gate 3B model runs BEFORE Claude. `authorizeShadowEntry`
 *      returns `rejected` if the forecast fails the payoff gate; Claude
 *      is not invoked in that branch (caller enforcement is asserted by
 *      test §1).
 *   2. Negative or incomplete economics never reach Claude.
 *   3. `not_calibrated` probabilities cannot influence sizing — this
 *      module never reads them, and the plan's `exactBaseSize` /
 *      `exactQuoteSize` come from `preview.baseSize` /
 *      `preview.quoteSize` unchanged.
 *   4. Only an approved plan can produce a shadow paper intent
 *      (enforced downstream by `consumePlan`).
 *   5. Any change to the plan's economic fields ⇒ new plan version;
 *      supersedes the prior row (which stays immutable).
 */

export const SHADOW_STRATEGY_VERSION = 'p1g3d-shadow-1';
export const SHADOW_LINEAGE_VERSION = 'p1g3d-lineage-1';

export interface AuthorizeShadowEntryInput {
  decisionChainId: number;
  operatingMode: OperatingMode;
  costForecastInput: CashFlowForecastInput;
  forecastRow: {
    /**
     * The persisted execution_cost_forecasts row id. The plan links back
     * to the exact authorizing forecast so attribution can walk the chain
     * — same forecast id → same plan.
     */
    costForecastId: number;
    quantitativeDecisionId?: number | null;
    /** feeTierSnapshotId associated with the forecast. */
    feeTierSnapshotId: number;
    /** Coinbase preview id. */
    approvedPreviewId: number;
  };
  protectionPolicy: ProtectionPolicyVersionRow;
  protectionCapability?: ProtectionCapabilityRow | null;
  configBuilderOverrides: Omit<
    BuildProtectedConfigInput,
    'targetPrice' | 'stopTriggerPrice' | 'decisionChainId' | 'previewId' | 'policyVersion'
  >;
  /** Plan lifetime in milliseconds. Default 60_000. */
  planLifetimeMs?: number;
  now?: Date;
}

export type AuthorizationVerdict = 'authorized' | 'rejected_economics' | 'rejected_protection' | 'invalid_input';

export interface AuthorizeShadowEntryResult {
  verdict: AuthorizationVerdict;
  forecast: CashFlowForecast;
  payoffGate: PayoffGateResult;
  capabilityVerdict: CapabilityVerdict | null;
  config: ProtectedConfig | null;
  plan: ShadowExecutionPlanRow | null;
  reason: string;
}

/**
 * The one-and-only entry point that produces a SHADOW_LIVE execution plan.
 * Legacy profitability calculations MUST NOT create a plan by any other
 * path.
 */
export async function authorizeShadowEntry(
  input: AuthorizeShadowEntryInput,
): Promise<AuthorizeShadowEntryResult> {
  const now = input.now ?? new Date();

  // 1. Gate 3B cash-flow forecast.
  const forecast = buildCashFlowForecast(input.costForecastInput);

  // 2. Cost-adjusted payoff gate — Claude is never invoked before this passes.
  const payoffGate = applyCostAdjustedPayoffGate(forecast as never, DEFAULT_PAYOFF_GATE_THRESHOLDS);
  if (payoffGate.decision !== 'accept') {
    await appendLineageEvent({
      decisionChainId: input.decisionChainId,
      eventType: 'shadow.authorization.rejected_economics',
      sourceEntityType: 'shadow_execution_plan',
      sourceRecordId: null,
      eventTime: now,
      actor: 'shadow_authorization',
      componentVersion: SHADOW_STRATEGY_VERSION,
      metadata: { reason: payoffGate.reason, decision: payoffGate.decision },
    });
    return {
      verdict: 'rejected_economics',
      forecast,
      payoffGate,
      capabilityVerdict: null,
      config: null,
      plan: null,
      reason: payoffGate.reason,
    };
  }

  // 3. Build the protection configuration (long-only for shadow — TP > SL).
  const configResult = buildProtectedConfig({
    ...input.configBuilderOverrides,
    targetPrice: forecast.takeProfitPrice,
    stopTriggerPrice: forecast.stopLossPrice,
    decisionChainId: input.decisionChainId,
    previewId: input.forecastRow.approvedPreviewId,
    policyVersion: input.protectionPolicy,
  });
  if (!configResult.ok) {
    await appendLineageEvent({
      decisionChainId: input.decisionChainId,
      eventType: 'shadow.authorization.rejected_config',
      sourceEntityType: 'shadow_execution_plan',
      sourceRecordId: null,
      eventTime: now,
      actor: 'shadow_authorization',
      componentVersion: SHADOW_STRATEGY_VERSION,
      metadata: { reason: configResult.reason, detail: configResult.detail },
    });
    return {
      verdict: 'invalid_input',
      forecast,
      payoffGate,
      capabilityVerdict: null,
      config: null,
      plan: null,
      reason: `${configResult.reason}: ${configResult.detail}`,
    };
  }
  const config = configResult.config;

  // 4. Protection capability evaluation.
  const capability =
    input.protectionCapability ??
    (await currentCapability({
      policyVersionId: input.protectionPolicy.id,
      productId: config.productId,
      side: config.side,
      entryOrderType: config.entryOrderType,
      timeInForce: config.timeInForce,
      protectionType: config.protectionType,
    }));
  const capabilityVerdict = evaluateProtectionCapability({
    product: { productId: config.productId },
    configuration: config,
    operatingMode: input.operatingMode,
    policyVersion: input.protectionPolicy,
    capability,
    preconditionsPassed:
      input.operatingMode === 'live_capital'
        ? { restartReconstruction: false, partialFillHandling: false, degradationBehavior: false }
        : undefined,
    gapRiskPolicy: input.operatingMode === 'shadow_live' ? CONFIGURED_GAP_RISK_POLICY : null,
    requiredQuantityConfirmed: false,
    now,
  });
  if (capabilityVerdict.decision !== 'authorized') {
    await appendLineageEvent({
      decisionChainId: input.decisionChainId,
      eventType: 'shadow.authorization.rejected_protection',
      sourceEntityType: 'shadow_execution_plan',
      sourceRecordId: null,
      eventTime: now,
      actor: 'shadow_authorization',
      componentVersion: SHADOW_STRATEGY_VERSION,
      metadata: {
        reason: capabilityVerdict.reason,
        decision: capabilityVerdict.decision,
      },
    });
    return {
      verdict: 'rejected_protection',
      forecast,
      payoffGate,
      capabilityVerdict,
      config,
      plan: null,
      reason: capabilityVerdict.reason,
    };
  }

  // 5. Fetch the persisted forecast row so we can bind the plan to
  //    exact server-side identifiers (not the caller-supplied inputs).
  const [forecastRow] = await db
    .select()
    .from(executionCostForecasts)
    .where(eq(executionCostForecasts.id, input.forecastRow.costForecastId))
    .limit(1);
  if (!forecastRow) {
    return {
      verdict: 'invalid_input',
      forecast,
      payoffGate,
      capabilityVerdict,
      config,
      plan: null,
      reason: `costForecastId ${input.forecastRow.costForecastId} not found`,
    };
  }

  // 6. Insert the immutable plan.
  const expiresAt = new Date(now.getTime() + (input.planLifetimeMs ?? 60_000));
  const preview = input.costForecastInput.preview;
  const [{ insertId }] = (await db.insert(shadowExecutionPlans).values({
    planVersion: 1,
    decisionChainId: input.decisionChainId,
    approvedPreviewId: input.forecastRow.approvedPreviewId,
    quantitativeDecisionId: input.forecastRow.quantitativeDecisionId ?? null,
    costForecastId: input.forecastRow.costForecastId,
    protectionPolicyVersionId: input.protectionPolicy.id,
    protectionCapabilityId: capability!.id,
    productId: config.productId,
    side: config.side,
    orderType: config.entryOrderType,
    timeInForce: config.timeInForce,
    exactBaseSize: preview.baseSize ? preview.baseSize.toDecimalString(8) : null,
    exactQuoteSize: preview.quoteSize ? preview.quoteSize.toDecimalString(8) : null,
    entryLimitPrice: null,
    targetPrice: config.targetPrice.toDecimalString(8),
    stopTriggerPrice: config.stopTriggerPrice.toDecimalString(8),
    stopLimitPrice: config.stopLimitPrice ? config.stopLimitPrice.toDecimalString(8) : null,
    configurationHash: config.configurationHash,
    feeTierSnapshotId: input.forecastRow.feeTierSnapshotId,
    previewedAt: now,
    expiresAt,
    strategyVersion: SHADOW_STRATEGY_VERSION,
    costModelVersion: CASH_FLOW_MODEL_VERSION,
    protectionPolicyVersion: input.protectionPolicy.version,
    simulationMode: input.operatingMode === 'shadow_live' ? 'SHADOW_LIVE' : 'STANDARD_DRY_RUN',
    status: 'approved',
  })) as unknown as { insertId: number }[];
  const [plan] = await db
    .select()
    .from(shadowExecutionPlans)
    .where(eq(shadowExecutionPlans.id, insertId))
    .limit(1);
  await appendLineageEvent({
    decisionChainId: input.decisionChainId,
    eventType: 'shadow.plan_approved',
    sourceEntityType: 'shadow_execution_plan',
    sourceRecordId: insertId,
    eventTime: now,
    actor: 'shadow_authorization',
    componentVersion: SHADOW_STRATEGY_VERSION,
    metadata: {
      configurationHash: config.configurationHash,
      costForecastId: input.forecastRow.costForecastId,
      capabilityId: capability!.id,
      bufferVersion: CASH_FLOW_BUFFER_VERSION,
    },
  });
  return {
    verdict: 'authorized',
    forecast,
    payoffGate,
    capabilityVerdict,
    config,
    plan: plan!,
    reason: 'authorized',
  };
}

/** @internal used by tests to look up a stored forecast row. */
export async function getForecastRow(id: number): Promise<ExecutionCostForecastRow | null> {
  const [row] = await db
    .select()
    .from(executionCostForecasts)
    .where(eq(executionCostForecasts.id, id))
    .limit(1);
  return row ?? null;
}
