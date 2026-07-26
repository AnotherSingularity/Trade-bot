/**
 * Phase 2A §H — Stage 2 confirmation features.
 *
 * Stage 2 features are EXPENSIVE and only run on shortlisted
 * products. They are used to CONFIRM or REFUTE the direction implied
 * by Stage 1 signals, never to invent one.
 *
 * The catalog is small on purpose:
 *   - ADF-lite / KPSS-lite stationarity diagnostics
 *   - OU (Ornstein–Uhlenbeck) fit quality + half-life
 *   - Range stability across sub-windows
 *   - Multi-window correlation stability with the primary benchmark
 *
 * These features honor the same FeatureResult contract as Stage 1.
 * They do NOT emit a "trending vs mean-reverting" verdict — that is
 * the fingerprint composer's job. They emit numeric evidence with
 * confidence and diagnostics.
 */

import {
  type FeatureDefinition,
  type FeatureResult,
  failResult,
  validResult,
} from './contract';
import {
  type FeatureInputBundle,
  alignedSeries,
  hashCandleWindow,
  visibleFinalizedBars,
} from './inputs';
import type { Stage1Feature } from './stage1';
import {
  autocorrelation,
  correlation,
  logReturns,
  mean,
  olsBeta,
  stdev,
  variance,
} from './math';

export const STAGE2_IMPLEMENTATION_VERSION = 'p2a-stage2-1';

function def(
  base: Omit<FeatureDefinition, 'implementationVersion' | 'stage' | 'status'>,
): FeatureDefinition {
  return {
    ...base,
    implementationVersion: STAGE2_IMPLEMENTATION_VERSION,
    stage: 'stage_2',
    status: 'observer',
  };
}

interface Preflight {
  closes: number[];
  returns: number[];
  lookbackStart: Date;
  lookbackEnd: Date;
  inputHash: string;
}

function preflight(
  fdef: FeatureDefinition,
  bundle: FeatureInputBundle,
  minBars: number,
): Preflight | FeatureResult {
  const bars = visibleFinalizedBars(bundle.bars, bundle.now);
  const inputHash = hashCandleWindow(bars, {
    key: fdef.key,
    version: fdef.version,
    pid: bundle.productId,
    now: bundle.now.toISOString(),
  });
  if (bars.length < minBars) {
    return failResult('insufficient_history', fdef, {
      dataAvailableAt: bundle.now,
      inputHash,
      sampleCount: bars.length,
      failureReason: `have ${bars.length} bars, need ${minBars}`,
    });
  }
  const closes = bars.map((b) => b.close);
  if (closes.some((c) => !(c > 0))) {
    return failResult('invalid_input', fdef, {
      dataAvailableAt: bundle.now,
      inputHash,
      sampleCount: bars.length,
      lookbackStart: bars[0].bucketStart,
      lookbackEnd: bars[bars.length - 1].bucketStart,
      failureReason: 'non-positive close price in window',
    });
  }
  const returns = logReturns(closes);
  if (returns.some((r) => !Number.isFinite(r))) {
    return failResult('numerical_failure', fdef, {
      dataAvailableAt: bundle.now,
      inputHash,
      sampleCount: returns.length,
      lookbackStart: bars[0].bucketStart,
      lookbackEnd: bars[bars.length - 1].bucketStart,
      failureReason: 'non-finite log return',
    });
  }
  return {
    closes,
    returns,
    lookbackStart: bars[0].bucketStart,
    lookbackEnd: bars[bars.length - 1].bucketStart,
    inputHash,
  };
}

// ---------------------------------------------------------------------------
// ADF-lite diagnostic
// ---------------------------------------------------------------------------

/**
 * Emits the t-statistic of the coefficient `rho` in
 *   Δy_t = rho * y_{t-1} + drift + noise
 * A more negative t-stat suggests stationarity. We do NOT compare to
 * MacKinnon critical values (those require simulated tables that
 * would drift from replay); we surface the t-stat and let the
 * composer interpret with a conservative threshold.
 */
export const adfLiteFeature = {
  def: def({
    key: 'stat.adf_lite_tstat',
    version: '1',
    description:
      'ADF-lite regression t-statistic on Δy vs lagged level with drift. More negative = stronger evidence of stationarity. No p-values (fingerprint composer applies conservative thresholds).',
    inputRequirements: 'finalized close-price candles (>=256 obs)',
    lookbackMs: 0,
    minimumSampleCount: 256,
    outputType: 'signed_scalar',
    unit: 't-stat',
    validRangeMin: -20,
    validRangeMax: 20,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle: FeatureInputBundle): FeatureResult {
    const pf = preflight(this.def, bundle, 257);
    if ('status' in pf) return pf;
    const y = pf.closes.map((c) => Math.log(c));
    // Δy_t = alpha + rho * y_{t-1} + eps
    const n = y.length - 1;
    if (n < 32) {
      return failResult('insufficient_history', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: n,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'need >=32 pairs',
      });
    }
    const x = y.slice(0, n);
    const dy: number[] = [];
    for (let i = 1; i < y.length; i += 1) dy.push(y[i] - y[i - 1]);
    const mx = mean(x);
    const md = mean(dy);
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
      const a = x[i] - mx;
      num += a * (dy[i] - md);
      den += a * a;
    }
    if (!(den > 0)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: n,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'zero variance in lagged level',
      });
    }
    const rho = num / den;
    const alpha = md - rho * mx;
    let sse = 0;
    for (let i = 0; i < n; i += 1) {
      const pred = alpha + rho * x[i];
      const e = dy[i] - pred;
      sse += e * e;
    }
    const sigma2 = sse / Math.max(1, n - 2);
    const se = Math.sqrt(sigma2 / den);
    if (!(se > 0)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: n,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'standard error is zero',
      });
    }
    const tstat = rho / se;
    return validResult(this.def, {
      value: tstat,
      confidence: 1,
      sampleCount: n,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
      diagnostics: { rho, alpha, se, sigma2 },
    });
  },
};

// ---------------------------------------------------------------------------
// KPSS-lite diagnostic — level stationarity statistic
// ---------------------------------------------------------------------------

/**
 * KPSS-style level-stationarity statistic (no lag correction — kernel
 * bandwidth 0). Higher = stronger evidence AGAINST stationarity.
 * Complementary to ADF: fingerprint composer treats a low ADF t-stat
 * AND a low KPSS statistic as agreement.
 */
export const kpssLiteFeature = {
  def: def({
    key: 'stat.kpss_lite',
    version: '1',
    description:
      'KPSS-lite level-stationarity statistic (no long-run variance correction). Larger = stronger evidence AGAINST stationarity. Used with adf_lite_tstat for corroboration.',
    inputRequirements: 'finalized close-price candles (>=256 obs)',
    lookbackMs: 0,
    minimumSampleCount: 256,
    outputType: 'scalar',
    unit: 'stat',
    validRangeMin: 0,
    validRangeMax: 100,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle: FeatureInputBundle): FeatureResult {
    const pf = preflight(this.def, bundle, 257);
    if ('status' in pf) return pf;
    const y = pf.closes.map((c) => Math.log(c));
    const n = y.length;
    const mu = mean(y);
    const dev = y.map((v) => v - mu);
    const cum: number[] = [];
    let running = 0;
    for (const d of dev) {
      running += d;
      cum.push(running);
    }
    const sumS2 = cum.reduce((a, s) => a + s * s, 0);
    const v = variance(y);
    if (!(v > 0)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: n,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'zero variance in log price',
      });
    }
    const kpss = sumS2 / (n * n * v);
    return validResult(this.def, {
      value: kpss,
      confidence: 1,
      sampleCount: n,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
      diagnostics: { variance: v },
    });
  },
};

// ---------------------------------------------------------------------------
// OU fit quality + half-life
// ---------------------------------------------------------------------------

/**
 * Fit an Ornstein–Uhlenbeck AR(1) on the log price series:
 *   y_t = phi * y_{t-1} + c + eps
 * If 0 < phi < 1 the process is mean-reverting with half-life
 *   H = -ln(2) / ln(phi)   (in bars).
 *
 * Returns the half-life IF phi is in (0,1) AND the AR(1) fit R² is
 * above 0.5. Otherwise returns `low_confidence` or an appropriate
 * failure status — we do not claim mean reversion without evidence.
 */
export const ouHalfLifeFeature = {
  def: def({
    key: 'stat.ou_half_life_bars',
    version: '1',
    description:
      'Ornstein–Uhlenbeck AR(1) half-life estimator (in bars). low_confidence when phi is outside (0,1) or the AR(1) fit R² < 0.5.',
    inputRequirements: 'finalized close-price candles (>=256 obs)',
    lookbackMs: 0,
    minimumSampleCount: 256,
    outputType: 'scalar',
    unit: 'bars',
    validRangeMin: 0,
    validRangeMax: 5000,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle: FeatureInputBundle): FeatureResult {
    const pf = preflight(this.def, bundle, 257);
    if ('status' in pf) return pf;
    const y = pf.closes.map((c) => Math.log(c));
    const x = y.slice(0, -1);
    const yn = y.slice(1);
    const phi = olsBeta(x, yn, true);
    if (!Number.isFinite(phi)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: yn.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'AR(1) slope undefined',
      });
    }
    const mx = mean(x);
    const my = mean(yn);
    const c = my - phi * mx;
    let ssRes = 0;
    let ssTot = 0;
    for (let i = 0; i < yn.length; i += 1) {
      const pred = c + phi * x[i];
      ssRes += (yn[i] - pred) ** 2;
      ssTot += (yn[i] - my) ** 2;
    }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

    if (!(phi > 0 && phi < 1)) {
      return validResult(this.def, {
        value: 0,
        confidence: 0.1,
        sampleCount: yn.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        lowConfidence: true,
        lowConfidenceReason: `phi=${phi.toFixed(4)} outside (0,1) — series is not OU mean-reverting`,
        diagnostics: { phi, r2, intercept: c },
      });
    }
    const halfLife = -Math.log(2) / Math.log(phi);
    const lowConf = r2 < 0.5;
    return validResult(this.def, {
      value: halfLife,
      confidence: lowConf ? Math.max(0, r2) : 1,
      sampleCount: yn.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
      lowConfidence: lowConf,
      lowConfidenceReason: lowConf
        ? `AR(1) fit R²=${r2.toFixed(3)} < 0.5 — half-life estimate is unreliable`
        : undefined,
      diagnostics: { phi, r2, intercept: c },
    });
  },
};

// ---------------------------------------------------------------------------
// Range stability across sub-windows
// ---------------------------------------------------------------------------

export const rangeStabilityFeature = {
  def: def({
    key: 'stat.range_stability',
    version: '1',
    description:
      'Coefficient of variation of high-low ranges across 4 equal sub-windows. Low CV = stable range.',
    inputRequirements: 'finalized OHLC candles (>=256 obs)',
    lookbackMs: 0,
    minimumSampleCount: 256,
    outputType: 'ratio',
    unit: 'cov',
    validRangeMin: 0,
    validRangeMax: 10,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle: FeatureInputBundle): FeatureResult {
    const bars = visibleFinalizedBars(bundle.bars, bundle.now);
    const inputHash = hashCandleWindow(bars, {
      key: this.def.key,
      version: this.def.version,
      pid: bundle.productId,
    });
    if (bars.length < 256) {
      return failResult('insufficient_history', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        sampleCount: bars.length,
        failureReason: `have ${bars.length} bars, need 256`,
      });
    }
    const chunkSize = Math.floor(bars.length / 4);
    const ranges: number[] = [];
    for (let c = 0; c < 4; c += 1) {
      const slice = bars.slice(c * chunkSize, (c + 1) * chunkSize);
      let hi = -Infinity;
      let lo = Infinity;
      for (const b of slice) {
        if (b.high > hi) hi = b.high;
        if (b.low < lo) lo = b.low;
      }
      if (!(lo > 0)) {
        return failResult('invalid_input', this.def, {
          dataAvailableAt: bundle.now,
          inputHash,
          sampleCount: bars.length,
          lookbackStart: bars[0].bucketStart,
          lookbackEnd: bars[bars.length - 1].bucketStart,
          failureReason: 'non-positive low in chunk',
        });
      }
      ranges.push((hi - lo) / lo);
    }
    const m = mean(ranges);
    if (!(m > 0)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        sampleCount: bars.length,
        lookbackStart: bars[0].bucketStart,
        lookbackEnd: bars[bars.length - 1].bucketStart,
        failureReason: 'mean range is zero',
      });
    }
    return validResult(this.def, {
      value: stdev(ranges) / m,
      confidence: 1,
      sampleCount: 4,
      lookbackStart: bars[0].bucketStart,
      lookbackEnd: bars[bars.length - 1].bucketStart,
      dataAvailableAt: bundle.now,
      inputHash,
      diagnostics: { chunks: ranges },
    });
  },
};

// ---------------------------------------------------------------------------
// Multi-window benchmark correlation stability
// ---------------------------------------------------------------------------

/**
 * Split the aligned product/benchmark returns into 4 chunks and
 * compute the coefficient of variation of the per-chunk correlation
 * with BTC. LOW cov = correlation is stable across the window (a
 * beta feature is meaningful). HIGH cov = the relationship is
 * unstable.
 */
export const btcCorrelationStabilityFeature = {
  def: def({
    key: 'stat.btc_corr_stability',
    version: '1',
    description:
      'Coefficient of variation of BTC-USD correlation across 4 equal sub-windows. Low = stable relationship.',
    inputRequirements: 'benchmark BTC-USD candles aligned by bucketStart',
    lookbackMs: 0,
    minimumSampleCount: 256,
    outputType: 'ratio',
    unit: 'cov',
    validRangeMin: 0,
    validRangeMax: 10,
    missingDataPolicy: 'drop unaligned buckets; skip chunk if <32 pairs',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle: FeatureInputBundle): FeatureResult {
    const bench = bundle.benchmarks?.['BTC-USD'];
    const inputHash = hashCandleWindow(bundle.bars, {
      key: this.def.key,
      version: this.def.version,
      pid: bundle.productId,
      benchPid: bench?.productId ?? null,
    });
    if (!bench) {
      return failResult('unsupported', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        failureReason: 'BTC-USD benchmark not provided',
      });
    }
    const productBars = visibleFinalizedBars(bundle.bars, bundle.now);
    const benchBars = visibleFinalizedBars(bench.bars, bundle.now);
    const aligned = alignedSeries(productBars, benchBars);
    if (aligned.aAligned.length < 256) {
      return failResult('insufficient_history', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        sampleCount: aligned.aAligned.length,
        failureReason: `have ${aligned.aAligned.length} aligned bars, need 256`,
      });
    }
    const pR = logReturns(aligned.aAligned.map((b) => b.close));
    const bR = logReturns(aligned.bAligned.map((b) => b.close));
    const chunkSize = Math.floor(pR.length / 4);
    const corrs: number[] = [];
    for (let c = 0; c < 4; c += 1) {
      const pc = pR.slice(c * chunkSize, (c + 1) * chunkSize);
      const bc = bR.slice(c * chunkSize, (c + 1) * chunkSize);
      if (pc.length < 32) continue;
      const cc = correlation(pc, bc);
      if (Number.isFinite(cc)) corrs.push(cc);
    }
    if (corrs.length < 3) {
      return failResult('insufficient_history', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        sampleCount: corrs.length,
        failureReason: 'need >=3 valid chunk correlations',
      });
    }
    const m = mean(corrs.map((c) => Math.abs(c)));
    if (!(m > 0)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash,
        sampleCount: corrs.length,
        failureReason: 'mean absolute correlation is zero',
      });
    }
    return validResult(this.def, {
      value: stdev(corrs) / m,
      confidence: 1,
      sampleCount: corrs.length,
      lookbackStart: aligned.aAligned[0].bucketStart,
      lookbackEnd: aligned.aAligned[aligned.aAligned.length - 1].bucketStart,
      dataAvailableAt: bundle.now,
      inputHash,
      diagnostics: { chunks: corrs },
    });
  },
};

// ---------------------------------------------------------------------------
// AR(1) residual whiteness (Ljung–Box style, lag 1..5)
// ---------------------------------------------------------------------------

/**
 * After fitting AR(1), examine the autocorrelation structure of the
 * residuals at lags 1..5. A truly OU-like series has residuals with
 * near-zero autocorrelation. We report max |autocorrelation| across
 * lags 1..5 — smaller = whiter = more OU-like.
 */
export const ar1ResidualWhitenessFeature = {
  def: def({
    key: 'stat.ar1_residual_whiteness',
    version: '1',
    description:
      'Max absolute residual autocorrelation at lags 1..5 after AR(1) fit. Lower = whiter residuals = cleaner OU signal.',
    inputRequirements: 'finalized close-price candles (>=256 obs)',
    lookbackMs: 0,
    minimumSampleCount: 256,
    outputType: 'scalar',
    unit: 'correlation',
    validRangeMin: 0,
    validRangeMax: 1,
    missingDataPolicy: 'drop gapped buckets',
    stalenessPolicy: 'inherits bundle honesty barrier',
  }),
  compute(bundle: FeatureInputBundle): FeatureResult {
    const pf = preflight(this.def, bundle, 257);
    if ('status' in pf) return pf;
    const y = pf.closes.map((c) => Math.log(c));
    const x = y.slice(0, -1);
    const yn = y.slice(1);
    const phi = olsBeta(x, yn, true);
    if (!Number.isFinite(phi)) {
      return failResult('numerical_failure', this.def, {
        dataAvailableAt: bundle.now,
        inputHash: pf.inputHash,
        sampleCount: yn.length,
        lookbackStart: pf.lookbackStart,
        lookbackEnd: pf.lookbackEnd,
        failureReason: 'AR(1) slope undefined',
      });
    }
    const mx = mean(x);
    const my = mean(yn);
    const c = my - phi * mx;
    const residuals = yn.map((v, i) => v - (c + phi * x[i]));
    let maxAbs = 0;
    for (let lag = 1; lag <= 5; lag += 1) {
      const ac = autocorrelation(residuals, lag);
      if (Number.isFinite(ac) && Math.abs(ac) > maxAbs) maxAbs = Math.abs(ac);
    }
    return validResult(this.def, {
      value: maxAbs,
      confidence: 1,
      sampleCount: residuals.length,
      lookbackStart: pf.lookbackStart,
      lookbackEnd: pf.lookbackEnd,
      dataAvailableAt: bundle.now,
      inputHash: pf.inputHash,
      diagnostics: { phi, intercept: c },
    });
  },
};

export const STAGE2_FEATURES: readonly Stage1Feature[] = [
  adfLiteFeature,
  kpssLiteFeature,
  ouHalfLifeFeature,
  rangeStabilityFeature,
  btcCorrelationStabilityFeature,
  ar1ResidualWhitenessFeature,
] as const;
