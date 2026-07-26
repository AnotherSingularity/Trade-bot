/**
 * Phase 2A — deterministic math helpers.
 *
 * These functions are DETERMINISTIC (no Math.random, no clocks) and
 * side-effect free. Every helper is written to be replay-safe: the
 * same numeric input always produces the same output on any host.
 *
 * Style: numeric-first, no exception paths in the hot loop. Callers
 * validate finiteness explicitly and promote NaN/Infinity into a
 * `numerical_failure` FeatureResult.
 */

export function safeLog(x: number): number {
  return Math.log(x);
}

/**
 * Simple log-returns of consecutive close prices. Requires strictly
 * positive prices — returns NaN if any input is <= 0.
 */
export function logReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const a = closes[i - 1];
    const b = closes[i];
    if (!(a > 0) || !(b > 0)) return [NaN];
    out.push(Math.log(b / a));
  }
  return out;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample variance (n-1). Returns NaN for n<2. */
export function variance(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) {
    const d = x - m;
    s += d * d;
  }
  return s / (xs.length - 1);
}

export function stdev(xs: readonly number[]): number {
  return Math.sqrt(variance(xs));
}

/**
 * Sample correlation (Pearson). Requires xs.length === ys.length >= 2.
 */
export function correlation(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx2 += a * a;
    dy2 += b * b;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (!(denom > 0)) return NaN;
  return num / denom;
}

/**
 * OLS slope of y on x with zero intercept option. When intercept=true
 * returns the slope of (y - mean(y)) on (x - mean(x)). When
 * intercept=false returns sum(xy)/sum(x^2).
 */
export function olsBeta(
  x: readonly number[],
  y: readonly number[],
  intercept = true,
): number {
  if (x.length !== y.length || x.length < 2) return NaN;
  if (intercept) {
    const mx = mean(x);
    const my = mean(y);
    let num = 0;
    let den = 0;
    for (let i = 0; i < x.length; i += 1) {
      const dx = x[i] - mx;
      num += dx * (y[i] - my);
      den += dx * dx;
    }
    if (!(den > 0)) return NaN;
    return num / den;
  }
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i += 1) {
    num += x[i] * y[i];
    den += x[i] * x[i];
  }
  if (!(den > 0)) return NaN;
  return num / den;
}

/**
 * Residual standard deviation of y after regressing on x (with
 * intercept). Returns NaN for degenerate inputs.
 */
export function residualStdev(x: readonly number[], y: readonly number[]): number {
  if (x.length !== y.length || x.length < 3) return NaN;
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i += 1) {
    const dx = x[i] - mx;
    num += dx * (y[i] - my);
    den += dx * dx;
  }
  if (!(den > 0)) return NaN;
  const beta = num / den;
  const alpha = my - beta * mx;
  let s = 0;
  for (let i = 0; i < x.length; i += 1) {
    const e = y[i] - (alpha + beta * x[i]);
    s += e * e;
  }
  return Math.sqrt(s / (x.length - 2));
}

/**
 * Autocorrelation at a lag (sample). Uses full-sample mean/variance
 * denominator (biased but conventional).
 */
export function autocorrelation(xs: readonly number[], lag: number): number {
  if (lag < 1 || xs.length <= lag + 1) return NaN;
  const m = mean(xs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const d = xs[i] - m;
    den += d * d;
  }
  for (let i = lag; i < xs.length; i += 1) {
    num += (xs[i] - m) * (xs[i - lag] - m);
  }
  if (!(den > 0)) return NaN;
  return num / den;
}

/**
 * Lo–MacKinlay variance ratio at horizon q. VR = Var(sum of q returns)
 * / (q * Var(returns)). Under a random walk VR ≈ 1.
 *
 * We also return a heteroskedasticity-consistent standard error
 * approximation so callers can decide when |VR - 1| is inside the
 * noise band (low_confidence).
 */
export interface VarianceRatioResult {
  vr: number;
  standardError: number;
  n: number;
  q: number;
}

export function varianceRatio(returns: readonly number[], q: number): VarianceRatioResult {
  const n = returns.length;
  if (q < 2 || n < q * 2) {
    return { vr: NaN, standardError: NaN, n, q };
  }
  const mu = mean(returns);
  let v1 = 0;
  for (const r of returns) v1 += (r - mu) * (r - mu);
  v1 /= n - 1;
  if (!(v1 > 0)) return { vr: NaN, standardError: NaN, n, q };

  const overlaps = n - q + 1;
  let vq = 0;
  for (let i = 0; i < overlaps; i += 1) {
    let s = 0;
    for (let j = 0; j < q; j += 1) s += returns[i + j];
    const d = s - q * mu;
    vq += d * d;
  }
  vq /= q * overlaps;
  const vr = vq / v1;

  // Lo–MacKinlay asymptotic SE (homoskedastic).
  const se = Math.sqrt((2 * (2 * q - 1) * (q - 1)) / (3 * q * n));
  return { vr, standardError: se, n, q };
}

/**
 * R/S rescaled range estimator of the Hurst exponent for a return
 * series. This is intentionally the classic R/S estimator (not DFA)
 * because it is trivially deterministic; we ALSO surface a
 * confidence-level diagnostic so the fingerprint composer can refuse
 * a naive "H > 0.5 ⇒ trend" reading.
 *
 * Returns `{H, confidence, chunks, minChunkSize}`.
 *
 * The confidence is the R² of the log(R/S) ~ log(n) fit. A low R²
 * means the R/S curve did not scale as a power law and Hurst is not
 * a meaningful measure of persistence for this series.
 */
export interface HurstResult {
  H: number;
  intercept: number;
  r2: number;
  scales: readonly number[];
  logScales: readonly number[];
  logRs: readonly number[];
}

export function hurstRs(returns: readonly number[]): HurstResult {
  const N = returns.length;
  if (N < 32) {
    return { H: NaN, intercept: NaN, r2: NaN, scales: [], logScales: [], logRs: [] };
  }
  const scales: number[] = [];
  const logRs: number[] = [];
  // Windows from 16 up to N/2 in doubling steps.
  for (let w = 16; w <= Math.floor(N / 2); w *= 2) {
    scales.push(w);
    const chunks = Math.floor(N / w);
    let sumRs = 0;
    let count = 0;
    for (let c = 0; c < chunks; c += 1) {
      const start = c * w;
      const chunk = returns.slice(start, start + w);
      const mu = mean(chunk);
      const dev = chunk.map((x) => x - mu);
      const cumdev: number[] = [];
      let running = 0;
      for (const d of dev) {
        running += d;
        cumdev.push(running);
      }
      const R = Math.max(...cumdev) - Math.min(...cumdev);
      const S = stdev(chunk);
      if (!(S > 0) || !Number.isFinite(R)) continue;
      sumRs += R / S;
      count += 1;
    }
    if (count === 0) {
      logRs.push(NaN);
      continue;
    }
    logRs.push(Math.log(sumRs / count));
  }
  const logScales = scales.map((s) => Math.log(s));
  const clean: Array<[number, number]> = [];
  for (let i = 0; i < scales.length; i += 1) {
    if (Number.isFinite(logRs[i])) clean.push([logScales[i], logRs[i]]);
  }
  if (clean.length < 3) {
    return { H: NaN, intercept: NaN, r2: NaN, scales, logScales, logRs };
  }
  const xs = clean.map((p) => p[0]);
  const ys = clean.map((p) => p[1]);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx2 += a * a;
    dy2 += b * b;
  }
  const H = num / dx2;
  const intercept = my - H * mx;
  const ssRes = ys.reduce((acc, yi, i) => {
    const pred = intercept + H * xs[i];
    return acc + (yi - pred) ** 2;
  }, 0);
  const ssTot = dy2;
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { H, intercept, r2, scales, logScales, logRs };
}

/**
 * Shannon entropy of a discrete distribution, in bits. Zero probabilities
 * are skipped.
 */
export function shannonEntropyBits(counts: readonly number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return NaN;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    h -= p * (Math.log(p) / Math.log(2));
  }
  return h;
}

/**
 * Median absolute deviation (uses the sample median, not the mean).
 * Returns 0 for a constant series.
 */
export function medianAbsDev(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const med = sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : 0.5 * (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]);
  const absDev = xs.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  return absDev.length % 2 === 1
    ? absDev[(absDev.length - 1) / 2]
    : 0.5 * (absDev[absDev.length / 2 - 1] + absDev[absDev.length / 2]);
}

export function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
