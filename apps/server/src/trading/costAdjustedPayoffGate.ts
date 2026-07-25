import { Money, ZERO_MONEY } from '@horizon/shared';
import type { CostForecast } from './costModel';

/**
 * Cost-adjusted payoff gate (Phase 1 §E / audit correction §O).
 *
 * PREVIOUS NAME: `applyEvGate` / "expected value gate". The audit correctly
 * pointed out that with a neutral 50/50 prior this is not an empirical
 * expected value — it's a cost-adjusted payoff feasibility check. This module
 * uses honest names. A future calibrated-probability gate will layer on top
 * of the three-outcome interface defined here.
 *
 * The gate is the last checkpoint before Claude sees a candidate. Its
 * responsibility is: "given the cost forecast, is the trade even
 * mathematically viable after Coinbase gets paid?"
 *
 * Claude may reject a mathematically valid trade. Claude MUST NOT rescue an
 * invalid one — enforced by placing this gate strictly before the Claude call.
 *
 * FAIL CLOSED: any missing / stale input causes rejection.
 */

export const PAYOFF_GATE_VERSION = 'p1s1-1-payoff';
/** @deprecated legacy name — use PAYOFF_GATE_VERSION */
export const EV_GATE_VERSION = PAYOFF_GATE_VERSION;

// ---------------------------------------------------------------------------
// Three-outcome interface (Phase 1.1.a §O)
// ---------------------------------------------------------------------------

/**
 * Outcome-probability estimate used by the gate. Third outcome (`timeout`)
 * is where price never touches TP/SL by the mode's timeout and the position
 * closes at some intermediate price. In slice 1.1.a we default to a neutral
 * TP/SL split with timeout=0 (i.e. we still assume TP or SL will be hit);
 * slice 3's calibration pipeline replaces this with a per-mode, per-regime
 * calibrated distribution.
 */
export interface OutcomeProbabilities {
  /** P(price hits TP first). */
  pTp: number;
  /** P(price hits SL first). */
  pSl: number;
  /** P(neither is hit within the mode's timeout). */
  pTimeout: number;
}

/**
 * Neutral prior — 50/50 TP-vs-SL with no timeout. This is INTENTIONALLY
 * unmeasured and is why the module is not called "expected value".
 */
export const NEUTRAL_OUTCOME_PROBABILITIES: OutcomeProbabilities = {
  pTp: 0.5,
  pSl: 0.5,
  pTimeout: 0,
};

function validateOutcomeProbabilities(p: OutcomeProbabilities): void {
  for (const [k, v] of Object.entries(p)) {
    if (!(v >= 0 && v <= 1)) {
      throw new Error(`outcome probability ${k}=${v} outside [0,1]`);
    }
  }
  const sum = p.pTp + p.pSl + p.pTimeout;
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`outcome probabilities sum to ${sum}, must be 1`);
  }
}

// ---------------------------------------------------------------------------
// Public gate config
// ---------------------------------------------------------------------------

export interface PayoffGateThresholds {
  /** Minimum net reward-to-risk after all costs. */
  minNetRewardRisk: number;
  /** Maximum share of gross TP consumed by round-trip cost, in percent. */
  maxCostToTargetPct: number;
  /**
   * Minimum cost-adjusted payoff EV in quote currency, or null to skip the
   * check. This is a payoff feasibility floor, NOT a calibrated-expectancy
   * guarantee — the underlying probability estimate is uncalibrated in slice 1.
   */
  minCostAdjustedPayoff: Money | null;
  /** Neutral prior — used when no calibrated probabilities supplied. */
  neutralOutcomeProbabilities: OutcomeProbabilities;
}

export const DEFAULT_PAYOFF_GATE_THRESHOLDS: PayoffGateThresholds = {
  minNetRewardRisk: 1.2,
  maxCostToTargetPct: 40,
  minCostAdjustedPayoff: ZERO_MONEY,
  neutralOutcomeProbabilities: NEUTRAL_OUTCOME_PROBABILITIES,
};

/** @deprecated use PayoffGateThresholds */
export type EvGateThresholds = PayoffGateThresholds;
/** @deprecated use DEFAULT_PAYOFF_GATE_THRESHOLDS */
export const DEFAULT_EV_GATE_THRESHOLDS = DEFAULT_PAYOFF_GATE_THRESHOLDS;

export type PayoffGateDecision =
  | 'accept'
  | 'reject_ev_gate' // reject_payoff_gate — kept as `reject_ev_gate` for DB-enum stability
  | 'reject_cost_gate'
  | 'reject_reward_risk_gate';
/** @deprecated use PayoffGateDecision */
export type EvGateDecision = PayoffGateDecision;

export interface PayoffGateResult {
  decision: PayoffGateDecision;
  version: string;
  reason: string;
  detail: Record<string, string | number | null>;
  /** Cost-adjusted payoff EV. NOT empirical expected value (see module header). */
  costAdjustedPayoff: Money;
  /** @deprecated same value as `costAdjustedPayoff`, kept for old callers. */
  expectedValue: Money;
  netRewardRisk: Money | null;
  breakEvenWinProb: Money | null;
  /** The outcome probabilities used to compute the payoff. */
  outcomeProbabilities: OutcomeProbabilities;
}
/** @deprecated use PayoffGateResult */
export type EvGateResult = PayoffGateResult;

// ---------------------------------------------------------------------------
// Cost-adjusted payoff calculation
// ---------------------------------------------------------------------------

/**
 * Computes the cost-adjusted payoff EV under a three-outcome model:
 *   payoff = P(TP) · netTpPnl
 *          + P(SL) · netSlPnl
 *          + P(timeout) · timeoutPnl
 *
 * The timeout P&L defaults to the AVERAGE of netTp and netSl (a reasonable
 * "somewhere in between" placeholder). Slice 3's calibrated model will use a
 * mode-specific empirical distribution.
 */
export function computeCostAdjustedPayoff(
  forecast: CostForecast,
  probs: OutcomeProbabilities,
  timeoutPnl?: Money,
): Money {
  validateOutcomeProbabilities(probs);
  const pTp = Money.fromNumber(probs.pTp);
  const pSl = Money.fromNumber(probs.pSl);
  const pTimeout = Money.fromNumber(probs.pTimeout);
  const timeout = timeoutPnl ?? forecast.netTpPnl.add(forecast.netSlPnl).divInt(2);
  return forecast.netTpPnl
    .mul(pTp)
    .add(forecast.netSlPnl.mul(pSl))
    .add(timeout.mul(pTimeout));
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Applies the cost-adjusted payoff gate to a cost forecast.
 *
 * Accept iff ALL of:
 *   1. Net TP P&L strictly positive (the audit's Reversion 3%/2%/60bps trap).
 *   2. Round-trip cost / gross target ≤ `maxCostToTargetPct`.
 *   3. Net R/R ≥ `minNetRewardRisk`.
 *   4. Cost-adjusted payoff EV ≥ `minCostAdjustedPayoff`.
 *
 * When `outcomeProbabilities` is omitted the neutral prior is used. That is a
 * feasibility check, not a calibrated-edge claim.
 */
export function applyCostAdjustedPayoffGate(
  forecast: CostForecast,
  thresholds: PayoffGateThresholds = DEFAULT_PAYOFF_GATE_THRESHOLDS,
  outcomeProbabilities: OutcomeProbabilities = thresholds.neutralOutcomeProbabilities,
): PayoffGateResult {
  validateOutcomeProbabilities(outcomeProbabilities);
  const payoff = computeCostAdjustedPayoff(forecast, outcomeProbabilities);

  const detailBase = {
    netTpPnl: forecast.netTpPnl.toDecimalString(2),
    netSlPnl: forecast.netSlPnl.toDecimalString(2),
    netRewardRisk: forecast.netRewardRisk ? forecast.netRewardRisk.toDecimalString(4) : null,
    breakEvenWinProb: forecast.breakEvenWinProb
      ? forecast.breakEvenWinProb.toDecimalString(4)
      : null,
    costToTargetPct: forecast.costToTargetPct.toDecimalString(2),
    pTp: outcomeProbabilities.pTp,
    pSl: outcomeProbabilities.pSl,
    pTimeout: outcomeProbabilities.pTimeout,
    costAdjustedPayoff: payoff.toDecimalString(2),
    version: PAYOFF_GATE_VERSION,
  } satisfies Record<string, string | number | null>;

  // Gate 1: net TP must be strictly positive after costs.
  if (!forecast.netTpPnl.isPositive()) {
    return build('reject_ev_gate', 'net_tp_not_positive_after_costs', detailBase, forecast, payoff, outcomeProbabilities);
  }

  // Gate 2: cost-to-target ratio.
  const maxCostPct = Money.fromNumber(thresholds.maxCostToTargetPct);
  if (forecast.costToTargetPct.gt(maxCostPct)) {
    return build(
      'reject_cost_gate',
      'round_trip_cost_consumes_too_much_of_target',
      { ...detailBase, maxCostToTargetPct: thresholds.maxCostToTargetPct },
      forecast,
      payoff,
      outcomeProbabilities,
    );
  }

  // Gate 3: net R/R.
  const minRr = Money.fromNumber(thresholds.minNetRewardRisk);
  if (!forecast.netRewardRisk || forecast.netRewardRisk.lt(minRr)) {
    return build(
      'reject_reward_risk_gate',
      'net_reward_risk_below_threshold',
      { ...detailBase, minNetRewardRisk: thresholds.minNetRewardRisk },
      forecast,
      payoff,
      outcomeProbabilities,
    );
  }

  // Gate 4: cost-adjusted payoff floor.
  if (thresholds.minCostAdjustedPayoff !== null && payoff.lt(thresholds.minCostAdjustedPayoff)) {
    return build(
      'reject_ev_gate',
      'expected_value_below_minimum',
      { ...detailBase, minCostAdjustedPayoff: thresholds.minCostAdjustedPayoff.toDecimalString(2) },
      forecast,
      payoff,
      outcomeProbabilities,
    );
  }

  return build('accept', 'passes_all_gates', detailBase, forecast, payoff, outcomeProbabilities);
}

function build(
  decision: PayoffGateDecision,
  reason: string,
  detail: Record<string, string | number | null>,
  forecast: CostForecast,
  payoff: Money,
  probs: OutcomeProbabilities,
): PayoffGateResult {
  return {
    decision,
    version: PAYOFF_GATE_VERSION,
    reason,
    detail,
    costAdjustedPayoff: payoff,
    expectedValue: payoff, // deprecated alias
    netRewardRisk: forecast.netRewardRisk,
    breakEvenWinProb: forecast.breakEvenWinProb,
    outcomeProbabilities: probs,
  };
}

// ---------------------------------------------------------------------------
// Backwards-compatible re-export of the old API
// ---------------------------------------------------------------------------

/**
 * @deprecated use `applyCostAdjustedPayoffGate`. Kept for slice-1 callers
 * that will migrate in slice 1.1.b. Accepts the legacy `priorTpProbability`
 * (a scalar) and internally builds a two-outcome distribution.
 */
export function applyEvGate(
  forecast: CostForecast,
  thresholds: PayoffGateThresholds = DEFAULT_PAYOFF_GATE_THRESHOLDS,
  priorTpProbability?: number,
): PayoffGateResult {
  const probs =
    priorTpProbability === undefined
      ? thresholds.neutralOutcomeProbabilities
      : { pTp: priorTpProbability, pSl: 1 - priorTpProbability, pTimeout: 0 };
  return applyCostAdjustedPayoffGate(forecast, thresholds, probs);
}
