import { createHash } from 'node:crypto';
import type { CandleBar } from '../features/inputs';
import { alignedSeries, visibleFinalizedBars } from '../features/inputs';
import { correlation, logReturns } from '../features/math';
import type { RiskMeasurement } from './contract';
import { invalidMeasurement, validMeasurement } from './contract';

/**
 * Phase 2C §K, §L — Correlation and covariance model.
 *
 * Rules:
 *   - Pairwise data MUST be aligned by exact bucket timestamp.
 *   - Missing returns are never zero-filled.
 *   - A minimum overlap threshold is required.
 *   - Correlations outside [-1, 1] fail (never clamped silently).
 *   - Constant series produce an explicit low_confidence or
 *     numerical_failure result, never a silent zero.
 *   - Future observations are prohibited.
 *
 * Shrinkage is intentionally the fixed-diagonal baseline and is
 * accurately named `fixed_diagonal_shrinkage`. A true Ledoit–Wolf
 * implementation is deferred until it can be validated against
 * reference matrices.
 */

export const CORRELATION_MODEL_KEY = 'p2c-correlation-baseline';
export const CORRELATION_MODEL_VERSION = 'p2c-corr-1';
export const CORRELATION_MIN_OVERLAP = 64;
export const CORRELATION_RETURN_INTERVAL = '5m';
export const SHRINKAGE_METHOD = 'fixed_diagonal_shrinkage';
export const SHRINKAGE_COEFFICIENT = 0.1;

export interface CorrelationInputSeries {
  productId: string;
  bars: CandleBar[];
}

export interface CorrelationPairResult {
  productA: string;
  productB: string;
  status:
    | 'valid'
    | 'low_confidence'
    | 'insufficient_history'
    | 'stale'
    | 'invalid_input'
    | 'numerical_failure'
    | 'unresolved_state'
    | 'unsupported';
  correlation: number | null;
  overlapCount: number;
  confidence: number;
  lookbackStart: Date;
  lookbackEnd: Date;
  dataAvailableAt: Date;
}

export function computeCorrelationSnapshot(input: {
  now: Date;
  series: readonly CorrelationInputSeries[];
  minOverlap?: number;
}): {
  pairs: CorrelationPairResult[];
  numericalStatus: 'ok' | 'psd_failure' | 'underflow_handled' | 'failure';
  rawCovarianceHash: string | null;
  shrunkCovarianceHash: string | null;
  inputHash: string;
} {
  const minOverlap = input.minOverlap ?? CORRELATION_MIN_OVERLAP;
  const products = [...input.series].sort((a, b) => a.productId.localeCompare(b.productId));
  const pairs: CorrelationPairResult[] = [];
  const covariances: number[][] = [];
  const productReturns = new Map<string, { returns: number[]; timestamps: number[] }>();
  for (const s of products) {
    const bars = visibleFinalizedBars(s.bars, input.now);
    if (bars.length < 2) {
      productReturns.set(s.productId, { returns: [], timestamps: [] });
      continue;
    }
    const ret = logReturns(bars.map((b) => b.close));
    const ts = bars.slice(1).map((b) => b.bucketStart.getTime());
    productReturns.set(s.productId, { returns: ret.filter((r) => Number.isFinite(r)), timestamps: ts });
  }
  for (let i = 0; i < products.length; i += 1) {
    covariances.push(new Array<number>(products.length).fill(0));
  }
  const dataAvailableAt = input.now;
  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        v: CORRELATION_MODEL_VERSION,
        now: input.now.toISOString(),
        seed: products.map((p) => ({
          pid: p.productId,
          n: p.bars.length,
          last: p.bars[p.bars.length - 1]?.close ?? null,
        })),
      }),
    )
    .digest('hex');
  for (let i = 0; i < products.length; i += 1) {
    for (let j = i + 1; j < products.length; j += 1) {
      const a = products[i];
      const b = products[j];
      const barsA = visibleFinalizedBars(a.bars, input.now);
      const barsB = visibleFinalizedBars(b.bars, input.now);
      const aligned = alignedSeries(barsA, barsB);
      const retA = logReturns(aligned.aAligned.map((x) => x.close));
      const retB = logReturns(aligned.bAligned.map((x) => x.close));
      const overlap = Math.min(retA.length, retB.length);
      const lookbackStart = aligned.aAligned[0]?.bucketStart ?? dataAvailableAt;
      const lookbackEnd = aligned.aAligned[aligned.aAligned.length - 1]?.bucketStart ?? dataAvailableAt;
      if (overlap < minOverlap) {
        pairs.push({
          productA: a.productId,
          productB: b.productId,
          status: 'insufficient_history',
          correlation: null,
          overlapCount: overlap,
          confidence: 0,
          lookbackStart,
          lookbackEnd,
          dataAvailableAt,
        });
        continue;
      }
      if (retA.some((r) => !Number.isFinite(r)) || retB.some((r) => !Number.isFinite(r))) {
        pairs.push({
          productA: a.productId,
          productB: b.productId,
          status: 'numerical_failure',
          correlation: null,
          overlapCount: overlap,
          confidence: 0,
          lookbackStart,
          lookbackEnd,
          dataAvailableAt,
        });
        continue;
      }
      // Constant-series check.
      const uniqueA = new Set(retA.map((r) => r.toFixed(10))).size;
      const uniqueB = new Set(retB.map((r) => r.toFixed(10))).size;
      if (uniqueA === 1 || uniqueB === 1) {
        pairs.push({
          productA: a.productId,
          productB: b.productId,
          status: 'low_confidence',
          correlation: null,
          overlapCount: overlap,
          confidence: 0.1,
          lookbackStart,
          lookbackEnd,
          dataAvailableAt,
        });
        continue;
      }
      const c = correlation(retA, retB);
      if (!Number.isFinite(c) || c < -1 || c > 1) {
        pairs.push({
          productA: a.productId,
          productB: b.productId,
          status: 'numerical_failure',
          correlation: null,
          overlapCount: overlap,
          confidence: 0,
          lookbackStart,
          lookbackEnd,
          dataAvailableAt,
        });
        continue;
      }
      pairs.push({
        productA: a.productId,
        productB: b.productId,
        status: 'valid',
        correlation: c,
        overlapCount: overlap,
        confidence: Math.min(1, overlap / (minOverlap * 2)),
        lookbackStart,
        lookbackEnd,
        dataAvailableAt,
      });
      covariances[i][j] = c;
      covariances[j][i] = c;
    }
    covariances[i][i] = 1;
  }
  const rawHash = hashMatrix(covariances);
  const shrunk = applyDiagonalShrinkage(covariances);
  const shrunkHash = hashMatrix(shrunk);
  const numericalStatus = validateMatrix(shrunk) ? 'ok' : 'psd_failure';
  return {
    pairs,
    numericalStatus,
    rawCovarianceHash: rawHash,
    shrunkCovarianceHash: shrunkHash,
    inputHash,
  };
}

function applyDiagonalShrinkage(cov: readonly (readonly number[])[]): number[][] {
  const n = cov.length;
  const out: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const alpha = SHRINKAGE_COEFFICIENT;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      out[i][j] = i === j ? cov[i][j] * (1 - alpha) + alpha : cov[i][j] * (1 - alpha);
    }
  }
  return out;
}

function validateMatrix(m: readonly (readonly number[])[]): boolean {
  if (m.length === 0) return true;
  for (let i = 0; i < m.length; i += 1) {
    if (m[i][i] < 0) return false;
    for (let j = 0; j < m.length; j += 1) {
      if (!Number.isFinite(m[i][j])) return false;
    }
  }
  return true;
}

function hashMatrix(m: readonly (readonly number[])[]): string {
  return createHash('sha256').update(JSON.stringify(m)).digest('hex');
}

// ---------------------------------------------------------------------------
// Clustering — deterministic connected-components on |corr| > threshold graph
// ---------------------------------------------------------------------------

export const CLUSTERING_POLICY_VERSION = 'p2c-cluster-1';
export const CLUSTERING_ABS_THRESHOLD = 0.7;

export interface ClusterAssignment {
  productId: string;
  clusterKey: string | null;
  membershipStrength: number | null;
  reason: 'clustered' | 'unclustered_no_evidence' | 'unclustered_below_threshold';
}

export function assignClusters(
  products: readonly string[],
  pairs: readonly CorrelationPairResult[],
  threshold: number = CLUSTERING_ABS_THRESHOLD,
): ClusterAssignment[] {
  const sorted = [...products].sort();
  const parent = new Map<string, string>();
  for (const p of sorted) parent.set(p, p);
  const find = (x: string): string => {
    let cur = x;
    while (parent.get(cur) !== cur) cur = parent.get(cur)!;
    parent.set(x, cur);
    return cur;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // deterministic union by lexical order
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  for (const pair of pairs) {
    if (pair.status !== 'valid' || pair.correlation == null) continue;
    if (Math.abs(pair.correlation) >= threshold) union(pair.productA, pair.productB);
  }
  // Determine cluster reason for each product.
  const hasEvidence = new Set<string>();
  for (const p of pairs) {
    if (p.status === 'valid') {
      hasEvidence.add(p.productA);
      hasEvidence.add(p.productB);
    }
  }
  const roots = new Map<string, number>();
  const out: ClusterAssignment[] = [];
  for (const p of sorted) {
    const root = find(p);
    // Product is clustered if some other product shares its root.
    let clusterSize = 0;
    for (const other of sorted) if (find(other) === root) clusterSize += 1;
    if (clusterSize > 1) {
      let idx = roots.get(root);
      if (idx == null) {
        idx = roots.size + 1;
        roots.set(root, idx);
      }
      out.push({
        productId: p,
        clusterKey: `cluster:${root}`,
        membershipStrength: null,
        reason: 'clustered',
      });
    } else {
      out.push({
        productId: p,
        clusterKey: null,
        membershipStrength: null,
        reason: hasEvidence.has(p) ? 'unclustered_below_threshold' : 'unclustered_no_evidence',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// §N — Benchmark beta exposure
// ---------------------------------------------------------------------------

export interface BetaExposureResult {
  signedExposure: number | null;
  absoluteExposure: number | null;
  candidateSignedIncrement: number | null;
  candidateAbsoluteIncrement: number | null;
  positionCount: number;
  missingCount: number;
}

export interface BetaInputPosition {
  productId: string;
  positionQuoteExposure: number;
  beta: number | null;
  betaStatus: 'valid' | 'low_confidence' | 'unknown';
}

export interface BetaCandidateInput {
  productId: string;
  candidateQuoteExposure: number;
  beta: number | null;
  betaStatus: 'valid' | 'low_confidence' | 'unknown';
}

export function measureBetaExposure(
  positions: readonly BetaInputPosition[],
  candidate: BetaCandidateInput,
): RiskMeasurement<BetaExposureResult> {
  const meta = {
    measurementKey: 'beta.exposure',
    unit: 'quote',
    observedAt: new Date(),
    dataAvailableAt: new Date(),
    policyVersion: 'p2c-risk-1',
    modelVersion: CORRELATION_MODEL_VERSION,
    inputHash: `beta:${candidate.productId}:${positions.length}`,
  };
  let signed = 0;
  let abs = 0;
  let missing = 0;
  for (const p of positions) {
    if (p.betaStatus === 'unknown' || p.beta == null) {
      missing += 1;
      continue;
    }
    signed += p.positionQuoteExposure * p.beta;
    abs += Math.abs(p.positionQuoteExposure * p.beta);
  }
  if (missing > 0) {
    // At least one position has unknown beta → unknown exposure.
    return invalidMeasurement<BetaExposureResult>('unresolved_state', {
      ...meta,
      failureReason: `${missing} position(s) with unknown beta`,
    });
  }
  let candidateSigned: number | null = null;
  let candidateAbs: number | null = null;
  if (candidate.beta != null && candidate.betaStatus !== 'unknown') {
    candidateSigned = candidate.candidateQuoteExposure * candidate.beta;
    candidateAbs = Math.abs(candidateSigned);
  }
  return validMeasurement<BetaExposureResult>({
    ...meta,
    value: {
      signedExposure: signed,
      absoluteExposure: abs,
      candidateSignedIncrement: candidateSigned,
      candidateAbsoluteIncrement: candidateAbs,
      positionCount: positions.length,
      missingCount: missing,
    },
    confidence: 1,
    sampleCount: positions.length,
  });
}
