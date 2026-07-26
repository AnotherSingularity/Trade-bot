import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  fingerprintDefinitions,
  fingerprintEvidence,
  fingerprintSnapshots,
  type FingerprintEvidenceRow,
  type FingerprintSnapshotRow,
} from '../../db/schema';
import type { FeatureResult } from '../features/contract';

/**
 * Phase 2A §K — Fingerprint composer.
 *
 * Consumes the Stage 1 (and optionally Stage 2) feature results for a
 * single product and classifies it into ONE of seven observer classes.
 *
 * Seven classes (§K):
 *   REVERSION_CANDIDATE
 *   BREAKOUT_CANDIDATE
 *   MACRO_FLOOR_RESEARCH_CANDIDATE
 *   RANDOM_OR_NOISY
 *   ILLIQUID
 *   DISORDERED
 *   UNCLASSIFIED
 *
 * Override rules (§K):
 *   ILLIQUID overrides every directional class.
 *   DISORDERED overrides every directional class (jump/gap noise).
 *   Directional classes (REVERSION/BREAKOUT/MACRO) require a QUORUM
 *   of valid supporting evidence; `low_confidence` never contributes.
 *   In the absence of a clean majority the class is UNCLASSIFIED —
 *   no default direction is ever chosen.
 *
 * Evidence roles:
 *   supporting  — a `valid` result that clears the class threshold
 *   conflicting — a `valid` result that argues against the class
 *   missing     — a required feature that was not `valid`
 *
 * NOTE: This classifier is OBSERVER-ONLY. It does not authorize
 * trades, does not resize champion positions, does not reroute
 * strategies. It writes to the fingerprint_snapshots and
 * fingerprint_evidence tables and stops.
 */

export const FINGERPRINT_CLASSIFICATION_VERSION = 'p2a-fingerprint-1';

export type FingerprintClass =
  | 'REVERSION_CANDIDATE'
  | 'BREAKOUT_CANDIDATE'
  | 'MACRO_FLOOR_RESEARCH_CANDIDATE'
  | 'RANDOM_OR_NOISY'
  | 'ILLIQUID'
  | 'DISORDERED'
  | 'UNCLASSIFIED';

export type EvidenceRole = 'supporting' | 'conflicting' | 'missing';

export interface EvidenceItem {
  featureKey: string;
  featureVersion: string;
  role: EvidenceRole;
  featureValueId?: number | null;
  detail?: string;
}

export interface FingerprintDecision {
  fingerprintClass: FingerprintClass;
  confidence: number;
  qualityPenalty: number;
  liquidityPenalty: number;
  state: 'complete' | 'degraded' | 'unresolved';
  evidence: EvidenceItem[];
  classificationVersion: string;
  metadataVersion: string;
  inputHash: string;
  reasonSummary: string;
}

export interface ComposerInput {
  productId: string;
  now: Date;
  results: Map<string, FeatureResult>;
  /** Optional feature-value ids so evidence rows can back-reference them. */
  featureValueIds?: Map<string, number>;
  metadataVersion: string;
}

// ---------------------------------------------------------------------------
// Feature thresholds
// ---------------------------------------------------------------------------

const THRESHOLDS = {
  // Illiquidity signals (any two → ILLIQUID)
  illiquid: {
    quoteVolume: 250_000, // 24h quote volume < this → suspect
    gapFreq: 0.05, // > 5% missing buckets → suspect
    zeroVolFreq: 0.15,
    amihudLog10: -8, // log10(Amihud) > this → highly illiquid
    minOrderNotional: 10, // >$10 min notional → hard to trade small
    spreadBps: 30,
  },
  // Disorder signals (any two → DISORDERED)
  disordered: {
    jumpFreq: 0.02,
    outlierConcentration: 0.5,
    dataQualityPenalty: 0.3,
    dirEntropyMax: 0.4, // very low directional entropy = degenerate series
  },
  // Reversion signals
  reversion: {
    varRatioBelow: 0.9,
    lag1AutocorrBelow: -0.05,
    hurstBelow: 0.45,
    hurstMinConfidence: 0.85,
    adfTstatBelow: -2.5,
    ouHalfLifeMaxBars: 288, // ~1 day at 5-min bars
    ouMinConfidence: 0.5,
  },
  // Breakout / trend signals
  breakout: {
    varRatioAbove: 1.1,
    lag1AutocorrAbove: 0.05,
    hurstAbove: 0.55,
    hurstMinConfidence: 0.85,
    trendEfficiencyAbove: 0.35,
    directionalPersistenceAbove: 0.55,
    expansionRatioAbove: 1.5,
  },
  // Macro-floor: high correlation stability with BTC + low residual vol
  macroFloor: {
    btcCorrAbove: 0.75,
    btcResidualVolMaxRatio: 0.6,
    corrStabilityBelow: 0.4,
  },
} as const;

const REQUIRED_MARKET_STRUCTURE = [
  'ms.stdev_log_return',
  'ms.return_autocorr_lag1',
  'ms.variance_ratio_q4',
  'ms.trend_efficiency',
  'ms.directional_persistence',
];

const REQUIRED_QUALITY = ['info.data_quality_penalty', 'info.jump_frequency'];

const REQUIRED_LIQUIDITY = ['liq.amihud', 'liq.quote_volume_24h'];

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export function composeFingerprint(input: ComposerInput): FingerprintDecision {
  const evidence: EvidenceItem[] = [];
  const push = (
    featureKey: string,
    role: EvidenceRole,
    detail?: string,
  ) => {
    const r = input.results.get(featureKey);
    evidence.push({
      featureKey,
      featureVersion: r?.featureVersion ?? '?',
      role,
      featureValueId: input.featureValueIds?.get(featureKey) ?? null,
      detail,
    });
  };

  const missingCriticals: string[] = [];
  for (const k of [...REQUIRED_MARKET_STRUCTURE, ...REQUIRED_QUALITY, ...REQUIRED_LIQUIDITY]) {
    const r = input.results.get(k);
    if (!r || r.status !== 'valid') {
      missingCriticals.push(k);
      push(k, 'missing', r ? `status=${r.status}` : 'absent');
    }
  }

  const liquidityPenalty = computeLiquidityPenalty(input.results);
  const qualityPenalty = computeQualityPenalty(input.results);
  const inputHash = hashComposerInput(input);

  // -------- Override 1: ILLIQUID --------
  const illiqSignals = illiquiditySignals(input.results, push);
  if (illiqSignals.count >= 2) {
    return finalize({
      fingerprintClass: 'ILLIQUID',
      confidence: clamp01(0.5 + 0.1 * illiqSignals.count),
      qualityPenalty,
      liquidityPenalty,
      state: 'complete',
      evidence,
      metadataVersion: input.metadataVersion,
      inputHash,
      reasonSummary: `illiquid_signals=${illiqSignals.count}: ${illiqSignals.reasons.join(',')}`,
    });
  }

  // -------- Override 2: DISORDERED --------
  const disorderSignals = disorderSignalsFn(input.results, push);
  if (disorderSignals.count >= 2) {
    return finalize({
      fingerprintClass: 'DISORDERED',
      confidence: clamp01(0.5 + 0.1 * disorderSignals.count),
      qualityPenalty,
      liquidityPenalty,
      state: 'complete',
      evidence,
      metadataVersion: input.metadataVersion,
      inputHash,
      reasonSummary: `disorder_signals=${disorderSignals.count}: ${disorderSignals.reasons.join(',')}`,
    });
  }

  // -------- Missing critical evidence → UNCLASSIFIED --------
  if (missingCriticals.length > 0) {
    return finalize({
      fingerprintClass: 'UNCLASSIFIED',
      confidence: 0,
      qualityPenalty,
      liquidityPenalty,
      state: 'unresolved',
      evidence,
      metadataVersion: input.metadataVersion,
      inputHash,
      reasonSummary: `missing_critical:${missingCriticals.join(',')}`,
    });
  }

  // -------- Directional quorum --------
  const rev = reversionSignals(input.results, push);
  const bo = breakoutSignals(input.results, push);
  const macro = macroFloorSignals(input.results, push);

  const scores = [
    { klass: 'REVERSION_CANDIDATE' as const, count: rev.count, reasons: rev.reasons },
    { klass: 'BREAKOUT_CANDIDATE' as const, count: bo.count, reasons: bo.reasons },
    { klass: 'MACRO_FLOOR_RESEARCH_CANDIDATE' as const, count: macro.count, reasons: macro.reasons },
  ].sort((a, b) => b.count - a.count);

  const top = scores[0];
  const second = scores[1];
  const marginOk = top.count - second.count >= 1;

  if (top.count >= 3 && marginOk) {
    return finalize({
      fingerprintClass: top.klass,
      confidence: clamp01(0.4 + 0.1 * (top.count - second.count) + 0.05 * top.count),
      qualityPenalty,
      liquidityPenalty,
      state: 'complete',
      evidence,
      metadataVersion: input.metadataVersion,
      inputHash,
      reasonSummary: `${top.klass.toLowerCase()}_quorum=${top.count} (over ${second.count}): ${top.reasons.join(',')}`,
    });
  }

  // -------- Random-or-noisy fallback --------
  const noisy = randomNoisySignals(input.results, push);
  if (noisy.count >= 3) {
    return finalize({
      fingerprintClass: 'RANDOM_OR_NOISY',
      confidence: 0.5,
      qualityPenalty,
      liquidityPenalty,
      state: 'complete',
      evidence,
      metadataVersion: input.metadataVersion,
      inputHash,
      reasonSummary: `random_noise_signals=${noisy.count}: ${noisy.reasons.join(',')}`,
    });
  }

  return finalize({
    fingerprintClass: 'UNCLASSIFIED',
    confidence: 0,
    qualityPenalty,
    liquidityPenalty,
    state: 'unresolved',
    evidence,
    metadataVersion: input.metadataVersion,
    inputHash,
    reasonSummary: `no_class_quorum: rev=${rev.count} bo=${bo.count} macro=${macro.count}`,
  });
}

function finalize(base: Omit<FingerprintDecision, 'classificationVersion'>): FingerprintDecision {
  return {
    ...base,
    classificationVersion: FINGERPRINT_CLASSIFICATION_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Signal counters
// ---------------------------------------------------------------------------

interface SignalSet {
  count: number;
  reasons: string[];
}

function pickValid(results: Map<string, FeatureResult>, key: string): number | null {
  const r = results.get(key);
  if (!r || r.status !== 'valid' || r.value == null) return null;
  return typeof r.value === 'number' ? r.value : null;
}

function illiquiditySignals(
  results: Map<string, FeatureResult>,
  push: (k: string, role: EvidenceRole, detail?: string) => void,
): SignalSet {
  const reasons: string[] = [];
  let count = 0;

  const qvol = pickValid(results, 'liq.quote_volume_24h');
  if (qvol != null && qvol < THRESHOLDS.illiquid.quoteVolume) {
    count += 1;
    reasons.push(`quote_vol<${THRESHOLDS.illiquid.quoteVolume}`);
    push('liq.quote_volume_24h', 'supporting', `${qvol}`);
  } else if (qvol != null) {
    push('liq.quote_volume_24h', 'conflicting', `${qvol}`);
  }

  const gap = pickValid(results, 'liq.candle_gap_freq');
  if (gap != null && gap > THRESHOLDS.illiquid.gapFreq) {
    count += 1;
    reasons.push(`gap_freq>${THRESHOLDS.illiquid.gapFreq}`);
    push('liq.candle_gap_freq', 'supporting', `${gap.toFixed(3)}`);
  }

  const zv = pickValid(results, 'liq.zero_volume_freq');
  if (zv != null && zv > THRESHOLDS.illiquid.zeroVolFreq) {
    count += 1;
    reasons.push(`zero_vol_freq>${THRESHOLDS.illiquid.zeroVolFreq}`);
    push('liq.zero_volume_freq', 'supporting', `${zv.toFixed(3)}`);
  }

  const amihud = pickValid(results, 'liq.amihud');
  if (amihud != null && amihud > 0) {
    const log10Amihud = Math.log10(amihud);
    if (log10Amihud > THRESHOLDS.illiquid.amihudLog10) {
      count += 1;
      reasons.push(`amihud_log10>${THRESHOLDS.illiquid.amihudLog10}`);
      push('liq.amihud', 'supporting', `log10=${log10Amihud.toFixed(2)}`);
    } else {
      push('liq.amihud', 'conflicting', `log10=${log10Amihud.toFixed(2)}`);
    }
  }

  const minOrd = pickValid(results, 'liq.min_order_notional_quote');
  if (minOrd != null && minOrd > THRESHOLDS.illiquid.minOrderNotional) {
    count += 1;
    reasons.push(`min_order>${THRESHOLDS.illiquid.minOrderNotional}`);
    push('liq.min_order_notional_quote', 'supporting', `${minOrd}`);
  }

  const spread = pickValid(results, 'liq.spread_bps');
  if (spread != null && spread > THRESHOLDS.illiquid.spreadBps) {
    count += 1;
    reasons.push(`spread_bps>${THRESHOLDS.illiquid.spreadBps}`);
    push('liq.spread_bps', 'supporting', `${spread}`);
  }

  return { count, reasons };
}

function disorderSignalsFn(
  results: Map<string, FeatureResult>,
  push: (k: string, role: EvidenceRole, detail?: string) => void,
): SignalSet {
  const reasons: string[] = [];
  let count = 0;

  const jf = pickValid(results, 'info.jump_frequency');
  if (jf != null && jf > THRESHOLDS.disordered.jumpFreq) {
    count += 1;
    reasons.push(`jump_freq>${THRESHOLDS.disordered.jumpFreq}`);
    push('info.jump_frequency', 'supporting', `${jf.toFixed(4)}`);
  }

  const oc = pickValid(results, 'info.outlier_concentration');
  if (oc != null && oc > THRESHOLDS.disordered.outlierConcentration) {
    count += 1;
    reasons.push(`outlier_conc>${THRESHOLDS.disordered.outlierConcentration}`);
    push('info.outlier_concentration', 'supporting', `${oc.toFixed(3)}`);
  }

  const dq = pickValid(results, 'info.data_quality_penalty');
  if (dq != null && dq > THRESHOLDS.disordered.dataQualityPenalty) {
    count += 1;
    reasons.push(`data_quality>${THRESHOLDS.disordered.dataQualityPenalty}`);
    push('info.data_quality_penalty', 'supporting', `${dq.toFixed(3)}`);
  }

  const de = pickValid(results, 'info.directional_entropy_bits');
  if (de != null && de < THRESHOLDS.disordered.dirEntropyMax) {
    count += 1;
    reasons.push(`dir_entropy<${THRESHOLDS.disordered.dirEntropyMax}`);
    push('info.directional_entropy_bits', 'supporting', `${de.toFixed(3)}`);
  }

  return { count, reasons };
}

function reversionSignals(
  results: Map<string, FeatureResult>,
  push: (k: string, role: EvidenceRole, detail?: string) => void,
): SignalSet {
  const reasons: string[] = [];
  let count = 0;

  const vr = pickValid(results, 'ms.variance_ratio_q4');
  if (vr != null && vr < THRESHOLDS.reversion.varRatioBelow) {
    count += 1;
    reasons.push(`vr<${THRESHOLDS.reversion.varRatioBelow}`);
    push('ms.variance_ratio_q4', 'supporting', `vr=${vr.toFixed(3)}`);
  } else if (vr != null) {
    push('ms.variance_ratio_q4', 'conflicting', `vr=${vr.toFixed(3)}`);
  }

  const ac = pickValid(results, 'ms.return_autocorr_lag1');
  if (ac != null && ac < THRESHOLDS.reversion.lag1AutocorrBelow) {
    count += 1;
    reasons.push(`lag1_ac<${THRESHOLDS.reversion.lag1AutocorrBelow}`);
    push('ms.return_autocorr_lag1', 'supporting', `ac=${ac.toFixed(3)}`);
  }

  // Hurst must be VALID and confidence must meet the threshold — never
  // read a low_confidence Hurst as a persistence claim.
  const hurstR = results.get('ms.hurst_rs');
  if (hurstR && hurstR.status === 'valid' && hurstR.value != null && hurstR.confidence >= THRESHOLDS.reversion.hurstMinConfidence) {
    const h = hurstR.value as number;
    if (h < THRESHOLDS.reversion.hurstBelow) {
      count += 1;
      reasons.push(`hurst<${THRESHOLDS.reversion.hurstBelow}`);
      push('ms.hurst_rs', 'supporting', `h=${h.toFixed(3)}`);
    }
  } else if (hurstR) {
    push('ms.hurst_rs', 'missing', `status=${hurstR.status} conf=${hurstR.confidence}`);
  }

  // Stage 2 corroboration
  const adf = pickValid(results, 'stat.adf_lite_tstat');
  if (adf != null && adf < THRESHOLDS.reversion.adfTstatBelow) {
    count += 1;
    reasons.push(`adf_t<${THRESHOLDS.reversion.adfTstatBelow}`);
    push('stat.adf_lite_tstat', 'supporting', `t=${adf.toFixed(2)}`);
  }

  const ouR = results.get('stat.ou_half_life_bars');
  if (ouR && ouR.status === 'valid' && ouR.value != null && ouR.confidence >= THRESHOLDS.reversion.ouMinConfidence) {
    const hl = ouR.value as number;
    if (hl > 0 && hl < THRESHOLDS.reversion.ouHalfLifeMaxBars) {
      count += 1;
      reasons.push(`ou_hl<${THRESHOLDS.reversion.ouHalfLifeMaxBars}`);
      push('stat.ou_half_life_bars', 'supporting', `hl=${hl.toFixed(1)}`);
    }
  }

  return { count, reasons };
}

function breakoutSignals(
  results: Map<string, FeatureResult>,
  push: (k: string, role: EvidenceRole, detail?: string) => void,
): SignalSet {
  const reasons: string[] = [];
  let count = 0;

  const vr = pickValid(results, 'ms.variance_ratio_q4');
  if (vr != null && vr > THRESHOLDS.breakout.varRatioAbove) {
    count += 1;
    reasons.push(`vr>${THRESHOLDS.breakout.varRatioAbove}`);
    push('ms.variance_ratio_q4', 'supporting', `vr=${vr.toFixed(3)}`);
  }

  const ac = pickValid(results, 'ms.return_autocorr_lag1');
  if (ac != null && ac > THRESHOLDS.breakout.lag1AutocorrAbove) {
    count += 1;
    reasons.push(`lag1_ac>${THRESHOLDS.breakout.lag1AutocorrAbove}`);
    push('ms.return_autocorr_lag1', 'supporting', `ac=${ac.toFixed(3)}`);
  }

  const hurstR = results.get('ms.hurst_rs');
  if (hurstR && hurstR.status === 'valid' && hurstR.value != null && hurstR.confidence >= THRESHOLDS.breakout.hurstMinConfidence) {
    const h = hurstR.value as number;
    if (h > THRESHOLDS.breakout.hurstAbove) {
      count += 1;
      reasons.push(`hurst>${THRESHOLDS.breakout.hurstAbove}`);
      push('ms.hurst_rs', 'supporting', `h=${h.toFixed(3)}`);
    }
  }

  const te = pickValid(results, 'ms.trend_efficiency');
  if (te != null && te > THRESHOLDS.breakout.trendEfficiencyAbove) {
    count += 1;
    reasons.push(`trend_eff>${THRESHOLDS.breakout.trendEfficiencyAbove}`);
    push('ms.trend_efficiency', 'supporting', `${te.toFixed(3)}`);
  }

  const dp = pickValid(results, 'ms.directional_persistence');
  if (dp != null && dp > THRESHOLDS.breakout.directionalPersistenceAbove) {
    count += 1;
    reasons.push(`dir_pers>${THRESHOLDS.breakout.directionalPersistenceAbove}`);
    push('ms.directional_persistence', 'supporting', `${dp.toFixed(3)}`);
  }

  const er = pickValid(results, 'vol.expansion_ratio');
  if (er != null && er > THRESHOLDS.breakout.expansionRatioAbove) {
    count += 1;
    reasons.push(`exp_ratio>${THRESHOLDS.breakout.expansionRatioAbove}`);
    push('vol.expansion_ratio', 'supporting', `${er.toFixed(3)}`);
  }

  return { count, reasons };
}

function macroFloorSignals(
  results: Map<string, FeatureResult>,
  push: (k: string, role: EvidenceRole, detail?: string) => void,
): SignalSet {
  const reasons: string[] = [];
  let count = 0;

  const corr = pickValid(results, 'bench.btc_corr');
  if (corr != null && Math.abs(corr) > THRESHOLDS.macroFloor.btcCorrAbove) {
    count += 1;
    reasons.push(`|btc_corr|>${THRESHOLDS.macroFloor.btcCorrAbove}`);
    push('bench.btc_corr', 'supporting', `${corr.toFixed(3)}`);
  }

  const rv = pickValid(results, 'bench.btc_residual_vol');
  const ownVol = pickValid(results, 'vol.realized');
  if (rv != null && ownVol != null && ownVol > 0) {
    const ratio = rv / ownVol;
    if (ratio < THRESHOLDS.macroFloor.btcResidualVolMaxRatio) {
      count += 1;
      reasons.push(`resid/vol<${THRESHOLDS.macroFloor.btcResidualVolMaxRatio}`);
      push('bench.btc_residual_vol', 'supporting', `ratio=${ratio.toFixed(3)}`);
    }
  }

  const stab = pickValid(results, 'stat.btc_corr_stability');
  if (stab != null && stab < THRESHOLDS.macroFloor.corrStabilityBelow) {
    count += 1;
    reasons.push(`corr_stab<${THRESHOLDS.macroFloor.corrStabilityBelow}`);
    push('stat.btc_corr_stability', 'supporting', `${stab.toFixed(3)}`);
  }

  return { count, reasons };
}

function randomNoisySignals(
  results: Map<string, FeatureResult>,
  push: (k: string, role: EvidenceRole, detail?: string) => void,
): SignalSet {
  const reasons: string[] = [];
  let count = 0;

  const vr = results.get('ms.variance_ratio_q4');
  if (vr && (vr.status === 'valid' || vr.status === 'low_confidence') && vr.value != null) {
    const v = vr.value as number;
    if (Math.abs(v - 1) < 0.1 || vr.status === 'low_confidence') {
      count += 1;
      reasons.push('vr_near_1_or_low_conf');
      push('ms.variance_ratio_q4', 'supporting', `vr=${v.toFixed(3)} status=${vr.status}`);
    }
  }

  const ac = pickValid(results, 'ms.return_autocorr_lag1');
  if (ac != null && Math.abs(ac) < 0.05) {
    count += 1;
    reasons.push('|lag1_ac|<0.05');
    push('ms.return_autocorr_lag1', 'supporting', `ac=${ac.toFixed(3)}`);
  }

  const entropy = pickValid(results, 'info.return_entropy_bits');
  if (entropy != null && entropy > 2.7) {
    count += 1;
    reasons.push('entropy_near_max');
    push('info.return_entropy_bits', 'supporting', `${entropy.toFixed(3)}`);
  }

  const te = pickValid(results, 'ms.trend_efficiency');
  if (te != null && te < 0.2) {
    count += 1;
    reasons.push('trend_eff<0.2');
    push('ms.trend_efficiency', 'supporting', `${te.toFixed(3)}`);
  }

  return { count, reasons };
}

// ---------------------------------------------------------------------------
// Penalty scoring
// ---------------------------------------------------------------------------

function computeLiquidityPenalty(results: Map<string, FeatureResult>): number {
  let p = 0;
  const qvol = pickValid(results, 'liq.quote_volume_24h');
  if (qvol != null && qvol < 1_000_000) p += 0.2;
  const gap = pickValid(results, 'liq.candle_gap_freq');
  if (gap != null) p += Math.min(0.3, gap);
  const zv = pickValid(results, 'liq.zero_volume_freq');
  if (zv != null) p += Math.min(0.3, zv);
  const spread = pickValid(results, 'liq.spread_bps');
  if (spread != null) p += Math.min(0.2, spread / 200);
  return clamp01(p);
}

function computeQualityPenalty(results: Map<string, FeatureResult>): number {
  const dq = pickValid(results, 'info.data_quality_penalty');
  if (dq != null) return clamp01(dq);
  return 0.5;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function hashComposerInput(input: ComposerInput): string {
  const parts: Array<[string, number | null, string]> = [];
  const keys = [...input.results.keys()].sort();
  for (const k of keys) {
    const r = input.results.get(k)!;
    const v = typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null;
    parts.push([k, v, `${r.status}:${r.featureVersion}`]);
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        productId: input.productId,
        metadataVersion: input.metadataVersion,
        classificationVersion: FINGERPRINT_CLASSIFICATION_VERSION,
        parts,
      }),
    )
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Fingerprint definition + persistence
// ---------------------------------------------------------------------------

export async function ensureFingerprintDefinition(): Promise<void> {
  const existing = await db
    .select()
    .from(fingerprintDefinitions)
    .where(eq(fingerprintDefinitions.classificationVersion, FINGERPRINT_CLASSIFICATION_VERSION))
    .limit(1);
  if (existing.length > 0) return;
  await db.insert(fingerprintDefinitions).values({
    classificationVersion: FINGERPRINT_CLASSIFICATION_VERSION,
    description:
      'Seven-class observer fingerprint composer. ILLIQUID and DISORDERED override directional classes; directional classes require a quorum of valid supporting features; low_confidence never counts as valid; missing critical features force UNCLASSIFIED.',
    requiredFeatures: JSON.stringify([
      ...REQUIRED_MARKET_STRUCTURE,
      ...REQUIRED_QUALITY,
      ...REQUIRED_LIQUIDITY,
    ]),
    overrideRules:
      'ILLIQUID > DISORDERED > REVERSION|BREAKOUT|MACRO (with quorum) > RANDOM_OR_NOISY > UNCLASSIFIED',
    implementationVersion: FINGERPRINT_CLASSIFICATION_VERSION,
    status: 'observer',
  });
}

export interface PersistFingerprintInput {
  snapshotId: number;
  productId: string;
  now: Date;
  dataAvailableAt: Date;
  decision: FingerprintDecision;
}

export async function persistFingerprint(
  input: PersistFingerprintInput,
): Promise<{ snapshot: FingerprintSnapshotRow; evidence: FingerprintEvidenceRow[] }> {
  const d = input.decision;
  const [{ insertId }] = (await db.insert(fingerprintSnapshots).values({
    snapshotId: input.snapshotId,
    productId: input.productId,
    fingerprintClass: d.fingerprintClass,
    confidence: d.confidence.toFixed(4),
    qualityPenalty: d.qualityPenalty.toFixed(4),
    liquidityPenalty: d.liquidityPenalty.toFixed(4),
    classificationVersion: d.classificationVersion,
    metadataVersion: d.metadataVersion,
    inputHash: d.inputHash,
    observedAt: input.now,
    dataAvailableAt: input.dataAvailableAt,
    state: d.state,
  })) as unknown as { insertId: number }[];
  const [snapshot] = await db
    .select()
    .from(fingerprintSnapshots)
    .where(eq(fingerprintSnapshots.id, insertId))
    .limit(1);
  const evidence: FingerprintEvidenceRow[] = [];
  for (const e of d.evidence) {
    await db.insert(fingerprintEvidence).values({
      fingerprintId: insertId,
      featureKey: e.featureKey,
      featureVersion: e.featureVersion,
      role: e.role,
      featureValueId: e.featureValueId ?? null,
    });
    const row = await db
      .select()
      .from(fingerprintEvidence)
      .where(
        and(
          eq(fingerprintEvidence.fingerprintId, insertId),
          eq(fingerprintEvidence.featureKey, e.featureKey),
          eq(fingerprintEvidence.role, e.role),
        ),
      )
      .limit(1);
    if (row[0]) evidence.push(row[0]);
  }
  return { snapshot: snapshot!, evidence };
}
