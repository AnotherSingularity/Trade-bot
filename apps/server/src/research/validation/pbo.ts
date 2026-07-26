import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  pboCandidateRankings,
  pboEvaluations,
  pboPartitionResults,
  type PboCandidateRankingRow,
  type PboEvaluationRow,
  type PboPartitionResultRow,
} from '../../db/schema';

/**
 * Phase 2F §G — Probability of Backtest Overfitting.
 *
 * Bailey & López de Prado (2015). We compute:
 *   1. Split the N observations into S non-overlapping partitions.
 *   2. For every combination of S/2 partitions taken as "in-sample" (IS),
 *      the remaining S/2 form the "out-of-sample" (OOS).
 *   3. For each partition combo:
 *        - Rank every candidate strategy's IS performance.
 *        - Take the best-IS candidate's OOS rank.
 *        - Compute the relative rank in [0,1] and its logit.
 *   4. PBO is the fraction of combos where the best-IS candidate lands
 *      below the OOS median (logit < 0).
 *
 * A single candidate cannot receive the same penalty as many; we return
 * `insufficient_candidates`.
 */

export interface PboInput {
  experimentId: number;
  candidates: readonly {
    candidateKey: string;
    observationReturns: readonly number[];
  }[];
  partitionCount: number;
}

export interface PboResult {
  pboEstimate: number | null;
  logitRankMean: number | null;
  partitionResults: Array<{
    partitionIndex: number;
    bestInSampleCandidate: string;
    bestInSampleValue: number;
    outOfSampleValue: number;
    medianOutOfSample: number;
    logitScore: number;
  }>;
  candidateRankings: Array<{
    candidateKey: string;
    inSampleRank: number;
    outOfSampleRank: number;
    relativeRank: number;
  }>;
  confidenceStatus: 'valid' | 'insufficient_candidates' | 'insufficient_partitions' | 'failed';
  failureReason: string | null;
  sampleCount: number;
}

function sharpeRatio(returns: readonly number[]): number {
  if (returns.length === 0) return 0;
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
  const variance = returns.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const sd = Math.sqrt(variance);
  return sd > 0 ? mean / sd : 0;
}

function partitionIndices(N: number, partitionCount: number): number[][] {
  const size = Math.floor(N / partitionCount);
  const out: number[][] = [];
  for (let i = 0; i < partitionCount; i += 1) {
    const start = i * size;
    const end = i === partitionCount - 1 ? N : start + size;
    const seg: number[] = [];
    for (let j = start; j < end; j += 1) seg.push(j);
    out.push(seg);
  }
  return out;
}

function inSampleCombos(partitionCount: number): number[][] {
  const halfSize = Math.floor(partitionCount / 2);
  const combos: number[][] = [];
  const build = (start: number, current: number[]) => {
    if (current.length === halfSize) {
      combos.push([...current]);
      return;
    }
    for (let i = start; i < partitionCount; i += 1) {
      current.push(i);
      build(i + 1, current);
      current.pop();
    }
  };
  build(0, []);
  return combos;
}

export function computePBO(input: PboInput): PboResult {
  const sampleCount = input.candidates.length > 0 ? input.candidates[0].observationReturns.length : 0;
  if (input.candidates.length < 2) {
    return {
      pboEstimate: null, logitRankMean: null,
      partitionResults: [], candidateRankings: [],
      confidenceStatus: 'insufficient_candidates',
      failureReason: 'pbo_requires_multiple_candidates',
      sampleCount,
    };
  }
  if (input.partitionCount < 2 || input.partitionCount > sampleCount) {
    return {
      pboEstimate: null, logitRankMean: null,
      partitionResults: [], candidateRankings: [],
      confidenceStatus: 'insufficient_partitions',
      failureReason: 'partition_count_out_of_range',
      sampleCount,
    };
  }
  const parts = partitionIndices(sampleCount, input.partitionCount);
  const combos = inSampleCombos(input.partitionCount);
  const partitionResults: PboResult['partitionResults'] = [];
  let overfitCount = 0;
  let logitSum = 0;
  const isSampleRankByCandidate = new Map<string, number>();
  const oosSampleRankByCandidate = new Map<string, number>();
  for (let ci = 0; ci < combos.length; ci += 1) {
    const isPartitions = combos[ci];
    const oosPartitions: number[] = [];
    for (let p = 0; p < input.partitionCount; p += 1) if (!isPartitions.includes(p)) oosPartitions.push(p);
    const isIndices = isPartitions.flatMap((p) => parts[p]);
    const oosIndices = oosPartitions.flatMap((p) => parts[p]);
    const isPerformances = input.candidates.map((c) => ({
      key: c.candidateKey,
      value: sharpeRatio(isIndices.map((i) => c.observationReturns[i] ?? 0)),
    }));
    const oosPerformances = input.candidates.map((c) => ({
      key: c.candidateKey,
      value: sharpeRatio(oosIndices.map((i) => c.observationReturns[i] ?? 0)),
    }));
    isPerformances.sort((a, b) => b.value - a.value);
    const bestIS = isPerformances[0];
    const oosValueForBest = oosPerformances.find((p) => p.key === bestIS.key)!.value;
    const oosSorted = [...oosPerformances].sort((a, b) => b.value - a.value);
    const oosRankOfBest = oosSorted.findIndex((p) => p.key === bestIS.key) + 1;
    const oosMedian = oosSorted[Math.floor(oosSorted.length / 2)].value;
    // Relative rank r ∈ (0,1); logit = log(r / (1 - r)). r above median → positive logit.
    const relativeRank = 1 - (oosRankOfBest / (oosSorted.length + 1));
    const clipped = Math.min(0.9999, Math.max(0.0001, relativeRank));
    const logit = Math.log(clipped / (1 - clipped));
    if (logit < 0) overfitCount += 1;
    logitSum += logit;
    partitionResults.push({
      partitionIndex: ci,
      bestInSampleCandidate: bestIS.key,
      bestInSampleValue: bestIS.value,
      outOfSampleValue: oosValueForBest,
      medianOutOfSample: oosMedian,
      logitScore: logit,
    });
    // Track candidate rankings.
    for (let r = 0; r < isPerformances.length; r += 1) {
      const prev = isSampleRankByCandidate.get(isPerformances[r].key) ?? 0;
      isSampleRankByCandidate.set(isPerformances[r].key, prev + (r + 1));
    }
    for (let r = 0; r < oosSorted.length; r += 1) {
      const prev = oosSampleRankByCandidate.get(oosSorted[r].key) ?? 0;
      oosSampleRankByCandidate.set(oosSorted[r].key, prev + (r + 1));
    }
  }
  const pbo = combos.length > 0 ? overfitCount / combos.length : null;
  const logitRankMean = combos.length > 0 ? logitSum / combos.length : null;
  const candidateRankings: PboResult['candidateRankings'] = input.candidates.map((c) => ({
    candidateKey: c.candidateKey,
    inSampleRank: Math.round((isSampleRankByCandidate.get(c.candidateKey) ?? 0) / combos.length),
    outOfSampleRank: Math.round((oosSampleRankByCandidate.get(c.candidateKey) ?? 0) / combos.length),
    relativeRank: input.candidates.length > 1
      ? ((oosSampleRankByCandidate.get(c.candidateKey) ?? 0) / combos.length) / input.candidates.length
      : 0.5,
  }));
  return {
    pboEstimate: pbo,
    logitRankMean,
    partitionResults,
    candidateRankings,
    confidenceStatus: 'valid',
    failureReason: null,
    sampleCount,
  };
}

export async function persistPboEvaluation(experimentId: number, input: PboInput, result: PboResult): Promise<PboEvaluationRow> {
  const inputHash = createHash('sha256').update(JSON.stringify({
    exp: experimentId,
    candidates: input.candidates.map((c) => ({ k: c.candidateKey, n: c.observationReturns.length })),
    pc: input.partitionCount,
  })).digest('hex');
  await db.insert(pboEvaluations).values({
    experimentId,
    candidateCount: input.candidates.length,
    partitionCount: input.partitionCount,
    pboEstimate: result.pboEstimate != null ? result.pboEstimate.toFixed(8) : null,
    logitRank: result.logitRankMean != null ? result.logitRankMean.toFixed(10) : null,
    sampleCount: result.sampleCount,
    confidenceStatus: result.confidenceStatus,
    failureReason: result.failureReason,
    inputHash,
  });
  const [row] = await db.select().from(pboEvaluations).where(eq(pboEvaluations.experimentId, experimentId)).limit(1);
  return row;
}

export async function persistPboCandidateRankings(pboEvaluationId: number, rankings: PboResult['candidateRankings']): Promise<PboCandidateRankingRow[]> {
  const rows: PboCandidateRankingRow[] = [];
  for (const r of rankings) {
    const existing = await db
      .select()
      .from(pboCandidateRankings)
      .where(and(eq(pboCandidateRankings.pboEvaluationId, pboEvaluationId), eq(pboCandidateRankings.candidateKey, r.candidateKey)))
      .limit(1);
    if (existing.length > 0) { rows.push(existing[0]); continue; }
    await db.insert(pboCandidateRankings).values({
      pboEvaluationId,
      candidateKey: r.candidateKey,
      inSampleRank: r.inSampleRank,
      outOfSampleRank: r.outOfSampleRank,
      relativeRank: r.relativeRank.toFixed(8),
    });
    const [row] = await db
      .select()
      .from(pboCandidateRankings)
      .where(and(eq(pboCandidateRankings.pboEvaluationId, pboEvaluationId), eq(pboCandidateRankings.candidateKey, r.candidateKey)))
      .limit(1);
    rows.push(row);
  }
  return rows;
}

export async function persistPboPartitionResults(pboEvaluationId: number, partitions: PboResult['partitionResults']): Promise<PboPartitionResultRow[]> {
  const rows: PboPartitionResultRow[] = [];
  for (const p of partitions) {
    await db.insert(pboPartitionResults).values({
      pboEvaluationId,
      partitionIndex: p.partitionIndex,
      bestInSampleCandidate: p.bestInSampleCandidate,
      bestInSampleValue: p.bestInSampleValue.toFixed(10),
      outOfSampleValue: p.outOfSampleValue.toFixed(10),
      medianOutOfSample: p.medianOutOfSample.toFixed(10),
      logitScore: p.logitScore.toFixed(10),
    });
    const [row] = await db
      .select()
      .from(pboPartitionResults)
      .where(and(eq(pboPartitionResults.pboEvaluationId, pboEvaluationId), eq(pboPartitionResults.partitionIndex, p.partitionIndex)))
      .limit(1);
    rows.push(row);
  }
  return rows;
}
