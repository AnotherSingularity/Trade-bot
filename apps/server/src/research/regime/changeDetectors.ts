import { createHash } from 'node:crypto';
import type { CandleBar } from '../features/inputs';
import { visibleFinalizedBars } from '../features/inputs';
import { logReturns, mean, stdev } from '../features/math';

/**
 * Phase 2B §G — Change-point detectors.
 *
 * Two independent DETERMINISTIC detectors:
 *
 *   1. `cusumDetector` — one-sided CUSUM in both directions with a
 *      versioned control-chart threshold. Emits an event only if
 *      the cumulative deviation crosses `k * sigma * length`.
 *
 *   2. `segmentedVarianceDetector` — splits the visible window at
 *      several candidate change points and reports the largest
 *      F-like variance-ratio jump. Fully deterministic; no future
 *      observations enter the score.
 *
 * A Bayesian online change-point detector is intentionally NOT
 * shipped: without a peer-reviewed hazard-policy audit its output
 * would be misleading. `bocpd_deferred` is a first-class enum value
 * in the schema so we can persist "we deliberately did not run this"
 * rather than silently omit it.
 */

export const CUSUM_DETECTOR_VERSION = 'p2b-cusum-1';
export const CUSUM_THRESHOLD_VERSION = 'p2b-cusum-thresh-1';
export const SEGMENTED_VARIANCE_VERSION = 'p2b-segvar-1';
export const SEGMENTED_VARIANCE_THRESHOLD_VERSION = 'p2b-segvar-thresh-1';

export type ChangePointDirection = 'up' | 'down' | 'either' | 'none';
export type NumericalStatus = 'ok' | 'underflow_handled' | 'overflow_handled' | 'failure';

export interface ChangePointResult {
  detector: 'cusum' | 'segmented_variance' | 'bocpd_deferred';
  detectorVersion: string;
  thresholdVersion: string;
  hazardPolicyVersion: string | null;
  direction: ChangePointDirection;
  magnitude: number | null;
  changeProbability: number | null;
  runLengthEstimate: number | null;
  confidence: number;
  numericalStatus: NumericalStatus;
  triggered: boolean;
  detectedAt: Date;
  dataAvailableAt: Date;
  inputHash: string;
  diagnostics: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// CUSUM detector
// ---------------------------------------------------------------------------

export interface CusumParams {
  /** Reference slack — smaller = more sensitive. */
  k: number;
  /** Alarm threshold expressed in units of sigma. */
  h: number;
  /** Minimum returns required before the detector runs. */
  minSamples: number;
}

export const DEFAULT_CUSUM_PARAMS: CusumParams = {
  k: 0.5,
  h: 5,
  minSamples: 64,
};

export interface CusumInput {
  productId: string | null;
  scope: 'global' | 'product';
  now: Date;
  bars: CandleBar[];
  params?: CusumParams;
}

export function cusumDetector(input: CusumInput): ChangePointResult {
  const params = input.params ?? DEFAULT_CUSUM_PARAMS;
  const visible = visibleFinalizedBars(input.bars, input.now);
  const inputHash = hashCusum(input);
  if (visible.length < params.minSamples + 1) {
    return {
      detector: 'cusum',
      detectorVersion: CUSUM_DETECTOR_VERSION,
      thresholdVersion: CUSUM_THRESHOLD_VERSION,
      hazardPolicyVersion: null,
      direction: 'none',
      magnitude: null,
      changeProbability: null,
      runLengthEstimate: null,
      confidence: 0,
      numericalStatus: 'ok',
      triggered: false,
      detectedAt: input.now,
      dataAvailableAt: input.now,
      inputHash,
      diagnostics: { reason: 'insufficient_samples', have: visible.length, need: params.minSamples + 1 },
    };
  }
  const closes = visible.map((b) => b.close);
  const returns = logReturns(closes);
  if (returns.some((r) => !Number.isFinite(r))) {
    return {
      detector: 'cusum',
      detectorVersion: CUSUM_DETECTOR_VERSION,
      thresholdVersion: CUSUM_THRESHOLD_VERSION,
      hazardPolicyVersion: null,
      direction: 'none',
      magnitude: null,
      changeProbability: null,
      runLengthEstimate: null,
      confidence: 0,
      numericalStatus: 'failure',
      triggered: false,
      detectedAt: input.now,
      dataAvailableAt: input.now,
      inputHash,
      diagnostics: { reason: 'non_finite_return' },
    };
  }
  const mu = mean(returns);
  const sigma = stdev(returns);
  if (!(sigma > 0)) {
    return {
      detector: 'cusum',
      detectorVersion: CUSUM_DETECTOR_VERSION,
      thresholdVersion: CUSUM_THRESHOLD_VERSION,
      hazardPolicyVersion: null,
      direction: 'none',
      magnitude: null,
      changeProbability: null,
      runLengthEstimate: null,
      confidence: 0,
      numericalStatus: 'failure',
      triggered: false,
      detectedAt: input.now,
      dataAvailableAt: input.now,
      inputHash,
      diagnostics: { reason: 'zero_sigma' },
    };
  }
  const kSigma = params.k * sigma;
  const threshold = params.h * sigma;
  let sPos = 0;
  let sNeg = 0;
  let maxPos = 0;
  let maxNeg = 0;
  let posIndex = -1;
  let negIndex = -1;
  for (let i = 0; i < returns.length; i += 1) {
    const dev = returns[i] - mu;
    sPos = Math.max(0, sPos + dev - kSigma);
    sNeg = Math.max(0, sNeg - dev - kSigma);
    if (sPos > maxPos) {
      maxPos = sPos;
      posIndex = i;
    }
    if (sNeg > maxNeg) {
      maxNeg = sNeg;
      negIndex = i;
    }
  }
  const upTriggered = maxPos > threshold;
  const downTriggered = maxNeg > threshold;
  const direction: ChangePointDirection =
    upTriggered && downTriggered ? 'either' : upTriggered ? 'up' : downTriggered ? 'down' : 'none';
  const magnitude = direction === 'up' ? maxPos : direction === 'down' ? maxNeg : direction === 'either' ? Math.max(maxPos, maxNeg) : Math.max(maxPos, maxNeg);
  const triggered = direction !== 'none';
  return {
    detector: 'cusum',
    detectorVersion: CUSUM_DETECTOR_VERSION,
    thresholdVersion: CUSUM_THRESHOLD_VERSION,
    hazardPolicyVersion: null,
    direction,
    magnitude,
    changeProbability: null,
    runLengthEstimate: null,
    confidence: triggered ? Math.min(1, magnitude / (2 * threshold)) : 0,
    numericalStatus: 'ok',
    triggered,
    detectedAt: input.now,
    dataAvailableAt: input.now,
    inputHash,
    diagnostics: {
      mu,
      sigma,
      kSigma,
      threshold,
      maxPos,
      maxNeg,
      posIndex,
      negIndex,
      samples: returns.length,
    },
  };
}

function hashCusum(input: CusumInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: CUSUM_DETECTOR_VERSION,
        t: CUSUM_THRESHOLD_VERSION,
        pid: input.productId,
        scope: input.scope,
        now: input.now.toISOString(),
        bars: input.bars.map((b) => [b.bucketStart.toISOString(), b.close, b.finalized]),
      }),
    )
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Segmented-variance detector
// ---------------------------------------------------------------------------

export interface SegmentedVarianceParams {
  /** Minimum window on each side of the candidate change point. */
  minSegment: number;
  /** Minimum log-ratio of variances to declare a change. */
  logRatioThreshold: number;
}

export const DEFAULT_SEGVAR_PARAMS: SegmentedVarianceParams = {
  minSegment: 48,
  logRatioThreshold: 0.6,
};

export interface SegmentedVarianceInput {
  productId: string | null;
  scope: 'global' | 'product';
  now: Date;
  bars: CandleBar[];
  params?: SegmentedVarianceParams;
}

export function segmentedVarianceDetector(input: SegmentedVarianceInput): ChangePointResult {
  const params = input.params ?? DEFAULT_SEGVAR_PARAMS;
  const visible = visibleFinalizedBars(input.bars, input.now);
  const inputHash = hashSegVar(input);
  if (visible.length < 2 * params.minSegment + 1) {
    return {
      detector: 'segmented_variance',
      detectorVersion: SEGMENTED_VARIANCE_VERSION,
      thresholdVersion: SEGMENTED_VARIANCE_THRESHOLD_VERSION,
      hazardPolicyVersion: null,
      direction: 'none',
      magnitude: null,
      changeProbability: null,
      runLengthEstimate: null,
      confidence: 0,
      numericalStatus: 'ok',
      triggered: false,
      detectedAt: input.now,
      dataAvailableAt: input.now,
      inputHash,
      diagnostics: {
        reason: 'insufficient_samples',
        have: visible.length,
        need: 2 * params.minSegment + 1,
      },
    };
  }
  const returns = logReturns(visible.map((b) => b.close));
  if (returns.some((r) => !Number.isFinite(r))) {
    return {
      detector: 'segmented_variance',
      detectorVersion: SEGMENTED_VARIANCE_VERSION,
      thresholdVersion: SEGMENTED_VARIANCE_THRESHOLD_VERSION,
      hazardPolicyVersion: null,
      direction: 'none',
      magnitude: null,
      changeProbability: null,
      runLengthEstimate: null,
      confidence: 0,
      numericalStatus: 'failure',
      triggered: false,
      detectedAt: input.now,
      dataAvailableAt: input.now,
      inputHash,
      diagnostics: { reason: 'non_finite_return' },
    };
  }
  const n = returns.length;
  let bestScore = 0;
  let bestIdx = -1;
  let bestLeft = 0;
  let bestRight = 0;
  for (let i = params.minSegment; i <= n - params.minSegment; i += 1) {
    const left = returns.slice(0, i);
    const right = returns.slice(i);
    const vL = variance(left);
    const vR = variance(right);
    if (!(vL > 0) || !(vR > 0)) continue;
    const score = Math.abs(Math.log(vR / vL));
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
      bestLeft = vL;
      bestRight = vR;
    }
  }
  const triggered = bestScore > params.logRatioThreshold;
  const direction: ChangePointDirection = triggered ? (bestRight > bestLeft ? 'up' : 'down') : 'none';
  return {
    detector: 'segmented_variance',
    detectorVersion: SEGMENTED_VARIANCE_VERSION,
    thresholdVersion: SEGMENTED_VARIANCE_THRESHOLD_VERSION,
    hazardPolicyVersion: null,
    direction,
    magnitude: bestScore,
    changeProbability: null,
    runLengthEstimate: bestIdx >= 0 ? n - bestIdx : null,
    confidence: triggered ? Math.min(1, bestScore / (2 * params.logRatioThreshold)) : 0,
    numericalStatus: 'ok',
    triggered,
    detectedAt: input.now,
    dataAvailableAt: input.now,
    inputHash,
    diagnostics: {
      bestIdx,
      bestLeft,
      bestRight,
      threshold: params.logRatioThreshold,
      samples: n,
    },
  };
}

function variance(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (xs.length - 1);
}

function hashSegVar(input: SegmentedVarianceInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: SEGMENTED_VARIANCE_VERSION,
        t: SEGMENTED_VARIANCE_THRESHOLD_VERSION,
        pid: input.productId,
        scope: input.scope,
        now: input.now.toISOString(),
        bars: input.bars.map((b) => [b.bucketStart.toISOString(), b.close, b.finalized]),
      }),
    )
    .digest('hex');
}

// ---------------------------------------------------------------------------
// BOCPD — deferred marker
// ---------------------------------------------------------------------------

/**
 * A first-class deferred marker so downstream code and audit rows can
 * see that BOCPD was deliberately skipped, not merely absent. Returns
 * a numerical_status='failure' with `triggered=false` — never any
 * "probability = 0" pretense.
 */
export function bocpdDeferred(input: {
  productId: string | null;
  scope: 'global' | 'product';
  now: Date;
}): ChangePointResult {
  const inputHash = createHash('sha256')
    .update(JSON.stringify({ v: 'p2b-bocpd-deferred', pid: input.productId, scope: input.scope, now: input.now.toISOString() }))
    .digest('hex');
  return {
    detector: 'bocpd_deferred',
    detectorVersion: 'p2b-bocpd-deferred',
    thresholdVersion: 'p2b-bocpd-deferred',
    hazardPolicyVersion: null,
    direction: 'none',
    magnitude: null,
    changeProbability: null,
    runLengthEstimate: null,
    confidence: 0,
    numericalStatus: 'failure',
    triggered: false,
    detectedAt: input.now,
    dataAvailableAt: input.now,
    inputHash,
    diagnostics: {
      reason: 'bocpd_intentionally_deferred_until_hazard_policy_audit',
    },
  };
}
