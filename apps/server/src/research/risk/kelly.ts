/**
 * Phase 2C §S — Kelly interface (DISABLED).
 *
 * The Kelly interface exists so that:
 *   - Callers cannot accidentally reach for an ad-hoc "kelly-ish"
 *     multiplier.
 *   - Audit trails can inspect "we did not use Kelly here".
 *
 * The effective multiplier is always 0. There is:
 *   - NO 1% minimum floor
 *   - NO 50/50 neutral assumption
 *   - NO raw win-rate estimate
 *   - NO allocation impact
 *
 * Future activation requires net outcomes, Bayesian shrinkage,
 * confidence bounds, and Phase 2F approval. Until then this file
 * refuses to produce any usable multiplier.
 */

export const KELLY_MODEL_VERSION = 'p2c-kelly-disabled-1';

export type KellyCalibrationStatus =
  | 'disabled'
  | 'insufficient_samples'
  | 'not_calibrated'
  | 'low_confidence'
  | 'valid_for_research';

export interface KellySizingEstimate {
  status: KellyCalibrationStatus;
  rawKellyFraction: number | null;
  uncertaintyAdjustedFraction: number | null;
  quarterKellyCap: number | null;
  sampleCount: number;
  posteriorSource: string;
  calibrationStatus: KellyCalibrationStatus;
  modelVersion: string;
  failureReason: string | null;
}

export function getKellyEstimate(): KellySizingEstimate {
  return {
    status: 'disabled',
    rawKellyFraction: null,
    uncertaintyAdjustedFraction: null,
    quarterKellyCap: null,
    sampleCount: 0,
    posteriorSource: 'none',
    calibrationStatus: 'disabled',
    modelVersion: KELLY_MODEL_VERSION,
    failureReason: 'Kelly sizing disabled in Phase 2C — activation requires Phase 2F approval',
  };
}

export const EFFECTIVE_KELLY_MULTIPLIER = 0;
