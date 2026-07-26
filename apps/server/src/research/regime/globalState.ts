import { createHash } from 'node:crypto';
import type { FeatureResult } from '../features/contract';
import type { CandleBar } from '../features/inputs';
import {
  alignedSeries,
  visibleFinalizedBars,
} from '../features/inputs';
import { logReturns, mean, stdev } from '../features/math';
import {
  type RegimeDefinition,
  type RegimeEvidenceItem,
  type RegimeResult,
  failRegime,
  validRegime,
} from './contract';

/**
 * Phase 2B §B — Global market state observer.
 *
 * The global state is a MARKET-WIDE reading derived from BTC, ETH,
 * and cross-sectional statistics over the eligible-product feature
 * set. It is versioned separately from product states and never
 * depends on any single product.
 *
 * Signals considered:
 *   - BTC directional return over the visible window
 *   - ETH directional return over the visible window
 *   - Cross-sectional median product return
 *   - Cross-sectional realized volatility
 *   - Cross-sectional dispersion (interquartile range)
 *   - % products advancing
 *   - % products in volatility expansion
 *   - % illiquid or disordered products
 *   - Benchmark correlation concentration
 *   - Data-quality health across the market
 */

export const GLOBAL_REGIME_KEY = 'global.market_state';
export const GLOBAL_REGIME_VERSION = 'p2b-global-1';
export const GLOBAL_TRANSITION_POLICY_VERSION = 'p2b-transition-1';

export const GLOBAL_DEFINITION: RegimeDefinition = {
  key: GLOBAL_REGIME_KEY,
  version: GLOBAL_REGIME_VERSION,
  scope: 'global',
  description:
    'Multi-signal global market state derived from BTC/ETH direction, cross-sectional return + volatility statistics, breadth of advance, expansion breadth, illiquidity share and correlation concentration. Fails to UNKNOWN under missing benchmarks; DISORDERED under market-wide quality failure.',
  requiredEvidence: [
    'btc.direction',
    'eth.direction',
    'cross.median_return',
    'cross.realized_vol',
    'cross.dispersion',
    'breadth.advance_pct',
    'breadth.expansion_pct',
    'breadth.disordered_pct',
    'quality.health',
  ],
  minimumValidEvidence: 6,
  conflictPolicy: 'reduce_confidence_no_downgrade_to_direction',
  missingDataPolicy: 'unknown_when_below_minimum',
  transitionPolicyVersion: GLOBAL_TRANSITION_POLICY_VERSION,
  status: 'observer',
};

export interface ProductAggregateInput {
  productId: string;
  bars: CandleBar[];
  features: Map<string, FeatureResult>;
  hygieneEligible: boolean;
  fingerprintClass?: string | null;
}

export interface GlobalObserverInput {
  now: Date;
  btcBars: CandleBar[] | null;
  ethBars: CandleBar[] | null;
  products: ProductAggregateInput[];
}

export function evaluateGlobalRegime(input: GlobalObserverInput): RegimeResult {
  const supporting: RegimeEvidenceItem[] = [];
  const conflicting: RegimeEvidenceItem[] = [];
  const missing: RegimeEvidenceItem[] = [];

  const push = (
    bucket: RegimeEvidenceItem[],
    component: string,
    weight: number,
    detail: string,
  ) => {
    bucket.push({ component, componentVersion: GLOBAL_REGIME_VERSION, role: 'supporting', weight, detail });
  };
  const pushMissing = (component: string, detail: string) => {
    missing.push({ component, componentVersion: GLOBAL_REGIME_VERSION, role: 'missing', weight: 0, detail });
  };
  const pushConflict = (component: string, weight: number, detail: string) => {
    conflicting.push({ component, componentVersion: GLOBAL_REGIME_VERSION, role: 'conflicting', weight, detail });
  };

  const inputHash = hashGlobalInput(input);
  const dataAvailableAt = input.now;
  const observedAt = input.now;

  // --- Benchmark direction ---
  const btcRet = benchmarkReturn(input.btcBars, input.now);
  const ethRet = benchmarkReturn(input.ethBars, input.now);
  if (btcRet == null) pushMissing('btc.direction', 'btc bars missing or too short');
  if (ethRet == null) pushMissing('eth.direction', 'eth bars missing or too short');

  // --- Cross-sectional statistics ---
  const productReturns: number[] = [];
  const productVols: number[] = [];
  let expansionCount = 0;
  let disorderedIlliquidCount = 0;
  let qualitySum = 0;
  let qualityCount = 0;
  let advanceCount = 0;
  let considered = 0;
  const benchmarkCorrs: number[] = [];

  for (const p of input.products) {
    if (!p.hygieneEligible) continue;
    considered += 1;
    const meanR = pickValid(p.features, 'ms.mean_log_return');
    if (meanR != null) {
      productReturns.push(meanR);
      if (meanR > 0) advanceCount += 1;
    }
    const rv = pickValid(p.features, 'vol.realized');
    if (rv != null) productVols.push(rv);
    const exp = pickValid(p.features, 'vol.expansion_ratio');
    if (exp != null && exp > 1.5) expansionCount += 1;
    if (p.fingerprintClass === 'ILLIQUID' || p.fingerprintClass === 'DISORDERED') disorderedIlliquidCount += 1;
    const q = pickValid(p.features, 'info.data_quality_penalty');
    if (q != null) {
      qualitySum += q;
      qualityCount += 1;
    }
    const corr = pickValid(p.features, 'bench.btc_corr');
    if (corr != null) benchmarkCorrs.push(Math.abs(corr));
  }

  if (productReturns.length === 0) pushMissing('cross.median_return', 'no valid product returns');
  if (productVols.length === 0) pushMissing('cross.realized_vol', 'no valid product vols');
  if (considered === 0) pushMissing('breadth.advance_pct', 'no eligible products');
  if (qualityCount === 0) pushMissing('quality.health', 'no quality data');

  const medianReturn = productReturns.length > 0 ? median(productReturns) : null;
  const xsDispersion = productReturns.length >= 4 ? iqr(productReturns) : null;
  const xsVol = productVols.length > 0 ? median(productVols) : null;
  const advancePct = considered > 0 ? advanceCount / considered : null;
  const expansionPct = considered > 0 ? expansionCount / considered : null;
  const disorderedPct = considered > 0 ? disorderedIlliquidCount / considered : null;
  const marketQuality = qualityCount > 0 ? qualitySum / qualityCount : null;
  const corrConcentration = benchmarkCorrs.length > 0 ? mean(benchmarkCorrs) : null;

  const validEvidenceCount = [
    btcRet,
    ethRet,
    medianReturn,
    xsVol,
    xsDispersion,
    advancePct,
    expansionPct,
    disorderedPct,
    marketQuality,
  ].filter((v) => v != null).length;

  if (validEvidenceCount < GLOBAL_DEFINITION.minimumValidEvidence) {
    return failRegime('insufficient_history', GLOBAL_DEFINITION, {
      observedAt,
      dataAvailableAt,
      inputHash,
      failureReason: `only ${validEvidenceCount}/${GLOBAL_DEFINITION.minimumValidEvidence} global signals available`,
      missingEvidence: missing,
    });
  }

  // --- DISORDERED override: severe market-wide data-quality failure. ---
  if (marketQuality != null && marketQuality > 0.5) {
    push(supporting, 'quality.health', 0.5, `mkt_quality=${marketQuality.toFixed(3)} > 0.5`);
    return validRegime(GLOBAL_DEFINITION, {
      state: 'DISORDERED',
      confidence: 0.6,
      supportingEvidence: supporting,
      conflictingEvidence: conflicting,
      missingEvidence: missing,
      observedAt,
      dataAvailableAt,
      inputHash,
      diagnostics: {
        marketQuality,
        disorderedPct,
        considered,
      },
    });
  }
  if (disorderedPct != null && disorderedPct > 0.5) {
    push(supporting, 'breadth.disordered_pct', 0.4, `disordered/illiquid=${(disorderedPct * 100).toFixed(1)}%`);
    return validRegime(GLOBAL_DEFINITION, {
      state: 'DISORDERED',
      confidence: 0.55,
      supportingEvidence: supporting,
      conflictingEvidence: conflicting,
      missingEvidence: missing,
      observedAt,
      dataAvailableAt,
      inputHash,
      diagnostics: { disorderedPct, considered },
    });
  }

  // --- CAPITULATION: broad severe drawdown + high vol + high breadth of decline ---
  const bigDown =
    btcRet != null &&
    ethRet != null &&
    medianReturn != null &&
    btcRet < -0.02 &&
    ethRet < -0.02 &&
    medianReturn < -0.01 &&
    advancePct != null &&
    advancePct < 0.15 &&
    xsVol != null &&
    xsVol > 0.05;
  if (bigDown) {
    push(supporting, 'btc.direction', 0.3, `btc=${btcRet!.toFixed(4)}`);
    push(supporting, 'eth.direction', 0.2, `eth=${ethRet!.toFixed(4)}`);
    push(supporting, 'cross.median_return', 0.2, `median=${medianReturn!.toFixed(4)}`);
    push(supporting, 'breadth.advance_pct', 0.15, `advance=${(advancePct! * 100).toFixed(1)}%`);
    push(supporting, 'cross.realized_vol', 0.15, `xs_vol=${xsVol!.toFixed(4)}`);
    return validRegime(GLOBAL_DEFINITION, {
      state: 'CAPITULATION',
      confidence: 0.65,
      supportingEvidence: supporting,
      conflictingEvidence: conflicting,
      missingEvidence: missing,
      observedAt,
      dataAvailableAt,
      inputHash,
      diagnostics: { btcRet, ethRet, medianReturn, advancePct, xsVol, disorderedPct },
    });
  }

  // --- VOLATILITY_EXPANSION: independent of direction ---
  if (expansionPct != null && expansionPct > 0.35 && xsVol != null && xsVol > 0.03) {
    push(supporting, 'breadth.expansion_pct', 0.4, `expansion=${(expansionPct * 100).toFixed(1)}%`);
    push(supporting, 'cross.realized_vol', 0.3, `xs_vol=${xsVol.toFixed(4)}`);
    return validRegime(GLOBAL_DEFINITION, {
      state: 'VOLATILITY_EXPANSION',
      confidence: 0.55,
      supportingEvidence: supporting,
      conflictingEvidence: conflicting,
      missingEvidence: missing,
      observedAt,
      dataAvailableAt,
      inputHash,
      diagnostics: { expansionPct, xsVol, advancePct },
    });
  }

  // --- TREND_UP / TREND_DOWN require a QUORUM of directional signals ---
  const upVotes = trendVotes('up', btcRet, ethRet, medianReturn, advancePct);
  const downVotes = trendVotes('down', btcRet, ethRet, medianReturn, advancePct);

  if (upVotes.count >= 3 && upVotes.count - downVotes.count >= 2) {
    for (const [c, w, d] of upVotes.rows) push(supporting, c, w, d);
    for (const [c, w, d] of downVotes.rows) pushConflict(c, w, d);
    return validRegime(GLOBAL_DEFINITION, {
      state: 'TREND_UP',
      confidence: 0.45 + 0.1 * (upVotes.count - downVotes.count),
      supportingEvidence: supporting,
      conflictingEvidence: conflicting,
      missingEvidence: missing,
      observedAt,
      dataAvailableAt,
      inputHash,
      diagnostics: { btcRet, ethRet, medianReturn, advancePct },
    });
  }
  if (downVotes.count >= 3 && downVotes.count - upVotes.count >= 2) {
    for (const [c, w, d] of downVotes.rows) push(supporting, c, w, d);
    for (const [c, w, d] of upVotes.rows) pushConflict(c, w, d);
    return validRegime(GLOBAL_DEFINITION, {
      state: 'TREND_DOWN',
      confidence: 0.45 + 0.1 * (downVotes.count - upVotes.count),
      supportingEvidence: supporting,
      conflictingEvidence: conflicting,
      missingEvidence: missing,
      observedAt,
      dataAvailableAt,
      inputHash,
      diagnostics: { btcRet, ethRet, medianReturn, advancePct },
    });
  }

  // --- RANGE: stable dispersion + directional votes balanced ---
  if (
    xsDispersion != null &&
    xsDispersion < 0.02 &&
    medianReturn != null &&
    Math.abs(medianReturn) < 0.005 &&
    (advancePct == null || Math.abs(advancePct - 0.5) < 0.15)
  ) {
    push(supporting, 'cross.dispersion', 0.3, `iqr=${xsDispersion.toFixed(4)}`);
    push(supporting, 'cross.median_return', 0.3, `median=${medianReturn.toFixed(4)}`);
    if (advancePct != null) push(supporting, 'breadth.advance_pct', 0.2, `advance=${(advancePct * 100).toFixed(1)}%`);
    return validRegime(GLOBAL_DEFINITION, {
      state: 'RANGE',
      confidence: 0.5,
      supportingEvidence: supporting,
      conflictingEvidence: conflicting,
      missingEvidence: missing,
      observedAt,
      dataAvailableAt,
      inputHash,
      diagnostics: { xsDispersion, medianReturn, advancePct, corrConcentration },
    });
  }

  return failRegime('conflicted', GLOBAL_DEFINITION, {
    observedAt,
    dataAvailableAt,
    inputHash,
    failureReason: 'no directional or range quorum reached',
    supportingEvidence: supporting,
    conflictingEvidence: conflicting,
    missingEvidence: missing,
    diagnostics: {
      btcRet,
      ethRet,
      medianReturn,
      xsDispersion,
      advancePct,
      expansionPct,
      disorderedPct,
      marketQuality,
      upVotes: upVotes.count,
      downVotes: downVotes.count,
    },
  });
}

function trendVotes(
  side: 'up' | 'down',
  btc: number | null,
  eth: number | null,
  median: number | null,
  advance: number | null,
): { count: number; rows: Array<[string, number, string]> } {
  const rows: Array<[string, number, string]> = [];
  const cmp = (v: number | null, threshold: number, name: string, w: number) => {
    if (v == null) return;
    const ok = side === 'up' ? v > threshold : v < -threshold;
    if (ok) rows.push([name, w, `${side}: ${name}=${v.toFixed(4)}`]);
  };
  cmp(btc, 0.002, 'btc.direction', 0.2);
  cmp(eth, 0.002, 'eth.direction', 0.15);
  cmp(median, 0.001, 'cross.median_return', 0.2);
  if (advance != null) {
    const ok = side === 'up' ? advance > 0.6 : advance < 0.4;
    if (ok) rows.push(['breadth.advance_pct', 0.15, `${side}: advance=${(advance * 100).toFixed(1)}%`]);
  }
  return { count: rows.length, rows };
}

function benchmarkReturn(bars: CandleBar[] | null, now: Date): number | null {
  if (!bars || bars.length === 0) return null;
  const visible = visibleFinalizedBars(bars, now);
  if (visible.length < 32) return null;
  const closes = visible.map((b) => b.close);
  const ret = logReturns(closes);
  if (ret.length === 0 || !Number.isFinite(ret[0])) return null;
  return mean(ret);
}

function pickValid(map: Map<string, FeatureResult>, key: string): number | null {
  const r = map.get(key);
  if (!r || r.status !== 'valid' || r.value == null) return null;
  return typeof r.value === 'number' ? r.value : null;
}

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n % 2 === 1) return sorted[(n - 1) / 2];
  return 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
}

function iqr(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const q1 = sorted[Math.floor(n * 0.25)];
  const q3 = sorted[Math.floor(n * 0.75)];
  return q3 - q1;
}

function hashGlobalInput(input: GlobalObserverInput): string {
  const productSummaries = input.products
    .map((p) => ({
      pid: p.productId,
      hy: p.hygieneEligible,
      fc: p.fingerprintClass ?? null,
      mR: firstValidNumber(p.features, 'ms.mean_log_return'),
      rv: firstValidNumber(p.features, 'vol.realized'),
      ex: firstValidNumber(p.features, 'vol.expansion_ratio'),
      dq: firstValidNumber(p.features, 'info.data_quality_penalty'),
      cc: firstValidNumber(p.features, 'bench.btc_corr'),
    }))
    .sort((a, b) => a.pid.localeCompare(b.pid));
  const btcSummary = input.btcBars
    ? { n: input.btcBars.length, last: input.btcBars[input.btcBars.length - 1]?.close ?? null }
    : null;
  const ethSummary = input.ethBars
    ? { n: input.ethBars.length, last: input.ethBars[input.ethBars.length - 1]?.close ?? null }
    : null;
  return createHash('sha256')
    .update(
      JSON.stringify({
        key: GLOBAL_REGIME_KEY,
        version: GLOBAL_REGIME_VERSION,
        now: input.now.toISOString(),
        btc: btcSummary,
        eth: ethSummary,
        products: productSummaries,
      }),
    )
    .digest('hex');
}

function firstValidNumber(map: Map<string, FeatureResult>, key: string): number | null {
  return pickValid(map, key);
}

/**
 * Small helper for callers that only need to know whether a benchmark
 * series is usable at all. Not used by the observer directly but
 * exposed for tests + reporting.
 */
export function isBenchmarkVisible(bars: CandleBar[] | null, now: Date, min = 32): boolean {
  if (!bars) return false;
  return visibleFinalizedBars(bars, now).length >= min;
}

/**
 * Returns the aligned span count between two benchmark series — used
 * by the shortlist to prefer products whose global-state input is
 * well-populated.
 */
export function alignedSpan(a: CandleBar[], b: CandleBar[]): number {
  const aligned = alignedSeries(a, b);
  return aligned.aAligned.length;
}

/**
 * A small structural helper — the tests reach into stdev/mean of a
 * synthetic distribution to prove the observer's math is real.
 */
export function _debug_stats(xs: readonly number[]): { mean: number; stdev: number } {
  return { mean: mean(xs), stdev: stdev(xs) };
}
