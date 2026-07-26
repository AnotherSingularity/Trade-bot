/**
 * Phase 2A §F — Feature Result contract.
 *
 * The result contract is the single source of truth for how a feature
 * reports its outcome. Every calculator returns a FeatureResult; the
 * fingerprint composer, persistence layer and shortlist policy all read
 * from the same shape.
 *
 * Rules (from the Phase 2A work order §F):
 *   1. Only `valid` may contribute normally to fingerprints.
 *   2. `low_confidence` values are retained but MUST NOT be treated as
 *      fully valid. The composer downweights or discards them per
 *      classification override rules.
 *   3. NO failure status may return a neutral zero. Failure values are
 *      always `null`. A zero MUST mean "the feature computed exactly
 *      zero", never "we don't know".
 *   4. NaN or Infinity are fatal — they promote to `numerical_failure`
 *      with value=null.
 *   5. Every candle used in the input MUST occur before
 *      `dataAvailableAt`. Look-ahead is a bug, not a warning.
 */

export type FeatureStatus =
  | 'valid'
  | 'insufficient_history'
  | 'stale'
  | 'invalid_input'
  | 'numerical_failure'
  | 'low_confidence'
  | 'gap_detected'
  | 'unsupported'
  | 'quarantined';

export interface FeatureResult<T = number> {
  status: FeatureStatus;
  value: T | null;
  /** In [0,1]. Only meaningful for `valid` and `low_confidence`. */
  confidence: number;
  sampleCount: number;
  lookbackStart: Date | null;
  lookbackEnd: Date | null;
  /** Local availability time — no candle after this may have been used. */
  dataAvailableAt: Date;
  inputHash: string;
  featureVersion: string;
  failureReason: string | null;
  diagnostics: Record<string, unknown> | null;
}

export interface FeatureDefinition {
  key: string;
  version: string;
  description: string;
  /** Human-readable list of required inputs. */
  inputRequirements: string;
  /** Minimum window in milliseconds (or 0 for point queries). */
  lookbackMs: number;
  /** Minimum number of clean samples required. */
  minimumSampleCount: number;
  outputType: 'scalar' | 'ratio' | 'bps' | 'count' | 'signed_scalar';
  unit: string | null;
  validRangeMin: number | null;
  validRangeMax: number | null;
  /** Text describing how missing/gap inputs are handled. */
  missingDataPolicy: string;
  /** Text describing what counts as stale for this feature. */
  stalenessPolicy: string;
  stage: 'stage_1' | 'stage_2';
  status: 'draft' | 'observer' | 'validated_for_research' | 'deprecated' | 'disabled';
  implementationVersion: string;
}

/**
 * Failure factory — every non-`valid` return path uses one of these to
 * guarantee we never leak a fabricated numeric value.
 */
export function failResult<T = number>(
  status: Exclude<FeatureStatus, 'valid' | 'low_confidence'>,
  def: Pick<FeatureDefinition, 'version'>,
  meta: {
    dataAvailableAt: Date;
    inputHash: string;
    sampleCount?: number;
    lookbackStart?: Date | null;
    lookbackEnd?: Date | null;
    failureReason: string;
    diagnostics?: Record<string, unknown> | null;
  },
): FeatureResult<T> {
  return {
    status,
    value: null,
    confidence: 0,
    sampleCount: meta.sampleCount ?? 0,
    lookbackStart: meta.lookbackStart ?? null,
    lookbackEnd: meta.lookbackEnd ?? null,
    dataAvailableAt: meta.dataAvailableAt,
    inputHash: meta.inputHash,
    featureVersion: def.version,
    failureReason: meta.failureReason,
    diagnostics: meta.diagnostics ?? null,
  };
}

export function validResult<T = number>(
  def: Pick<FeatureDefinition, 'version'>,
  meta: {
    value: T;
    confidence: number;
    sampleCount: number;
    lookbackStart: Date;
    lookbackEnd: Date;
    dataAvailableAt: Date;
    inputHash: string;
    diagnostics?: Record<string, unknown> | null;
    /**
     * Optional guard: promote to `low_confidence` when true (e.g.
     * variance-ratio distance too small vs standard error, Hurst
     * bootstrap CI wider than the trend/mean-reversion band).
     */
    lowConfidence?: boolean;
    lowConfidenceReason?: string;
  },
): FeatureResult<T> {
  const num = typeof meta.value === 'number' ? (meta.value as unknown as number) : NaN;
  if (typeof meta.value === 'number' && (!Number.isFinite(num))) {
    return failResult('numerical_failure', def, {
      dataAvailableAt: meta.dataAvailableAt,
      inputHash: meta.inputHash,
      sampleCount: meta.sampleCount,
      lookbackStart: meta.lookbackStart,
      lookbackEnd: meta.lookbackEnd,
      failureReason: 'value is NaN or Infinity',
      diagnostics: meta.diagnostics ?? null,
    });
  }
  const confidence = clamp01(meta.confidence);
  const status: FeatureStatus = meta.lowConfidence ? 'low_confidence' : 'valid';
  return {
    status,
    value: meta.value,
    confidence,
    sampleCount: meta.sampleCount,
    lookbackStart: meta.lookbackStart,
    lookbackEnd: meta.lookbackEnd,
    dataAvailableAt: meta.dataAvailableAt,
    inputHash: meta.inputHash,
    featureVersion: def.version,
    failureReason: meta.lowConfidenceReason ?? null,
    diagnostics: meta.diagnostics ?? null,
  };
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * A `valid` result contributes normally; a `low_confidence` result may
 * be shown to reviewers but must not participate in the composer's
 * strict quorum tests. Any other status is a hard exclusion.
 */
export function isValid<T>(r: FeatureResult<T>): r is FeatureResult<T> & { value: T } {
  return r.status === 'valid' && r.value !== null;
}

export function isUsableWithCaveat<T>(r: FeatureResult<T>): r is FeatureResult<T> & { value: T } {
  return (r.status === 'valid' || r.status === 'low_confidence') && r.value !== null;
}
