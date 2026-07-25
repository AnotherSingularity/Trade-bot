import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from './index';
import {
  decisionChains,
  eligibilityDecisions,
  lineageEvents,
  marketObservations,
  outcomeLabels,
  postFillRevalidations,
  protectionCapabilities,
  protectionEvents,
  protectionInstances,
  protectionPolicyVersions,
  protectionValidationRuns,
  scanRuns,
  setupEvaluations,
  shadowExecutionPlans,
  strategyRoutingDecisions,
  type DecisionChainRow,
  type EligibilityDecisionRow,
  type LineageEventInsert,
  type MarketObservationRow,
  type OutcomeLabelRow,
  type PostFillRevalidationRow,
  type ProtectionCapabilityRow,
  type ProtectionEventRow,
  type ProtectionInstanceRow,
  type ProtectionPolicyVersionRow,
  type ProtectionValidationRunRow,
  type ScanRunRow,
  type SetupEvaluationRow,
  type ShadowExecutionPlanRow,
  type StrategyRoutingDecisionRow,
} from './schema';

/**
 * Decision-to-outcome lineage helpers (Phase 1.1 Gate 2).
 *
 * Every write goes through exactly one of the helpers here so the
 * immutability policy is enforced in code:
 *
 *   - `scan_runs` — mutable status transitions only (`startScanRun`,
 *     `completeScanRun`, `failScanRun`). All other columns are set at
 *     insert time and never updated.
 *   - `decision_chains` — mutable operational fields only
 *     (`currentStatus`, `decisionCompletedAt`, `lineageCompleteness`).
 *     Every transition emits a `lineage_events` row.
 *   - `market_observations`, `eligibility_decisions`, `setup_evaluations`,
 *     `strategy_routing_decisions` — INSERT-ONLY. There is no `update*`
 *     helper. Corrections must go through `supersede*` in a future slice.
 *   - `outcome_labels` — insert-only; corrections create a NEW version
 *     via `appendCorrectedOutcomeLabel` which sets
 *     `supersedesOutcomeLabelId` + a new `labelVersion`.
 *   - `lineage_events` — append-only. No update helper exists.
 *
 * Callers must NOT import table objects from `./schema` for these tables
 * except through this module; ad-hoc `db.update(marketObservations)`
 * bypasses the immutability policy.
 */

// ---------------------------------------------------------------------------
// Scan runs — mutable status only
// ---------------------------------------------------------------------------

export interface StartScanRunInput {
  triggerType: string;
  scannerVersion: string;
  botState?: string | null;
  reconciliationStatus?: string | null;
  marketWindowState?: string | null;
}

export async function startScanRun(input: StartScanRunInput): Promise<ScanRunRow> {
  const [{ insertId }] = (await db
    .insert(scanRuns)
    .values({
      triggerType: input.triggerType,
      scannerVersion: input.scannerVersion,
      botState: input.botState ?? null,
      reconciliationStatus: input.reconciliationStatus ?? null,
      marketWindowState: input.marketWindowState ?? null,
      status: 'started',
    })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(scanRuns).where(eq(scanRuns.id, insertId)).limit(1);
  return row!;
}

export async function completeScanRun(
  scanRunId: number,
  status: 'completed' | 'partially_completed' | 'blocked' | 'failed' = 'completed',
  failureReason?: string | null,
): Promise<void> {
  await db
    .update(scanRuns)
    .set({
      status,
      completedAt: new Date(),
      failureReason: failureReason ?? null,
    })
    .where(eq(scanRuns.id, scanRunId));
}

// ---------------------------------------------------------------------------
// Decision chains — mutable currentStatus / completeness only
// ---------------------------------------------------------------------------

export interface CreateChainInput {
  scanRunId: number;
  productId: string;
  strategyVersion: string;
  observedAt: Date;
  dataAvailableAt: Date;
  decisionStartedAt?: Date;
}

export async function createDecisionChain(input: CreateChainInput): Promise<DecisionChainRow> {
  const decisionStartedAt = input.decisionStartedAt ?? new Date();
  const [{ insertId }] = (await db
    .insert(decisionChains)
    .values({
      scanRunId: input.scanRunId,
      productId: input.productId,
      strategyVersion: input.strategyVersion,
      currentStatus: 'observed',
      observedAt: input.observedAt,
      dataAvailableAt: input.dataAvailableAt,
      decisionStartedAt,
    })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(decisionChains)
    .where(eq(decisionChains.id, insertId))
    .limit(1);
  await appendLineageEvent({
    decisionChainId: insertId,
    eventType: 'chain_created',
    sourceEntityType: 'decision_chain',
    sourceRecordId: insertId,
    eventTime: decisionStartedAt,
    dataAvailableAt: input.dataAvailableAt,
    actor: 'scanner',
    componentVersion: input.strategyVersion,
  });
  return row!;
}

export type ChainStatus = DecisionChainRow['currentStatus'];

/**
 * Transition a chain's currentStatus + optionally finalize its
 * `decisionCompletedAt`. Emits a lineage event describing the transition.
 * Callers pass `completeness` to also record whether the chain is
 * `complete` / `partial` / `broken`.
 */
export async function transitionChainStatus(
  chainId: number,
  newStatus: ChainStatus,
  options: {
    completeness?: DecisionChainRow['lineageCompleteness'];
    markDecisionCompleted?: boolean;
    actor?: string;
    componentVersion?: string;
    eventTime?: Date;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const rows = await db
    .select()
    .from(decisionChains)
    .where(eq(decisionChains.id, chainId))
    .limit(1);
  const existing = rows[0];
  if (!existing) throw new Error(`transitionChainStatus: chain ${chainId} not found`);
  const patch: Partial<DecisionChainRow> = { currentStatus: newStatus };
  if (options.completeness) patch.lineageCompleteness = options.completeness;
  if (options.markDecisionCompleted && !existing.decisionCompletedAt) {
    patch.decisionCompletedAt = options.eventTime ?? new Date();
  }
  await db.update(decisionChains).set(patch).where(eq(decisionChains.id, chainId));
  await appendLineageEvent({
    decisionChainId: chainId,
    eventType: `status_${newStatus}`,
    sourceEntityType: 'decision_chain',
    sourceRecordId: chainId,
    eventTime: options.eventTime ?? new Date(),
    actor: options.actor ?? 'system',
    componentVersion: options.componentVersion ?? existing.strategyVersion,
    metadata: options.metadata,
  });
}

// ---------------------------------------------------------------------------
// Market observations — INSERT ONLY
// ---------------------------------------------------------------------------

export interface RecordObservationInput {
  decisionChainId: number;
  productId: string;
  observedAt: Date;
  dataAvailableAt: Date;
  marketDataVersion: string;
  price?: string;
  volume24h?: string;
  spread?: string;
  dataQualityStatus: MarketObservationRow['dataQualityStatus'];
  failureReason?: string;
  payload: Record<string, unknown>;
}

export async function recordObservation(
  input: RecordObservationInput,
): Promise<MarketObservationRow> {
  const payloadJson = JSON.stringify(input.payload);
  const inputDataHash = createHash('sha256').update(payloadJson).digest('hex');
  const [{ insertId }] = (await db
    .insert(marketObservations)
    .values({
      decisionChainId: input.decisionChainId,
      productId: input.productId,
      observedAt: input.observedAt,
      dataAvailableAt: input.dataAvailableAt,
      marketDataVersion: input.marketDataVersion,
      inputDataHash,
      price: input.price ?? null,
      volume24h: input.volume24h ?? null,
      spread: input.spread ?? null,
      dataQualityStatus: input.dataQualityStatus,
      failureReason: input.failureReason ?? null,
      immutablePayload: payloadJson,
    })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(marketObservations)
    .where(eq(marketObservations.id, insertId))
    .limit(1);
  await appendLineageEvent({
    decisionChainId: input.decisionChainId,
    eventType: 'market_observed',
    sourceEntityType: 'market_observation',
    sourceRecordId: insertId,
    eventTime: input.observedAt,
    dataAvailableAt: input.dataAvailableAt,
    actor: 'scanner',
    componentVersion: input.marketDataVersion,
  });
  return row!;
}

// ---------------------------------------------------------------------------
// Eligibility decisions — INSERT ONLY
// ---------------------------------------------------------------------------

export interface RecordEligibilityInput {
  decisionChainId: number;
  marketObservationId?: number | null;
  eligible: boolean;
  reasonCode: EligibilityDecisionRow['reasonCode'];
  reasonDetail?: string;
  policyVersion: string;
  decidedAt?: Date;
}

export async function recordEligibility(
  input: RecordEligibilityInput,
): Promise<EligibilityDecisionRow> {
  const decidedAt = input.decidedAt ?? new Date();
  const [{ insertId }] = (await db
    .insert(eligibilityDecisions)
    .values({
      decisionChainId: input.decisionChainId,
      marketObservationId: input.marketObservationId ?? null,
      eligible: input.eligible,
      reasonCode: input.reasonCode,
      reasonDetail: input.reasonDetail ?? null,
      policyVersion: input.policyVersion,
      decidedAt,
    })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(eligibilityDecisions)
    .where(eq(eligibilityDecisions.id, insertId))
    .limit(1);
  await appendLineageEvent({
    decisionChainId: input.decisionChainId,
    eventType: input.eligible ? 'eligible' : 'ineligible',
    sourceEntityType: 'eligibility_decision',
    sourceRecordId: insertId,
    eventTime: decidedAt,
    actor: 'scanner',
    componentVersion: input.policyVersion,
    metadata: { reasonCode: input.reasonCode, reasonDetail: input.reasonDetail },
  });
  return row!;
}

// ---------------------------------------------------------------------------
// Setup evaluations — INSERT ONLY
// ---------------------------------------------------------------------------

export interface RecordSetupEvaluationInput {
  decisionChainId: number;
  marketObservationId: number;
  modeEvaluated?: string;
  setupDetected: boolean;
  setupScore?: string;
  strategyVersion: string;
  indicatorVersion: string;
  inputHash: string;
  reasonCodes: string[];
  evaluatedAt?: Date;
}

export async function recordSetupEvaluation(
  input: RecordSetupEvaluationInput,
): Promise<SetupEvaluationRow> {
  const evaluatedAt = input.evaluatedAt ?? new Date();
  const [{ insertId }] = (await db
    .insert(setupEvaluations)
    .values({
      decisionChainId: input.decisionChainId,
      marketObservationId: input.marketObservationId,
      modeEvaluated: input.modeEvaluated ?? null,
      setupDetected: input.setupDetected,
      setupScore: input.setupScore ?? null,
      strategyVersion: input.strategyVersion,
      indicatorVersion: input.indicatorVersion,
      inputHash: input.inputHash,
      reasonCodes: JSON.stringify(input.reasonCodes),
      evaluatedAt,
    })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(setupEvaluations)
    .where(eq(setupEvaluations.id, insertId))
    .limit(1);
  await appendLineageEvent({
    decisionChainId: input.decisionChainId,
    eventType: input.setupDetected ? 'setup_detected' : 'no_setup',
    sourceEntityType: 'setup_evaluation',
    sourceRecordId: insertId,
    eventTime: evaluatedAt,
    actor: 'scanner',
    componentVersion: input.strategyVersion,
  });
  return row!;
}

// ---------------------------------------------------------------------------
// Strategy routing decisions — INSERT ONLY
// ---------------------------------------------------------------------------

export interface RecordRoutingInput {
  decisionChainId: number;
  setupEvaluationId: number;
  selectedMode?: string;
  routingOutcome: StrategyRoutingDecisionRow['routingOutcome'];
  reasonCodes: string[];
  strategyVersion: string;
  decidedAt?: Date;
}

export async function recordRoutingDecision(
  input: RecordRoutingInput,
): Promise<StrategyRoutingDecisionRow> {
  const decidedAt = input.decidedAt ?? new Date();
  const [{ insertId }] = (await db
    .insert(strategyRoutingDecisions)
    .values({
      decisionChainId: input.decisionChainId,
      setupEvaluationId: input.setupEvaluationId,
      selectedMode: input.selectedMode ?? null,
      routingOutcome: input.routingOutcome,
      reasonCodes: JSON.stringify(input.reasonCodes),
      strategyVersion: input.strategyVersion,
      decidedAt,
    })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(strategyRoutingDecisions)
    .where(eq(strategyRoutingDecisions.id, insertId))
    .limit(1);
  await appendLineageEvent({
    decisionChainId: input.decisionChainId,
    eventType: `routed_${input.routingOutcome}`,
    sourceEntityType: 'strategy_routing_decision',
    sourceRecordId: insertId,
    eventTime: decidedAt,
    actor: 'scanner',
    componentVersion: input.strategyVersion,
  });
  return row!;
}

// ---------------------------------------------------------------------------
// Outcome labels — insert-only + versioned corrections
// ---------------------------------------------------------------------------

export interface RecordOutcomeLabelInput {
  decisionChainId: number;
  roundTripId?: number | null;
  labelType: string;
  tpReachedFirst?: boolean;
  slReachedFirst?: boolean;
  timeout?: boolean;
  ambiguous?: boolean;
  maximumFavorableExcursion?: string;
  maximumAdverseExcursion?: string;
  timeToTp?: number;
  timeToSl?: number;
  grossPnl?: string;
  netPnl?: string;
  totalFees?: string;
  forecastCost?: string;
  realizedCost?: string;
  labelWindowStart: Date;
  labelWindowEnd: Date;
  dataAvailableAt: Date;
}

export async function insertOutcomeLabel(
  input: RecordOutcomeLabelInput,
): Promise<OutcomeLabelRow> {
  // Enforce forward-only: dataAvailableAt must be >= chain.decisionCompletedAt.
  const chain = await db
    .select()
    .from(decisionChains)
    .where(eq(decisionChains.id, input.decisionChainId))
    .limit(1);
  const decisionCompletedAt = chain[0]?.decisionCompletedAt;
  if (!decisionCompletedAt) {
    throw new Error(
      `insertOutcomeLabel: chain ${input.decisionChainId} has no decisionCompletedAt; outcome labels require a completed decision`,
    );
  }
  if (input.dataAvailableAt.getTime() < decisionCompletedAt.getTime()) {
    throw new Error(
      `insertOutcomeLabel: outcome dataAvailableAt (${input.dataAvailableAt.toISOString()}) is BEFORE decisionCompletedAt (${decisionCompletedAt.toISOString()}); look-ahead bias rejected`,
    );
  }

  // Compute next version.
  const prior = await db
    .select({ v: outcomeLabels.labelVersion })
    .from(outcomeLabels)
    .where(eq(outcomeLabels.decisionChainId, input.decisionChainId))
    .orderBy(desc(outcomeLabels.labelVersion))
    .limit(1);
  const nextVersion = (prior[0]?.v ?? 0) + 1;
  const [{ insertId }] = (await db
    .insert(outcomeLabels)
    .values({
      decisionChainId: input.decisionChainId,
      roundTripId: input.roundTripId ?? null,
      labelVersion: nextVersion,
      labelType: input.labelType,
      tpReachedFirst: input.tpReachedFirst ?? null,
      slReachedFirst: input.slReachedFirst ?? null,
      timeout: input.timeout ?? false,
      ambiguous: input.ambiguous ?? false,
      maximumFavorableExcursion: input.maximumFavorableExcursion ?? null,
      maximumAdverseExcursion: input.maximumAdverseExcursion ?? null,
      timeToTp: input.timeToTp ?? null,
      timeToSl: input.timeToSl ?? null,
      grossPnl: input.grossPnl ?? null,
      netPnl: input.netPnl ?? null,
      totalFees: input.totalFees ?? null,
      forecastCost: input.forecastCost ?? null,
      realizedCost: input.realizedCost ?? null,
      labelWindowStart: input.labelWindowStart,
      labelWindowEnd: input.labelWindowEnd,
      dataAvailableAt: input.dataAvailableAt,
    })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(outcomeLabels)
    .where(eq(outcomeLabels.id, insertId))
    .limit(1);
  await appendLineageEvent({
    decisionChainId: input.decisionChainId,
    eventType: 'outcome_labeled',
    sourceEntityType: 'outcome_label',
    sourceRecordId: insertId,
    eventTime: new Date(),
    dataAvailableAt: input.dataAvailableAt,
    actor: 'labeler',
    componentVersion: `v${nextVersion}`,
    metadata: { labelType: input.labelType, version: nextVersion },
  });
  return row!;
}

/**
 * Emit a corrected outcome label — a NEW row with `supersedesOutcomeLabelId`
 * pointing back to the original and an incremented `labelVersion`.
 */
export async function appendCorrectedOutcomeLabel(
  supersedesId: number,
  correctionReason: string,
  input: RecordOutcomeLabelInput,
): Promise<OutcomeLabelRow> {
  const priorRows = await db
    .select()
    .from(outcomeLabels)
    .where(eq(outcomeLabels.id, supersedesId))
    .limit(1);
  if (!priorRows[0]) throw new Error(`appendCorrectedOutcomeLabel: prior ${supersedesId} not found`);
  const newRow = await insertOutcomeLabel(input);
  // Patch the fields the plain insertOutcomeLabel skipped.
  await db
    .update(outcomeLabels)
    .set({ supersedesOutcomeLabelId: supersedesId, correctionReason })
    .where(eq(outcomeLabels.id, newRow.id));
  const [refreshed] = await db
    .select()
    .from(outcomeLabels)
    .where(eq(outcomeLabels.id, newRow.id))
    .limit(1);
  return refreshed!;
}

// ---------------------------------------------------------------------------
// Lineage events — append-only journal
// ---------------------------------------------------------------------------

export async function appendLineageEvent(input: {
  decisionChainId: number;
  eventType: string;
  sourceEntityType: string;
  sourceRecordId?: number | null;
  eventTime: Date;
  dataAvailableAt?: Date | null;
  actor: string;
  componentVersion: string;
  metadata?: Record<string, unknown> | string | null;
}): Promise<void> {
  const values: LineageEventInsert = {
    decisionChainId: input.decisionChainId,
    eventType: input.eventType,
    sourceEntityType: input.sourceEntityType,
    sourceRecordId: input.sourceRecordId ?? null,
    eventTime: input.eventTime,
    dataAvailableAt: input.dataAvailableAt ?? null,
    actor: input.actor,
    componentVersion: input.componentVersion,
    metadata:
      input.metadata == null
        ? null
        : typeof input.metadata === 'string'
          ? input.metadata
          : JSON.stringify(input.metadata),
  };
  await db.insert(lineageEvents).values(values);
}

// ---------------------------------------------------------------------------
// Read helpers (audit route)
// ---------------------------------------------------------------------------

export async function getDecisionChainAggregate(chainId: number) {
  const [chain] = await db
    .select()
    .from(decisionChains)
    .where(eq(decisionChains.id, chainId))
    .limit(1);
  if (!chain) return null;
  const [scan] = await db.select().from(scanRuns).where(eq(scanRuns.id, chain.scanRunId)).limit(1);
  const [observation] = await db
    .select()
    .from(marketObservations)
    .where(eq(marketObservations.decisionChainId, chainId))
    .limit(1);
  const [eligibility] = await db
    .select()
    .from(eligibilityDecisions)
    .where(eq(eligibilityDecisions.decisionChainId, chainId))
    .limit(1);
  const [setup] = await db
    .select()
    .from(setupEvaluations)
    .where(eq(setupEvaluations.decisionChainId, chainId))
    .limit(1);
  const [routing] = await db
    .select()
    .from(strategyRoutingDecisions)
    .where(eq(strategyRoutingDecisions.decisionChainId, chainId))
    .limit(1);
  const events = await db
    .select()
    .from(lineageEvents)
    .where(eq(lineageEvents.decisionChainId, chainId))
    .orderBy(lineageEvents.eventTime);
  const outcomes = await db
    .select()
    .from(outcomeLabels)
    .where(eq(outcomeLabels.decisionChainId, chainId))
    .orderBy(outcomeLabels.labelVersion);
  const protection = await loadProtectionChain(chainId);
  const shadow = await loadShadowChain(chainId);
  return {
    chain,
    scan: scan ?? null,
    observation: observation ?? null,
    eligibility: eligibility ?? null,
    setup: setup ?? null,
    routing: routing ?? null,
    events,
    outcomes,
    protection,
    shadow,
  };
}

// ---------------------------------------------------------------------------
// Phase 1.1 Gate 3D — shadow-integration aggregate for the audit route.
// ---------------------------------------------------------------------------
export interface ShadowChainAggregate {
  plans: ShadowExecutionPlanRow[];
  revalidations: PostFillRevalidationRow[];
}

async function loadShadowChain(chainId: number): Promise<ShadowChainAggregate> {
  const plans = await db
    .select()
    .from(shadowExecutionPlans)
    .where(eq(shadowExecutionPlans.decisionChainId, chainId))
    .orderBy(shadowExecutionPlans.planVersion);
  const revalidations = await db
    .select()
    .from(postFillRevalidations)
    .where(eq(postFillRevalidations.decisionChainId, chainId))
    .orderBy(postFillRevalidations.createdAt);
  return { plans, revalidations };
}

// ---------------------------------------------------------------------------
// Phase 1.1 Gate 3C — protection aggregate for the audit route.
// ---------------------------------------------------------------------------
export interface ProtectionChainAggregate {
  instance: ProtectionInstanceRow | null;
  policy: ProtectionPolicyVersionRow | null;
  capability: ProtectionCapabilityRow | null;
  validationRuns: ProtectionValidationRunRow[];
  events: ProtectionEventRow[];
  legStates: {
    takeProfit: ProtectionInstanceRow['takeProfitLegState'];
    stopLoss: ProtectionInstanceRow['stopLossLegState'];
  } | null;
  degradationReason: string | null;
}

async function loadProtectionChain(chainId: number): Promise<ProtectionChainAggregate> {
  const [instance] = await db
    .select()
    .from(protectionInstances)
    .where(eq(protectionInstances.decisionChainId, chainId))
    .limit(1);
  if (!instance) {
    return {
      instance: null,
      policy: null,
      capability: null,
      validationRuns: [],
      events: [],
      legStates: null,
      degradationReason: null,
    };
  }
  const [policy] = await db
    .select()
    .from(protectionPolicyVersions)
    .where(eq(protectionPolicyVersions.id, instance.policyVersionId))
    .limit(1);
  const [capability] = await db
    .select()
    .from(protectionCapabilities)
    .where(eq(protectionCapabilities.id, instance.capabilityId))
    .limit(1);
  const validationRuns = capability
    ? await db
        .select()
        .from(protectionValidationRuns)
        .where(eq(protectionValidationRuns.capabilityId, capability.id))
        .orderBy(protectionValidationRuns.startedAt)
    : [];
  const events = await db
    .select()
    .from(protectionEvents)
    .where(eq(protectionEvents.protectionInstanceId, instance.id))
    .orderBy(protectionEvents.eventTime);
  return {
    instance,
    policy: policy ?? null,
    capability: capability ?? null,
    validationRuns,
    events,
    legStates: {
      takeProfit: instance.takeProfitLegState,
      stopLoss: instance.stopLossLegState,
    },
    degradationReason: instance.state === 'degraded' ? instance.failureReason : null,
  };
}

void and;
