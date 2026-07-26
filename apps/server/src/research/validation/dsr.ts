import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { deflatedSharpeEvaluations, type DeflatedSharpeEvaluationRow } from '../../db/schema';

/**
 * Phase 2F §H — Deflated Sharpe Ratio (Bailey & López de Prado, 2014).
 *
 * DSR = z( (SR - E[max SR_N]) * sqrt(T - 1) / sqrt(1 - g3*SR + (g4-1)/4 * SR^2) )
 *
 * where:
 *   - SR is the observed Sharpe (net of costs)
 *   - E[max SR_N] is the expected maximum Sharpe under N trials
 *   - g3 is skewness of returns
 *   - g4 is kurtosis (Pearson) — g4 - 1 uses excess kurtosis form
 *   - T is the sample count
 *
 * Notes:
 *   - We use the closed-form approximation for E[max SR_N] via:
 *       E[max SR_N] ≈ (1 - γ) Φ⁻¹(1 - 1/N) + γ Φ⁻¹(1 - 1/(N*e))
 *     where γ ≈ 0.5772 (Euler-Mascheroni) and Φ⁻¹ is the standard normal
 *     inverse CDF, approximated via Beasley-Springer-Moro.
 *   - One trial (N=1) still applies the deflation formula but the
 *     expected-max reduces to Φ⁻¹(0), which is treated as 0. Multiple
 *     trials receive a larger penalty.
 *   - Sample count < minimumSamples returns `insufficient_samples`.
 *   - Zero or non-finite variance returns `invalid_variance`.
 */

const MIN_SAMPLES_FOR_DSR = 30;
const EULER_MASCHERONI = 0.5772156649015329;

// Beasley-Springer-Moro inverse normal CDF
function inverseStandardNormalCdf(p: number): number {
  const A1 = -3.969683028665376e1, A2 = 2.209460984245205e2, A3 = -2.759285104469687e2;
  const A4 = 1.383577518672690e2, A5 = -3.066479806614716e1, A6 = 2.506628277459239;
  const B1 = -5.447609879822406e1, B2 = 1.615858368580409e2, B3 = -1.556989798598866e2;
  const B4 = 6.680131188771972e1, B5 = -1.328068155288572e1;
  const C1 = -7.784894002430293e-3, C2 = -3.223964580411365e-1, C3 = -2.400758277161838;
  const C4 = -2.549732539343734, C5 = 4.374664141464968, C6 = 2.938163982698783;
  const D1 = 7.784695709041462e-3, D2 = 3.224671290700398e-1, D3 = 2.445134137142996;
  const D4 = 3.754408661907416;
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((C1 * q + C2) * q + C3) * q + C4) * q + C5) * q + C6) / ((((D1 * q + D2) * q + D3) * q + D4) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((A1 * r + A2) * r + A3) * r + A4) * r + A5) * r + A6) * q /
      (((((B1 * r + B2) * r + B3) * r + B4) * r + B5) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((C1 * q + C2) * q + C3) * q + C4) * q + C5) * q + C6) /
    ((((D1 * q + D2) * q + D3) * q + D4) * q + 1);
}

function standardNormalCdf(x: number): number {
  // Abramowitz & Stegun approximation.
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1.0 + sign * y);
}

export function expectedMaxSharpeUnderNTrials(numberOfTrials: number): number {
  if (numberOfTrials < 2) return 0;
  const p1 = 1 - 1 / numberOfTrials;
  const p2 = 1 - 1 / (numberOfTrials * Math.E);
  const inv1 = inverseStandardNormalCdf(p1);
  const inv2 = inverseStandardNormalCdf(p2);
  return (1 - EULER_MASCHERONI) * inv1 + EULER_MASCHERONI * inv2;
}

export interface DsrInput {
  netReturns: readonly number[];
  numberOfTrials: number;
  returnInterval: string;
  annualizationFactor: number;
  benchmarkSharpe?: number;
  netOfCosts?: boolean;
}

export interface DsrResult {
  observedSharpe: number | null;
  deflatedSharpe: number | null;
  expectedMaximumSharpe: number;
  sampleCount: number;
  returnSkewness: number | null;
  returnKurtosis: number | null;
  status: 'valid' | 'insufficient_samples' | 'invalid_variance' | 'failed';
  failureReason: string | null;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stddev(xs: readonly number[], mu: number): number {
  return Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / Math.max(1, xs.length - 1));
}

function skewness(xs: readonly number[]): number {
  if (xs.length < 3) return 0;
  const mu = mean(xs);
  const sd = stddev(xs, mu);
  if (sd === 0) return 0;
  return xs.reduce((s, x) => s + ((x - mu) / sd) ** 3, 0) / xs.length;
}

function kurtosis(xs: readonly number[]): number {
  if (xs.length < 4) return 3;
  const mu = mean(xs);
  const sd = stddev(xs, mu);
  if (sd === 0) return 3;
  return xs.reduce((s, x) => s + ((x - mu) / sd) ** 4, 0) / xs.length;
}

export function computeDeflatedSharpe(input: DsrInput): DsrResult {
  const rs = input.netReturns;
  if (rs.length < MIN_SAMPLES_FOR_DSR) {
    return {
      observedSharpe: null, deflatedSharpe: null,
      expectedMaximumSharpe: 0,
      sampleCount: rs.length,
      returnSkewness: null, returnKurtosis: null,
      status: 'insufficient_samples',
      failureReason: `sampleCount<${MIN_SAMPLES_FOR_DSR}`,
    };
  }
  const mu = mean(rs);
  const sd = stddev(rs, mu);
  if (!Number.isFinite(sd) || sd === 0) {
    return {
      observedSharpe: null, deflatedSharpe: null,
      expectedMaximumSharpe: 0,
      sampleCount: rs.length,
      returnSkewness: null, returnKurtosis: null,
      status: 'invalid_variance',
      failureReason: 'zero_or_nonfinite_variance',
    };
  }
  const sr = (mu / sd) * Math.sqrt(input.annualizationFactor);
  const g3 = skewness(rs);
  const g4 = kurtosis(rs);
  const emaxSR = expectedMaxSharpeUnderNTrials(input.numberOfTrials);
  const T = rs.length;
  const denomInner = 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr;
  const denomSafe = Math.max(1e-9, denomInner);
  const z = ((sr - emaxSR) * Math.sqrt(T - 1)) / Math.sqrt(denomSafe);
  const deflated = standardNormalCdf(z);
  return {
    observedSharpe: sr,
    deflatedSharpe: deflated,
    expectedMaximumSharpe: emaxSR,
    sampleCount: T,
    returnSkewness: g3,
    returnKurtosis: g4,
    status: 'valid',
    failureReason: null,
  };
}

export async function persistDsrEvaluation(experimentId: number, input: DsrInput, result: DsrResult): Promise<DeflatedSharpeEvaluationRow> {
  const inputHash = createHash('sha256').update(JSON.stringify({
    exp: experimentId,
    n: input.netReturns.length,
    trials: input.numberOfTrials,
    ann: input.annualizationFactor,
    interval: input.returnInterval,
  })).digest('hex');
  await db.insert(deflatedSharpeEvaluations).values({
    experimentId,
    observedSharpe: result.observedSharpe != null ? result.observedSharpe.toFixed(10) : null,
    deflatedSharpe: result.deflatedSharpe != null ? result.deflatedSharpe.toFixed(10) : null,
    numberOfTrials: input.numberOfTrials,
    sampleCount: result.sampleCount,
    returnInterval: input.returnInterval,
    annualizationFactor: input.annualizationFactor.toFixed(10),
    returnSkewness: result.returnSkewness != null ? result.returnSkewness.toFixed(10) : null,
    returnKurtosis: result.returnKurtosis != null ? result.returnKurtosis.toFixed(10) : null,
    expectedMaximumSharpe: result.expectedMaximumSharpe.toFixed(10),
    benchmarkSharpe: input.benchmarkSharpe != null ? input.benchmarkSharpe.toFixed(10) : null,
    netOfCosts: input.netOfCosts !== false,
    status: result.status,
    failureReason: result.failureReason,
    inputHash,
  });
  const [row] = await db.select().from(deflatedSharpeEvaluations).where(eq(deflatedSharpeEvaluations.experimentId, experimentId)).limit(1);
  return row;
}
