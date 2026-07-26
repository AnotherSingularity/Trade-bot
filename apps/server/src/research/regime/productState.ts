import { createHash } from 'node:crypto';
import type { FeatureResult } from '../features/contract';
import {
  type RegimeDefinition,
  type RegimeEvidenceItem,
  type RegimeResult,
  type RegimeState,
  failRegime,
  validRegime,
} from './contract';

/**
 * Phase 2B §E, §F — Deterministic product-regime baseline.
 *
 * The baseline combines evidence from FIVE families:
 *
 *   1. Direction:      multi-window return direction, trend efficiency,
 *                      directional persistence, benchmark relative
 *                      strength, positive-return balance.
 *   2. Volatility:     realized vol, expansion ratio, vol-of-vol,
 *                      Parkinson range vol, ATR-normalized.
 *   3. Range / MR:     ADF-lite, KPSS-lite, OU half-life, range
 *                      stability, lag-1 autocorrelation, variance
 *                      ratio.
 *   4. Disorder:       return entropy, directional entropy, jump
 *                      frequency, outlier concentration, gap
 *                      frequency, data-quality penalty.
 *   5. Contextual:     global market state, Phase 2A fingerprint,
 *                      liquidity flags, quarantine state.
 *
 * No single feature may establish a state. Every state emission
 * documents which evidence rows supported it, which rows argued
 * against it, and which required rows were missing.
 */

export const PRODUCT_REGIME_KEY = 'product.regime_state';
export const PRODUCT_REGIME_VERSION = 'p2b-product-1';
export const PRODUCT_TRANSITION_POLICY_VERSION = 'p2b-transition-1';

export const PRODUCT_DEFINITION: RegimeDefinition = {
  key: PRODUCT_REGIME_KEY,
  version: PRODUCT_REGIME_VERSION,
  scope: 'product',
  description:
    'Deterministic product regime baseline combining direction, volatility, range/MR diagnostics, disorder and contextual signals. Requires quorum across families; single-feature evidence never establishes a state.',
  requiredEvidence: [
    'ms.mean_log_return',
    'ms.stdev_log_return',
    'ms.variance_ratio_q4',
    'ms.trend_efficiency',
    'ms.directional_persistence',
    'vol.realized',
    'vol.expansion_ratio',
    'info.jump_frequency',
    'info.data_quality_penalty',
  ],
  minimumValidEvidence: 6,
  conflictPolicy: 'quorum_with_margin',
  missingDataPolicy: 'unknown_when_below_minimum',
  transitionPolicyVersion: PRODUCT_TRANSITION_POLICY_VERSION,
  status: 'observer',
};

export interface ProductRegimeInput {
  productId: string;
  now: Date;
  dataAvailableAt: Date;
  features: Map<string, FeatureResult>;
  fingerprintClass?: string | null;
  fingerprintSnapshotId?: number | null;
  globalState?: RegimeState | null;
  globalStateId?: number | null;
  hygieneEligible: boolean;
  quarantined?: boolean;
}

interface Signals {
  supporting: RegimeEvidenceItem[];
  conflicting: RegimeEvidenceItem[];
  missing: RegimeEvidenceItem[];
}

function pushSupport(
  s: Signals,
  component: string,
  weight: number,
  detail: string,
): void {
  s.supporting.push({ component, componentVersion: PRODUCT_REGIME_VERSION, role: 'supporting', weight, detail });
}

function pushConflict(
  s: Signals,
  component: string,
  weight: number,
  detail: string,
): void {
  s.conflicting.push({ component, componentVersion: PRODUCT_REGIME_VERSION, role: 'conflicting', weight, detail });
}

function pushMissing(s: Signals, component: string, detail: string): void {
  s.missing.push({ component, componentVersion: PRODUCT_REGIME_VERSION, role: 'missing', weight: 0, detail });
}

function pickValid(map: Map<string, FeatureResult>, key: string): number | null {
  const r = map.get(key);
  if (!r || r.status !== 'valid' || r.value == null) return null;
  return typeof r.value === 'number' ? r.value : null;
}

function pickWithCaveat(map: Map<string, FeatureResult>, key: string): number | null {
  const r = map.get(key);
  if (!r || r.value == null) return null;
  if (r.status !== 'valid' && r.status !== 'low_confidence') return null;
  return typeof r.value === 'number' ? r.value : null;
}

export function evaluateProductRegime(input: ProductRegimeInput): RegimeResult {
  const s: Signals = { supporting: [], conflicting: [], missing: [] };
  const inputHash = hashInput(input);
  const observedAt = input.now;
  const dataAvailableAt = input.dataAvailableAt;

  // Quarantine wins.
  if (input.quarantined) {
    return failRegime('quarantined', PRODUCT_DEFINITION, {
      observedAt,
      dataAvailableAt,
      inputHash,
      failureReason: 'product under active quarantine',
      globalStateId: input.globalStateId ?? null,
      fingerprintSnapshotId: input.fingerprintSnapshotId ?? null,
    });
  }
  if (!input.hygieneEligible) {
    return failRegime('unknown', PRODUCT_DEFINITION, {
      observedAt,
      dataAvailableAt,
      inputHash,
      failureReason: 'product not eligible under hygiene gate',
      globalStateId: input.globalStateId ?? null,
      fingerprintSnapshotId: input.fingerprintSnapshotId ?? null,
    });
  }

  // Check required evidence.
  let validRequired = 0;
  for (const key of PRODUCT_DEFINITION.requiredEvidence) {
    const r = input.features.get(key);
    if (r && r.status === 'valid') validRequired += 1;
    else pushMissing(s, key, r ? `status=${r.status}` : 'absent');
  }
  if (validRequired < PRODUCT_DEFINITION.minimumValidEvidence) {
    return failRegime('insufficient_history', PRODUCT_DEFINITION, {
      observedAt,
      dataAvailableAt,
      inputHash,
      failureReason: `only ${validRequired}/${PRODUCT_DEFINITION.minimumValidEvidence} required features valid`,
      supportingEvidence: s.supporting,
      conflictingEvidence: s.conflicting,
      missingEvidence: s.missing,
      globalStateId: input.globalStateId ?? null,
      fingerprintSnapshotId: input.fingerprintSnapshotId ?? null,
    });
  }

  // Data-quality penalty check → severe → DISORDERED override.
  const dq = pickValid(input.features, 'info.data_quality_penalty');
  const jumpFreq = pickValid(input.features, 'info.jump_frequency');
  const outConc = pickValid(input.features, 'info.outlier_concentration');
  const gapFreq = pickValid(input.features, 'liq.candle_gap_freq');

  const disorderSignals: string[] = [];
  if (dq != null && dq > 0.4) disorderSignals.push(`dq=${dq.toFixed(3)}`);
  if (jumpFreq != null && jumpFreq > 0.02) disorderSignals.push(`jf=${jumpFreq.toFixed(4)}`);
  if (outConc != null && outConc > 0.5) disorderSignals.push(`oc=${outConc.toFixed(3)}`);
  if (gapFreq != null && gapFreq > 0.05) disorderSignals.push(`gap=${gapFreq.toFixed(3)}`);
  // A Phase 2A DISORDERED fingerprint already went through its own multi-family
  // quorum, so we treat it as a sufficient override on its own.
  const fpDisordered = input.fingerprintClass === 'DISORDERED';
  if (fpDisordered) disorderSignals.push('fp=DISORDERED');

  if (disorderSignals.length >= 2 || fpDisordered) {
    pushSupport(s, 'disorder.composite', 0.5, disorderSignals.join(','));
    return validRegime(PRODUCT_DEFINITION, {
      state: 'DISORDERED',
      confidence: 0.55,
      supportingEvidence: s.supporting,
      conflictingEvidence: s.conflicting,
      missingEvidence: s.missing,
      observedAt,
      dataAvailableAt,
      inputHash,
      globalStateId: input.globalStateId ?? null,
      fingerprintSnapshotId: input.fingerprintSnapshotId ?? null,
      diagnostics: { disorderSignals },
    });
  }

  // Score each candidate state.
  const trendUp = trendScore('up', input.features, input.globalState);
  const trendDown = trendScore('down', input.features, input.globalState);
  const range = rangeScore(input.features);
  const volExp = volatilityExpansionScore(input.features);
  const cap = capitulationScore(input.features, input.globalState);

  const scores = [
    { state: 'TREND_UP' as RegimeState, ...trendUp },
    { state: 'TREND_DOWN' as RegimeState, ...trendDown },
    { state: 'RANGE' as RegimeState, ...range },
    { state: 'VOLATILITY_EXPANSION' as RegimeState, ...volExp },
    { state: 'CAPITULATION' as RegimeState, ...cap },
  ];
  const capitulationScored = scores.find((x) => x.state === 'CAPITULATION')!;
  if (capitulationScored.count >= 4) {
    for (const r of capitulationScored.rows) pushSupport(s, r[0], r[1], r[2]);
    return validRegime(PRODUCT_DEFINITION, {
      state: 'CAPITULATION',
      confidence: 0.5 + 0.05 * capitulationScored.count,
      supportingEvidence: s.supporting,
      conflictingEvidence: s.conflicting,
      missingEvidence: s.missing,
      observedAt,
      dataAvailableAt,
      inputHash,
      globalStateId: input.globalStateId ?? null,
      fingerprintSnapshotId: input.fingerprintSnapshotId ?? null,
      diagnostics: { capitulationCount: capitulationScored.count },
    });
  }

  const nonCap = scores.filter((x) => x.state !== 'CAPITULATION');
  nonCap.sort((a, b) => b.count - a.count);
  const top = nonCap[0];
  const runnerUp = nonCap[1];
  const marginOk = top.count - runnerUp.count >= 1;

  if (top.count >= 3 && marginOk) {
    for (const r of top.rows) pushSupport(s, r[0], r[1], r[2]);
    for (const r of runnerUp.rows) pushConflict(s, r[0], r[1], r[2]);
    // Volatility expansion is direction-neutral — never coerce into a trend even if directional votes tie.
    const state = top.state;
    return validRegime(PRODUCT_DEFINITION, {
      state,
      confidence: 0.45 + 0.05 * top.count + 0.05 * (top.count - runnerUp.count),
      supportingEvidence: s.supporting,
      conflictingEvidence: s.conflicting,
      missingEvidence: s.missing,
      observedAt,
      dataAvailableAt,
      inputHash,
      globalStateId: input.globalStateId ?? null,
      fingerprintSnapshotId: input.fingerprintSnapshotId ?? null,
      diagnostics: {
        candidate: state,
        topCount: top.count,
        runnerUp: runnerUp.state,
        runnerUpCount: runnerUp.count,
      },
    });
  }

  // Conflicted / no quorum.
  const rankLine = nonCap.map((x) => `${x.state}=${x.count}`).join(', ');
  return failRegime('conflicted', PRODUCT_DEFINITION, {
    observedAt,
    dataAvailableAt,
    inputHash,
    failureReason: `no directional quorum (${rankLine})`,
    supportingEvidence: s.supporting,
    conflictingEvidence: s.conflicting,
    missingEvidence: s.missing,
    globalStateId: input.globalStateId ?? null,
    fingerprintSnapshotId: input.fingerprintSnapshotId ?? null,
    diagnostics: {
      rankings: nonCap.map((x) => ({ state: x.state, count: x.count })),
    },
  });
}

// ---------------------------------------------------------------------------
// State scorers — each state must combine multiple families.
// ---------------------------------------------------------------------------

function trendScore(
  side: 'up' | 'down',
  features: Map<string, FeatureResult>,
  globalState?: RegimeState | null,
): { count: number; rows: Array<[string, number, string]> } {
  const rows: Array<[string, number, string]> = [];
  const meanR = pickValid(features, 'ms.mean_log_return');
  const persistence = pickValid(features, 'ms.directional_persistence');
  const trendEff = pickValid(features, 'ms.trend_efficiency');
  const posFrac = pickValid(features, 'ms.positive_return_fraction');
  const btcRs = pickValid(features, 'bench.rel_strength_btc');
  const lag1 = pickValid(features, 'ms.return_autocorr_lag1');

  const positive = side === 'up';
  if (meanR != null && (positive ? meanR > 0.0005 : meanR < -0.0005)) {
    rows.push(['direction.mean_log_return', 0.2, `${meanR.toFixed(5)}`]);
  }
  if (persistence != null && persistence > 0.55) {
    rows.push(['direction.persistence', 0.15, `${persistence.toFixed(3)}`]);
  }
  if (trendEff != null && trendEff > 0.35) {
    rows.push(['direction.trend_efficiency', 0.2, `${trendEff.toFixed(3)}`]);
  }
  if (posFrac != null && (positive ? posFrac > 0.55 : posFrac < 0.45)) {
    rows.push(['direction.positive_return_fraction', 0.1, `${posFrac.toFixed(3)}`]);
  }
  if (btcRs != null && (positive ? btcRs > 0.001 : btcRs < -0.001)) {
    rows.push(['direction.relative_strength_btc', 0.1, `${btcRs.toFixed(5)}`]);
  }
  if (lag1 != null && lag1 > 0.05) {
    rows.push(['direction.autocorr_positive', 0.05, `lag1=${lag1.toFixed(3)}`]);
  }
  // Global-state confirmation — supportive but not decisive.
  if (globalState && ((positive && globalState === 'TREND_UP') || (!positive && globalState === 'TREND_DOWN'))) {
    rows.push(['context.global_state', 0.2, `global=${globalState}`]);
  }
  return { count: rows.length, rows };
}

function rangeScore(features: Map<string, FeatureResult>): {
  count: number;
  rows: Array<[string, number, string]>;
} {
  const rows: Array<[string, number, string]> = [];
  const vr = pickValid(features, 'ms.variance_ratio_q4');
  const lag1 = pickValid(features, 'ms.return_autocorr_lag1');
  const adf = pickValid(features, 'stat.adf_lite_tstat');
  const kpss = pickValid(features, 'stat.kpss_lite');
  const ou = pickValid(features, 'stat.ou_half_life_bars');
  const rangeStab = pickValid(features, 'stat.range_stability');
  const trendEff = pickValid(features, 'ms.trend_efficiency');
  const meanR = pickValid(features, 'ms.mean_log_return');

  if (vr != null && vr < 0.95) rows.push(['range.variance_ratio', 0.2, `vr=${vr.toFixed(3)}`]);
  if (lag1 != null && lag1 < 0) rows.push(['range.autocorr_lag1', 0.15, `lag1=${lag1.toFixed(3)}`]);
  if (adf != null && adf < -2.0) rows.push(['range.adf_tstat', 0.2, `t=${adf.toFixed(2)}`]);
  if (kpss != null && kpss < 0.2) rows.push(['range.kpss_low', 0.1, `kpss=${kpss.toFixed(3)}`]);
  if (ou != null && ou > 0 && ou < 1500) rows.push(['range.ou_half_life', 0.15, `hl=${ou.toFixed(1)}`]);
  if (rangeStab != null && rangeStab < 0.4) rows.push(['range.stability', 0.1, `cov=${rangeStab.toFixed(3)}`]);
  if (trendEff != null && trendEff < 0.25) rows.push(['range.low_trend_efficiency', 0.1, `${trendEff.toFixed(3)}`]);
  if (meanR != null && Math.abs(meanR) < 0.0005) rows.push(['range.small_mean_return', 0.1, `${meanR.toFixed(5)}`]);
  return { count: rows.length, rows };
}

function volatilityExpansionScore(features: Map<string, FeatureResult>): {
  count: number;
  rows: Array<[string, number, string]>;
} {
  const rows: Array<[string, number, string]> = [];
  const exp = pickValid(features, 'vol.expansion_ratio');
  const vv = pickValid(features, 'vol.vol_of_vol');
  const parkinson = pickValid(features, 'vol.range_vol');
  const atr = pickValid(features, 'vol.atr_normalized');
  const rv = pickValid(features, 'vol.realized');

  if (exp != null && exp > 1.5) rows.push(['vol.expansion_ratio', 0.3, `${exp.toFixed(3)}`]);
  if (vv != null && vv > 0.02) rows.push(['vol.vol_of_vol', 0.2, `${vv.toFixed(4)}`]);
  if (parkinson != null && rv != null && parkinson > rv) rows.push(['vol.range_gt_close', 0.15, `parkinson=${parkinson.toFixed(4)}`]);
  if (atr != null && atr > 0.02) rows.push(['vol.atr_high', 0.15, `${atr.toFixed(4)}`]);
  if (rv != null && rv > 0.04) rows.push(['vol.rv_elevated', 0.2, `${rv.toFixed(4)}`]);
  return { count: rows.length, rows };
}

function capitulationScore(
  features: Map<string, FeatureResult>,
  globalState?: RegimeState | null,
): { count: number; rows: Array<[string, number, string]> } {
  const rows: Array<[string, number, string]> = [];
  const meanR = pickValid(features, 'ms.mean_log_return');
  const downVol = pickValid(features, 'vol.downside');
  const rv = pickValid(features, 'vol.realized');
  const jump = pickValid(features, 'info.jump_frequency');
  const outlier = pickValid(features, 'info.outlier_concentration');
  const persistence = pickValid(features, 'ms.directional_persistence');
  const posFrac = pickValid(features, 'ms.positive_return_fraction');
  const trendEff = pickValid(features, 'ms.trend_efficiency');

  if (meanR != null && meanR < -0.003) rows.push(['cap.mean_neg', 0.2, `${meanR.toFixed(5)}`]);
  if (downVol != null && rv != null && rv > 0 && downVol / rv > 0.8) rows.push(['cap.downside_dominant', 0.2, `ratio=${(downVol / rv).toFixed(3)}`]);
  if (jump != null && jump > 0.015) rows.push(['cap.jump_freq', 0.15, `${jump.toFixed(4)}`]);
  if (outlier != null && outlier > 0.4) rows.push(['cap.outlier_conc', 0.1, `${outlier.toFixed(3)}`]);
  if (posFrac != null && posFrac < 0.35) rows.push(['cap.pos_frac_low', 0.1, `${posFrac.toFixed(3)}`]);
  if (persistence != null && persistence > 0.55) rows.push(['cap.persistence', 0.1, `${persistence.toFixed(3)}`]);
  if (trendEff != null && trendEff > 0.3) rows.push(['cap.direction_efficiency', 0.05, `${trendEff.toFixed(3)}`]);
  if (globalState === 'CAPITULATION') rows.push(['cap.global_confirmation', 0.2, `global=${globalState}`]);
  return { count: rows.length, rows };
}

function hashInput(input: ProductRegimeInput): string {
  const keys = [...input.features.keys()].sort();
  const parts = keys.map((k) => {
    const r = input.features.get(k)!;
    return [k, typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null, r.status] as const;
  });
  return createHash('sha256')
    .update(
      JSON.stringify({
        pid: input.productId,
        now: input.now.toISOString(),
        globalState: input.globalState ?? null,
        fp: input.fingerprintClass ?? null,
        parts,
        version: PRODUCT_REGIME_VERSION,
      }),
    )
    .digest('hex');
}

/**
 * Unused-but-exposed helper — callers may want to detect whether a
 * result's status is one of the "soft" degraded values worth
 * reporting explicitly.
 */
export function isDegradedRegime(r: RegimeResult): boolean {
  return (
    r.status === 'insufficient_history' ||
    r.status === 'stale' ||
    r.status === 'gap_detected' ||
    r.status === 'conflicted' ||
    r.status === 'quarantined' ||
    r.status === 'unknown'
  );
}

/**
 * Utility for tests: a low-confidence version of pickValid that also
 * lets tests peek at low-confidence features when they need to.
 */
export function _debug_pickWithCaveat(map: Map<string, FeatureResult>, key: string): number | null {
  return pickWithCaveat(map, key);
}
