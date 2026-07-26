/**
 * Phase 2A §G — Stage 1 feature catalog.
 *
 * Stage-1 features run against every eligible product. They must be
 * cheap, deterministic, and honest:
 *   - Every calculator returns a `FeatureResult`.
 *   - No shortcut interpretations ("Hurst > 0.5 = trend", zero on
 *     failure, etc.).
 *   - Benchmark relationships require aligned inputs; missing candles
 *     are dropped, never zero-filled.
 *
 * The catalog is grouped into families:
 *   - market structure   (log-return statistics + shape descriptors)
 *   - volatility         (realized, downside, range, ATR-like, expansion)
 *   - liquidity          (spread, quote volume, trade count, Amihud,
 *                         turnover stability, gaps, zero-volume,
 *                         increment burden, min-order burden)
 *   - information/disorder (return entropy, directional entropy,
 *                           jump frequency, outlier concentration,
 *                           serial-dependence diagnostic, quality
 *                           penalty)
 *   - benchmarks         (BTC/ETH beta, correlation, residual vol,
 *                         relative strength)
 *
 * Every feature is versioned. Bumping the calculator's semantics
 * REQUIRES bumping `version` — the DB uniqueness on (featureKey,
 * featureVersion) turns silent behavior changes into hard errors.
 */

import {
  type FeatureDefinition,
  type FeatureResult,
  failResult,
  validResult,
} from './contract';
import {
  type CandleBar,
  type FeatureInputBundle,
  alignedSeries,
  hashCandleWindow,
  visibleFinalizedBars,
} from './inputs';
import {
  autocorrelation,
  correlation,
  hurstRs,
  mean,
  medianAbsDev,
  olsBeta,
  residualStdev,
  shannonEntropyBits,
  stdev,
  varianceRatio,
  logReturns,
} from './math';

export const STAGE1_IMPLEMENTATION_VERSION = 'p2a-stage1-1';

// ---------------------------------------------------------------------------
// Common preflight
// ---------------------------------------------------------------------------

interface Preflight {
  bars: CandleBar[];
  closes: number[];
  returns: number[];
  lookbackStart: Date;
  lookbackEnd: Date;
  inputHash: string;
}

/**
 * Shared preflight. Returns either a Preflight or a failure result the
 * caller should return directly. This centralizes:
 *   - honesty barrier (no future-visible bars),
 *   - minimum sample count,
 *   - price positivity,
 *   - deterministic input hash.
 */
function preflight(
  def: FeatureDefinition,
  bundle: FeatureInputBundle,
  minBars: number,
): Preflight | FeatureResult {
  const bars = visibleFinalizedBars(bundle.bars, bundle.now);
  const inputHash = hashCandleWindow(bars, {
    key: def.key,
    version: def.version,
    productId: bundle.productId,
    now: bundle.now.toISOString(),
  });
  if (bars.length < minBars) {
    return failResult('insufficient_history', def, {
      dataAvailableAt: bundle.now,
      inputHash,
      sampleCount: bars.length,
      failureReason: `have ${bars.length} bars, need ${minBars}`,
    });
  }
  const closes = bars.map((b) => b.close);
  if (closes.some((c) => !(c > 0))) {
    return failResult('invalid_input', def, {
      dataAvailableAt: bundle.now,
      inputHash,
      sampleCount: bars.length,
      lookbackStart: bars[0].bucketStart,
      lookbackEnd: bars[bars.length - 1].bucketStart,
      failureReason: 'non-positive close price in window',
    });
  }
  const returns = logReturns(closes);
  if (returns.length < minBars - 1 || returns.some((r) => !Number.isFinite(r))) {
    return failResult('numerical_failure', def, {
      dataAvailableAt: bundle.now,
      inputHash,
      sampleCount: returns.length,
      lookbackStart: bars[0].bucketStart,
      lookbackEnd: bars[bars.length - 1].bucketStart,
      failureReason: 'log return produced non-finite values',
    });
  }
  return {
    bars,
    closes,
    returns,
    lookbackStart: bars[0].bucketStart,
    lookbackEnd: bars[bars.length - 1].bucketStart,
    inputHash,
  };
}

// ---------------------------------------------------------------------------
// Feature definitions + calculators
// ---------------------------------------------------------------------------

export interface Stage1Feature {
  def: FeatureDefinition;
  compute(bundle: FeatureInputBundle): FeatureResult;
}

function def(
  base: Omit<FeatureDefinition, 'implementationVersion' | 'stage' | 'status'>,
): FeatureDefinition {
  return {
    ...base,
    implementationVersion: STAGE1_IMPLEMENTATION_VERSION,
    stage: 'stage_1',
    status: 'observer',
  };
}

// ---------------------------------------------------------------------------
// Market structure
// ---------------------------------------------------------------------------

const MIN_RETURNS = 96; // 8h at 5-min bars is enough for baseline stats

export const meanLogReturnFeature: Stage1Feature = {
  def: def({
    key: 'ms.mean_log_return',
    version: '1',
    description: 'Sample mean of consecutive log returns over the visible window.',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'signed_scalar',
    unit: 'log_return',
    validRangeMin: -0.5,
    validRangeMax: 0.5,
    missingDataPolicy: 'drop gapped buckets before hashing',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    const m = mean(pf.returns);
    return validResult(this.def, {
      value: m,
      confidence: 1,
      sampleCount: pf.returns.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const stdevLogReturnFeature: Stage1Feature = {
  def: def({
    key: 'ms.stdev_log_return',
    version: '1',
    description: 'Sample standard deviation of consecutive log returns.',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'scalar',
    unit: 'log_return',
    validRangeMin: 0,
    validRangeMax: 1,
    missingDataPolicy: 'drop gapped buckets before hashing',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    const s = stdev(pf.returns);
    return validResult(this.def, {
      value: s,
      confidence: 1,
      sampleCount: pf.returns.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const positiveReturnFractionFeature: Stage1Feature = {
  def: def({
    key: 'ms.positive_return_fraction',
    version: '1',
    description: 'Fraction of returns that are strictly positive.',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'ratio',
    unit: 'ratio',
    validRangeMin: 0,
    validRangeMax: 1,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    const pos = pf.returns.filter((r) => r > 0).length;
    return validResult(this.def, {
      value: pos / pf.returns.length,
      confidence: 1,
      sampleCount: pf.returns.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const rollingAutocorrelationFeature: Stage1Feature = {
  def: def({
    key: 'ms.return_autocorr_lag1',
    version: '1',
    description: 'Lag-1 autocorrelation of log returns.',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'signed_scalar',
    unit: 'correlation',
    validRangeMin: -1,
    validRangeMax: 1,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    const ac = autocorrelation(pf.returns, 1);
    if (!Number.isFinite(ac)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.returns.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'autocorrelation undefined',
      });
    }
    return validResult(this.def, {
      value: ac,
      confidence: 1,
      sampleCount: pf.returns.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const varianceRatioFeature: Stage1Feature = {
  def: def({
    key: 'ms.variance_ratio_q4',
    version: '1',
    description:
      'Lo–MacKinlay variance ratio at q=4 with asymptotic SE. Low_confidence when |VR-1| < 2*SE.',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: 128,
    outputType: 'scalar',
    unit: 'ratio',
    validRangeMin: 0,
    validRangeMax: 5,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, 129);
    if ('status' in pf) return pf;
    const vr = varianceRatio(pf.returns, 4);
    if (!Number.isFinite(vr.vr)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.returns.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'variance ratio undefined',
      });
    }
    const noiseBand = 2 * vr.standardError;
    const insideBand = Math.abs(vr.vr - 1) < noiseBand;
    return validResult(this.def, {
      value: vr.vr,
      confidence: insideBand ? 0.4 : 1,
      sampleCount: pf.returns.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
      lowConfidence: insideBand,
      lowConfidenceReason: insideBand ? '|VR-1| < 2*SE — indistinguishable from random walk' : undefined,
      diagnostics: { q: vr.q, se: vr.standardError, noiseBand },
    });
  },
};

export const hurstFeature: Stage1Feature = {
  def: def({
    key: 'ms.hurst_rs',
    version: '1',
    description:
      'R/S rescaled-range Hurst estimator. Emits low_confidence when the log-log fit R² < 0.85. Never interprets H alone as "trending" — see §H.',
    inputRequirements: 'finalized close-price candles (>=256 returns)',
    lookbackMs: 0,
    minimumSampleCount: 256,
    outputType: 'scalar',
    unit: 'hurst',
    validRangeMin: 0,
    validRangeMax: 1,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, 257);
    if ('status' in pf) return pf;
    const h = hurstRs(pf.returns);
    if (!Number.isFinite(h.H) || !Number.isFinite(h.r2)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.returns.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'Hurst R/S fit failed',
      });
    }
    const lowConfidence = h.r2 < 0.85;
    return validResult(this.def, {
      value: h.H,
      confidence: lowConfidence ? Math.max(0, h.r2) : 1,
      sampleCount: pf.returns.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
      lowConfidence,
      lowConfidenceReason: lowConfidence
        ? `R/S fit R²=${h.r2.toFixed(3)} < 0.85 — Hurst is not a reliable persistence indicator here`
        : undefined,
      diagnostics: {
        r2: h.r2,
        intercept: h.intercept,
        scales: h.scales,
      },
    });
  },
};

export const trendEfficiencyFeature: Stage1Feature = {
  def: def({
    key: 'ms.trend_efficiency',
    version: '1',
    description:
      'Kaufman efficiency ratio: |close_end - close_start| / sum(|Δclose|). Range [0,1], 1 = pure straight line.',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'ratio',
    unit: 'ratio',
    validRangeMin: 0,
    validRangeMax: 1,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    const first = pf.closes[0];
    const last = pf.closes[pf.closes.length - 1];
    let denom = 0;
    for (let i = 1; i < pf.closes.length; i += 1) denom += Math.abs(pf.closes[i] - pf.closes[i - 1]);
    if (!(denom > 0)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.closes.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'zero-motion series (all closes equal)',
      });
    }
    return validResult(this.def, {
      value: Math.abs(last - first) / denom,
      confidence: 1,
      sampleCount: pf.closes.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const rangeEfficiencyFeature: Stage1Feature = {
  def: def({
    key: 'ms.range_efficiency',
    version: '1',
    description: 'Close-to-close range / high-low range over the window (bounded [0,1]).',
    inputRequirements: 'finalized OHLC candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'ratio',
    unit: 'ratio',
    validRangeMin: 0,
    validRangeMax: 1,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    const closeRange = Math.abs(pf.closes[pf.closes.length - 1] - pf.closes[0]);
    let hi = -Infinity;
    let lo = Infinity;
    for (const b of pf.bars) {
      if (b.high > hi) hi = b.high;
      if (b.low < lo) lo = b.low;
    }
    const denom = hi - lo;
    if (!(denom > 0)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.bars.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'zero-range series (high == low across the window)',
      });
    }
    return validResult(this.def, {
      value: Math.min(1, closeRange / denom),
      confidence: 1,
      sampleCount: pf.bars.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const directionalPersistenceFeature: Stage1Feature = {
  def: def({
    key: 'ms.directional_persistence',
    version: '1',
    description: 'Fraction of consecutive-return-pairs that share sign.',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'ratio',
    unit: 'ratio',
    validRangeMin: 0,
    validRangeMax: 1,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    let same = 0;
    let total = 0;
    for (let i = 1; i < pf.returns.length; i += 1) {
      const a = pf.returns[i - 1];
      const b = pf.returns[i];
      if (a === 0 || b === 0) continue;
      total += 1;
      if ((a > 0) === (b > 0)) same += 1;
    }
    if (total === 0) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.returns.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'all returns are zero',
      });
    }
    return validResult(this.def, {
      value: same / total,
      confidence: 1,
      sampleCount: total,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

// ---------------------------------------------------------------------------
// Volatility
// ---------------------------------------------------------------------------

export const realizedVolFeature: Stage1Feature = {
  def: def({
    key: 'vol.realized',
    version: '1',
    description: 'Realized volatility = sqrt(sum(r^2)) over the window.',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'scalar',
    unit: 'log_return',
    validRangeMin: 0,
    validRangeMax: 5,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    let s = 0;
    for (const r of pf.returns) s += r * r;
    return validResult(this.def, {
      value: Math.sqrt(s),
      confidence: 1,
      sampleCount: pf.returns.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const downsideVolFeature: Stage1Feature = {
  def: def({
    key: 'vol.downside',
    version: '1',
    description: 'Downside realized volatility (only negative returns contribute).',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'scalar',
    unit: 'log_return',
    validRangeMin: 0,
    validRangeMax: 5,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    let s = 0;
    for (const r of pf.returns) if (r < 0) s += r * r;
    return validResult(this.def, {
      value: Math.sqrt(s),
      confidence: 1,
      sampleCount: pf.returns.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const volOfVolFeature: Stage1Feature = {
  def: def({
    key: 'vol.vol_of_vol',
    version: '1',
    description: 'Standard deviation of rolling-8 realized-vol snapshots.',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: 128,
    outputType: 'scalar',
    unit: 'log_return',
    validRangeMin: 0,
    validRangeMax: 5,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, 129);
    if ('status' in pf) return pf;
    const window = 8;
    const rolls: number[] = [];
    for (let i = window; i <= pf.returns.length; i += 1) {
      const slice = pf.returns.slice(i - window, i);
      let s = 0;
      for (const r of slice) s += r * r;
      rolls.push(Math.sqrt(s));
    }
    if (rolls.length < 8) {
      return failResult('insufficient_history', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: rolls.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'not enough rolling snapshots',
      });
    }
    return validResult(this.def, {
      value: stdev(rolls),
      confidence: 1,
      sampleCount: rolls.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const highLowRangeVolFeature: Stage1Feature = {
  def: def({
    key: 'vol.range_vol',
    version: '1',
    description: 'Parkinson high-low range volatility estimator.',
    inputRequirements: 'finalized OHLC candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'scalar',
    unit: 'log_return',
    validRangeMin: 0,
    validRangeMax: 5,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    let s = 0;
    for (const b of pf.bars) {
      if (!(b.high > 0) || !(b.low > 0)) {
        return failResult('invalid_input', this.def, {
          dataAvailableAt: bundle.now,
          inputHash: pf.inputHash,
          sampleCount: pf.bars.length,
          lookbackStart: pf.lookbackStart,
          lookbackEnd: pf.lookbackEnd,
          failureReason: 'non-positive high or low',
        });
      }
      const l = Math.log(b.high / b.low);
      s += l * l;
    }
    const parkinson = Math.sqrt(s / (4 * Math.log(2) * pf.bars.length));
    return validResult(this.def, {
      value: parkinson,
      confidence: 1,
      sampleCount: pf.bars.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const atrLikeNormalizedRangeFeature: Stage1Feature = {
  def: def({
    key: 'vol.atr_normalized',
    version: '1',
    description: 'Mean true range normalized by close (ATR-like scale-free measure).',
    inputRequirements: 'finalized OHLC candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'scalar',
    unit: 'ratio',
    validRangeMin: 0,
    validRangeMax: 5,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    const trs: number[] = [];
    for (let i = 1; i < pf.bars.length; i += 1) {
      const b = pf.bars[i];
      const prev = pf.bars[i - 1];
      const tr = Math.max(
        b.high - b.low,
        Math.abs(b.high - prev.close),
        Math.abs(b.low - prev.close),
      );
      trs.push(tr / b.close);
    }
    return validResult(this.def, {
      value: mean(trs),
      confidence: 1,
      sampleCount: trs.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const expansionRatioFeature: Stage1Feature = {
  def: def({
    key: 'vol.expansion_ratio',
    version: '1',
    description:
      'Ratio of realized vol in the most recent quartile of the window vs the first quartile.',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: 128,
    outputType: 'ratio',
    unit: 'ratio',
    validRangeMin: 0,
    validRangeMax: 10,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, 129);
    if ('status' in pf) return pf;
    const q = Math.floor(pf.returns.length / 4);
    const first = pf.returns.slice(0, q);
    const last = pf.returns.slice(pf.returns.length - q);
    const rvFirst = Math.sqrt(first.reduce((a, r) => a + r * r, 0));
    const rvLast = Math.sqrt(last.reduce((a, r) => a + r * r, 0));
    if (!(rvFirst > 0)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.returns.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'zero volatility in early window — ratio undefined',
      });
    }
    return validResult(this.def, {
      value: rvLast / rvFirst,
      confidence: 1,
      sampleCount: pf.returns.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

// ---------------------------------------------------------------------------
// Liquidity / tradability
// ---------------------------------------------------------------------------

export const approximateSpreadFeature: Stage1Feature = {
  def: def({
    key: 'liq.spread_bps',
    version: '1',
    description: 'Snapshot approximate spread in bps sourced from the ticker channel.',
    inputRequirements: 'ticker observation attached to bundle',
    lookbackMs: 0,
    minimumSampleCount: 1,
    outputType: 'bps',
    unit: 'bps',
    validRangeMin: 0,
    validRangeMax: 1_000_000,
    missingDataPolicy: 'return unsupported when spread is null',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const spread = bundle.staticInputs.approximateSpreadBps;
    const inputHash = hashCandleWindow([], {
      key: this.def.key,
      version: this.def.version,
      spread: spread ?? null,
      pid: bundle.productId,
    });
    if (spread == null) {
      return failResult('unsupported', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        failureReason: 'no spread observation available',
      });
    }
    if (!Number.isFinite(spread) || spread < 0) {
      return failResult('invalid_input', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        failureReason: 'spread must be finite and non-negative',
      });
    }
    return validResult(this.def, {
      value: spread,
      confidence: 1,
      sampleCount: 1,
      lookbackStart: bundle.now,
      lookbackEnd: bundle.now,
      dataAvailableAt: bundle.now,
      inputHash,
    });
  },
};

export const quoteVolumeFeature: Stage1Feature = {
  def: def({
    key: 'liq.quote_volume_24h',
    version: '1',
    description: 'Approximate quote-currency volume over the last 24h from static metadata.',
    inputRequirements: 'quoteVolume24h attached to product static inputs',
    lookbackMs: 24 * 60 * 60 * 1000,
    minimumSampleCount: 1,
    outputType: 'scalar',
    unit: 'quote',
    validRangeMin: 0,
    validRangeMax: null,
    missingDataPolicy: 'unsupported when null',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const v = bundle.staticInputs.quoteVolume24h;
    const inputHash = hashCandleWindow([], {
      key: this.def.key,
      version: this.def.version,
      v: v ?? null,
      pid: bundle.productId,
    });
    if (v == null) {
      return failResult('unsupported', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        failureReason: 'no quote volume observation available',
      });
    }
    if (!Number.isFinite(v) || v < 0) {
      return failResult('invalid_input', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        failureReason: 'quote volume must be finite and non-negative',
      });
    }
    return validResult(this.def, {
      value: v,
      confidence: 1,
      sampleCount: 1,
      lookbackStart: new Date(bundle.now.getTime() - 24 * 60 * 60 * 1000),
      lookbackEnd: bundle.now,
      dataAvailableAt: bundle.now,
      inputHash,
    });
  },
};

export const tradeCountFeature: Stage1Feature = {
  def: def({
    key: 'liq.trade_count_24h',
    version: '1',
    description: 'Approximate trade count over the last 24h from static metadata.',
    inputRequirements: 'tradeCount24h attached to product static inputs',
    lookbackMs: 24 * 60 * 60 * 1000,
    minimumSampleCount: 1,
    outputType: 'count',
    unit: 'count',
    validRangeMin: 0,
    validRangeMax: null,
    missingDataPolicy: 'unsupported when null',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const v = bundle.staticInputs.tradeCount24h;
    const inputHash = hashCandleWindow([], {
      key: this.def.key,
      version: this.def.version,
      v: v ?? null,
      pid: bundle.productId,
    });
    if (v == null) {
      return failResult('unsupported', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        failureReason: 'no trade count observation available',
      });
    }
    if (!Number.isFinite(v) || v < 0) {
      return failResult('invalid_input', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        failureReason: 'trade count must be finite and non-negative',
      });
    }
    return validResult(this.def, {
      value: v,
      confidence: 1,
      sampleCount: 1,
      lookbackStart: new Date(bundle.now.getTime() - 24 * 60 * 60 * 1000),
      lookbackEnd: bundle.now,
      dataAvailableAt: bundle.now,
      inputHash,
    });
  },
};

export const amihudIlliquidityFeature: Stage1Feature = {
  def: def({
    key: 'liq.amihud',
    version: '1',
    description: 'Amihud illiquidity: mean(|r| / quote_volume_bar).',
    inputRequirements: 'finalized close-price + volume candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'scalar',
    unit: 'illiquidity',
    validRangeMin: 0,
    validRangeMax: null,
    missingDataPolicy: 'skip bars with zero volume',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    const scores: number[] = [];
    for (let i = 1; i < pf.bars.length; i += 1) {
      const b = pf.bars[i];
      const quoteVol = b.close * b.volume;
      if (!(quoteVol > 0)) continue;
      scores.push(Math.abs(pf.returns[i - 1]) / quoteVol);
    }
    if (scores.length < 8) {
      return failResult('insufficient_history', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: scores.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'not enough non-zero-volume bars for Amihud',
      });
    }
    return validResult(this.def, {
      value: mean(scores),
      confidence: 1,
      sampleCount: scores.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const turnoverStabilityFeature: Stage1Feature = {
  def: def({
    key: 'liq.turnover_stability',
    version: '1',
    description:
      'Coefficient of variation of bar-quote-volume across the window (lower = more stable turnover).',
    inputRequirements: 'finalized volume candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'ratio',
    unit: 'cov',
    validRangeMin: 0,
    validRangeMax: null,
    missingDataPolicy: 'skip zero-volume bars',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    const q: number[] = [];
    for (const b of pf.bars) {
      const qv = b.close * b.volume;
      if (qv > 0) q.push(qv);
    }
    if (q.length < 16) {
      return failResult('insufficient_history', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: q.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'too many zero-volume bars',
      });
    }
    const m = mean(q);
    if (!(m > 0)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: q.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'mean turnover is zero',
      });
    }
    return validResult(this.def, {
      value: stdev(q) / m,
      confidence: 1,
      sampleCount: q.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const candleGapFrequencyFeature: Stage1Feature = {
  def: def({
    key: 'liq.candle_gap_freq',
    version: '1',
    description: 'Ratio of missing buckets vs expected buckets across the window.',
    inputRequirements: 'raw finalized bars (pre-drop)',
    lookbackMs: 0,
    minimumSampleCount: 32,
    outputType: 'ratio',
    unit: 'ratio',
    validRangeMin: 0,
    validRangeMax: 1,
    missingDataPolicy: 'counts missing buckets directly',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, 32);
    if ('status' in pf) return pf;
    if (pf.bars.length < 2) {
      return failResult('insufficient_history', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.bars.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'need >=2 bars to detect gaps',
      });
    }
    const g = pf.bars[0].granularitySeconds * 1000;
    const spanMs = pf.bars[pf.bars.length - 1].bucketStart.getTime() - pf.bars[0].bucketStart.getTime();
    const expected = Math.floor(spanMs / g) + 1;
    const missing = Math.max(0, expected - pf.bars.length);
    return validResult(this.def, {
      value: missing / expected,
      confidence: 1,
      sampleCount: expected,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
      diagnostics: { missing, expected, granularitySeconds: pf.bars[0].granularitySeconds },
    });
  },
};

export const zeroVolumeFrequencyFeature: Stage1Feature = {
  def: def({
    key: 'liq.zero_volume_freq',
    version: '1',
    description: 'Fraction of visible bars with zero volume.',
    inputRequirements: 'finalized OHLCV candles',
    lookbackMs: 0,
    minimumSampleCount: 32,
    outputType: 'ratio',
    unit: 'ratio',
    validRangeMin: 0,
    validRangeMax: 1,
    missingDataPolicy: 'includes zero-volume bars',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, 32);
    if ('status' in pf) return pf;
    let zeros = 0;
    for (const b of pf.bars) if (!(b.volume > 0)) zeros += 1;
    return validResult(this.def, {
      value: zeros / pf.bars.length,
      confidence: 1,
      sampleCount: pf.bars.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const incrementBurdenFeature: Stage1Feature = {
  def: def({
    key: 'liq.increment_burden',
    version: '1',
    description:
      'Quote increment expressed as bps of the most recent close — how coarse a single tick is.',
    inputRequirements: 'quoteIncrement + at least one close',
    lookbackMs: 0,
    minimumSampleCount: 1,
    outputType: 'bps',
    unit: 'bps',
    validRangeMin: 0,
    validRangeMax: null,
    missingDataPolicy: 'unsupported when quoteIncrement <= 0',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const bars = visibleFinalizedBars(bundle.bars, bundle.now);
    const inputHash = hashCandleWindow(bars.slice(-1), {
      key: this.def.key,
      version: this.def.version,
      qi: bundle.staticInputs.quoteIncrement,
      pid: bundle.productId,
    });
    if (bars.length === 0) {
      return failResult('insufficient_history', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        failureReason: 'no visible bars',
      });
    }
    const qi = bundle.staticInputs.quoteIncrement;
    if (!(qi > 0)) {
      return failResult('unsupported', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        failureReason: 'quoteIncrement <= 0',
      });
    }
    const last = bars[bars.length - 1].close;
    if (!(last > 0)) {
      return failResult('invalid_input', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        failureReason: 'last close <= 0',
      });
    }
    return validResult(this.def, {
      value: (qi / last) * 10_000,
      confidence: 1,
      sampleCount: 1,
      lookbackStart: bars[bars.length - 1].bucketStart,
      lookbackEnd: bars[bars.length - 1].bucketStart,
      dataAvailableAt: bundle.now,
      inputHash,
    });
  },
};

export const minOrderBurdenFeature: Stage1Feature = {
  def: def({
    key: 'liq.min_order_notional_quote',
    version: '1',
    description:
      'Smallest tradable notional in the quote currency (baseMinimum * last close). Higher = harder for tiny orders.',
    inputRequirements: 'baseMinimum + at least one close',
    lookbackMs: 0,
    minimumSampleCount: 1,
    outputType: 'scalar',
    unit: 'quote',
    validRangeMin: 0,
    validRangeMax: null,
    missingDataPolicy: 'unsupported when baseMinimum <= 0',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const bars = visibleFinalizedBars(bundle.bars, bundle.now);
    const inputHash = hashCandleWindow(bars.slice(-1), {
      key: this.def.key,
      version: this.def.version,
      bm: bundle.staticInputs.baseMinimum,
      pid: bundle.productId,
    });
    if (bars.length === 0) {
      return failResult('insufficient_history', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        failureReason: 'no visible bars',
      });
    }
    const bm = bundle.staticInputs.baseMinimum;
    if (!(bm > 0)) {
      return failResult('unsupported', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        failureReason: 'baseMinimum <= 0',
      });
    }
    const last = bars[bars.length - 1].close;
    if (!(last > 0)) {
      return failResult('invalid_input', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        failureReason: 'last close <= 0',
      });
    }
    return validResult(this.def, {
      value: bm * last,
      confidence: 1,
      sampleCount: 1,
      lookbackStart: bars[bars.length - 1].bucketStart,
      lookbackEnd: bars[bars.length - 1].bucketStart,
      dataAvailableAt: bundle.now,
      inputHash,
      diagnostics: { minNotional: bm * last, lastClose: last, baseMinimum: bm },
    });
  },
};

// ---------------------------------------------------------------------------
// Information / disorder
// ---------------------------------------------------------------------------

export const returnEntropyFeature: Stage1Feature = {
  def: def({
    key: 'info.return_entropy_bits',
    version: '1',
    description:
      'Shannon entropy (bits) of returns discretized into 8 quantile buckets. Range [0, log2(8)]=3.',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: 64,
    outputType: 'scalar',
    unit: 'bits',
    validRangeMin: 0,
    validRangeMax: 3,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, 65);
    if ('status' in pf) return pf;
    const sorted = [...pf.returns].sort((a, b) => a - b);
    const nBuckets = 8;
    const buckets = new Array<number>(nBuckets).fill(0);
    for (const r of pf.returns) {
      // Rank-based bucket assignment for scale invariance.
      const rank = sorted.indexOf(r);
      const b = Math.min(nBuckets - 1, Math.floor((rank / sorted.length) * nBuckets));
      buckets[b] += 1;
    }
    const h = shannonEntropyBits(buckets);
    if (!Number.isFinite(h)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.returns.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'entropy undefined',
      });
    }
    return validResult(this.def, {
      value: h,
      confidence: 1,
      sampleCount: pf.returns.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const directionalEntropyFeature: Stage1Feature = {
  def: def({
    key: 'info.directional_entropy_bits',
    version: '1',
    description:
      'Shannon entropy (bits) of the sign pattern of returns (buckets: +, -, 0). Range [0, log2(3)].',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'scalar',
    unit: 'bits',
    validRangeMin: 0,
    validRangeMax: 2,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    let pos = 0;
    let neg = 0;
    let zero = 0;
    for (const r of pf.returns) {
      if (r > 0) pos += 1;
      else if (r < 0) neg += 1;
      else zero += 1;
    }
    const h = shannonEntropyBits([pos, neg, zero]);
    return validResult(this.def, {
      value: h,
      confidence: 1,
      sampleCount: pf.returns.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const jumpFrequencyFeature: Stage1Feature = {
  def: def({
    key: 'info.jump_frequency',
    version: '1',
    description:
      'Fraction of returns whose absolute value exceeds 5 * MAD (median absolute deviation).',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'ratio',
    unit: 'ratio',
    validRangeMin: 0,
    validRangeMax: 1,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    const mad = medianAbsDev(pf.returns);
    if (!(mad > 0)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.returns.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'MAD is zero — degenerate return series',
      });
    }
    const threshold = 5 * mad;
    let jumps = 0;
    for (const r of pf.returns) if (Math.abs(r) > threshold) jumps += 1;
    return validResult(this.def, {
      value: jumps / pf.returns.length,
      confidence: 1,
      sampleCount: pf.returns.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
      diagnostics: { threshold, mad },
    });
  },
};

export const outlierConcentrationFeature: Stage1Feature = {
  def: def({
    key: 'info.outlier_concentration',
    version: '1',
    description: 'Fraction of total return variance contributed by the top 5% |r| bars.',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'ratio',
    unit: 'ratio',
    validRangeMin: 0,
    validRangeMax: 1,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    const squares = pf.returns.map((r) => r * r).sort((a, b) => b - a);
    const total = squares.reduce((a, b) => a + b, 0);
    if (!(total > 0)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.returns.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'zero total variance',
      });
    }
    const k = Math.max(1, Math.floor(squares.length * 0.05));
    const top = squares.slice(0, k).reduce((a, b) => a + b, 0);
    return validResult(this.def, {
      value: top / total,
      confidence: 1,
      sampleCount: squares.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
      diagnostics: { k, top, total },
    });
  },
};

export const serialDependenceFeature: Stage1Feature = {
  def: def({
    key: 'info.abs_return_autocorr_lag1',
    version: '1',
    description:
      'Autocorrelation of |returns| at lag 1 — a volatility-clustering diagnostic.',
    inputRequirements: 'finalized close-price candles',
    lookbackMs: 0,
    minimumSampleCount: MIN_RETURNS,
    outputType: 'signed_scalar',
    unit: 'correlation',
    validRangeMin: -1,
    validRangeMax: 1,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, MIN_RETURNS + 1);
    if ('status' in pf) return pf;
    const absR = pf.returns.map((r) => Math.abs(r));
    const ac = autocorrelation(absR, 1);
    if (!Number.isFinite(ac)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.returns.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: '|r| autocorrelation undefined',
      });
    }
    return validResult(this.def, {
      value: ac,
      confidence: 1,
      sampleCount: pf.returns.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const dataQualityPenaltyFeature: Stage1Feature = {
  def: def({
    key: 'info.data_quality_penalty',
    version: '1',
    description:
      'Composite quality penalty in [0,1] combining gap ratio, zero-volume ratio, and any bundle-declared upstream gaps. 0 = clean.',
    inputRequirements: 'finalized bars + gapCount hint',
    lookbackMs: 0,
    minimumSampleCount: 32,
    outputType: 'ratio',
    unit: 'ratio',
    validRangeMin: 0,
    validRangeMax: 1,
    missingDataPolicy: 'penalty INCREASES with missing/upstream gaps',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = preflight(this.def, bundle, 32);
    if ('status' in pf) return pf;
    const g = pf.bars[0].granularitySeconds * 1000;
    const spanMs = pf.bars[pf.bars.length - 1].bucketStart.getTime() - pf.bars[0].bucketStart.getTime();
    const expected = Math.floor(spanMs / g) + 1;
    const missing = Math.max(0, expected - pf.bars.length);
    const gapRatio = missing / Math.max(1, expected);
    let zeros = 0;
    for (const b of pf.bars) if (!(b.volume > 0)) zeros += 1;
    const zvRatio = zeros / pf.bars.length;
    const upstream = Math.min(1, (bundle.gapCount ?? 0) / Math.max(32, pf.bars.length));
    const penalty = Math.min(1, 0.5 * gapRatio + 0.3 * zvRatio + 0.2 * upstream);
    return validResult(this.def, {
      value: penalty,
      confidence: 1,
      sampleCount: pf.bars.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
      diagnostics: { gapRatio, zvRatio, upstream, missing, expected },
    });
  },
};

// ---------------------------------------------------------------------------
// Benchmark relationships — REQUIRE time-aligned data
// ---------------------------------------------------------------------------

function benchPairPreflight(
  def: FeatureDefinition,
  bundle: FeatureInputBundle,
  benchKey: string,
  minPairs: number,
): { productReturns: number[]; benchReturns: number[]; startAt: Date; endAt: Date; inputHash: string } | FeatureResult {
  const bench = bundle.benchmarks?.[benchKey];
  const inputHash = hashCandleWindow(bundle.bars, {
    key: def.key,
    version: def.version,
    benchKey,
    pid: bundle.productId,
    benchPid: bench?.productId ?? null,
  });
  if (!bench) {
    return failResult('unsupported', def, {
      dataAvailableAt: bundle.now,
      inputHash,
      failureReason: `benchmark ${benchKey} not provided`,
    });
  }
  const productBars = visibleFinalizedBars(bundle.bars, bundle.now);
  const benchBars = visibleFinalizedBars(bench.bars, bundle.now);
  const aligned = alignedSeries(productBars, benchBars);
  if (aligned.aAligned.length < minPairs) {
    return failResult('insufficient_history', def, {
      dataAvailableAt: bundle.now,
      inputHash,
      sampleCount: aligned.aAligned.length,
      failureReason: `need ${minPairs} aligned buckets vs ${benchKey}; have ${aligned.aAligned.length}`,
    });
  }
  const pClose = aligned.aAligned.map((b) => b.close);
  const bClose = aligned.bAligned.map((b) => b.close);
  if (pClose.some((c) => !(c > 0)) || bClose.some((c) => !(c > 0))) {
    return failResult('invalid_input', def, {
      dataAvailableAt: bundle.now,
      inputHash,
      sampleCount: pClose.length,
      failureReason: 'non-positive close in aligned series',
    });
  }
  const pR = logReturns(pClose);
  const bR = logReturns(bClose);
  if (pR.some((r) => !Number.isFinite(r)) || bR.some((r) => !Number.isFinite(r))) {
    return failResult('numerical_failure', def, {
      dataAvailableAt: bundle.now,
      inputHash,
      sampleCount: pR.length,
      failureReason: 'non-finite return',
    });
  }
  return {
    productReturns: pR,
    benchReturns: bR,
    startAt: aligned.aAligned[0].bucketStart,
    endAt: aligned.aAligned[aligned.aAligned.length - 1].bucketStart,
    inputHash,
  };
}

export const btcBetaFeature: Stage1Feature = {
  def: def({
    key: 'bench.btc_beta',
    version: '1',
    description:
      'OLS beta of product returns on BTC-USD returns using only time-aligned buckets. Requires >=64 aligned pairs.',
    inputRequirements: 'benchmark BTC-USD candles aligned by bucketStart',
    lookbackMs: 0,
    minimumSampleCount: 64,
    outputType: 'signed_scalar',
    unit: 'beta',
    validRangeMin: -10,
    validRangeMax: 10,
    missingDataPolicy: 'drop unaligned buckets — never zero-fill',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = benchPairPreflight(this.def, bundle, 'BTC-USD', 64);
    if ('status' in pf) return pf;
    const beta = olsBeta(pf.benchReturns, pf.productReturns, true);
    if (!Number.isFinite(beta)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.productReturns.length,
        lookbackStart: pf.startAt,
        lookbackEnd: pf.endAt,
        failureReason: 'benchmark variance is zero',
      });
    }
    return validResult(this.def, {
      value: beta,
      confidence: 1,
      sampleCount: pf.productReturns.length,
      lookbackStart: pf.startAt,
      lookbackEnd: pf.endAt,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const btcCorrelationFeature: Stage1Feature = {
  def: def({
    key: 'bench.btc_corr',
    version: '1',
    description: 'Pearson correlation of product vs BTC-USD returns (aligned only).',
    inputRequirements: 'benchmark BTC-USD candles aligned by bucketStart',
    lookbackMs: 0,
    minimumSampleCount: 64,
    outputType: 'signed_scalar',
    unit: 'correlation',
    validRangeMin: -1,
    validRangeMax: 1,
    missingDataPolicy: 'drop unaligned buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = benchPairPreflight(this.def, bundle, 'BTC-USD', 64);
    if ('status' in pf) return pf;
    const c = correlation(pf.productReturns, pf.benchReturns);
    if (!Number.isFinite(c)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.productReturns.length,
        lookbackStart: pf.startAt,
        lookbackEnd: pf.endAt,
        failureReason: 'correlation undefined',
      });
    }
    return validResult(this.def, {
      value: c,
      confidence: 1,
      sampleCount: pf.productReturns.length,
      lookbackStart: pf.startAt,
      lookbackEnd: pf.endAt,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const btcResidualVolFeature: Stage1Feature = {
  def: def({
    key: 'bench.btc_residual_vol',
    version: '1',
    description: 'Residual stdev after OLS on BTC-USD returns.',
    inputRequirements: 'benchmark BTC-USD candles aligned by bucketStart',
    lookbackMs: 0,
    minimumSampleCount: 64,
    outputType: 'scalar',
    unit: 'log_return',
    validRangeMin: 0,
    validRangeMax: 5,
    missingDataPolicy: 'drop unaligned buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = benchPairPreflight(this.def, bundle, 'BTC-USD', 64);
    if ('status' in pf) return pf;
    const rv = residualStdev(pf.benchReturns, pf.productReturns);
    if (!Number.isFinite(rv)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.productReturns.length,
        lookbackStart: pf.startAt,
        lookbackEnd: pf.endAt,
        failureReason: 'residual stdev undefined',
      });
    }
    return validResult(this.def, {
      value: rv,
      confidence: 1,
      sampleCount: pf.productReturns.length,
      lookbackStart: pf.startAt,
      lookbackEnd: pf.endAt,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const relativeStrengthVsBtcFeature: Stage1Feature = {
  def: def({
    key: 'bench.rel_strength_btc',
    version: '1',
    description: 'Mean product return minus mean BTC return over aligned buckets.',
    inputRequirements: 'benchmark BTC-USD candles aligned by bucketStart',
    lookbackMs: 0,
    minimumSampleCount: 64,
    outputType: 'signed_scalar',
    unit: 'log_return',
    validRangeMin: -1,
    validRangeMax: 1,
    missingDataPolicy: 'drop unaligned buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = benchPairPreflight(this.def, bundle, 'BTC-USD', 64);
    if ('status' in pf) return pf;
    const rs = mean(pf.productReturns) - mean(pf.benchReturns);
    return validResult(this.def, {
      value: rs,
      confidence: 1,
      sampleCount: pf.productReturns.length,
      lookbackStart: pf.startAt,
      lookbackEnd: pf.endAt,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const ethBetaFeature: Stage1Feature = {
  def: def({
    key: 'bench.eth_beta',
    version: '1',
    description: 'OLS beta of product returns on ETH-USD returns using only aligned buckets.',
    inputRequirements: 'benchmark ETH-USD candles aligned by bucketStart',
    lookbackMs: 0,
    minimumSampleCount: 64,
    outputType: 'signed_scalar',
    unit: 'beta',
    validRangeMin: -10,
    validRangeMax: 10,
    missingDataPolicy: 'drop unaligned buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = benchPairPreflight(this.def, bundle, 'ETH-USD', 64);
    if ('status' in pf) return pf;
    const beta = olsBeta(pf.benchReturns, pf.productReturns, true);
    if (!Number.isFinite(beta)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.productReturns.length,
        lookbackStart: pf.startAt,
        lookbackEnd: pf.endAt,
        failureReason: 'benchmark variance is zero',
      });
    }
    return validResult(this.def, {
      value: beta,
      confidence: 1,
      sampleCount: pf.productReturns.length,
      lookbackStart: pf.startAt,
      lookbackEnd: pf.endAt,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

export const ethCorrelationFeature: Stage1Feature = {
  def: def({
    key: 'bench.eth_corr',
    version: '1',
    description: 'Pearson correlation of product vs ETH-USD returns (aligned only).',
    inputRequirements: 'benchmark ETH-USD candles aligned by bucketStart',
    lookbackMs: 0,
    minimumSampleCount: 64,
    outputType: 'signed_scalar',
    unit: 'correlation',
    validRangeMin: -1,
    validRangeMax: 1,
    missingDataPolicy: 'drop unaligned buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle) {
    const pf = benchPairPreflight(this.def, bundle, 'ETH-USD', 64);
    if ('status' in pf) return pf;
    const c = correlation(pf.productReturns, pf.benchReturns);
    if (!Number.isFinite(c)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: pf.productReturns.length,
        lookbackStart: pf.startAt,
        lookbackEnd: pf.endAt,
        failureReason: 'correlation undefined',
      });
    }
    return validResult(this.def, {
      value: c,
      confidence: 1,
      sampleCount: pf.productReturns.length,
      lookbackStart: pf.startAt,
      lookbackEnd: pf.endAt,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
    });
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const STAGE1_FEATURES: readonly Stage1Feature[] = [
  meanLogReturnFeature,
  stdevLogReturnFeature,
  positiveReturnFractionFeature,
  rollingAutocorrelationFeature,
  varianceRatioFeature,
  hurstFeature,
  trendEfficiencyFeature,
  rangeEfficiencyFeature,
  directionalPersistenceFeature,
  realizedVolFeature,
  downsideVolFeature,
  volOfVolFeature,
  highLowRangeVolFeature,
  atrLikeNormalizedRangeFeature,
  expansionRatioFeature,
  approximateSpreadFeature,
  quoteVolumeFeature,
  tradeCountFeature,
  amihudIlliquidityFeature,
  turnoverStabilityFeature,
  candleGapFrequencyFeature,
  zeroVolumeFrequencyFeature,
  incrementBurdenFeature,
  minOrderBurdenFeature,
  returnEntropyFeature,
  directionalEntropyFeature,
  jumpFrequencyFeature,
  outlierConcentrationFeature,
  serialDependenceFeature,
  dataQualityPenaltyFeature,
  btcBetaFeature,
  btcCorrelationFeature,
  btcResidualVolFeature,
  relativeStrengthVsBtcFeature,
  ethBetaFeature,
  ethCorrelationFeature,
] as const;
