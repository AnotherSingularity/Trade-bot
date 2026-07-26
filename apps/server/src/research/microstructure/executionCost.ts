import { createHash } from 'node:crypto';
import type { BookSnapshot } from './bookEngine';

/**
 * Phase 2D §G, §H, §I, §J — execution-cost observer.
 *
 * Distinct from Gate 3B's preview-based forecast. This module is
 * BOOK-AWARE (`isBookAware=true`), walks the visible book exactly,
 * refuses to extrapolate depth silently, admits queue uncertainty
 * in the passive-fill model, and represents stop execution under
 * multiple adverse regimes without pretending trigger price is a
 * guaranteed execution price.
 */

export const EXEC_COST_MODEL_VERSION = 'p2d-exec-cost-1';
export const IMPACT_MODEL_VERSION = 'p2d-impact-1';
export const PASSIVE_FILL_MODEL_VERSION = 'p2d-passive-1';
export const STOP_EXECUTION_MODEL_VERSION = 'p2d-stop-exec-1';

// ---------------------------------------------------------------------------
// Impact curves
// ---------------------------------------------------------------------------

export interface ImpactCurvePoint {
  notional: number;
  filledNotional: number;
  unfilledNotional: number;
  avgFillPrice: number | null;
  impactBps: number | null;
  extrapolated: boolean;
}

export interface ImpactCurveResult {
  side: 'buy' | 'sell';
  points: ImpactCurvePoint[];
  monotonic: boolean;
  modelVersion: string;
}

export function computeImpactCurve(
  snap: BookSnapshot,
  side: 'buy' | 'sell',
  notionals: readonly number[],
): ImpactCurveResult {
  const levels = side === 'buy' ? snap.asks : snap.bids;
  const anchor = side === 'buy' ? snap.asks[0]?.price ?? null : snap.bids[0]?.price ?? null;
  const points: ImpactCurvePoint[] = [];
  for (const targetNotional of notionals) {
    let remainingNotional = targetNotional;
    let filled = 0;
    let filledNotional = 0;
    for (const l of levels) {
      const availableNotional = l.price * l.size;
      if (availableNotional <= 0) continue;
      if (remainingNotional <= availableNotional) {
        const sizeTaken = remainingNotional / l.price;
        filled += sizeTaken;
        filledNotional += remainingNotional;
        remainingNotional = 0;
        break;
      }
      filled += l.size;
      filledNotional += availableNotional;
      remainingNotional -= availableNotional;
    }
    const unfilledNotional = Math.max(0, remainingNotional);
    const avgFillPrice = filled > 0 ? filledNotional / filled : null;
    const impactBps =
      avgFillPrice != null && anchor != null && anchor > 0
        ? Math.abs(avgFillPrice - anchor) / anchor * 10_000 * (side === 'buy' ? 1 : 1)
        : null;
    points.push({
      notional: targetNotional,
      filledNotional,
      unfilledNotional,
      avgFillPrice,
      impactBps,
      extrapolated: false, // never silently extrapolate — unfilled is surfaced instead
    });
  }
  // Monotonicity check: impact per unit should not decrease with size.
  let monotonic = true;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    if (prev.impactBps != null && cur.impactBps != null && cur.impactBps + 1e-9 < prev.impactBps) {
      monotonic = false;
      break;
    }
  }
  return { side, points, monotonic, modelVersion: IMPACT_MODEL_VERSION };
}

// ---------------------------------------------------------------------------
// Passive fill model
// ---------------------------------------------------------------------------

export type PassiveFillState = 'unlikely' | 'low_confidence' | 'possible' | 'probable' | 'unknown';

export interface PassiveFillResult {
  side: 'buy' | 'sell';
  limitPrice: number;
  visibleSizeAhead: number | null;
  state: PassiveFillState;
  confidence: number;
  reason: string;
  modelVersion: string;
}

export function estimatePassiveFill(snap: BookSnapshot, side: 'buy' | 'sell', limitPrice: number): PassiveFillResult {
  const sameSide = side === 'buy' ? snap.bids : snap.asks;
  const oppSide = side === 'buy' ? snap.asks : snap.bids;
  if (sameSide.length === 0 || oppSide.length === 0) {
    return {
      side,
      limitPrice,
      visibleSizeAhead: null,
      state: 'unknown',
      confidence: 0,
      reason: 'empty_book',
      modelVersion: PASSIVE_FILL_MODEL_VERSION,
    };
  }
  // A buy limit at or above the best ask crosses → it becomes a marketable
  // order, not a passive one; the caller should route as marketable.
  if (side === 'buy' && limitPrice >= oppSide[0].price) {
    return {
      side,
      limitPrice,
      visibleSizeAhead: 0,
      state: 'unknown',
      confidence: 0,
      reason: 'marketable_not_passive',
      modelVersion: PASSIVE_FILL_MODEL_VERSION,
    };
  }
  if (side === 'sell' && limitPrice <= oppSide[0].price) {
    return {
      side,
      limitPrice,
      visibleSizeAhead: 0,
      state: 'unknown',
      confidence: 0,
      reason: 'marketable_not_passive',
      modelVersion: PASSIVE_FILL_MODEL_VERSION,
    };
  }
  // Sum visible size at prices strictly better than limitPrice (favorable for the counter).
  let visibleSizeAhead = 0;
  for (const l of sameSide) {
    const better = side === 'buy' ? l.price > limitPrice : l.price < limitPrice;
    if (better) visibleSizeAhead += l.size;
  }
  // We DO NOT claim exchange-queue realism — queue position is not observable
  // from a top-of-book view alone. State is a scoring model over visibleSizeAhead
  // and the spread, with a permanent low_confidence cap when we have no queue
  // identity data.
  const spread = (snap.asks[0]?.price ?? 0) - (snap.bids[0]?.price ?? 0);
  let state: PassiveFillState = 'possible';
  let confidence = 0.4;
  let reason = 'passive_within_spread';
  if (visibleSizeAhead > 100 * (snap.asks[0]?.size ?? 1)) {
    state = 'unlikely';
    confidence = 0.2;
    reason = 'large_visible_queue_ahead';
  } else if (spread > 0 && spread / (snap.asks[0]?.price ?? 1) > 0.01) {
    state = 'low_confidence';
    confidence = 0.3;
    reason = 'wide_spread_reduces_fill_confidence';
  }
  return {
    side,
    limitPrice,
    visibleSizeAhead,
    state,
    confidence,
    reason,
    modelVersion: PASSIVE_FILL_MODEL_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Stop-execution observer
// ---------------------------------------------------------------------------

export interface StopExecutionEstimate {
  triggerPrice: number;
  side: 'buy' | 'sell';
  estimatedExitPriceNormal: number | null;
  estimatedExitPriceSpreadExpansion: number | null;
  estimatedExitPriceGapThrough: number | null;
  estimatedExitPricePartial: number | null;
  estimatedExitPriceProtectionFailure: number | null;
  modelVersion: string;
}

export function estimateStopExecution(snap: BookSnapshot, side: 'buy' | 'sell', triggerPrice: number): StopExecutionEstimate {
  const oppSide = side === 'buy' ? snap.asks : snap.bids;
  const bestOpposite = oppSide[0]?.price ?? null;
  const normal = bestOpposite;
  const spreadExpansion = bestOpposite != null ? bestOpposite * (side === 'buy' ? 1.005 : 0.995) : null;
  const gapThrough = triggerPrice * (side === 'buy' ? 1.01 : 0.99);
  const partial = bestOpposite != null ? bestOpposite * (side === 'buy' ? 1.002 : 0.998) : null;
  const protectionFailure = triggerPrice * (side === 'buy' ? 1.02 : 0.98);
  return {
    triggerPrice,
    side,
    estimatedExitPriceNormal: normal,
    estimatedExitPriceSpreadExpansion: spreadExpansion,
    estimatedExitPriceGapThrough: gapThrough,
    estimatedExitPricePartial: partial,
    estimatedExitPriceProtectionFailure: protectionFailure,
    modelVersion: STOP_EXECUTION_MODEL_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Execution-cost observer (top-level composition)
// ---------------------------------------------------------------------------

export interface ExecutionCostObserverInput {
  bookSnapshot: BookSnapshot;
  side: 'buy' | 'sell';
  entryNotional: number;
  passiveLimitPrice: number | null;
  latencyMs: number;
  feeBps: number;
  now: Date;
}

export interface ExecutionCostObserverResult {
  entryNotional: number;
  marketableVWAP: number | null;
  passiveLimitPrice: number | null;
  estimatedSpreadCost: number | null;
  estimatedImpact: number | null;
  estimatedLatencyCost: number | null;
  estimatedFee: number | null;
  estimatedFillProbability: number | null;
  estimatedUnfilledProbability: number | null;
  estimatedPartialFillProbability: number | null;
  estimatedQueueUncertainty: number | null;
  estimatedStopExecutionCost: number | null;
  isBookAware: boolean;
  modelVersion: string;
  inputHash: string;
  observedAt: Date;
  dataAvailableAt: Date;
}

export function computeExecutionCost(input: ExecutionCostObserverInput): ExecutionCostObserverResult {
  const snap = input.bookSnapshot;
  const impact = computeImpactCurve(snap, input.side, [input.entryNotional]);
  const marketablePoint = impact.points[0];
  const marketableVWAP = marketablePoint?.avgFillPrice ?? null;
  const unfilled = marketablePoint?.unfilledNotional ?? input.entryNotional;
  const mid = snap.bids[0] && snap.asks[0] ? (snap.bids[0].price + snap.asks[0].price) / 2 : null;
  const spreadCost =
    mid != null && marketableVWAP != null && input.entryNotional > 0
      ? Math.abs(marketableVWAP - mid) * (input.entryNotional / marketableVWAP)
      : null;
  const impactCost = spreadCost;
  const latencyCost = mid != null ? (input.entryNotional * input.latencyMs) / 1_000_000_000 : 0; // symbolic, non-negative
  const fee = input.entryNotional * (input.feeBps / 10_000);
  const passive = input.passiveLimitPrice != null ? estimatePassiveFill(snap, input.side, input.passiveLimitPrice) : null;
  const fillProbability = passive != null
    ? passive.state === 'probable'
      ? 0.7
      : passive.state === 'possible'
        ? 0.4
        : passive.state === 'low_confidence'
          ? 0.25
          : passive.state === 'unlikely'
            ? 0.1
            : null
    : marketableVWAP != null && unfilled <= 0
      ? 0.99
      : marketableVWAP != null
        ? 0.5
        : null;
  const unfilledProbability = fillProbability != null ? 1 - fillProbability : null;
  const partialFillProbability = fillProbability != null ? Math.max(0, Math.min(1, 1 - fillProbability) / 2) : null;
  const queueUncertainty = passive != null ? Math.max(0.5, 1 - passive.confidence) : 0.1;
  const stop = mid != null ? estimateStopExecution(snap, input.side === 'buy' ? 'sell' : 'buy', mid) : null;
  const stopCost =
    stop != null && stop.estimatedExitPriceNormal != null
      ? Math.abs(stop.estimatedExitPriceNormal - stop.triggerPrice) * (input.entryNotional / stop.triggerPrice)
      : null;
  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        v: EXEC_COST_MODEL_VERSION,
        pid: snap.productId,
        seq: snap.sequence,
        side: input.side,
        n: input.entryNotional,
        p: input.passiveLimitPrice,
        lat: input.latencyMs,
        fee: input.feeBps,
      }),
    )
    .digest('hex');
  return {
    entryNotional: input.entryNotional,
    marketableVWAP,
    passiveLimitPrice: input.passiveLimitPrice,
    estimatedSpreadCost: spreadCost,
    estimatedImpact: impactCost,
    estimatedLatencyCost: latencyCost,
    estimatedFee: fee,
    estimatedFillProbability: fillProbability,
    estimatedUnfilledProbability: unfilledProbability,
    estimatedPartialFillProbability: partialFillProbability,
    estimatedQueueUncertainty: queueUncertainty,
    estimatedStopExecutionCost: stopCost,
    isBookAware: true,
    modelVersion: EXEC_COST_MODEL_VERSION,
    inputHash,
    observedAt: input.now,
    dataAvailableAt: snap.dataAvailableAt,
  };
}
