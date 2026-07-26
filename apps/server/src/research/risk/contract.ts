/**
 * Phase 2C §A, §E — Risk measurement contract.
 *
 * Three ideas kept STRICTLY SEPARATE:
 *   1. Risk measurement — an observed quantity (exposure, VaR, stop
 *      risk, drawdown, …). Never a limit.
 *   2. Risk policy — a versioned set of permitted limits and
 *      handling behavior.
 *   3. Risk decision — the result of applying a policy to a
 *      candidate + portfolio.
 *
 * A measurement does not establish a limit. A limit does not imply
 * authorization. A decision is the only artifact that recommends an
 * action, and Phase 2C decisions remain observer-only.
 */

export type RiskMeasurementStatus =
  | 'valid'
  | 'low_confidence'
  | 'insufficient_history'
  | 'stale'
  | 'invalid_input'
  | 'numerical_failure'
  | 'unresolved_state'
  | 'unsupported';

export interface RiskMeasurement<T = number> {
  measurementKey: string;
  status: RiskMeasurementStatus;
  value: T | null;
  unit: string;
  confidence: number | null;
  sampleCount: number | null;
  observedAt: Date;
  dataAvailableAt: Date;
  policyVersion: string;
  modelVersion: string | null;
  inputHash: string;
  failureReason: string | null;
  diagnostics: Record<string, unknown> | null;
}

export function invalidMeasurement<T = number>(
  status: Exclude<RiskMeasurementStatus, 'valid' | 'low_confidence'>,
  meta: {
    measurementKey: string;
    unit: string;
    observedAt: Date;
    dataAvailableAt: Date;
    policyVersion: string;
    modelVersion?: string | null;
    inputHash: string;
    failureReason: string;
    diagnostics?: Record<string, unknown> | null;
  },
): RiskMeasurement<T> {
  return {
    measurementKey: meta.measurementKey,
    status,
    value: null,
    unit: meta.unit,
    confidence: null,
    sampleCount: null,
    observedAt: meta.observedAt,
    dataAvailableAt: meta.dataAvailableAt,
    policyVersion: meta.policyVersion,
    modelVersion: meta.modelVersion ?? null,
    inputHash: meta.inputHash,
    failureReason: meta.failureReason,
    diagnostics: meta.diagnostics ?? null,
  };
}

export function validMeasurement<T = number>(meta: {
  measurementKey: string;
  value: T;
  unit: string;
  confidence?: number | null;
  sampleCount?: number | null;
  observedAt: Date;
  dataAvailableAt: Date;
  policyVersion: string;
  modelVersion?: string | null;
  inputHash: string;
  diagnostics?: Record<string, unknown> | null;
  lowConfidence?: boolean;
  lowConfidenceReason?: string;
}): RiskMeasurement<T> {
  if (typeof meta.value === 'number' && !Number.isFinite(meta.value as unknown as number)) {
    return invalidMeasurement<T>('numerical_failure', {
      measurementKey: meta.measurementKey,
      unit: meta.unit,
      observedAt: meta.observedAt,
      dataAvailableAt: meta.dataAvailableAt,
      policyVersion: meta.policyVersion,
      modelVersion: meta.modelVersion ?? null,
      inputHash: meta.inputHash,
      failureReason: 'value is NaN or Infinity',
      diagnostics: meta.diagnostics ?? null,
    });
  }
  return {
    measurementKey: meta.measurementKey,
    status: meta.lowConfidence ? 'low_confidence' : 'valid',
    value: meta.value,
    unit: meta.unit,
    confidence: meta.confidence ?? null,
    sampleCount: meta.sampleCount ?? null,
    observedAt: meta.observedAt,
    dataAvailableAt: meta.dataAvailableAt,
    policyVersion: meta.policyVersion,
    modelVersion: meta.modelVersion ?? null,
    inputHash: meta.inputHash,
    failureReason: meta.lowConfidenceReason ?? null,
    diagnostics: meta.diagnostics ?? null,
  };
}

/** Only a `valid` result may enter authorization arithmetic. */
export function isValid<T>(m: RiskMeasurement<T>): m is RiskMeasurement<T> & { value: T } {
  return m.status === 'valid' && m.value !== null;
}

/** A `low_confidence` result may be surfaced to reports but never grow size. */
export function isUsableForReporting<T>(m: RiskMeasurement<T>): m is RiskMeasurement<T> & { value: T } {
  return (m.status === 'valid' || m.status === 'low_confidence') && m.value !== null;
}
