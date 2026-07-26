import type { RegimeState } from './contract';
import type { TransitionPolicy } from './registry';

/**
 * Phase 2B §K — Temporal smoothing + hysteresis.
 *
 * Given a stream of raw regime observations, decide which one is
 * accepted as the current "smoothed" state. Rules:
 *
 *   - A candidate state must persist for `candidateConfirmationCount`
 *     consecutive observations at ≥ minimumTransitionConfidence
 *     before it replaces the previous state.
 *   - The previous state remains until the transition is accepted.
 *   - `emergencyOverrideStates` (typically DISORDERED, UNKNOWN) may
 *     transition immediately.
 *   - A stale-state expiry (in ms) forces UNKNOWN when the last
 *     accepted state is older than `staleStateExpiryMs`.
 *   - Confidence decays by `confidenceDecay` per observation with
 *     no supporting evidence.
 *   - If a change-point event fires, the confirmation count may be
 *     reduced (see acceptedTransitionWithChangePoint).
 *
 * No rule may consume future observations.
 */

export interface HysteresisObservation {
  observedAt: Date;
  candidateState: RegimeState;
  candidateConfidence: number;
  changePointTriggered: boolean;
}

export interface HysteresisState {
  previousState: RegimeState;
  previousStateSince: Date;
  previousStateConfidence: number;
  candidateState: RegimeState | null;
  candidateStreak: number;
  candidatePolicyVersion: string;
}

export interface HysteresisResult {
  finalState: RegimeState;
  finalConfidence: number;
  transitionAccepted: boolean;
  reasonCodes: string[];
  previousState: RegimeState;
  candidateState: RegimeState;
  transitionPolicyVersion: string;
  nextState: HysteresisState;
}

export function applyHysteresis(
  policy: TransitionPolicy,
  currentState: HysteresisState,
  obs: HysteresisObservation,
): HysteresisResult {
  const reasons: string[] = [];
  const previous = currentState.previousState;
  const emergency = policy.emergencyOverrideStates.includes(obs.candidateState);
  const stale =
    obs.observedAt.getTime() - currentState.previousStateSince.getTime() > policy.staleStateExpiryMs;

  // 1. Stale expiry → UNKNOWN (only when observation itself doesn't refresh the state).
  if (stale && obs.candidateState !== previous) {
    reasons.push('stale_state_expired');
    return {
      finalState: 'UNKNOWN',
      finalConfidence: 0,
      transitionAccepted: true,
      reasonCodes: reasons,
      previousState: previous,
      candidateState: obs.candidateState,
      transitionPolicyVersion: policy.policyVersion,
      nextState: {
        previousState: 'UNKNOWN',
        previousStateSince: obs.observedAt,
        previousStateConfidence: 0,
        candidateState: null,
        candidateStreak: 0,
        candidatePolicyVersion: policy.policyVersion,
      },
    };
  }

  // 2. Emergency override — accept immediately.
  if (emergency && obs.candidateState !== previous) {
    reasons.push(`emergency_override:${obs.candidateState}`);
    return {
      finalState: obs.candidateState,
      finalConfidence: obs.candidateConfidence,
      transitionAccepted: true,
      reasonCodes: reasons,
      previousState: previous,
      candidateState: obs.candidateState,
      transitionPolicyVersion: policy.policyVersion,
      nextState: {
        previousState: obs.candidateState,
        previousStateSince: obs.observedAt,
        previousStateConfidence: obs.candidateConfidence,
        candidateState: null,
        candidateStreak: 0,
        candidatePolicyVersion: policy.policyVersion,
      },
    };
  }

  // 3. Same state as before — refresh + decay.
  if (obs.candidateState === previous) {
    const conf = Math.min(1, obs.candidateConfidence);
    return {
      finalState: previous,
      finalConfidence: conf,
      transitionAccepted: false,
      reasonCodes: ['maintained'],
      previousState: previous,
      candidateState: obs.candidateState,
      transitionPolicyVersion: policy.policyVersion,
      nextState: {
        previousState: previous,
        previousStateSince: currentState.previousStateSince,
        previousStateConfidence: conf,
        candidateState: null,
        candidateStreak: 0,
        candidatePolicyVersion: policy.policyVersion,
      },
    };
  }

  // 4. New candidate — increment streak.
  const streak =
    currentState.candidateState === obs.candidateState ? currentState.candidateStreak + 1 : 1;
  const requiredStreak = obs.changePointTriggered
    ? Math.max(1, policy.candidateConfirmationCount - 1)
    : policy.candidateConfirmationCount;
  const meetsStreak = streak >= requiredStreak;
  const meetsConfidence = obs.candidateConfidence >= policy.minimumTransitionConfidence;

  if (meetsStreak && meetsConfidence) {
    reasons.push('candidate_confirmed');
    if (obs.changePointTriggered) reasons.push('change_point_expedited');
    return {
      finalState: obs.candidateState,
      finalConfidence: obs.candidateConfidence,
      transitionAccepted: true,
      reasonCodes: reasons,
      previousState: previous,
      candidateState: obs.candidateState,
      transitionPolicyVersion: policy.policyVersion,
      nextState: {
        previousState: obs.candidateState,
        previousStateSince: obs.observedAt,
        previousStateConfidence: obs.candidateConfidence,
        candidateState: null,
        candidateStreak: 0,
        candidatePolicyVersion: policy.policyVersion,
      },
    };
  }

  // Not yet accepted — remain on previous with decayed confidence.
  const decayed = Math.max(0, currentState.previousStateConfidence - policy.confidenceDecay);
  reasons.push(
    meetsStreak ? 'confidence_below_minimum' : `awaiting_confirmation(${streak}/${requiredStreak})`,
  );
  return {
    finalState: previous,
    finalConfidence: decayed,
    transitionAccepted: false,
    reasonCodes: reasons,
    previousState: previous,
    candidateState: obs.candidateState,
    transitionPolicyVersion: policy.policyVersion,
    nextState: {
      previousState: previous,
      previousStateSince: currentState.previousStateSince,
      previousStateConfidence: decayed,
      candidateState: obs.candidateState,
      candidateStreak: streak,
      candidatePolicyVersion: policy.policyVersion,
    },
  };
}

export function initialHysteresisState(state: RegimeState, at: Date, policy: TransitionPolicy): HysteresisState {
  return {
    previousState: state,
    previousStateSince: at,
    previousStateConfidence: 0,
    candidateState: null,
    candidateStreak: 0,
    candidatePolicyVersion: policy.policyVersion,
  };
}
