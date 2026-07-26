import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  championMicrostructureComparisons,
  microstructureExecutionDecisions,
  type ChampionMicrostructureComparisonRow,
  type MicrostructureExecutionDecisionRow,
} from '../../db/schema';
import type { BookSnapshot } from './bookEngine';
import { computeExecutionCost, type ExecutionCostObserverResult } from './executionCost';

/**
 * Phase 2D §K — Immutable execution recommendation.
 *
 * Never creates or mutates a plan. The champion path never consumes
 * this output — a downstream reader may compare it to the champion
 * decision after the fact.
 */

export const MS_EXECUTION_POLICY_VERSION = 'p2d-exec-policy-1';

export type MsExecutionAction =
  | 'proceed_as_planned'
  | 'prefer_marketable'
  | 'prefer_passive'
  | 'reduce_size'
  | 'delay'
  | 'reject'
  | 'abstain'
  | 'data_failure';

export interface MsExecutionDecision {
  decisionChainId: number;
  productId: string;
  shortlistMembershipId: number | null;
  bookSnapshotId: number | null;
  policyVersion: string;
  championOrderType: string | null;
  championSize: number;
  recommendedAction: MsExecutionAction;
  recommendedMaximumSize: number;
  sizeMultiplier: number;
  preferredOrderStyle: string | null;
  preferredPriceBand: string | null;
  expiryRecommendation: string | null;
  fillConfidence: number | null;
  impactEstimateBps: number | null;
  reasonCodes: string[];
  dataQualityState: string;
  observedAt: Date;
  dataAvailableAt: Date;
  inputHash: string;
}

export interface EvaluateExecutionInput {
  decisionChainId: number;
  shortlistMembershipId: number | null;
  bookSnapshotId: number | null;
  championOrderType: 'market' | 'limit' | null;
  championSize: number;
  championSide: 'buy' | 'sell';
  championNotional: number;
  passiveLimitPrice: number | null;
  latencyMs: number;
  feeBps: number;
  bookSnapshot: BookSnapshot;
  now: Date;
}

export interface EvaluateExecutionResult {
  decision: MsExecutionDecision;
  cost: ExecutionCostObserverResult;
}

export function evaluateExecution(input: EvaluateExecutionInput): EvaluateExecutionResult {
  const snap = input.bookSnapshot;
  const reasons: string[] = [];
  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        v: MS_EXECUTION_POLICY_VERSION,
        chain: input.decisionChainId,
        seq: snap.sequence,
        side: input.championSide,
        size: input.championSize,
        n: input.championNotional,
        p: input.passiveLimitPrice,
      }),
    )
    .digest('hex');

  const dataQuality = snap.bookHealth;
  const fallback: MsExecutionDecision = {
    decisionChainId: input.decisionChainId,
    productId: snap.productId,
    shortlistMembershipId: input.shortlistMembershipId,
    bookSnapshotId: input.bookSnapshotId,
    policyVersion: MS_EXECUTION_POLICY_VERSION,
    championOrderType: input.championOrderType,
    championSize: input.championSize,
    recommendedAction: 'data_failure',
    recommendedMaximumSize: 0,
    sizeMultiplier: 0,
    preferredOrderStyle: null,
    preferredPriceBand: null,
    expiryRecommendation: null,
    fillConfidence: null,
    impactEstimateBps: null,
    reasonCodes: reasons,
    dataQualityState: dataQuality,
    observedAt: input.now,
    dataAvailableAt: snap.dataAvailableAt,
    inputHash,
  };

  if (dataQuality === 'inconsistent' || dataQuality === 'gap_detected' || dataQuality === 'unknown') {
    reasons.push(`data_quality:${dataQuality}`);
    return { decision: { ...fallback, reasonCodes: reasons }, cost: dummyCost(input) };
  }
  const cost = computeExecutionCost({
    bookSnapshot: snap,
    side: input.championSide,
    entryNotional: input.championNotional,
    passiveLimitPrice: input.passiveLimitPrice,
    latencyMs: input.latencyMs,
    feeBps: input.feeBps,
    now: input.now,
  });

  const impactBps = cost.marketableVWAP != null && snap.asks[0]
    ? Math.abs(cost.marketableVWAP - snap.asks[0].price) / snap.asks[0].price * 10_000
    : null;
  const unfilledFraction =
    cost.marketableVWAP != null && input.championNotional > 0
      ? Math.max(0, 1 - (input.championNotional - (cost.marketableVWAP * (input.championNotional / cost.marketableVWAP))) / input.championNotional)
      : 0;
  void unfilledFraction;

  // Decision hierarchy.
  if (dataQuality === 'stale') {
    reasons.push('book_stale');
    return {
      decision: {
        ...fallback,
        recommendedAction: 'abstain',
        reasonCodes: reasons,
        dataQualityState: dataQuality,
      },
      cost,
    };
  }
  if (impactBps != null && impactBps > 200) {
    reasons.push('impact_bps>200');
    return {
      decision: {
        ...fallback,
        recommendedAction: 'reject',
        reasonCodes: reasons,
        impactEstimateBps: impactBps,
      },
      cost,
    };
  }
  if (impactBps != null && impactBps > 50) {
    reasons.push('impact_bps>50');
    const scale = Math.max(0.1, 50 / impactBps);
    return {
      decision: {
        ...fallback,
        recommendedAction: 'reduce_size',
        recommendedMaximumSize: input.championSize * scale,
        sizeMultiplier: scale,
        preferredOrderStyle: 'passive',
        preferredPriceBand: `<= mid + 5bps`,
        fillConfidence: cost.estimatedFillProbability,
        impactEstimateBps: impactBps,
        reasonCodes: reasons,
      },
      cost,
    };
  }
  // Style preference.
  const preferredStyle =
    cost.estimatedFillProbability != null && cost.estimatedFillProbability > 0.7
      ? 'marketable'
      : impactBps != null && impactBps < 5
        ? 'passive'
        : 'marketable';
  const action: MsExecutionAction =
    preferredStyle === 'marketable' ? 'prefer_marketable' : 'prefer_passive';
  reasons.push(`preferred_style:${preferredStyle}`);
  return {
    decision: {
      ...fallback,
      recommendedAction: action,
      recommendedMaximumSize: input.championSize,
      sizeMultiplier: 1,
      preferredOrderStyle: preferredStyle,
      preferredPriceBand: null,
      fillConfidence: cost.estimatedFillProbability,
      impactEstimateBps: impactBps,
      reasonCodes: reasons,
    },
    cost,
  };
}

function dummyCost(input: EvaluateExecutionInput): ExecutionCostObserverResult {
  return {
    entryNotional: input.championNotional,
    marketableVWAP: null,
    passiveLimitPrice: input.passiveLimitPrice,
    estimatedSpreadCost: null,
    estimatedImpact: null,
    estimatedLatencyCost: null,
    estimatedFee: null,
    estimatedFillProbability: null,
    estimatedUnfilledProbability: null,
    estimatedPartialFillProbability: null,
    estimatedQueueUncertainty: null,
    estimatedStopExecutionCost: null,
    isBookAware: false,
    modelVersion: 'p2d-exec-cost-1',
    inputHash: 'no-book',
    observedAt: input.now,
    dataAvailableAt: input.bookSnapshot.dataAvailableAt,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function persistMsExecutionDecision(d: MsExecutionDecision): Promise<MicrostructureExecutionDecisionRow> {
  const [{ insertId }] = (await db.insert(microstructureExecutionDecisions).values({
    decisionChainId: d.decisionChainId,
    productId: d.productId,
    shortlistMembershipId: d.shortlistMembershipId,
    bookSnapshotId: d.bookSnapshotId,
    policyVersion: d.policyVersion,
    championOrderType: d.championOrderType,
    championSize: d.championSize.toFixed(10),
    recommendedAction: d.recommendedAction,
    recommendedMaximumSize: d.recommendedMaximumSize.toFixed(10),
    sizeMultiplier: d.sizeMultiplier.toFixed(8),
    preferredOrderStyle: d.preferredOrderStyle,
    preferredPriceBand: d.preferredPriceBand,
    expiryRecommendation: d.expiryRecommendation,
    fillConfidence: d.fillConfidence != null ? d.fillConfidence.toFixed(4) : null,
    impactEstimateBps: d.impactEstimateBps != null ? d.impactEstimateBps.toFixed(6) : null,
    reasonCodes: d.reasonCodes.join(','),
    dataQualityState: d.dataQualityState,
    observedAt: d.observedAt,
    dataAvailableAt: d.dataAvailableAt,
    inputHash: d.inputHash,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(microstructureExecutionDecisions)
    .where(eq(microstructureExecutionDecisions.id, insertId))
    .limit(1);
  return row;
}

export type MsAgreementState =
  | 'agree'
  | 'ms_prefers_style'
  | 'ms_reduced'
  | 'ms_delayed'
  | 'ms_rejected'
  | 'ms_abstained'
  | 'unresolved';

export function classifyMsAgreement(d: MsExecutionDecision): MsAgreementState {
  switch (d.recommendedAction) {
    case 'proceed_as_planned':
      return 'agree';
    case 'prefer_marketable':
    case 'prefer_passive':
      return 'ms_prefers_style';
    case 'reduce_size':
      return 'ms_reduced';
    case 'delay':
      return 'ms_delayed';
    case 'reject':
      return 'ms_rejected';
    case 'abstain':
      return 'ms_abstained';
    case 'data_failure':
      return 'unresolved';
  }
}

export async function persistChampionMsComparison(input: {
  decisionChainId: number;
  msExecutionDecisionId: number | null;
  productId: string;
  championOrderType: string | null;
  championSize: number;
  msDecision: MsExecutionDecision;
  policyVersion: string;
  observedAt: Date;
  dataAvailableAt: Date;
}): Promise<ChampionMicrostructureComparisonRow> {
  const agreement = classifyMsAgreement(input.msDecision);
  await db.insert(championMicrostructureComparisons).values({
    decisionChainId: input.decisionChainId,
    msExecutionDecisionId: input.msExecutionDecisionId,
    productId: input.productId,
    championOrderType: input.championOrderType,
    championSize: input.championSize.toFixed(10),
    msRecommendation: input.msDecision.recommendedAction,
    msRecommendedSize: input.msDecision.recommendedMaximumSize.toFixed(10),
    agreementState: agreement,
    reasonCodes: input.msDecision.reasonCodes.join(','),
    policyVersion: input.policyVersion,
    observedAt: input.observedAt,
    dataAvailableAt: input.dataAvailableAt,
  });
  const [row] = await db
    .select()
    .from(championMicrostructureComparisons)
    .where(eq(championMicrostructureComparisons.decisionChainId, input.decisionChainId))
    .limit(1);
  return row;
}
