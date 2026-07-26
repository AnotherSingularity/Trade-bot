/**
 * Phase 2B §D — RegimeResult contract.
 *
 * A regime state is TIME-DEPENDENT and distinct from a Phase 2A
 * cross-sectional fingerprint. The contract enforces:
 *   - A closed set of 7 semantic states.
 *   - Nine status values with strict fail-closed semantics.
 *   - Evidence rows (supporting, conflicting, missing) that must be
 *     recorded even when the state is UNKNOWN.
 *   - Model + transition policy versions so any behavior change
 *     produces a new lineage without silent drift.
 *
 * A `RegimeResult` MUST NOT be used to authorize, resize, reroute
 * or reject any champion behavior. It is a research/observer output.
 */

export type RegimeState =
  | 'TREND_UP'
  | 'TREND_DOWN'
  | 'RANGE'
  | 'VOLATILITY_EXPANSION'
  | 'CAPITULATION'
  | 'DISORDERED'
  | 'UNKNOWN';

export type RegimeStatus =
  | 'valid'
  | 'low_confidence'
  | 'insufficient_history'
  | 'stale'
  | 'gap_detected'
  | 'conflicted'
  | 'numerical_failure'
  | 'quarantined'
  | 'unknown';

export type EvidenceRole = 'supporting' | 'conflicting' | 'missing';

export interface RegimeEvidenceItem {
  component: string;
  componentVersion: string;
  role: EvidenceRole;
  weight: number;
  detail?: string;
  featureValueId?: number | null;
  changePointEventId?: number | null;
  latentStateAssignmentId?: number | null;
}

export interface RegimeResult {
  state: RegimeState;
  status: RegimeStatus;
  /** In [0,1]. Only meaningful for `valid` and `low_confidence`. */
  confidence: number;
  supportingEvidence: RegimeEvidenceItem[];
  conflictingEvidence: RegimeEvidenceItem[];
  missingEvidence: RegimeEvidenceItem[];
  globalStateId: number | null;
  fingerprintSnapshotId: number | null;
  observedAt: Date;
  dataAvailableAt: Date;
  modelVersion: string;
  transitionPolicyVersion: string;
  inputHash: string;
  diagnostics: Record<string, unknown> | null;
  failureReason: string | null;
}

export interface RegimeDefinition {
  key: string;
  version: string;
  scope: 'global' | 'product';
  description: string;
  requiredEvidence: readonly string[];
  minimumValidEvidence: number;
  conflictPolicy: string;
  missingDataPolicy: string;
  transitionPolicyVersion: string;
  status: 'draft' | 'observer' | 'validated_for_research' | 'deprecated' | 'disabled';
}

/**
 * Build a fail-closed result. `state` defaults to UNKNOWN unless a
 * caller explicitly opts into DISORDERED for a quality-override path.
 * `value`/numeric coercion is never possible here because state is
 * always a semantic label, not a numeric.
 */
export function failRegime(
  status: Exclude<RegimeStatus, 'valid' | 'low_confidence'>,
  def: Pick<RegimeDefinition, 'version' | 'transitionPolicyVersion'>,
  meta: {
    observedAt: Date;
    dataAvailableAt: Date;
    inputHash: string;
    failureReason: string;
    state?: RegimeState;
    supportingEvidence?: RegimeEvidenceItem[];
    conflictingEvidence?: RegimeEvidenceItem[];
    missingEvidence?: RegimeEvidenceItem[];
    diagnostics?: Record<string, unknown> | null;
    globalStateId?: number | null;
    fingerprintSnapshotId?: number | null;
  },
): RegimeResult {
  const preferredState: RegimeState =
    meta.state ?? (status === 'gap_detected' || status === 'stale' ? 'UNKNOWN' : 'UNKNOWN');
  return {
    state: preferredState,
    status,
    confidence: 0,
    supportingEvidence: meta.supportingEvidence ?? [],
    conflictingEvidence: meta.conflictingEvidence ?? [],
    missingEvidence: meta.missingEvidence ?? [],
    globalStateId: meta.globalStateId ?? null,
    fingerprintSnapshotId: meta.fingerprintSnapshotId ?? null,
    observedAt: meta.observedAt,
    dataAvailableAt: meta.dataAvailableAt,
    modelVersion: def.version,
    transitionPolicyVersion: def.transitionPolicyVersion,
    inputHash: meta.inputHash,
    diagnostics: meta.diagnostics ?? null,
    failureReason: meta.failureReason,
  };
}

export function validRegime(
  def: Pick<RegimeDefinition, 'version' | 'transitionPolicyVersion'>,
  meta: {
    state: RegimeState;
    confidence: number;
    supportingEvidence: RegimeEvidenceItem[];
    conflictingEvidence?: RegimeEvidenceItem[];
    missingEvidence?: RegimeEvidenceItem[];
    observedAt: Date;
    dataAvailableAt: Date;
    inputHash: string;
    diagnostics?: Record<string, unknown> | null;
    globalStateId?: number | null;
    fingerprintSnapshotId?: number | null;
    lowConfidence?: boolean;
    lowConfidenceReason?: string;
  },
): RegimeResult {
  const conf = clamp01(meta.confidence);
  const status: RegimeStatus = meta.lowConfidence ? 'low_confidence' : 'valid';
  return {
    state: meta.state,
    status,
    confidence: conf,
    supportingEvidence: meta.supportingEvidence,
    conflictingEvidence: meta.conflictingEvidence ?? [],
    missingEvidence: meta.missingEvidence ?? [],
    globalStateId: meta.globalStateId ?? null,
    fingerprintSnapshotId: meta.fingerprintSnapshotId ?? null,
    observedAt: meta.observedAt,
    dataAvailableAt: meta.dataAvailableAt,
    modelVersion: def.version,
    transitionPolicyVersion: def.transitionPolicyVersion,
    inputHash: meta.inputHash,
    diagnostics: meta.diagnostics ?? null,
    failureReason: meta.lowConfidenceReason ?? null,
  };
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** A valid regime — the only status a champion audit would treat as canonical if it consumed one (which it must not). */
export function isValidRegime(r: RegimeResult): boolean {
  return r.status === 'valid';
}

/** Usable with caveat — a low-confidence result may inform reports but never authorization. */
export function isUsableWithCaveat(r: RegimeResult): boolean {
  return r.status === 'valid' || r.status === 'low_confidence';
}
