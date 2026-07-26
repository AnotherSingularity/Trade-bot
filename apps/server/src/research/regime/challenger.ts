import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  challengerRoutingDecisions,
  championChallengerRoutingComparisons,
  changePointEvents,
  globalRegimeSnapshots,
  latentStateAssignments,
  latentStateMappings,
  latentStateModelVersions,
  productRegimeSnapshots,
  regimeEvidence,
  regimeObserverRuns,
  regimeTransitions,
  universeSnapshots,
  type ChallengerRoutingDecisionRow,
  type ChampionChallengerRoutingComparisonRow,
  type ChangePointEventRow,
  type GlobalRegimeSnapshotRow,
  type LatentStateAssignmentRow,
  type LatentStateMappingRow,
  type LatentStateModelVersionRow,
  type ProductRegimeSnapshotRow,
  type RegimeObserverRunRow,
  type RegimeTransitionRow,
} from '../../db/schema';
import type { ChangePointResult } from './changeDetectors';
import type { RegimeEvidenceItem, RegimeResult, RegimeState } from './contract';
import type { HmmAssignment, HmmModel, SemanticMappingEntry } from './hmm';

/**
 * Phase 2B §M, §N — Challenger routing + champion comparison.
 *
 * The router is a DETERMINISTIC observer that consumes:
 *   - product regime state
 *   - global regime state
 *   - Phase 2A fingerprint class
 *   - liquidity / data-quality flags
 *   - regime confidence + conflict flags
 *
 * It emits one of six labels. It NEVER enters the champion execution
 * path — a downstream reader may compare its label to the champion's
 * decision, that's all.
 */

export const CHALLENGER_ROUTER_VERSION = 'p2b-router-1';

export type ChallengerRecommendation =
  | 'REVERSION'
  | 'BREAKOUT'
  | 'MACRO_FLOOR_RESEARCH'
  | 'NO_TRADE'
  | 'ABSTAIN'
  | 'CONFLICT';

export interface ChallengerRouterInput {
  productId: string;
  now: Date;
  dataAvailableAt: Date;
  productRegime: RegimeResult;
  globalRegime?: RegimeResult | null;
  fingerprintClass?: string | null;
  liquidityIlliquid?: boolean;
  dataQualityPenalty?: number | null;
  ensembleConflict?: boolean;
  productRegimeId?: number | null;
  globalRegimeId?: number | null;
  fingerprintSnapshotId?: number | null;
}

export interface ChallengerRouterOutcome {
  productId: string;
  recommendation: ChallengerRecommendation;
  confidence: number;
  reasonCodes: string[];
  routerVersion: string;
  observedAt: Date;
  dataAvailableAt: Date;
  inputHash: string;
  diagnostics: Record<string, unknown> | null;
}

export function evaluateChallengerRouting(input: ChallengerRouterInput): ChallengerRouterOutcome {
  const reasons: string[] = [];
  const inputHash = hashRouterInput(input);
  const now = input.now;
  const dataAvailableAt = input.dataAvailableAt;

  // Fast fails.
  if (input.dataQualityPenalty != null && input.dataQualityPenalty > 0.5) {
    reasons.push('quality_penalty_severe');
    return {
      productId: input.productId,
      recommendation: 'NO_TRADE',
      confidence: 0,
      reasonCodes: reasons,
      routerVersion: CHALLENGER_ROUTER_VERSION,
      observedAt: now,
      dataAvailableAt,
      inputHash,
      diagnostics: { dataQualityPenalty: input.dataQualityPenalty },
    };
  }
  if (input.liquidityIlliquid) {
    reasons.push('illiquid');
    return {
      productId: input.productId,
      recommendation: 'NO_TRADE',
      confidence: 0,
      reasonCodes: reasons,
      routerVersion: CHALLENGER_ROUTER_VERSION,
      observedAt: now,
      dataAvailableAt,
      inputHash,
      diagnostics: null,
    };
  }
  const pState = input.productRegime.state;
  if (pState === 'DISORDERED' || input.productRegime.status === 'quarantined') {
    reasons.push(`state:${pState}`, `status:${input.productRegime.status}`);
    return {
      productId: input.productId,
      recommendation: 'NO_TRADE',
      confidence: 0,
      reasonCodes: reasons,
      routerVersion: CHALLENGER_ROUTER_VERSION,
      observedAt: now,
      dataAvailableAt,
      inputHash,
      diagnostics: null,
    };
  }
  if (pState === 'UNKNOWN' || input.productRegime.status !== 'valid') {
    reasons.push('regime_not_valid');
    return {
      productId: input.productId,
      recommendation: 'ABSTAIN',
      confidence: input.productRegime.confidence,
      reasonCodes: reasons,
      routerVersion: CHALLENGER_ROUTER_VERSION,
      observedAt: now,
      dataAvailableAt,
      inputHash,
      diagnostics: null,
    };
  }
  if (input.ensembleConflict) {
    reasons.push('ensemble_conflict');
    return {
      productId: input.productId,
      recommendation: 'CONFLICT',
      confidence: input.productRegime.confidence,
      reasonCodes: reasons,
      routerVersion: CHALLENGER_ROUTER_VERSION,
      observedAt: now,
      dataAvailableAt,
      inputHash,
      diagnostics: null,
    };
  }
  if (input.productRegime.confidence < 0.4) {
    reasons.push('low_confidence');
    return {
      productId: input.productId,
      recommendation: 'ABSTAIN',
      confidence: input.productRegime.confidence,
      reasonCodes: reasons,
      routerVersion: CHALLENGER_ROUTER_VERSION,
      observedAt: now,
      dataAvailableAt,
      inputHash,
      diagnostics: null,
    };
  }

  // Directional recommendations.
  let recommendation: ChallengerRecommendation = 'ABSTAIN';
  const fp = input.fingerprintClass ?? '';
  switch (pState) {
    case 'RANGE': {
      if (fp === 'REVERSION_CANDIDATE') {
        recommendation = 'REVERSION';
        reasons.push('range_plus_reversion_fp');
      } else {
        recommendation = 'ABSTAIN';
        reasons.push('range_without_reversion_fp');
      }
      break;
    }
    case 'TREND_UP':
    case 'VOLATILITY_EXPANSION': {
      if (fp === 'BREAKOUT_CANDIDATE') {
        recommendation = 'BREAKOUT';
        reasons.push('trend_or_expansion_plus_breakout_fp');
      } else {
        recommendation = 'ABSTAIN';
        reasons.push('trend_or_expansion_without_breakout_fp');
      }
      break;
    }
    case 'TREND_DOWN': {
      // Short is not a champion strategy — abstain rather than issue a research short.
      recommendation = 'ABSTAIN';
      reasons.push('trend_down_no_short_channel');
      break;
    }
    case 'CAPITULATION': {
      recommendation = 'MACRO_FLOOR_RESEARCH';
      reasons.push('capitulation_research_label_only');
      break;
    }
    default:
      recommendation = 'ABSTAIN';
  }

  return {
    productId: input.productId,
    recommendation,
    confidence: input.productRegime.confidence,
    reasonCodes: reasons,
    routerVersion: CHALLENGER_ROUTER_VERSION,
    observedAt: now,
    dataAvailableAt,
    inputHash,
    diagnostics: {
      productState: pState,
      globalState: input.globalRegime?.state ?? null,
      fingerprintClass: fp || null,
    },
  };
}

function hashRouterInput(input: ChallengerRouterInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: CHALLENGER_ROUTER_VERSION,
        pid: input.productId,
        pState: input.productRegime.state,
        pStatus: input.productRegime.status,
        pConf: round(input.productRegime.confidence, 4),
        gState: input.globalRegime?.state ?? null,
        gStatus: input.globalRegime?.status ?? null,
        fp: input.fingerprintClass ?? null,
        illiq: input.liquidityIlliquid ?? false,
        dq: input.dataQualityPenalty ?? null,
        conflict: input.ensembleConflict ?? false,
        now: input.now.toISOString(),
      }),
    )
    .digest('hex');
}

function round(x: number, digits: number): number {
  const p = 10 ** digits;
  return Math.round(x * p) / p;
}

// ---------------------------------------------------------------------------
// Champion/challenger comparison
// ---------------------------------------------------------------------------

export type AgreementState =
  | 'agree'
  | 'partial_agreement'
  | 'disagree'
  | 'champion_only'
  | 'challenger_abstained'
  | 'unresolved';

export interface ComparisonInput {
  decisionChainId: number;
  productId: string;
  championDecision: string;
  championMode: string | null;
  challengerRecommendation: ChallengerRecommendation;
  challengerDecisionId: number | null;
  globalRegimeState: RegimeState | null;
  productRegimeState: RegimeState | null;
  fingerprintClass: string | null;
  observerVersion: string;
  observedAt: Date;
  dataAvailableAt: Date;
}

/**
 * Deterministic mapping from (champion, challenger) → agreement.
 */
export function classifyAgreement(
  championDecision: string,
  challenger: ChallengerRecommendation,
): AgreementState {
  if (challenger === 'ABSTAIN' || challenger === 'NO_TRADE') return 'challenger_abstained';
  if (challenger === 'CONFLICT') return 'unresolved';
  const c = championDecision.toUpperCase();
  if (c === 'REJECT' || c === 'REJECTED' || c === 'NO_TRADE') return 'champion_only';
  if (
    (challenger === 'BREAKOUT' && (c.includes('BREAKOUT') || c === 'ENTER_LONG')) ||
    (challenger === 'REVERSION' && (c.includes('REVERSION') || c === 'ENTER_LONG'))
  ) {
    return 'agree';
  }
  if (challenger === 'MACRO_FLOOR_RESEARCH') return 'partial_agreement';
  return 'disagree';
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

export interface StartObserverRunInput {
  snapshotId: number;
  now: Date;
  observerVersion: string;
  transitionPolicyVersion: string;
  productsConsidered: number;
}

export async function startRegimeObserverRun(
  input: StartObserverRunInput,
): Promise<RegimeObserverRunRow> {
  const [{ insertId }] = (await db.insert(regimeObserverRuns).values({
    snapshotId: input.snapshotId,
    startedAt: input.now,
    productsConsidered: input.productsConsidered,
    observerVersion: input.observerVersion,
    transitionPolicyVersion: input.transitionPolicyVersion,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(regimeObserverRuns)
    .where(eq(regimeObserverRuns.id, insertId))
    .limit(1);
  return row!;
}

export async function completeRegimeObserverRun(
  runId: number,
  completedAt: Date,
  counts: { globalStates: number; productStates: number; unknown: number; disordered: number },
  notes?: string,
): Promise<void> {
  await db
    .update(regimeObserverRuns)
    .set({
      completedAt,
      globalStatesEmitted: counts.globalStates,
      productStatesEmitted: counts.productStates,
      unknownCount: counts.unknown,
      disorderedCount: counts.disordered,
      notes: notes ?? null,
    })
    .where(eq(regimeObserverRuns.id, runId));
}

export async function persistGlobalRegime(input: {
  observerRunId: number;
  regime: RegimeResult;
  regimeKey: string;
}): Promise<GlobalRegimeSnapshotRow> {
  const r = input.regime;
  const [{ insertId }] = (await db.insert(globalRegimeSnapshots).values({
    observerRunId: input.observerRunId,
    regimeKey: input.regimeKey,
    regimeVersion: r.modelVersion,
    state: r.state,
    status: r.status,
    confidence: r.confidence.toFixed(4),
    inputHash: r.inputHash,
    observedAt: r.observedAt,
    dataAvailableAt: r.dataAvailableAt,
    diagnostics: r.diagnostics ? JSON.stringify(r.diagnostics) : null,
    failureReason: r.failureReason,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(globalRegimeSnapshots)
    .where(eq(globalRegimeSnapshots.id, insertId))
    .limit(1);
  await persistEvidence('global', insertId, null, r);
  return row!;
}

export async function persistProductRegime(input: {
  observerRunId: number;
  productId: string;
  rawRegime: RegimeResult;
  smoothedState: RegimeState;
  smoothedConfidence: number;
  regimeKey: string;
}): Promise<ProductRegimeSnapshotRow> {
  const r = input.rawRegime;
  const [{ insertId }] = (await db.insert(productRegimeSnapshots).values({
    observerRunId: input.observerRunId,
    productId: input.productId,
    regimeKey: input.regimeKey,
    regimeVersion: r.modelVersion,
    rawState: r.state,
    smoothedState: input.smoothedState,
    status: r.status,
    confidence: input.smoothedConfidence.toFixed(4),
    globalStateId: r.globalStateId ?? null,
    fingerprintSnapshotId: r.fingerprintSnapshotId ?? null,
    inputHash: r.inputHash,
    observedAt: r.observedAt,
    dataAvailableAt: r.dataAvailableAt,
    diagnostics: r.diagnostics ? JSON.stringify(r.diagnostics) : null,
    failureReason: r.failureReason,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(productRegimeSnapshots)
    .where(eq(productRegimeSnapshots.id, insertId))
    .limit(1);
  await persistEvidence('product', null, insertId, r);
  return row!;
}

async function persistEvidence(
  scope: 'global' | 'product',
  globalId: number | null,
  productId: number | null,
  r: RegimeResult,
): Promise<void> {
  const all: Array<{ role: 'supporting' | 'conflicting' | 'missing'; items: RegimeEvidenceItem[] }> = [
    { role: 'supporting', items: r.supportingEvidence },
    { role: 'conflicting', items: r.conflictingEvidence },
    { role: 'missing', items: r.missingEvidence },
  ];
  for (const bucket of all) {
    for (const item of bucket.items) {
      await db.insert(regimeEvidence).values({
        scope,
        globalRegimeId: globalId,
        productRegimeId: productId,
        component: item.component,
        componentVersion: item.componentVersion,
        role: bucket.role,
        weight: item.weight.toFixed(4),
        detail: item.detail ?? null,
        featureValueId: item.featureValueId ?? null,
        changePointEventId: item.changePointEventId ?? null,
        latentStateAssignmentId: item.latentStateAssignmentId ?? null,
      });
    }
  }
}

export async function persistChangePointEvent(input: {
  observerRunId: number;
  scope: 'global' | 'product';
  productId: string | null;
  result: ChangePointResult;
}): Promise<ChangePointEventRow> {
  const r = input.result;
  const [{ insertId }] = (await db.insert(changePointEvents).values({
    observerRunId: input.observerRunId,
    scope: input.scope,
    productId: input.productId,
    detector: r.detector,
    detectorVersion: r.detectorVersion,
    direction: r.direction,
    magnitude: r.magnitude != null ? r.magnitude.toFixed(10) : null,
    changeProbability: r.changeProbability != null ? r.changeProbability.toFixed(4) : null,
    runLengthEstimate: r.runLengthEstimate,
    thresholdVersion: r.thresholdVersion,
    hazardPolicyVersion: r.hazardPolicyVersion,
    numericalStatus: r.numericalStatus,
    confidence: r.confidence.toFixed(4),
    detectedAt: r.detectedAt,
    dataAvailableAt: r.dataAvailableAt,
    inputHash: r.inputHash,
    diagnostics: r.diagnostics ? JSON.stringify(r.diagnostics) : null,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(changePointEvents)
    .where(eq(changePointEvents.id, insertId))
    .limit(1);
  return row!;
}

export async function persistTransition(input: {
  observerRunId: number;
  productId: string | null;
  scope: 'global' | 'product';
  previous: RegimeState;
  candidate: RegimeState;
  final: RegimeState;
  transitionAccepted: boolean;
  reasonCodes: string[];
  confidenceBefore: number;
  confidenceAfter: number;
  changePointEventId: number | null;
  transitionPolicyVersion: string;
  observedAt: Date;
  dataAvailableAt: Date;
}): Promise<RegimeTransitionRow> {
  const [{ insertId }] = (await db.insert(regimeTransitions).values({
    observerRunId: input.observerRunId,
    productId: input.productId,
    scope: input.scope,
    previousState: input.previous,
    candidateState: input.candidate,
    finalState: input.final,
    transitionAccepted: input.transitionAccepted,
    reasonCodes: input.reasonCodes.join(','),
    confidenceBefore: input.confidenceBefore.toFixed(4),
    confidenceAfter: input.confidenceAfter.toFixed(4),
    changePointEventId: input.changePointEventId,
    transitionPolicyVersion: input.transitionPolicyVersion,
    observedAt: input.observedAt,
    dataAvailableAt: input.dataAvailableAt,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(regimeTransitions)
    .where(eq(regimeTransitions.id, insertId))
    .limit(1);
  return row!;
}

export async function persistLatentModel(model: HmmModel): Promise<LatentStateModelVersionRow> {
  const existing = await db
    .select()
    .from(latentStateModelVersions)
    .where(
      and(
        eq(latentStateModelVersions.modelKey, model.key),
        eq(latentStateModelVersions.modelVersion, model.version),
      ),
    )
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(latentStateModelVersions).values({
    modelKey: model.key,
    modelVersion: model.version,
    numLatentStates: model.numStates,
    observationDimensions: JSON.stringify(model.observationDimensions),
    initializationPolicy: model.initializationPolicy,
    convergencePolicy: model.convergencePolicy,
    maxIterations: model.maxIterations,
    numericalPolicy: model.numericalPolicy,
    deterministicSeed: model.deterministicSeed,
    trainingWindowStart: model.trainingWindowStart,
    trainingWindowEnd: model.trainingWindowEnd,
    trainingSampleCount: model.trainingSampleCount,
    converged: model.converged,
    finalLogLikelihood: model.finalLogLikelihood != null ? model.finalLogLikelihood.toFixed(10) : null,
    implementationHash: model.implementationHash,
  });
  const [row] = await db
    .select()
    .from(latentStateModelVersions)
    .where(
      and(
        eq(latentStateModelVersions.modelKey, model.key),
        eq(latentStateModelVersions.modelVersion, model.version),
      ),
    )
    .limit(1);
  return row!;
}

export async function persistLatentAssignment(input: {
  modelVersionId: number;
  observerRunId: number;
  productId: string | null;
  scope: 'global' | 'product';
  assignment: HmmAssignment;
}): Promise<LatentStateAssignmentRow> {
  const a = input.assignment;
  const [{ insertId }] = (await db.insert(latentStateAssignments).values({
    modelVersionId: input.modelVersionId,
    observerRunId: input.observerRunId,
    productId: input.productId,
    scope: input.scope,
    latentState: a.latentState,
    posterior: a.posterior.toFixed(4),
    logLikelihood: Number.isFinite(a.logLikelihood) ? a.logLikelihood.toFixed(10) : null,
    numericalStatus: a.numericalStatus,
    observedAt: a.observedAt,
    dataAvailableAt: a.dataAvailableAt,
    inputHash: a.inputHash,
    diagnostics: a.diagnostics ? JSON.stringify(a.diagnostics) : null,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(latentStateAssignments)
    .where(eq(latentStateAssignments.id, insertId))
    .limit(1);
  return row!;
}

export async function persistLatentMapping(
  modelVersionId: number,
  entries: readonly SemanticMappingEntry[],
  mappedAt: Date,
): Promise<LatentStateMappingRow[]> {
  const rows: LatentStateMappingRow[] = [];
  for (const e of entries) {
    const existing = await db
      .select()
      .from(latentStateMappings)
      .where(
        and(
          eq(latentStateMappings.modelVersionId, modelVersionId),
          eq(latentStateMappings.latentState, e.latentState),
          eq(latentStateMappings.mappingVersion, e.mappingVersion),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      rows.push(existing[0]);
      continue;
    }
    await db.insert(latentStateMappings).values({
      modelVersionId,
      latentState: e.latentState,
      semanticState: e.semanticState,
      mappingEvidence: e.mappingEvidence,
      mappingConfidence: e.mappingConfidence.toFixed(4),
      mappedAt,
      dataAvailableAt: mappedAt,
      mappingVersion: e.mappingVersion,
    });
    const [row] = await db
      .select()
      .from(latentStateMappings)
      .where(
        and(
          eq(latentStateMappings.modelVersionId, modelVersionId),
          eq(latentStateMappings.latentState, e.latentState),
          eq(latentStateMappings.mappingVersion, e.mappingVersion),
        ),
      )
      .limit(1);
    rows.push(row!);
  }
  return rows;
}

export async function persistChallengerRouting(input: {
  observerRunId: number;
  outcome: ChallengerRouterOutcome;
  productRegimeId: number | null;
  globalRegimeId: number | null;
  fingerprintSnapshotId: number | null;
}): Promise<ChallengerRoutingDecisionRow> {
  const o = input.outcome;
  const [{ insertId }] = (await db.insert(challengerRoutingDecisions).values({
    observerRunId: input.observerRunId,
    productId: o.productId,
    productRegimeId: input.productRegimeId,
    globalRegimeId: input.globalRegimeId,
    fingerprintSnapshotId: input.fingerprintSnapshotId,
    recommendation: o.recommendation,
    confidence: o.confidence.toFixed(4),
    reasonCodes: o.reasonCodes.join(','),
    routerVersion: o.routerVersion,
    observedAt: o.observedAt,
    dataAvailableAt: o.dataAvailableAt,
    inputHash: o.inputHash,
    diagnostics: o.diagnostics ? JSON.stringify(o.diagnostics) : null,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(challengerRoutingDecisions)
    .where(eq(challengerRoutingDecisions.id, insertId))
    .limit(1);
  return row!;
}

export async function persistChampionChallengerComparison(
  input: ComparisonInput,
): Promise<ChampionChallengerRoutingComparisonRow> {
  const agreement = classifyAgreement(input.championDecision, input.challengerRecommendation);
  const reasons: string[] = [`agreement:${agreement}`];
  await db.insert(championChallengerRoutingComparisons).values({
    decisionChainId: input.decisionChainId,
    challengerDecisionId: input.challengerDecisionId,
    productId: input.productId,
    championMode: input.championMode,
    championDecision: input.championDecision,
    challengerRecommendation: input.challengerRecommendation,
    globalRegimeState: input.globalRegimeState,
    productRegimeState: input.productRegimeState,
    fingerprintClass: input.fingerprintClass,
    agreementState: agreement,
    reasonCodes: reasons.join(','),
    observerVersion: input.observerVersion,
    observedAt: input.observedAt,
    dataAvailableAt: input.dataAvailableAt,
  });
  const [row] = await db
    .select()
    .from(championChallengerRoutingComparisons)
    .where(eq(championChallengerRoutingComparisons.decisionChainId, input.decisionChainId))
    .limit(1);
  return row!;
}

// Silence linter for unused imports
void universeSnapshots;
