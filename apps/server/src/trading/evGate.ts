import { Money, ZERO_MONEY } from '@horizon/shared';
import type { CostForecast } from './costModel';

/**
 * Profitability + expected-value gate (Phase 1 §E).
 *
 * The gate is the last checkpoint before Claude sees a candidate. Its
 * responsibility is: "given the cost forecast, would this trade even be
 * mathematically profitable if it hit its TP/SL levels?"
 *
 * Claude may reject a mathematically profitable trade. Claude MUST NOT rescue
 * a mathematically unprofitable one — the audit says this explicitly. That
 * property is enforced by placing this gate strictly before the Claude call.
 *
 * INPUTS:
 *   • The cost forecast (net TP, net SL, R/R, break-even prob)
 *   • Configurable thresholds (min R/R, min EV, max cost/target ratio)
 *   • Optional prior — an EV estimate from historical calibration. When
 *     unknown, we fall back to the neutral "50/50 TP-vs-SL" and require
 *     the deterministic net-TP-P&L to be positive AND R/R above threshold.
 *
 * OUTPUTS:
 *   • `pass` — the candidate proceeds to Claude
 *   • `reject_*` — a specific, machine-readable reason with detail
 *
 * FAIL CLOSED: any missing / stale input causes rejection.
 */

export const EV_GATE_VERSION = 'p1s1-1';

export interface EvGateThresholds {
  /** Minimum net reward-to-risk after all costs. */
  minNetRewardRisk: number;
  /** Maximum share of gross TP consumed by round-trip cost, in percent. */
  maxCostToTargetPct: number;
  /**
   * Minimum expected value in quote currency, or null to defer the EV check
   * to the caller (some strategies may want size-scaled EV thresholds).
   */
  minExpectedValue: Money | null;
  /**
   * Neutral outcome prior: probability weight on TP (rest on SL) when no
   * calibrated prior is available.
   */
  neutralTpProbability: number;
}

export const DEFAULT_EV_GATE_THRESHOLDS: EvGateThresholds = {
  minNetRewardRisk: 1.2,
  maxCostToTargetPct: 40,
  minExpectedValue: ZERO_MONEY,
  neutralTpProbability: 0.5,
};

export type EvGateDecision =
  | 'accept'
  | 'reject_ev_gate'
  | 'reject_cost_gate'
  | 'reject_reward_risk_gate';

export interface EvGateResult {
  decision: EvGateDecision;
  version: string;
  reason: string;
  detail: Record<string, string | number | null>;
  expectedValue: Money;
  netRewardRisk: Money | null;
  breakEvenWinProb: Money | null;
}

/**
 * Applies the profitability gate to a cost forecast.
 *
 * The candidate is accepted only when ALL of the following hold:
 *   1. Net TP P&L is strictly positive (mode 1's early exit is the classic
 *      failure — a "3% TP / 2% SL / 1.5% early exit" setup can be
 *      arithmetically negative once fees are applied).
 *   2. Net reward-to-risk exceeds the configured threshold (default 1.2).
 *   3. Round-trip cost consumes at most `maxCostToTargetPct` of gross TP.
 *   4. Expected value using the neutral prior (or a supplied one) meets
 *      the configured minimum.
 */
export function applyEvGate(
  forecast: CostForecast,
  thresholds: EvGateThresholds = DEFAULT_EV_GATE_THRESHOLDS,
  priorTpProbability?: number,
): EvGateResult {
  const p = priorTpProbability ?? thresholds.neutralTpProbability;
  if (!(p >= 0 && p <= 1)) {
    throw new Error(`applyEvGate: prior TP probability out of range: ${p}`);
  }
  const pTp = Money.fromNumber(p);
  const pSl = Money.fromString('1').sub(pTp);
  const expectedValue = forecast.netTpPnl.mul(pTp).add(forecast.netSlPnl.mul(pSl));

  const detailBase = {
    netTpPnl: forecast.netTpPnl.toDecimalString(2),
    netSlPnl: forecast.netSlPnl.toDecimalString(2),
    netRewardRisk: forecast.netRewardRisk ? forecast.netRewardRisk.toDecimalString(4) : null,
    breakEvenWinProb: forecast.breakEvenWinProb
      ? forecast.breakEvenWinProb.toDecimalString(4)
      : null,
    costToTargetPct: forecast.costToTargetPct.toDecimalString(2),
    priorTpProbability: p,
    expectedValue: expectedValue.toDecimalString(2),
    version: EV_GATE_VERSION,
  } satisfies Record<string, string | number | null>;

  // Gate 1: net TP must be strictly positive after costs.
  if (!forecast.netTpPnl.isPositive()) {
    return {
      decision: 'reject_ev_gate',
      version: EV_GATE_VERSION,
      reason: 'net_tp_not_positive_after_costs',
      detail: detailBase,
      expectedValue,
      netRewardRisk: forecast.netRewardRisk,
      breakEvenWinProb: forecast.breakEvenWinProb,
    };
  }

  // Gate 2: cost-to-target ratio.
  const maxCostPct = Money.fromNumber(thresholds.maxCostToTargetPct);
  if (forecast.costToTargetPct.gt(maxCostPct)) {
    return {
      decision: 'reject_cost_gate',
      version: EV_GATE_VERSION,
      reason: 'round_trip_cost_consumes_too_much_of_target',
      detail: {
        ...detailBase,
        maxCostToTargetPct: thresholds.maxCostToTargetPct,
      },
      expectedValue,
      netRewardRisk: forecast.netRewardRisk,
      breakEvenWinProb: forecast.breakEvenWinProb,
    };
  }

  // Gate 3: net R/R.
  const minRr = Money.fromNumber(thresholds.minNetRewardRisk);
  if (!forecast.netRewardRisk || forecast.netRewardRisk.lt(minRr)) {
    return {
      decision: 'reject_reward_risk_gate',
      version: EV_GATE_VERSION,
      reason: 'net_reward_risk_below_threshold',
      detail: {
        ...detailBase,
        minNetRewardRisk: thresholds.minNetRewardRisk,
      },
      expectedValue,
      netRewardRisk: forecast.netRewardRisk,
      breakEvenWinProb: forecast.breakEvenWinProb,
    };
  }

  // Gate 4: EV minimum.
  if (thresholds.minExpectedValue !== null && expectedValue.lt(thresholds.minExpectedValue)) {
    return {
      decision: 'reject_ev_gate',
      version: EV_GATE_VERSION,
      reason: 'expected_value_below_minimum',
      detail: {
        ...detailBase,
        minExpectedValue: thresholds.minExpectedValue.toDecimalString(2),
      },
      expectedValue,
      netRewardRisk: forecast.netRewardRisk,
      breakEvenWinProb: forecast.breakEvenWinProb,
    };
  }

  return {
    decision: 'accept',
    version: EV_GATE_VERSION,
    reason: 'passes_all_gates',
    detail: detailBase,
    expectedValue,
    netRewardRisk: forecast.netRewardRisk,
    breakEvenWinProb: forecast.breakEvenWinProb,
  };
}
