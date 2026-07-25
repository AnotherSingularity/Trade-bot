import { Money, ZERO_MONEY, type TradingMode } from '@horizon/shared';
import type { FeeTierCurrent } from './feeTier';
import type { PreviewOk } from './preview';

/**
 * Minimum-viable cost model (Phase 1 §D, slice 1).
 *
 * Produces a per-candidate execution-cost forecast that the EV gate uses to
 * decide whether the trade is worth showing to Claude. This is INTENTIONALLY
 * conservative on the exit side because we do not yet have L2 book depth or
 * a realized-exit-cost distribution — slice 2 refines those.
 *
 * The model version string is persisted with every forecast so realized-vs-
 * forecast reconciliation in slice 3 can bucket errors by model era.
 *
 * INPUTS (per candidate):
 *   • FeeTierCurrent — authenticated maker/taker rates
 *   • PreviewOk      — Coinbase's own preview: commission, est fill price,
 *                      best bid/ask, base/quote size, slippage estimate
 *   • arrivalMid     — mid-price at the moment the signal was approved
 *   • takeProfitPct  — mode's TP as a percentage (e.g. 3 for 3%)
 *   • stopLossPct    — mode's SL as a percentage
 *
 * OUTPUTS: entry/exit fees, impact in bps, latency-slippage buffer,
 * round-trip cost, cost/target ratio, TP/SL prices, net TP and SL P&L in
 * quote currency, net reward/risk ratio, cost-adjusted break-even win prob.
 */

export const COST_MODEL_VERSION = 'p1s1-mv-1';

/**
 * Configurable, conservative buffers used by the MV model. Chosen from
 * public research + Coinbase spread observations on small-mid-cap alts; refined
 * in slice 2 with real distributions. Values are in bps.
 */
export const DEFAULT_LATENCY_SLIPPAGE_BPS = 5; // 0.05% network + book-walk during latency
export const DEFAULT_EXIT_EXTRA_SPREAD_BPS = 10; // 0.10% conservative widening on exit
export const DEFAULT_EXIT_IMPACT_QUANTILE = 0.95; // "95th-%ile" conservative bucket
/** Extra market-impact buffer for tokens outside the top ~10 liquidity tier. */
export const DEFAULT_ILLIQUID_IMPACT_BPS = 15;

/** Simple, hardcoded liquidity classification. Refined in slice 2. */
const LIQUID_TIER = new Set([
  'LINK',
  'AAVE',
  'UNI',
  'COMP',
  'CRV',
  'MKR',
  'LDO',
  'ARB',
  'OP',
  'NEAR',
  'XLM',
  'TRX',
  'INJ',
  'GRT',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostModelInput {
  token: string;
  mode: TradingMode;
  arrivalMid: Money;
  takeProfitPct: number;
  stopLossPct: number;
  feeTier: FeeTierCurrent;
  preview: PreviewOk;
  /** Explicit override for exit-slippage buffer. Default is quantile-based. */
  exitExtraSpreadBps?: number;
  latencySlippageBps?: number;
  exitCostQuantile?: number;
}

export interface CostForecast {
  costModelVersion: string;
  exitCostQuantile: number;

  arrivalMid: Money;
  spreadBps: Money;

  // Entry side (derived from preview)
  entryFee: Money;
  entryImpactBps: Money;
  estimatedEntryFillPrice: Money;
  filledBaseSize: Money;

  // Exit side (modeled conservatively — no live book yet)
  exitFeeEstimate: Money;
  exitImpactBpsEstimate: Money;
  latencySlippageBpsEstimate: Money;

  // Round-trip
  roundTripCost: Money;
  costToTargetPct: Money;

  // Price targets
  takeProfitPrice: Money;
  stopLossPrice: Money;

  // Net outcomes (in quote currency, per this specific candidate size)
  netTpPnl: Money;
  netSlPnl: Money;
  netRewardRisk: Money | null;
  breakEvenWinProb: Money | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Estimates a conservative exit-side cost buffer. In the MV model this is a
 * static configurable bps figure keyed by token liquidity tier. Slice 2
 * replaces this with a real distribution keyed by (token, side, size,
 * volatility, spread regime).
 */
export function estimateExitImpactBps(
  token: string,
  extraSpreadBps: number = DEFAULT_EXIT_EXTRA_SPREAD_BPS,
): number {
  const illiquidBoost = LIQUID_TIER.has(token) ? 0 : DEFAULT_ILLIQUID_IMPACT_BPS;
  return extraSpreadBps + illiquidBoost;
}

function spreadBpsOf(bid: Money | null, ask: Money | null, mid: Money): Money {
  if (!bid || !ask || mid.isZero()) return ZERO_MONEY;
  return ask.sub(bid).div(mid).mul(Money.fromString('10000'));
}

function impactBpsOf(fillPrice: Money, arrivalMid: Money): Money {
  if (arrivalMid.isZero()) return ZERO_MONEY;
  // Signed impact: positive = fill worse than mid on buy.
  return fillPrice.sub(arrivalMid).div(arrivalMid).mul(Money.fromString('10000'));
}

// ---------------------------------------------------------------------------
// Cost forecast
// ---------------------------------------------------------------------------

/**
 * Builds a full cost forecast from the fee tier + preview. Assumes a LONG
 * position (buy → sell); short/sell-side variants are added when the strategy
 * spec supports them.
 */
export function buildCostForecast(input: CostModelInput): CostForecast {
  const {
    token,
    arrivalMid,
    takeProfitPct,
    stopLossPct,
    feeTier,
    preview,
    exitExtraSpreadBps,
    latencySlippageBps,
    exitCostQuantile,
  } = input;

  const spreadBps = spreadBpsOf(preview.bestBid, preview.bestAsk, arrivalMid);

  // ENTRY — from preview.
  const entryFee = preview.commissionTotal;
  const estimatedEntryFillPrice = preview.estimatedAvgFillPrice;
  const entryImpactBps = impactBpsOf(estimatedEntryFillPrice, arrivalMid);

  // Filled base size: prefer preview.baseSize; otherwise derive from quote/fill.
  const filledBaseSize =
    preview.baseSize ??
    (preview.quoteSize && !estimatedEntryFillPrice.isZero()
      ? preview.quoteSize.div(estimatedEntryFillPrice)
      : ZERO_MONEY);

  // EXIT — modeled conservatively.
  const exitBps = Money.fromBps(estimateExitImpactBps(token, exitExtraSpreadBps));
  const latencyBps = Money.fromBps(latencySlippageBps ?? DEFAULT_LATENCY_SLIPPAGE_BPS);

  const takeProfitPrice = arrivalMid.mul(
    Money.fromString('1').add(Money.fromString(String(takeProfitPct)).divInt(100)),
  );
  const stopLossPrice = arrivalMid.mul(
    Money.fromString('1').sub(Money.fromString(String(stopLossPct)).divInt(100)),
  );

  // Assumed exit fill (long): TP hits at TP price with an exit-impact haircut,
  // SL hits at SL price with the same haircut.
  const exitHaircut = exitBps.add(latencyBps); // in "bps as Money" (0.0001 each)
  const exitHaircutRatio = exitHaircut.divInt(10000);
  const assumedTpFillPrice = takeProfitPrice.mul(Money.fromString('1').sub(exitHaircutRatio));
  const assumedSlFillPrice = stopLossPrice.mul(Money.fromString('1').sub(exitHaircutRatio));

  const exitFeeEstimateAtTp = assumedTpFillPrice.mul(filledBaseSize).mul(feeTier.takerFeeRate);
  const exitFeeEstimateAtSl = assumedSlFillPrice.mul(filledBaseSize).mul(feeTier.takerFeeRate);
  // The conservative exit-fee estimate for the round-trip cost figure uses TP —
  // it's the larger of the two absolute fees typically and represents "cost we
  // pay even when winning". Both TP and SL fees are used in the net P&L rows.
  const exitFeeEstimate = exitFeeEstimateAtTp;

  const grossTpPnl = takeProfitPrice.sub(arrivalMid).mul(filledBaseSize);
  const grossSlPnl = stopLossPrice.sub(arrivalMid).mul(filledBaseSize); // negative

  // Impact loss on exit (haircut vs. TP/SL price).
  const impactLossAtTp = takeProfitPrice.sub(assumedTpFillPrice).mul(filledBaseSize);
  const impactLossAtSl = stopLossPrice.sub(assumedSlFillPrice).mul(filledBaseSize);

  const netTpPnl = grossTpPnl.sub(entryFee).sub(exitFeeEstimateAtTp).sub(impactLossAtTp);
  const netSlPnl = grossSlPnl.sub(entryFee).sub(exitFeeEstimateAtSl).sub(impactLossAtSl);

  const roundTripCost = entryFee.add(exitFeeEstimate).add(impactLossAtTp);

  const costToTargetPct = grossTpPnl.isZero()
    ? Money.fromString('100')
    : roundTripCost.div(grossTpPnl).mul(Money.fromString('100'));

  const rewardAbs = netTpPnl;
  const riskAbs = netSlPnl.abs();
  const netRewardRisk = riskAbs.isZero() ? null : rewardAbs.div(riskAbs);

  // Cost-adjusted break-even win probability:
  //   BE = |netSl| / (|netSl| + netTp)     — assuming binary TP/SL outcomes.
  const denom = rewardAbs.add(riskAbs);
  const breakEvenWinProb =
    denom.isZero() || !rewardAbs.isPositive() ? null : riskAbs.div(denom);

  return {
    costModelVersion: COST_MODEL_VERSION,
    exitCostQuantile: exitCostQuantile ?? DEFAULT_EXIT_IMPACT_QUANTILE,
    arrivalMid,
    spreadBps,
    entryFee,
    entryImpactBps,
    estimatedEntryFillPrice,
    filledBaseSize,
    exitFeeEstimate,
    exitImpactBpsEstimate: exitBps,
    latencySlippageBpsEstimate: latencyBps,
    roundTripCost,
    costToTargetPct,
    takeProfitPrice,
    stopLossPrice,
    netTpPnl,
    netSlPnl,
    netRewardRisk,
    breakEvenWinProb,
  };
}
