/**
 * @deprecated This module has been renamed `costAdjustedPayoffGate` in Phase
 * 1.1.a §O. The audit correctly noted that the neutral 50/50 prior makes
 * "expected value" a misleading label — this is a cost-adjusted payoff
 * feasibility check, not an empirical EV.
 *
 * This file re-exports the new symbols under their old names so slice-1
 * callers keep working. Slice 1.1.b removes the shim.
 */

export {
  applyEvGate,
  applyCostAdjustedPayoffGate,
  computeCostAdjustedPayoff,
  DEFAULT_EV_GATE_THRESHOLDS,
  DEFAULT_PAYOFF_GATE_THRESHOLDS,
  EV_GATE_VERSION,
  PAYOFF_GATE_VERSION,
  NEUTRAL_OUTCOME_PROBABILITIES,
} from './costAdjustedPayoffGate';
export type {
  EvGateDecision,
  EvGateResult,
  EvGateThresholds,
  PayoffGateDecision,
  PayoffGateResult,
  PayoffGateThresholds,
  OutcomeProbabilities,
} from './costAdjustedPayoffGate';
