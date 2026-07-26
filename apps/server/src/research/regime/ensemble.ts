import type { ChangePointResult } from './changeDetectors';
import type { RegimeResult, RegimeState } from './contract';
import type { HmmAssignment, SemanticMappingEntry } from './hmm';

/**
 * Phase 2B §J — Evidence ensemble.
 *
 * Combines outputs from the deterministic baseline, change detectors,
 * HMM latent-state observer (via a semantic mapping), Phase 2A
 * fingerprint, global state, and data-quality state into ONE
 * observer answer. The ensemble's job is to:
 *
 *   - Record every component's vote
 *   - Reduce confidence on disagreement
 *   - Never conceal disagreement
 *   - Emit UNKNOWN or DISORDERED when quality fails
 *
 * The ensemble does NOT decide champion behavior. Its output feeds
 * the challenger router and comparison table only.
 */

export type EnsembleOutcome =
  | 'consensus'
  | 'weak_consensus'
  | 'conflict'
  | 'insufficient_evidence'
  | 'quality_override';

export interface EnsembleVote {
  component: string;
  state: RegimeState | null;
  confidence: number;
  status: string;
  detail?: string;
}

export interface EnsembleInput {
  baseline: RegimeResult;
  changeDetectors: readonly ChangePointResult[];
  hmm?: {
    assignment: HmmAssignment;
    mapping: readonly SemanticMappingEntry[];
    modelVersion: string;
  } | null;
  fingerprintClass?: string | null;
  globalState?: RegimeState | null;
  dataQualityPenalty?: number | null;
}

export interface EnsembleResult {
  finalState: RegimeState;
  finalConfidence: number;
  outcome: EnsembleOutcome;
  votes: EnsembleVote[];
  reasonCodes: string[];
  changePointTriggered: boolean;
  disagreementCount: number;
}

export function combineEnsemble(input: EnsembleInput): EnsembleResult {
  const votes: EnsembleVote[] = [];
  const reasonCodes: string[] = [];

  // 1. Baseline vote.
  votes.push({
    component: 'baseline',
    state: input.baseline.state,
    confidence: input.baseline.confidence,
    status: input.baseline.status,
    detail: input.baseline.failureReason ?? undefined,
  });

  // 2. HMM vote (via semantic mapping).
  let hmmState: RegimeState | null = null;
  let hmmConfidence = 0;
  if (input.hmm) {
    const entry = input.hmm.mapping.find((m) => m.latentState === input.hmm!.assignment.latentState);
    if (entry) {
      hmmState = entry.semanticState;
      hmmConfidence = input.hmm.assignment.posterior * entry.mappingConfidence;
    }
    votes.push({
      component: 'hmm',
      state: hmmState,
      confidence: hmmConfidence,
      status: input.hmm.assignment.numericalStatus,
      detail: entry?.mappingEvidence,
    });
  } else {
    votes.push({ component: 'hmm', state: null, confidence: 0, status: 'not_available' });
  }

  // 3. Change detectors — recorded as evidence but not as a semantic vote.
  const changePointTriggered = input.changeDetectors.some((d) => d.triggered);
  for (const d of input.changeDetectors) {
    votes.push({
      component: `change:${d.detector}`,
      state: null,
      confidence: d.confidence,
      status: d.triggered ? `triggered:${d.direction}` : d.numericalStatus,
      detail:
        d.diagnostics && typeof d.diagnostics === 'object'
          ? JSON.stringify(d.diagnostics).slice(0, 120)
          : undefined,
    });
  }
  if (changePointTriggered) reasonCodes.push('change_point_triggered');

  // 4. Fingerprint vote (advisory).
  if (input.fingerprintClass) {
    votes.push({
      component: 'fingerprint',
      state: mapFingerprintToRegime(input.fingerprintClass),
      confidence: 0.5,
      status: input.fingerprintClass,
    });
  }

  // 5. Global-state vote (advisory).
  if (input.globalState) {
    votes.push({
      component: 'global_state',
      state: input.globalState,
      confidence: 0.4,
      status: 'observer',
    });
  }

  // --- Quality override ---
  if (input.dataQualityPenalty != null && input.dataQualityPenalty > 0.5) {
    reasonCodes.push('quality_override');
    return {
      finalState: 'DISORDERED',
      finalConfidence: 0.4,
      outcome: 'quality_override',
      votes,
      reasonCodes,
      changePointTriggered,
      disagreementCount: 0,
    };
  }

  // --- Insufficient baseline ---
  if (input.baseline.status !== 'valid' && input.baseline.status !== 'low_confidence') {
    reasonCodes.push(`baseline:${input.baseline.status}`);
    return {
      finalState: input.baseline.state,
      finalConfidence: 0,
      outcome: 'insufficient_evidence',
      votes,
      reasonCodes,
      changePointTriggered,
      disagreementCount: 0,
    };
  }

  // --- Consensus logic ---
  const semanticStates = votes.filter((v) => v.state && v.confidence > 0).map((v) => v.state as RegimeState);
  const tally = new Map<RegimeState, number>();
  for (const s of semanticStates) tally.set(s, (tally.get(s) ?? 0) + 1);
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  const runnerUp = sorted[1];
  const total = semanticStates.length;
  const disagreementCount = total > 0 && top ? total - top[1] : 0;

  if (top && top[1] >= 3 && top[1] - (runnerUp?.[1] ?? 0) >= 2) {
    return {
      finalState: top[0],
      finalConfidence: clamp(0.55 + 0.05 * top[1] - 0.05 * disagreementCount),
      outcome: 'consensus',
      votes,
      reasonCodes: [...reasonCodes, `consensus:${top[0]}`],
      changePointTriggered,
      disagreementCount,
    };
  }
  if (top && top[1] >= 2 && top[0] === input.baseline.state) {
    // The baseline plus one supporting vote → weak consensus.
    return {
      finalState: top[0],
      finalConfidence: clamp(input.baseline.confidence * 0.9 - 0.05 * disagreementCount),
      outcome: 'weak_consensus',
      votes,
      reasonCodes: [...reasonCodes, `weak_consensus:${top[0]}`],
      changePointTriggered,
      disagreementCount,
    };
  }
  // Direct disagreement → keep baseline but reduce confidence.
  return {
    finalState: input.baseline.state,
    finalConfidence: Math.max(0, input.baseline.confidence * 0.6 - 0.05 * disagreementCount),
    outcome: 'conflict',
    votes,
    reasonCodes: [...reasonCodes, 'ensemble_conflict'],
    changePointTriggered,
    disagreementCount,
  };
}

function mapFingerprintToRegime(fpClass: string): RegimeState | null {
  switch (fpClass) {
    case 'REVERSION_CANDIDATE':
      return 'RANGE';
    case 'BREAKOUT_CANDIDATE':
      return 'TREND_UP';
    case 'MACRO_FLOOR_RESEARCH_CANDIDATE':
      return null; // observer label only
    case 'RANDOM_OR_NOISY':
      return 'UNKNOWN';
    case 'ILLIQUID':
    case 'DISORDERED':
      return 'DISORDERED';
    default:
      return null;
  }
}

function clamp(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
