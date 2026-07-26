import { createHash } from 'node:crypto';
import { and, desc, eq, lte } from 'drizzle-orm';
import { db } from './index';
import {
  candidateContextDecisions,
  candidateRiskDecisions,
  challengerRoutingDecisions,
  championChallengerRoutingComparisons,
  championContextComparisons,
  championMicrostructureComparisons,
  championRiskComparisons,
  changePointEvents,
  contextEnsembleEvidence,
  contextIncidents,
  contextObservations,
  contextObserverRuns,
  contextPolicyVersions,
  contextProviderDefinitions,
  contextProviderHealth,
  contextSignalDefinitions,
  contextSignalValues,
  decisionChains,
  eligibilityDecisions,
  executionCostObserverSnapshots,
  fingerprintEvidence,
  fingerprintSnapshots,
  globalContextSnapshots,
  globalRegimeSnapshots,
  latentStateAssignments,
  latentStateMappings,
  lineageEvents,
  marketImpactCurves,
  marketObservations,
  microstructureExecutionDecisions,
  microstructureFeatureDefinitions,
  microstructureFeatureValues,
  microstructureShortlistMemberships,
  microstructureShortlistRuns,
  orderBookGaps,
  orderBookLevels,
  orderBookSessions,
  orderBookSnapshots,
  outcomeLabels,
  passiveFillEstimates,
  portfolioRiskSnapshots,
  positionRiskSnapshots,
  postFillRevalidations,
  productContextSnapshots,
  productHygieneDecisions,
  productQuarantines,
  productRegimeSnapshots,
  protectionCapabilities,
  protectionEvents,
  protectionInstances,
  protectionPolicyVersions,
  protectionValidationRuns,
  regimeEvidence,
  regimeObserverRuns,
  regimeTransitions,
  riskLimitBreaches,
  scanRuns,
  setupEvaluations,
  shadowExecutionPlans,
  shortlistDecisions,
  strategyRoutingDecisions,
  stressTestResults,
  stressTestRuns,
  tradeFlowWindows,
  universeSnapshots,
  type CandidateContextDecisionRow,
  type ChampionContextComparisonRow,
  type ChampionMicrostructureComparisonRow,
  type ContextEnsembleEvidenceRow,
  type ContextIncidentRow,
  type ContextObservationRow,
  type ContextObserverRunRow,
  type ContextPolicyVersionRow,
  type ContextProviderDefinitionRow,
  type ContextProviderHealthRow,
  type ContextSignalDefinitionRow,
  type ContextSignalValueRow,
  type GlobalContextSnapshotRow,
  type ProductContextSnapshotRow,
  type DecisionChainRow,
  type EligibilityDecisionRow,
  type ExecutionCostObserverSnapshotRow,
  type FingerprintEvidenceRow,
  type FingerprintSnapshotRow,
  type LineageEventInsert,
  type MarketImpactCurveRow,
  type MarketObservationRow,
  type MicrostructureExecutionDecisionRow,
  type MicrostructureFeatureDefinitionRow,
  type MicrostructureFeatureValueRow,
  type MicrostructureShortlistMembershipRow,
  type MicrostructureShortlistRunRow,
  type OrderBookGapRow,
  type OrderBookLevelRow,
  type OrderBookSessionRow,
  type OrderBookSnapshotRow,
  type OutcomeLabelRow,
  type PassiveFillEstimateRow,
  type PostFillRevalidationRow,
  type CandidateRiskDecisionRow,
  type ChallengerRoutingDecisionRow,
  type ChampionChallengerRoutingComparisonRow,
  type ChampionRiskComparisonRow,
  type ChangePointEventRow,
  type GlobalRegimeSnapshotRow,
  type LatentStateAssignmentRow,
  type LatentStateMappingRow,
  type PortfolioRiskSnapshotRow,
  type PositionRiskSnapshotRow,
  type ProductHygieneDecisionRow,
  type ProductQuarantineRow,
  type ProductRegimeSnapshotRow,
  type ProtectionCapabilityRow,
  type ProtectionEventRow,
  type ProtectionInstanceRow,
  type ProtectionPolicyVersionRow,
  type ProtectionValidationRunRow,
  type RegimeEvidenceRow,
  type RegimeObserverRunRow,
  type RegimeTransitionRow,
  type RiskLimitBreachRow,
  type ScanRunRow,
  type StressTestResultRow,
  type StressTestRunRow,
  type SetupEvaluationRow,
  type ShadowExecutionPlanRow,
  type ShortlistDecisionRow,
  type StrategyRoutingDecisionRow,
  type TradeFlowWindowRow,
  type UniverseSnapshotRow,
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
  const researchObserver = await loadResearchObserverChain(chain);
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
    researchObserver,
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

// ---------------------------------------------------------------------------
// Phase 2A §L — Research observer aggregate for the audit route.
//
// Attaches the observer's view of the product AT the point in time
// the champion decision chain was created. This is READ-ONLY and does
// not influence the champion decision — the audit surface only reads
// the most recent snapshot at or before `chain.observedAt`.
// ---------------------------------------------------------------------------

export interface ResearchObserverAggregate {
  snapshot: UniverseSnapshotRow | null;
  hygiene: ProductHygieneDecisionRow | null;
  activeQuarantines: ProductQuarantineRow[];
  shortlist: ShortlistDecisionRow | null;
  fingerprint: FingerprintSnapshotRow | null;
  fingerprintEvidence: FingerprintEvidenceRow[];
  regimeObserverRun: RegimeObserverRunRow | null;
  globalRegime: GlobalRegimeSnapshotRow | null;
  productRegime: ProductRegimeSnapshotRow | null;
  regimeEvidenceRows: RegimeEvidenceRow[];
  changePoints: ChangePointEventRow[];
  latentAssignment: LatentStateAssignmentRow | null;
  latentMappings: LatentStateMappingRow[];
  transitions: RegimeTransitionRow[];
  challengerRouting: ChallengerRoutingDecisionRow | null;
  championComparison: ChampionChallengerRoutingComparisonRow | null;
  portfolioRisk: {
    snapshot: PortfolioRiskSnapshotRow | null;
    positions: PositionRiskSnapshotRow[];
    candidateDecision: CandidateRiskDecisionRow | null;
    breaches: RiskLimitBreachRow[];
    stressTestRun: StressTestRunRow | null;
    stressResults: StressTestResultRow[];
    championComparison: ChampionRiskComparisonRow | null;
  };
  microstructure: MicrostructureAggregate;
  context: ContextAggregate;
}

/**
 * Phase 2E §P — Context observer aggregate for the audit route.
 *
 * Loads INDEPENDENTLY of Phase 2A/2B/2C/2D records.
 */
export interface ContextAggregate {
  observerRun: ContextObserverRunRow | null;
  policyVersion: ContextPolicyVersionRow | null;
  providerDefinitions: ContextProviderDefinitionRow[];
  providerHealth: ContextProviderHealthRow[];
  observations: ContextObservationRow[];
  signalDefinitions: ContextSignalDefinitionRow[];
  signalValues: ContextSignalValueRow[];
  globalSnapshot: GlobalContextSnapshotRow | null;
  productSnapshot: ProductContextSnapshotRow | null;
  ensembleEvidence: ContextEnsembleEvidenceRow[];
  candidateDecision: CandidateContextDecisionRow | null;
  championComparison: ChampionContextComparisonRow | null;
  incidents: ContextIncidentRow[];
}

/**
 * Phase 2D-FIX §1 — Microstructure aggregate for the audit route.
 *
 * Loads INDEPENDENTLY of Phase 2A universe, Phase 2B regime and Phase 2C
 * risk records. The audit route must be able to explain every observation
 * of a chain even if the earlier observers wrote nothing.
 */
export interface MicrostructureAggregate {
  shortlistRun: MicrostructureShortlistRunRow | null;
  shortlistMembership: MicrostructureShortlistMembershipRow | null;
  bookSession: OrderBookSessionRow | null;
  bookSnapshot: OrderBookSnapshotRow | null;
  bookLevels: OrderBookLevelRow[];
  bookGaps: OrderBookGapRow[];
  bookContinuityState: OrderBookSessionRow['state'] | null;
  featureDefinitions: MicrostructureFeatureDefinitionRow[];
  featureValues: MicrostructureFeatureValueRow[];
  tradeFlowWindow: TradeFlowWindowRow | null;
  marketImpactCurves: MarketImpactCurveRow[];
  passiveFillEstimate: PassiveFillEstimateRow | null;
  executionCostObserverSnapshot: ExecutionCostObserverSnapshotRow | null;
  microstructureDecision: MicrostructureExecutionDecisionRow | null;
  championComparison: ChampionMicrostructureComparisonRow | null;
}

async function loadResearchObserverChain(
  chain: DecisionChainRow,
): Promise<ResearchObserverAggregate> {
  const [snapshot] = await db
    .select()
    .from(universeSnapshots)
    .where(lte(universeSnapshots.observedAt, chain.observedAt))
    .orderBy(desc(universeSnapshots.observedAt))
    .limit(1);
  if (!snapshot) {
    // No Phase 2A universe snapshot exists, but Phase 2C/2D/2E data may still
    // be present. Load them independently.
    const portfolioRisk = await loadPortfolioRiskForChain(chain.id);
    const microstructure = await loadMicrostructureForChain(chain.id);
    const context = await loadContextForChain(chain.id);
    return {
      snapshot: null,
      hygiene: null,
      activeQuarantines: [],
      shortlist: null,
      fingerprint: null,
      fingerprintEvidence: [],
      regimeObserverRun: null,
      globalRegime: null,
      productRegime: null,
      regimeEvidenceRows: [],
      changePoints: [],
      latentAssignment: null,
      latentMappings: [],
      transitions: [],
      challengerRouting: null,
      championComparison: null,
      portfolioRisk,
      microstructure,
      context,
    };
  }
  const [hygiene] = await db
    .select()
    .from(productHygieneDecisions)
    .where(
      and(
        eq(productHygieneDecisions.snapshotId, snapshot.id),
        eq(productHygieneDecisions.productId, chain.productId),
      ),
    )
    .limit(1);
  const [shortlist] = await db
    .select()
    .from(shortlistDecisions)
    .where(
      and(
        eq(shortlistDecisions.snapshotId, snapshot.id),
        eq(shortlistDecisions.productId, chain.productId),
      ),
    )
    .limit(1);
  const [fingerprint] = await db
    .select()
    .from(fingerprintSnapshots)
    .where(
      and(
        eq(fingerprintSnapshots.snapshotId, snapshot.id),
        eq(fingerprintSnapshots.productId, chain.productId),
      ),
    )
    .limit(1);
  const evidence = fingerprint
    ? await db
        .select()
        .from(fingerprintEvidence)
        .where(eq(fingerprintEvidence.fingerprintId, fingerprint.id))
    : [];
  const activeQuarantines = await db
    .select()
    .from(productQuarantines)
    .where(eq(productQuarantines.productId, chain.productId))
    .orderBy(desc(productQuarantines.startedAt));

  // Phase 2B — most recent regime observer run for this snapshot.
  const [regimeRun] = await db
    .select()
    .from(regimeObserverRuns)
    .where(eq(regimeObserverRuns.snapshotId, snapshot.id))
    .orderBy(desc(regimeObserverRuns.startedAt))
    .limit(1);
  let globalRegime: GlobalRegimeSnapshotRow | null = null;
  let productRegime: ProductRegimeSnapshotRow | null = null;
  let regimeEvidenceRows: RegimeEvidenceRow[] = [];
  let changePoints: ChangePointEventRow[] = [];
  let latentAssignment: LatentStateAssignmentRow | null = null;
  let latentMappings: LatentStateMappingRow[] = [];
  let transitions: RegimeTransitionRow[] = [];
  let challengerRouting: ChallengerRoutingDecisionRow | null = null;
  if (regimeRun) {
    const [g] = await db
      .select()
      .from(globalRegimeSnapshots)
      .where(eq(globalRegimeSnapshots.observerRunId, regimeRun.id))
      .limit(1);
    globalRegime = g ?? null;
    const [p] = await db
      .select()
      .from(productRegimeSnapshots)
      .where(
        and(
          eq(productRegimeSnapshots.observerRunId, regimeRun.id),
          eq(productRegimeSnapshots.productId, chain.productId),
        ),
      )
      .limit(1);
    productRegime = p ?? null;
    if (productRegime) {
      regimeEvidenceRows = await db
        .select()
        .from(regimeEvidence)
        .where(eq(regimeEvidence.productRegimeId, productRegime.id));
    }
    changePoints = await db
      .select()
      .from(changePointEvents)
      .where(
        and(
          eq(changePointEvents.observerRunId, regimeRun.id),
          eq(changePointEvents.productId, chain.productId),
        ),
      );
    const [la] = await db
      .select()
      .from(latentStateAssignments)
      .where(
        and(
          eq(latentStateAssignments.observerRunId, regimeRun.id),
          eq(latentStateAssignments.productId, chain.productId),
        ),
      )
      .orderBy(desc(latentStateAssignments.observedAt))
      .limit(1);
    latentAssignment = la ?? null;
    if (latentAssignment) {
      latentMappings = await db
        .select()
        .from(latentStateMappings)
        .where(eq(latentStateMappings.modelVersionId, latentAssignment.modelVersionId));
    }
    transitions = await db
      .select()
      .from(regimeTransitions)
      .where(
        and(
          eq(regimeTransitions.observerRunId, regimeRun.id),
          eq(regimeTransitions.productId, chain.productId),
        ),
      );
    const [cr] = await db
      .select()
      .from(challengerRoutingDecisions)
      .where(
        and(
          eq(challengerRoutingDecisions.observerRunId, regimeRun.id),
          eq(challengerRoutingDecisions.productId, chain.productId),
        ),
      )
      .limit(1);
    challengerRouting = cr ?? null;
  }
  const [championComparison] = await db
    .select()
    .from(championChallengerRoutingComparisons)
    .where(eq(championChallengerRoutingComparisons.decisionChainId, chain.id))
    .limit(1);

  const portfolioRisk = await loadPortfolioRiskForChain(chain.id);
  const microstructure = await loadMicrostructureForChain(chain.id);
  const context = await loadContextForChain(chain.id);

  return {
    snapshot,
    hygiene: hygiene ?? null,
    activeQuarantines,
    shortlist: shortlist ?? null,
    fingerprint: fingerprint ?? null,
    fingerprintEvidence: evidence,
    regimeObserverRun: regimeRun ?? null,
    globalRegime,
    productRegime,
    regimeEvidenceRows,
    changePoints,
    latentAssignment,
    latentMappings,
    transitions,
    challengerRouting,
    championComparison: championComparison ?? null,
    portfolioRisk,
    microstructure,
    context,
  };
}

// ---------------------------------------------------------------------------
// Phase 2E §P — Context aggregate loader.
// Loads independently: the chain may exist without any Phase 2A/2B/2C/2D
// observer records.
// ---------------------------------------------------------------------------

async function loadContextForChain(chainId: number): Promise<ContextAggregate> {
  const empty: ContextAggregate = {
    observerRun: null,
    policyVersion: null,
    providerDefinitions: [],
    providerHealth: [],
    observations: [],
    signalDefinitions: [],
    signalValues: [],
    globalSnapshot: null,
    productSnapshot: null,
    ensembleEvidence: [],
    candidateDecision: null,
    championComparison: null,
    incidents: [],
  };
  const [decision] = await db
    .select()
    .from(candidateContextDecisions)
    .where(eq(candidateContextDecisions.decisionChainId, chainId))
    .limit(1);
  const [comparison] = await db
    .select()
    .from(championContextComparisons)
    .where(eq(championContextComparisons.decisionChainId, chainId))
    .limit(1);
  if (!decision && !comparison) return empty;
  let policyVersion: ContextPolicyVersionRow | null = null;
  let globalSnapshot: GlobalContextSnapshotRow | null = null;
  let productSnapshot: ProductContextSnapshotRow | null = null;
  let observerRun: ContextObserverRunRow | null = null;
  if (decision) {
    const [pv] = await db.select().from(contextPolicyVersions).where(eq(contextPolicyVersions.id, decision.contextPolicyVersionId)).limit(1);
    policyVersion = pv ?? null;
    if (decision.globalContextSnapshotId) {
      const [gs] = await db.select().from(globalContextSnapshots).where(eq(globalContextSnapshots.id, decision.globalContextSnapshotId)).limit(1);
      globalSnapshot = gs ?? null;
      if (gs) {
        const [run] = await db.select().from(contextObserverRuns).where(eq(contextObserverRuns.id, gs.observerRunId)).limit(1);
        observerRun = run ?? null;
      }
    }
    if (decision.productContextSnapshotId) {
      const [ps] = await db.select().from(productContextSnapshots).where(eq(productContextSnapshots.id, decision.productContextSnapshotId)).limit(1);
      productSnapshot = ps ?? null;
      if (!observerRun && ps) {
        const [run] = await db.select().from(contextObserverRuns).where(eq(contextObserverRuns.id, ps.observerRunId)).limit(1);
        observerRun = run ?? null;
      }
    }
  }
  let ensembleEvidence: ContextEnsembleEvidenceRow[] = [];
  if (globalSnapshot || productSnapshot) {
    if (globalSnapshot) {
      const g = await db.select().from(contextEnsembleEvidence).where(eq(contextEnsembleEvidence.globalSnapshotId, globalSnapshot.id));
      ensembleEvidence = ensembleEvidence.concat(g);
    }
    if (productSnapshot) {
      const p = await db.select().from(contextEnsembleEvidence).where(eq(contextEnsembleEvidence.productSnapshotId, productSnapshot.id));
      ensembleEvidence = ensembleEvidence.concat(p);
    }
  }
  // Resolve every signal definition + value referenced by the evidence.
  let signalDefinitions: ContextSignalDefinitionRow[] = [];
  let signalValues: ContextSignalValueRow[] = [];
  if (ensembleEvidence.length > 0) {
    const sigDefIds = Array.from(new Set(ensembleEvidence.map((e) => e.signalDefinitionId)));
    const sigValueIds = Array.from(new Set(ensembleEvidence.map((e) => e.signalValueId).filter((v): v is number => v != null)));
    for (const id of sigDefIds) {
      const [d] = await db.select().from(contextSignalDefinitions).where(eq(contextSignalDefinitions.id, id)).limit(1);
      if (d) signalDefinitions.push(d);
    }
    for (const id of sigValueIds) {
      const [v] = await db.select().from(contextSignalValues).where(eq(contextSignalValues.id, id)).limit(1);
      if (v) signalValues.push(v);
    }
  }
  // Resolve provider definitions referenced by signal definitions.
  let providerDefinitions: ContextProviderDefinitionRow[] = [];
  let providerHealth: ContextProviderHealthRow[] = [];
  let observations: ContextObservationRow[] = [];
  if (signalDefinitions.length > 0) {
    const providerIds = Array.from(new Set(signalDefinitions.map((d) => d.providerDefinitionId)));
    for (const id of providerIds) {
      const [p] = await db.select().from(contextProviderDefinitions).where(eq(contextProviderDefinitions.id, id)).limit(1);
      if (p) providerDefinitions.push(p);
      const h = await db
        .select()
        .from(contextProviderHealth)
        .where(eq(contextProviderHealth.providerDefinitionId, id))
        .orderBy(desc(contextProviderHealth.observedAt))
        .limit(5);
      providerHealth = providerHealth.concat(h);
    }
    // Observations referenced by the signal values.
    const obsIds = Array.from(new Set(signalValues.map((v) => v.observationId).filter((v): v is number => v != null)));
    for (const id of obsIds) {
      const [o] = await db.select().from(contextObservations).where(eq(contextObservations.id, id)).limit(1);
      if (o) observations.push(o);
    }
  }
  const incidents = await db
    .select()
    .from(contextIncidents)
    .where(eq(contextIncidents.productId, decision?.productId ?? '__none__'))
    .orderBy(desc(contextIncidents.detectedAt));
  return {
    observerRun,
    policyVersion,
    providerDefinitions,
    providerHealth,
    observations,
    signalDefinitions,
    signalValues,
    globalSnapshot,
    productSnapshot,
    ensembleEvidence,
    candidateDecision: decision ?? null,
    championComparison: comparison ?? null,
    incidents,
  };
}

// ---------------------------------------------------------------------------
// Phase 2D-FIX §1 — Microstructure aggregate loader.
//
// Loads independently: the decision chain may exist without any Phase 2A/2B/2C
// observer records. The loader returns what's present and nulls what isn't.
// ---------------------------------------------------------------------------

async function loadMicrostructureForChain(chainId: number): Promise<MicrostructureAggregate> {
  const emptyAggregate: MicrostructureAggregate = {
    shortlistRun: null,
    shortlistMembership: null,
    bookSession: null,
    bookSnapshot: null,
    bookLevels: [],
    bookGaps: [],
    bookContinuityState: null,
    featureDefinitions: [],
    featureValues: [],
    tradeFlowWindow: null,
    marketImpactCurves: [],
    passiveFillEstimate: null,
    executionCostObserverSnapshot: null,
    microstructureDecision: null,
    championComparison: null,
  };
  const [decision] = await db
    .select()
    .from(microstructureExecutionDecisions)
    .where(eq(microstructureExecutionDecisions.decisionChainId, chainId))
    .limit(1);
  const [comparison] = await db
    .select()
    .from(championMicrostructureComparisons)
    .where(eq(championMicrostructureComparisons.decisionChainId, chainId))
    .limit(1);
  if (!decision && !comparison) return emptyAggregate;
  let shortlistMembership: MicrostructureShortlistMembershipRow | null = null;
  let shortlistRun: MicrostructureShortlistRunRow | null = null;
  if (decision?.shortlistMembershipId) {
    const [membership] = await db
      .select()
      .from(microstructureShortlistMemberships)
      .where(eq(microstructureShortlistMemberships.id, decision.shortlistMembershipId))
      .limit(1);
    shortlistMembership = membership ?? null;
    if (membership) {
      const [run] = await db
        .select()
        .from(microstructureShortlistRuns)
        .where(eq(microstructureShortlistRuns.id, membership.runId))
        .limit(1);
      shortlistRun = run ?? null;
    }
  }
  let bookSnapshot: OrderBookSnapshotRow | null = null;
  let bookSession: OrderBookSessionRow | null = null;
  let bookLevels: OrderBookLevelRow[] = [];
  let bookGaps: OrderBookGapRow[] = [];
  let bookContinuityState: OrderBookSessionRow['state'] | null = null;
  if (decision?.bookSnapshotId) {
    const [snap] = await db
      .select()
      .from(orderBookSnapshots)
      .where(eq(orderBookSnapshots.id, decision.bookSnapshotId))
      .limit(1);
    bookSnapshot = snap ?? null;
    if (snap) {
      const [sess] = await db
        .select()
        .from(orderBookSessions)
        .where(eq(orderBookSessions.id, snap.sessionId))
        .limit(1);
      bookSession = sess ?? null;
      bookContinuityState = sess ? sess.state : null;
      bookLevels = await db
        .select()
        .from(orderBookLevels)
        .where(eq(orderBookLevels.snapshotId, snap.id))
        .orderBy(orderBookLevels.side, orderBookLevels.levelIndex);
      bookGaps = await db
        .select()
        .from(orderBookGaps)
        .where(eq(orderBookGaps.sessionId, snap.sessionId))
        .orderBy(orderBookGaps.detectedAt);
    }
  }
  let featureValues: MicrostructureFeatureValueRow[] = [];
  let featureDefinitions: MicrostructureFeatureDefinitionRow[] = [];
  if (bookSnapshot) {
    featureValues = await db
      .select()
      .from(microstructureFeatureValues)
      .where(eq(microstructureFeatureValues.snapshotId, bookSnapshot.id))
      .orderBy(microstructureFeatureValues.featureKey);
    const usedKeys = new Set(featureValues.map((v) => `${v.featureKey}@${v.featureVersion}`));
    if (usedKeys.size > 0) {
      const defs = await db.select().from(microstructureFeatureDefinitions);
      featureDefinitions = defs.filter((d) => usedKeys.has(`${d.featureKey}@${d.featureVersion}`));
    }
  }
  let tradeFlowWindow: TradeFlowWindowRow | null = null;
  if (bookSession) {
    const flows = await db
      .select()
      .from(tradeFlowWindows)
      .where(eq(tradeFlowWindows.sessionId, bookSession.id))
      .orderBy(desc(tradeFlowWindows.windowEnd))
      .limit(1);
    tradeFlowWindow = flows[0] ?? null;
  }
  let marketImpactCurvesRows: MarketImpactCurveRow[] = [];
  let passiveFillEstimate: PassiveFillEstimateRow | null = null;
  let executionCostObserverSnapshot: ExecutionCostObserverSnapshotRow | null = null;
  if (bookSnapshot) {
    marketImpactCurvesRows = await db
      .select()
      .from(marketImpactCurves)
      .where(eq(marketImpactCurves.bookSnapshotId, bookSnapshot.id))
      .orderBy(marketImpactCurves.side, marketImpactCurves.notional);
    const [pf] = await db
      .select()
      .from(passiveFillEstimates)
      .where(eq(passiveFillEstimates.bookSnapshotId, bookSnapshot.id))
      .orderBy(desc(passiveFillEstimates.createdAt))
      .limit(1);
    passiveFillEstimate = pf ?? null;
    const [ec] = await db
      .select()
      .from(executionCostObserverSnapshots)
      .where(eq(executionCostObserverSnapshots.bookSnapshotId, bookSnapshot.id))
      .orderBy(desc(executionCostObserverSnapshots.createdAt))
      .limit(1);
    executionCostObserverSnapshot = ec ?? null;
  }
  return {
    shortlistRun,
    shortlistMembership,
    bookSession,
    bookSnapshot,
    bookLevels,
    bookGaps,
    bookContinuityState,
    featureDefinitions,
    featureValues,
    tradeFlowWindow,
    marketImpactCurves: marketImpactCurvesRows,
    passiveFillEstimate,
    executionCostObserverSnapshot,
    microstructureDecision: decision ?? null,
    championComparison: comparison ?? null,
  };
}

async function loadPortfolioRiskForChain(chainId: number): Promise<ResearchObserverAggregate['portfolioRisk']> {
  const [candidateRisk] = await db
    .select()
    .from(candidateRiskDecisions)
    .where(eq(candidateRiskDecisions.decisionChainId, chainId))
    .orderBy(desc(candidateRiskDecisions.createdAt))
    .limit(1);
  let portfolioRiskSnapshot: PortfolioRiskSnapshotRow | null = null;
  let portfolioRiskPositions: PositionRiskSnapshotRow[] = [];
  let portfolioRiskBreaches: RiskLimitBreachRow[] = [];
  let stressTestRun: StressTestRunRow | null = null;
  let stressResults: StressTestResultRow[] = [];
  if (candidateRisk) {
    const [snap] = await db
      .select()
      .from(portfolioRiskSnapshots)
      .where(eq(portfolioRiskSnapshots.id, candidateRisk.portfolioRiskSnapshotId))
      .limit(1);
    portfolioRiskSnapshot = snap ?? null;
    if (portfolioRiskSnapshot) {
      portfolioRiskPositions = await db
        .select()
        .from(positionRiskSnapshots)
        .where(eq(positionRiskSnapshots.portfolioRiskSnapshotId, portfolioRiskSnapshot.id));
      portfolioRiskBreaches = await db
        .select()
        .from(riskLimitBreaches)
        .where(eq(riskLimitBreaches.candidateRiskDecisionId, candidateRisk.id));
      const [str] = await db
        .select()
        .from(stressTestRuns)
        .where(eq(stressTestRuns.portfolioRiskSnapshotId, portfolioRiskSnapshot.id))
        .orderBy(desc(stressTestRuns.startedAt))
        .limit(1);
      stressTestRun = str ?? null;
      if (stressTestRun) {
        stressResults = await db
          .select()
          .from(stressTestResults)
          .where(eq(stressTestResults.stressTestRunId, stressTestRun.id));
      }
    }
  }
  const [championRiskCmp] = await db
    .select()
    .from(championRiskComparisons)
    .where(eq(championRiskComparisons.decisionChainId, chainId))
    .limit(1);
  return {
    snapshot: portfolioRiskSnapshot,
    positions: portfolioRiskPositions,
    candidateDecision: candidateRisk ?? null,
    breaches: portfolioRiskBreaches,
    stressTestRun,
    stressResults,
    championComparison: championRiskCmp ?? null,
  };
}

void and;
