import { createHash } from 'node:crypto';
import type {
  ContextAuthority,
  ContextSignalResult,
} from './signals';

/**
 * Phase 2E §K — Deterministic ensemble composition.
 *
 * Rules (from §K):
 *   - combinedMultiplier is clamped to [0,1].
 *   - Supportive signals contribute no multiplier above 1.
 *   - Reductions compose under a documented rule: `min(...)` — the most
 *     conservative signal wins. This is deliberately blunt so a stack of
 *     weak signals cannot drive the multiplier to near-zero.
 *   - Hard veto (authority=hard_veto AND vote=veto) produces multiplier 0.
 *   - Conflicting high-authority signals produce `conflict` and abstention.
 *   - Provider failure cannot improve the result.
 *   - Missing optional context may produce no-op.
 *   - Missing required context produces `abstain` or `data_failure`.
 *   - Every vote is persisted; the veto records the exact signal + policy.
 */

export type EnsembleOutcome =
  | 'clear'
  | 'caution'
  | 'high_risk'
  | 'conflict'
  | 'insufficient_evidence'
  | 'data_failure';

export type EnsembleVote = 'supportive' | 'neutral' | 'adverse' | 'veto' | 'abstain' | 'missing' | 'conflicted';

export interface EnsembleSignalVote {
  signalKey: string;
  signalVersion: string;
  authority: ContextAuthority;
  vote: EnsembleVote;
  multiplierContribution: number;
  weight: number;
  reasonCode: string;
  signal: ContextSignalResult | null;
}

export interface EnsembleInput {
  signals: readonly ContextSignalResult[];
  requiredSignalKeys?: readonly string[];
  hardVetoFamilies?: readonly string[];
  maximumCombinedReduction?: number; // floor on multiplier when not vetoed (e.g. 0.1)
  decisionAt: Date;
  policyKey: string;
  policyVersion: string;
}

export interface ContextEnsembleResult {
  outcome: EnsembleOutcome;
  combinedMultiplier: number;
  signalVotes: EnsembleSignalVote[];
  vetoSignals: string[];
  reductionSignals: string[];
  warningSignals: string[];
  supportiveSignals: string[];
  missingSignals: string[];
  conflictingSignals: string[];
  providerFailures: string[];
  confidence: number;
  dataQualityState: 'clean' | 'provider_degraded' | 'partial' | 'failed';
  observedAt: Date;
  dataAvailableAt: Date;
  expiresAt: Date | null;
  policyKey: string;
  policyVersion: string;
  inputHash: string;
}

function severityMultiplier(sig: ContextSignalResult): number {
  // Map severity to a multiplier: severity 0 → 1.0, severity 1 → 0.5 (max 50% cut per signal)
  if (sig.direction === 'supportive') return 1;
  if (sig.direction === 'neutral') return 1;
  if (sig.direction === 'unknown') return 1;
  const s = Math.max(0, Math.min(1, sig.severity));
  return 1 - 0.5 * s;
}

function classifyVote(sig: ContextSignalResult, hardVetoFamilies: readonly string[]): EnsembleVote {
  if (sig.status === 'unavailable' || sig.status === 'invalid_input' || sig.status === 'numerical_failure' || sig.status === 'unsupported') {
    return 'missing';
  }
  if (sig.status === 'conflicted' || sig.direction === 'conflicted') return 'conflicted';
  if (sig.status === 'stale') return 'missing';
  if (sig.status === 'insufficient_history') return 'missing';
  const familyHardVeto = hardVetoFamilies.includes(sig.providerFamily) && sig.direction === 'adverse' && sig.severity > 0.8;
  if (sig.authority === 'hard_veto' && sig.direction === 'adverse') return 'veto';
  if (familyHardVeto) return 'veto';
  if (sig.direction === 'adverse') return 'adverse';
  if (sig.direction === 'supportive') return 'supportive';
  return 'neutral';
}

export function evaluateEnsemble(input: EnsembleInput): ContextEnsembleResult {
  const votes: EnsembleSignalVote[] = [];
  const veto: string[] = [];
  const reduction: string[] = [];
  const warning: string[] = [];
  const supportive: string[] = [];
  const missing: string[] = [];
  const conflicting: string[] = [];
  const failures: string[] = [];
  let observedAt = input.decisionAt;
  let dataAvailableAt = input.decisionAt;
  let expiresAt: Date | null = null;
  let dataQuality: ContextEnsembleResult['dataQualityState'] = 'clean';
  const hardVetoFamilies = input.hardVetoFamilies ?? [];
  const providedKeys = new Set(input.signals.map((s) => s.signalKey));

  // First: missing REQUIRED signals.
  for (const req of input.requiredSignalKeys ?? []) {
    if (!providedKeys.has(req)) {
      votes.push({
        signalKey: req,
        signalVersion: 'unknown',
        authority: 'medium',
        vote: 'missing',
        multiplierContribution: 1,
        weight: 1,
        reasonCode: 'required_missing',
        signal: null,
      });
      missing.push(req);
    }
  }

  // Score each signal.
  let combined = 1;
  let confidenceAcc = 0;
  let confidenceCount = 0;
  for (const sig of input.signals) {
    const vote = classifyVote(sig, hardVetoFamilies);
    const contribution = vote === 'veto' ? 0 : vote === 'adverse' ? severityMultiplier(sig) : 1;
    votes.push({
      signalKey: sig.signalKey,
      signalVersion: sig.signalVersion,
      authority: sig.authority,
      vote,
      multiplierContribution: contribution,
      weight: 1,
      reasonCode:
        vote === 'veto' ? `veto_${sig.signalKey}`
        : vote === 'adverse' ? `reduce_${sig.signalKey}`
        : vote === 'supportive' ? `support_${sig.signalKey}`
        : vote === 'conflicted' ? `conflict_${sig.signalKey}`
        : vote === 'missing' ? `missing_${sig.signalKey}`
        : `neutral_${sig.signalKey}`,
      signal: sig,
    });
    if (sig.observedAt.getTime() > observedAt.getTime()) observedAt = sig.observedAt;
    if (sig.dataAvailableAt.getTime() > dataAvailableAt.getTime()) dataAvailableAt = sig.dataAvailableAt;
    if (sig.expiresAt && (!expiresAt || sig.expiresAt.getTime() < expiresAt.getTime())) expiresAt = sig.expiresAt;
    if (vote === 'veto') veto.push(sig.signalKey);
    else if (vote === 'adverse') reduction.push(sig.signalKey);
    else if (vote === 'supportive') supportive.push(sig.signalKey);
    else if (vote === 'conflicted') conflicting.push(sig.signalKey);
    else if (vote === 'missing') missing.push(sig.signalKey);
    if (sig.status === 'provider_degraded') {
      failures.push(sig.signalKey);
      dataQuality = 'provider_degraded';
    }
    if (sig.severity > 0.5 && sig.direction === 'adverse') warning.push(sig.signalKey);
    combined = Math.min(combined, contribution);
    confidenceAcc += Math.max(0, Math.min(1, sig.confidence));
    confidenceCount += 1;
  }

  // Enforce reduction floor: unless vetoed, combined multiplier must stay
  // above `maximumCombinedReduction` so a stack of weak signals cannot
  // collapse to zero.
  if (combined > 0 && input.maximumCombinedReduction != null) {
    combined = Math.max(combined, 1 - input.maximumCombinedReduction);
  }
  combined = Math.max(0, Math.min(1, combined));

  const confidence = confidenceCount > 0 ? confidenceAcc / confidenceCount : 0;
  const hasHighConflict = votes.some(
    (v) => v.vote === 'conflicted' && (v.authority === 'high' || v.authority === 'hard_veto'),
  );
  let outcome: EnsembleOutcome;
  if (veto.length > 0) {
    outcome = 'high_risk';
  } else if (hasHighConflict) {
    outcome = 'conflict';
  } else if (missing.filter((m) => (input.requiredSignalKeys ?? []).includes(m)).length > 0) {
    outcome = 'insufficient_evidence';
  } else if (failures.length > 0 && confidence < 0.3) {
    outcome = 'data_failure';
  } else if (reduction.length > 0) {
    outcome = 'caution';
  } else {
    outcome = 'clear';
  }

  if (outcome === 'insufficient_evidence' || outcome === 'data_failure' || outcome === 'high_risk' || outcome === 'conflict') {
    // These outcomes never boost — data-quality must reflect this.
    if (outcome === 'data_failure') dataQuality = 'failed';
    else if (outcome === 'high_risk') dataQuality = dataQuality === 'clean' ? 'clean' : dataQuality;
    else dataQuality = 'partial';
  }

  const inputHash = createHash('sha256')
    .update(JSON.stringify({
      pk: input.policyKey,
      pv: input.policyVersion,
      s: votes.map((v) => ({ k: v.signalKey, vote: v.vote, mc: v.multiplierContribution })),
    }))
    .digest('hex');

  return {
    outcome,
    combinedMultiplier: combined,
    signalVotes: votes,
    vetoSignals: veto,
    reductionSignals: reduction,
    warningSignals: warning,
    supportiveSignals: supportive,
    missingSignals: missing,
    conflictingSignals: conflicting,
    providerFailures: failures,
    confidence,
    dataQualityState: dataQuality,
    observedAt,
    dataAvailableAt,
    expiresAt,
    policyKey: input.policyKey,
    policyVersion: input.policyVersion,
    inputHash,
  };
}
