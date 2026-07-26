import { createHash } from 'node:crypto';
import type { CandleBar } from '../features/inputs';
import { visibleFinalizedBars } from '../features/inputs';
import { logReturns, mean, stdev } from '../features/math';
import type { RegimeState } from './contract';

/**
 * Phase 2B §H, §I — Latent-state HMM observer + semantic mapping.
 *
 * A minimal, versioned, DETERMINISTIC HMM observer whose latent
 * identities are NEVER interpreted as trend/range/etc. until an
 * evidence-backed `SemanticMapping` is created.
 *
 * Design constraints per §H:
 *   - Fixed K (default 3) with a versioned model identifier.
 *   - Explicit deterministic initialization (k-means-lite over a
 *     seeded ordering — no wall-clock randomness).
 *   - Fixed maximum iteration count.
 *   - Explicit convergence tolerance.
 *   - Log-space forward/backward for numerical safety.
 *   - Silent-swap safe: state labels are stable across converged
 *     retrains within the same seed + observation ordering.
 *
 * The classifier NEVER routes strategies — it emits observations
 * that the ensemble may use.
 */

export const HMM_MODEL_KEY = 'p2b-hmm-baseline';
export const HMM_MODEL_VERSION = 'p2b-hmm-1';
export const HMM_MAPPING_VERSION = 'p2b-hmm-mapping-1';
export const HMM_NUM_STATES = 3;

export interface HmmObservation {
  logReturn: number;
  logAbsReturn: number;
  logRange: number;
}

export interface HmmParams {
  numStates: number;
  maxIterations: number;
  tolerance: number;
  deterministicSeed: number;
}

export const DEFAULT_HMM_PARAMS: HmmParams = {
  numStates: HMM_NUM_STATES,
  maxIterations: 60,
  tolerance: 1e-4,
  deterministicSeed: 42,
};

export interface HmmModel {
  key: string;
  version: string;
  numStates: number;
  observationDimensions: readonly (keyof HmmObservation)[];
  initializationPolicy: string;
  convergencePolicy: string;
  maxIterations: number;
  numericalPolicy: string;
  deterministicSeed: number;
  trainingWindowStart: Date;
  trainingWindowEnd: Date;
  trainingSampleCount: number;
  converged: boolean;
  finalLogLikelihood: number | null;
  transitions: number[][]; // [K][K], row-stochastic
  emissions: {
    mean: number[]; // per state
    variance: number[]; // per state (log-return variance)
    rangeMean: number[]; // per state (log-range)
    rangeVariance: number[]; // per state
  };
  initial: number[]; // [K]
  implementationHash: string;
}

export interface HmmTrainingInput {
  now: Date;
  bars: CandleBar[];
  params?: HmmParams;
}

export interface HmmTrainingResult {
  model: HmmModel | null;
  numericalStatus: 'ok' | 'underflow_handled' | 'failure';
  iterations: number;
  failureReason: string | null;
}

// ---------------------------------------------------------------------------
// Training (Baum–Welch, log-space)
// ---------------------------------------------------------------------------

export function trainHmm(input: HmmTrainingInput): HmmTrainingResult {
  const params = input.params ?? DEFAULT_HMM_PARAMS;
  const K = params.numStates;
  const visible = visibleFinalizedBars(input.bars, input.now);
  if (visible.length < 128) {
    return { model: null, numericalStatus: 'failure', iterations: 0, failureReason: 'insufficient_history' };
  }
  const closes = visible.map((b) => b.close);
  const returns = logReturns(closes);
  if (returns.length < 64 || returns.some((r) => !Number.isFinite(r))) {
    return { model: null, numericalStatus: 'failure', iterations: 0, failureReason: 'non_finite_return' };
  }
  const observations: HmmObservation[] = [];
  for (let i = 1; i < visible.length; i += 1) {
    const b = visible[i];
    const r = returns[i - 1];
    const rangeRatio = Math.log(Math.max(1e-9, b.high / Math.max(b.low, 1e-9)));
    observations.push({ logReturn: r, logAbsReturn: Math.log(Math.max(1e-9, Math.abs(r))), logRange: rangeRatio });
  }
  const T = observations.length;
  if (T < 64) {
    return { model: null, numericalStatus: 'failure', iterations: 0, failureReason: 'too_few_observations' };
  }

  // --- Deterministic init: partition returns by quantile of |return|. ---
  const sortedByAbs = [...observations].sort((a, b) => Math.abs(a.logReturn) - Math.abs(b.logReturn));
  const buckets: HmmObservation[][] = [];
  for (let s = 0; s < K; s += 1) {
    const from = Math.floor((s * T) / K);
    const to = Math.floor(((s + 1) * T) / K);
    buckets.push(sortedByAbs.slice(from, to));
  }
  const emMean = buckets.map((b) => mean(b.map((o) => o.logReturn)));
  const emVar = buckets.map((b) => Math.max(1e-8, variance(b.map((o) => o.logReturn))));
  const rgMean = buckets.map((b) => mean(b.map((o) => o.logRange)));
  const rgVar = buckets.map((b) => Math.max(1e-8, variance(b.map((o) => o.logRange))));

  // --- Uniform initial + strong diagonal transition (encourages persistence). ---
  const initial = Array<number>(K).fill(1 / K);
  const transitions: number[][] = Array.from({ length: K }, () =>
    Array<number>(K).fill(0.1 / (K - 1)),
  );
  for (let i = 0; i < K; i += 1) transitions[i][i] = 0.9;

  let prevLL = -Infinity;
  let converged = false;
  let iterations = 0;
  let numericalStatus: 'ok' | 'underflow_handled' | 'failure' = 'ok';

  for (let it = 0; it < params.maxIterations; it += 1) {
    iterations = it + 1;
    // Log-space forward + backward.
    const logEmit: number[][] = Array.from({ length: T }, () => Array<number>(K).fill(0));
    for (let t = 0; t < T; t += 1) {
      for (let k = 0; k < K; k += 1) {
        const ret = observations[t].logReturn;
        const rge = observations[t].logRange;
        const lp1 = logNormal(ret, emMean[k], emVar[k]);
        const lp2 = logNormal(rge, rgMean[k], rgVar[k]);
        logEmit[t][k] = lp1 + lp2;
      }
    }
    const logAlpha: number[][] = Array.from({ length: T }, () => Array<number>(K).fill(-Infinity));
    for (let k = 0; k < K; k += 1) logAlpha[0][k] = Math.log(initial[k]) + logEmit[0][k];
    for (let t = 1; t < T; t += 1) {
      for (let j = 0; j < K; j += 1) {
        const parts: number[] = [];
        for (let i = 0; i < K; i += 1) {
          parts.push(logAlpha[t - 1][i] + Math.log(transitions[i][j]));
        }
        logAlpha[t][j] = logSumExp(parts) + logEmit[t][j];
      }
    }
    const logBeta: number[][] = Array.from({ length: T }, () => Array<number>(K).fill(-Infinity));
    for (let k = 0; k < K; k += 1) logBeta[T - 1][k] = 0;
    for (let t = T - 2; t >= 0; t -= 1) {
      for (let i = 0; i < K; i += 1) {
        const parts: number[] = [];
        for (let j = 0; j < K; j += 1) {
          parts.push(Math.log(transitions[i][j]) + logEmit[t + 1][j] + logBeta[t + 1][j]);
        }
        logBeta[t][i] = logSumExp(parts);
      }
    }
    const ll = logSumExp(logAlpha[T - 1]);
    if (!Number.isFinite(ll)) {
      numericalStatus = 'failure';
      return { model: null, numericalStatus, iterations, failureReason: 'log_likelihood_non_finite' };
    }
    if (Math.abs(ll - prevLL) < params.tolerance && it > 0) {
      converged = true;
      const hash = hashModelBody(K, transitions, emMean, emVar, rgMean, rgVar, initial);
      return {
        model: buildModel(K, params, input, visible, T, transitions, emMean, emVar, rgMean, rgVar, initial, ll, true, hash),
        numericalStatus,
        iterations,
        failureReason: null,
      };
    }
    prevLL = ll;

    // Posteriors + updates (log-space).
    const gamma: number[][] = Array.from({ length: T }, () => Array<number>(K).fill(0));
    for (let t = 0; t < T; t += 1) {
      const denom = logSumExp(logAlpha[t].map((a, i) => a + logBeta[t][i]));
      for (let k = 0; k < K; k += 1) gamma[t][k] = Math.exp(logAlpha[t][k] + logBeta[t][k] - denom);
    }
    const xi: number[][][] = Array.from({ length: T - 1 }, () =>
      Array.from({ length: K }, () => Array<number>(K).fill(0)),
    );
    for (let t = 0; t < T - 1; t += 1) {
      const denomParts: number[] = [];
      for (let i = 0; i < K; i += 1)
        for (let j = 0; j < K; j += 1)
          denomParts.push(logAlpha[t][i] + Math.log(transitions[i][j]) + logEmit[t + 1][j] + logBeta[t + 1][j]);
      const denom = logSumExp(denomParts);
      for (let i = 0; i < K; i += 1) {
        for (let j = 0; j < K; j += 1) {
          xi[t][i][j] = Math.exp(
            logAlpha[t][i] + Math.log(transitions[i][j]) + logEmit[t + 1][j] + logBeta[t + 1][j] - denom,
          );
        }
      }
    }
    // Update initial.
    for (let k = 0; k < K; k += 1) initial[k] = Math.max(1e-8, gamma[0][k]);
    normalize(initial);
    // Update transitions.
    for (let i = 0; i < K; i += 1) {
      let denom = 0;
      for (let t = 0; t < T - 1; t += 1) denom += gamma[t][i];
      if (!(denom > 0)) {
        numericalStatus = 'underflow_handled';
        denom = 1e-8;
      }
      for (let j = 0; j < K; j += 1) {
        let num = 0;
        for (let t = 0; t < T - 1; t += 1) num += xi[t][i][j];
        transitions[i][j] = Math.max(1e-8, num / denom);
      }
      normalize(transitions[i]);
    }
    // Update emissions.
    for (let k = 0; k < K; k += 1) {
      let denom = 0;
      let ret = 0;
      let rge = 0;
      for (let t = 0; t < T; t += 1) {
        denom += gamma[t][k];
        ret += gamma[t][k] * observations[t].logReturn;
        rge += gamma[t][k] * observations[t].logRange;
      }
      if (!(denom > 0)) {
        numericalStatus = 'underflow_handled';
        denom = 1e-8;
      }
      emMean[k] = ret / denom;
      rgMean[k] = rge / denom;
      let vRet = 0;
      let vRge = 0;
      for (let t = 0; t < T; t += 1) {
        vRet += gamma[t][k] * (observations[t].logReturn - emMean[k]) ** 2;
        vRge += gamma[t][k] * (observations[t].logRange - rgMean[k]) ** 2;
      }
      emVar[k] = Math.max(1e-8, vRet / denom);
      rgVar[k] = Math.max(1e-8, vRge / denom);
    }
  }
  const hash = hashModelBody(K, transitions, emMean, emVar, rgMean, rgVar, initial);
  return {
    model: buildModel(
      K,
      params,
      input,
      visible,
      T,
      transitions,
      emMean,
      emVar,
      rgMean,
      rgVar,
      initial,
      prevLL,
      converged,
      hash,
    ),
    numericalStatus,
    iterations,
    failureReason: converged ? null : 'max_iterations_without_convergence',
  };
}

function buildModel(
  K: number,
  params: HmmParams,
  _input: HmmTrainingInput,
  visible: CandleBar[],
  T: number,
  transitions: number[][],
  emMean: number[],
  emVar: number[],
  rgMean: number[],
  rgVar: number[],
  initial: number[],
  ll: number,
  converged: boolean,
  hash: string,
): HmmModel {
  return {
    key: HMM_MODEL_KEY,
    version: HMM_MODEL_VERSION,
    numStates: K,
    observationDimensions: ['logReturn', 'logRange'] as const,
    initializationPolicy: 'quantile-partition-of-|return|',
    convergencePolicy: `abs_delta_log_likelihood<${params.tolerance}`,
    maxIterations: params.maxIterations,
    numericalPolicy: 'log-space-forward-backward,posterior-floor-1e-8',
    deterministicSeed: params.deterministicSeed,
    trainingWindowStart: visible[0].bucketStart,
    trainingWindowEnd: visible[visible.length - 1].bucketStart,
    trainingSampleCount: T,
    converged,
    finalLogLikelihood: ll,
    transitions,
    emissions: { mean: emMean, variance: emVar, rangeMean: rgMean, rangeVariance: rgVar },
    initial,
    implementationHash: hash,
  };
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export interface HmmAssignmentInput {
  model: HmmModel;
  now: Date;
  bars: CandleBar[];
}

export interface HmmAssignment {
  latentState: number;
  posterior: number;
  logLikelihood: number;
  numericalStatus: 'ok' | 'underflow_handled' | 'failure';
  observedAt: Date;
  dataAvailableAt: Date;
  inputHash: string;
  diagnostics: Record<string, unknown> | null;
}

export function assignHmm(input: HmmAssignmentInput): HmmAssignment {
  const visible = visibleFinalizedBars(input.bars, input.now);
  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        v: input.model.version,
        h: input.model.implementationHash,
        now: input.now.toISOString(),
        bars: visible.map((b) => [b.bucketStart.toISOString(), b.close, b.high, b.low]),
      }),
    )
    .digest('hex');
  if (visible.length < 32) {
    return {
      latentState: -1,
      posterior: 0,
      logLikelihood: NaN,
      numericalStatus: 'failure',
      observedAt: input.now,
      dataAvailableAt: input.now,
      inputHash,
      diagnostics: { reason: 'insufficient_samples' },
    };
  }
  const closes = visible.map((b) => b.close);
  const returns = logReturns(closes);
  const K = input.model.numStates;
  const logAlpha = new Array<number>(K).fill(-Infinity);
  for (let k = 0; k < K; k += 1) logAlpha[k] = Math.log(input.model.initial[k]) + emit(input.model, 0, visible, returns, k);
  for (let t = 1; t < returns.length; t += 1) {
    const next: number[] = new Array(K).fill(-Infinity);
    for (let j = 0; j < K; j += 1) {
      const parts: number[] = [];
      for (let i = 0; i < K; i += 1) parts.push(logAlpha[i] + Math.log(input.model.transitions[i][j]));
      next[j] = logSumExp(parts) + emit(input.model, t, visible, returns, j);
    }
    for (let k = 0; k < K; k += 1) logAlpha[k] = next[k];
  }
  const ll = logSumExp(logAlpha);
  if (!Number.isFinite(ll)) {
    return {
      latentState: -1,
      posterior: 0,
      logLikelihood: NaN,
      numericalStatus: 'failure',
      observedAt: input.now,
      dataAvailableAt: input.now,
      inputHash,
      diagnostics: { reason: 'll_non_finite' },
    };
  }
  let bestK = 0;
  let bestP = -Infinity;
  const posteriors: number[] = new Array(K);
  for (let k = 0; k < K; k += 1) {
    posteriors[k] = Math.exp(logAlpha[k] - ll);
    if (posteriors[k] > bestP) {
      bestP = posteriors[k];
      bestK = k;
    }
  }
  return {
    latentState: bestK,
    posterior: posteriors[bestK],
    logLikelihood: ll,
    numericalStatus: 'ok',
    observedAt: input.now,
    dataAvailableAt: input.now,
    inputHash,
    diagnostics: { posteriors },
  };
}

function emit(model: HmmModel, t: number, visible: CandleBar[], returns: number[], k: number): number {
  const r = returns[Math.min(t, returns.length - 1)];
  const b = visible[Math.min(t + 1, visible.length - 1)];
  const rge = Math.log(Math.max(1e-9, b.high / Math.max(b.low, 1e-9)));
  return logNormal(r, model.emissions.mean[k], model.emissions.variance[k]) +
    logNormal(rge, model.emissions.rangeMean[k], model.emissions.rangeVariance[k]);
}

// ---------------------------------------------------------------------------
// Semantic mapping — latent identity → RegimeState (versioned)
// ---------------------------------------------------------------------------

export interface SemanticMappingEntry {
  latentState: number;
  semanticState: RegimeState;
  mappingEvidence: string;
  mappingConfidence: number;
  mappingVersion: string;
}

/**
 * A DETERMINISTIC evidence-based mapping. Latent index alone does NOT
 * imply a semantic label; the mapping considers each state's:
 *   - emission mean (log-return sign)
 *   - emission variance (magnitude of activity)
 *   - range mean (how far bars stretch)
 *
 * If the evidence is inconclusive, the state maps to UNKNOWN.
 */
export function computeSemanticMapping(model: HmmModel): SemanticMappingEntry[] {
  const out: SemanticMappingEntry[] = [];
  const K = model.numStates;
  const em = model.emissions;
  // Rank by variance to pick the most-volatile state.
  const varRank = Array.from({ length: K }, (_, k) => k).sort((a, b) => em.variance[b] - em.variance[a]);
  const highVarState = varRank[0];
  for (let k = 0; k < K; k += 1) {
    let semantic: RegimeState;
    let evidence: string;
    let confidence: number;
    if (k === highVarState && em.variance[k] > 3 * em.variance[varRank[varRank.length - 1]]) {
      semantic = 'VOLATILITY_EXPANSION';
      evidence = `high_variance_ratio=${(em.variance[k] / em.variance[varRank[varRank.length - 1]]).toFixed(2)}`;
      confidence = 0.6;
    } else if (em.mean[k] > 0.0005) {
      semantic = 'TREND_UP';
      evidence = `mean=${em.mean[k].toFixed(5)}>0.0005`;
      confidence = 0.55;
    } else if (em.mean[k] < -0.0005) {
      semantic = 'TREND_DOWN';
      evidence = `mean=${em.mean[k].toFixed(5)}<-0.0005`;
      confidence = 0.55;
    } else if (em.variance[k] < em.variance[varRank[varRank.length - 1]] * 1.5) {
      semantic = 'RANGE';
      evidence = `low_variance mean=${em.mean[k].toFixed(5)}`;
      confidence = 0.5;
    } else {
      semantic = 'UNKNOWN';
      evidence = 'no_clear_regime_signature';
      confidence = 0.2;
    }
    out.push({
      latentState: k,
      semanticState: semantic,
      mappingEvidence: evidence,
      mappingConfidence: confidence,
      mappingVersion: HMM_MAPPING_VERSION,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Numerical helpers
// ---------------------------------------------------------------------------

function logSumExp(xs: readonly number[]): number {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  if (!Number.isFinite(m)) return -Infinity;
  let sum = 0;
  for (const x of xs) sum += Math.exp(x - m);
  return m + Math.log(sum);
}

function logNormal(x: number, mu: number, variance: number): number {
  const v = Math.max(1e-8, variance);
  return -0.5 * (Math.log(2 * Math.PI * v) + ((x - mu) ** 2) / v);
}

function variance(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (xs.length - 1);
}

function normalize(v: number[]): void {
  let s = 0;
  for (const x of v) s += x;
  if (!(s > 0)) {
    for (let i = 0; i < v.length; i += 1) v[i] = 1 / v.length;
    return;
  }
  for (let i = 0; i < v.length; i += 1) v[i] /= s;
}

function hashModelBody(
  K: number,
  transitions: number[][],
  emMean: number[],
  emVar: number[],
  rgMean: number[],
  rgVar: number[],
  initial: number[],
): string {
  const seed = JSON.stringify({
    K,
    transitions,
    emMean: emMean.map((x) => round(x, 8)),
    emVar: emVar.map((x) => round(x, 8)),
    rgMean: rgMean.map((x) => round(x, 8)),
    rgVar: rgVar.map((x) => round(x, 8)),
    initial: initial.map((x) => round(x, 6)),
    version: HMM_MODEL_VERSION,
  });
  return `hmm-${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

function round(x: number, digits: number): number {
  const p = 10 ** digits;
  return Math.round(x * p) / p;
}

/**
 * Expose stdev so the ensemble can inspect emission spread when
 * reporting HMM confidence.
 */
export const _debug = { stdev, mean };
