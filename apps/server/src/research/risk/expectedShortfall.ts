import { invalidMeasurement, validMeasurement, type RiskMeasurement } from './contract';

/**
 * Phase 2C §Q — Historical Expected Shortfall.
 *
 * Non-parametric. Given a sorted array of historical portfolio
 * returns, compute VaR at the configured confidence level (lower
 * quantile of losses) and ES as the mean of losses beyond that
 * boundary. No normality assumption. No future returns.
 */

export const ES_MODEL_VERSION = 'p2c-es-1';

export interface EsConfig {
  confidenceLevel: number;
  minimumSampleCount: number;
  weightingPolicy: 'equal_weight';
  returnInterval: string;
  missingDataPolicy: 'insufficient_history_when_below_min';
}

export const DEFAULT_ES_CONFIG: EsConfig = {
  confidenceLevel: 0.95,
  minimumSampleCount: 200,
  weightingPolicy: 'equal_weight',
  returnInterval: '5m',
  missingDataPolicy: 'insufficient_history_when_below_min',
};

export interface EsResult {
  var: number; // Value-at-Risk (a loss magnitude, >= 0)
  expectedShortfall: number; // >= 0
  candidateIncrementalEs: number | null;
  sampleCount: number;
  boundaryIndex: number;
}

export function computeHistoricalExpectedShortfall(input: {
  historicalReturns: readonly number[];
  portfolioValueBefore: number;
  candidateIncrementalReturns?: readonly number[] | null;
  now: Date;
  dataAvailableAt: Date;
  config?: EsConfig;
}): RiskMeasurement<EsResult> {
  const config = input.config ?? DEFAULT_ES_CONFIG;
  const meta = {
    measurementKey: 'portfolio.expected_shortfall',
    unit: 'quote',
    observedAt: input.now,
    dataAvailableAt: input.dataAvailableAt,
    policyVersion: 'p2c-risk-1',
    modelVersion: ES_MODEL_VERSION,
    inputHash: `es:${input.historicalReturns.length}:${input.portfolioValueBefore}`,
  };
  if (input.historicalReturns.length < config.minimumSampleCount) {
    return invalidMeasurement<EsResult>('insufficient_history', {
      ...meta,
      failureReason: `have ${input.historicalReturns.length} returns, need ${config.minimumSampleCount}`,
    });
  }
  if (input.historicalReturns.some((r) => !Number.isFinite(r))) {
    return invalidMeasurement<EsResult>('numerical_failure', {
      ...meta,
      failureReason: 'non-finite return',
    });
  }
  const sortedLosses = [...input.historicalReturns]
    .map((r) => -r) // losses as positive numbers
    .sort((a, b) => a - b);
  const n = sortedLosses.length;
  const boundaryIndex = Math.floor(n * config.confidenceLevel);
  const varLoss = Math.max(0, sortedLosses[boundaryIndex] ?? 0);
  const tail = sortedLosses.slice(boundaryIndex).filter((x) => x > 0);
  const esRate = tail.length > 0 ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
  const esQuote = esRate * input.portfolioValueBefore;
  const varQuote = varLoss * input.portfolioValueBefore;
  let candidateIncrementalEs: number | null = null;
  if (input.candidateIncrementalReturns && input.candidateIncrementalReturns.length > 0) {
    const cand = [...input.candidateIncrementalReturns].map((r) => -r).sort((a, b) => a - b);
    const cn = cand.length;
    const cb = Math.floor(cn * config.confidenceLevel);
    const ct = cand.slice(cb).filter((x) => x > 0);
    candidateIncrementalEs = (ct.length > 0 ? ct.reduce((a, b) => a + b, 0) / ct.length : 0) * input.portfolioValueBefore;
  }
  return validMeasurement<EsResult>({
    ...meta,
    value: {
      var: varQuote,
      expectedShortfall: esQuote,
      candidateIncrementalEs,
      sampleCount: n,
      boundaryIndex,
    },
    confidence: 1,
    sampleCount: n,
    diagnostics: {
      confidenceLevel: config.confidenceLevel,
      returnInterval: config.returnInterval,
      weightingPolicy: config.weightingPolicy,
    },
  });
}
