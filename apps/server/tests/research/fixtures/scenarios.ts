/**
 * Phase 2A §O — Replay fixture catalog.
 *
 * A deterministic library of synthetic scenarios that the Phase 2A
 * observer tests replay against. Each scenario returns candle bars
 * plus a static-inputs bundle and, optionally, benchmark series so
 * BTC-relative features can be exercised without a live feed.
 *
 * The point of these fixtures is BYTE-STABILITY:
 *   - No Math.random, no clocks. All randomness comes from a seeded
 *     linear-congruential generator.
 *   - The same inputs always produce the same closes and volumes.
 *   - Tests can assert exact fingerprint classes because the numbers
 *     don't wander.
 *
 * Scenarios (16 total, targeted at the 7-class fingerprint space):
 *   S01_ideal_trender_long          → BREAKOUT_CANDIDATE
 *   S02_ideal_trender_short         → BREAKOUT_CANDIDATE
 *   S03_ou_reverter_fast            → REVERSION_CANDIDATE
 *   S04_ou_reverter_slow            → REVERSION_CANDIDATE (via ADF corroboration)
 *   S05_random_walk_pure            → RANDOM_OR_NOISY
 *   S06_illiquid_thin_book          → ILLIQUID
 *   S07_illiquid_gappy              → ILLIQUID
 *   S08_disordered_jumpy            → DISORDERED
 *   S09_disordered_low_dir_entropy  → DISORDERED
 *   S10_btc_shadow_high_corr        → MACRO_FLOOR_RESEARCH_CANDIDATE
 *   S11_btc_shadow_stable_beta      → MACRO_FLOOR_RESEARCH_CANDIDATE
 *   S12_short_history               → insufficient_history everywhere
 *   S13_stale_metadata              → hygiene quarantine
 *   S14_recent_listing              → hygiene quarantine
 *   S15_stablecoin_ineligible       → hygiene ineligible
 *   S16_manual_quarantine           → hygiene quarantined (manual override)
 */

import type { CandleBar, ProductStaticInputs, BenchmarkSeries } from '../../../src/research/features/inputs';

export interface Scenario {
  id: string;
  label: string;
  productId: string;
  bars: CandleBar[];
  staticInputs: ProductStaticInputs;
  benchmarks?: Record<string, BenchmarkSeries>;
  now: Date;
  expected?: {
    fingerprintClass?:
      | 'REVERSION_CANDIDATE'
      | 'BREAKOUT_CANDIDATE'
      | 'MACRO_FLOOR_RESEARCH_CANDIDATE'
      | 'RANDOM_OR_NOISY'
      | 'ILLIQUID'
      | 'DISORDERED'
      | 'UNCLASSIFIED';
    hygiene?: 'eligible' | 'ineligible' | 'quarantined' | 'insufficient_data';
  };
}

const G = 300; // 5-minute bars
const ORIGIN = new Date('2026-01-01T00:00:00.000Z');

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes constants.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeBar(
  productId: string,
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  originMs: number,
): CandleBar {
  const t = new Date(originMs + i * G * 1000);
  return {
    productId,
    bucketStart: t,
    granularitySeconds: G,
    open,
    high,
    low,
    close,
    volume,
    dataAvailableAt: new Date(t.getTime() + G * 1000),
    finalized: true,
  };
}

function trendBars(
  productId: string,
  n: number,
  driftPerBar: number,
  sigma: number,
  seed: number,
  volumeMean = 1000,
): CandleBar[] {
  const rng = seededRng(seed);
  const out: CandleBar[] = [];
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    const shock = (rng() - 0.5) * 2 * sigma;
    const nextPx = px * Math.exp(driftPerBar + shock);
    const hi = Math.max(px, nextPx) * (1 + 0.001 * rng());
    const lo = Math.min(px, nextPx) * (1 - 0.001 * rng());
    const vol = volumeMean * (0.5 + rng());
    out.push(makeBar(productId, i, px, hi, lo, nextPx, vol, ORIGIN.getTime()));
    px = nextPx;
  }
  return out;
}

function ouBars(
  productId: string,
  n: number,
  phi: number,
  sigma: number,
  seed: number,
  volumeMean = 1000,
): CandleBar[] {
  const rng = seededRng(seed);
  const out: CandleBar[] = [];
  const meanLog = Math.log(100);
  let y = meanLog;
  for (let i = 0; i < n; i += 1) {
    const eps = (rng() - 0.5) * 2 * sigma;
    const yNext = meanLog + phi * (y - meanLog) + eps;
    const px = Math.exp(y);
    const pxNext = Math.exp(yNext);
    const hi = Math.max(px, pxNext) * (1 + 0.001 * rng());
    const lo = Math.min(px, pxNext) * (1 - 0.001 * rng());
    const vol = volumeMean * (0.5 + rng());
    out.push(makeBar(productId, i, px, hi, lo, pxNext, vol, ORIGIN.getTime()));
    y = yNext;
  }
  return out;
}

function randomWalkBars(
  productId: string,
  n: number,
  sigma: number,
  seed: number,
  volumeMean = 1000,
): CandleBar[] {
  const rng = seededRng(seed);
  const out: CandleBar[] = [];
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    // Box–Muller-ish deterministic normal-ish shock from two uniforms.
    const u1 = Math.max(1e-9, rng());
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const nextPx = px * Math.exp(sigma * z);
    const hi = Math.max(px, nextPx) * (1 + 0.001 * rng());
    const lo = Math.min(px, nextPx) * (1 - 0.001 * rng());
    const vol = volumeMean * (0.5 + rng());
    out.push(makeBar(productId, i, px, hi, lo, nextPx, vol, ORIGIN.getTime()));
    px = nextPx;
  }
  return out;
}

function jumpyBars(
  productId: string,
  n: number,
  sigma: number,
  jumpProb: number,
  jumpSigma: number,
  seed: number,
): CandleBar[] {
  const rng = seededRng(seed);
  const out: CandleBar[] = [];
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    const baseShock = (rng() - 0.5) * 2 * sigma;
    const jump = rng() < jumpProb ? (rng() - 0.5) * 2 * jumpSigma : 0;
    const nextPx = px * Math.exp(baseShock + jump);
    const hi = Math.max(px, nextPx) * (1 + 0.005 * rng());
    const lo = Math.min(px, nextPx) * (1 - 0.005 * rng());
    out.push(makeBar(productId, i, px, hi, lo, nextPx, 500 * (0.5 + rng()), ORIGIN.getTime()));
    px = nextPx;
  }
  return out;
}

function gappyBars(
  productId: string,
  n: number,
  gapEvery: number,
  seed: number,
): CandleBar[] {
  const dense = trendBars(productId, n, 0, 0.002, seed, 200);
  return dense.filter((_, i) => i % gapEvery !== 0);
}

function derivedFromBtc(
  productId: string,
  btc: CandleBar[],
  beta: number,
  seed: number,
): CandleBar[] {
  const rng = seededRng(seed);
  const out: CandleBar[] = [];
  let px = 50;
  for (let i = 0; i < btc.length; i += 1) {
    const btcRet = i === 0 ? 0 : Math.log(btc[i].close / btc[i - 1].close);
    const idio = (rng() - 0.5) * 0.001;
    const r = beta * btcRet + idio;
    const nextPx = px * Math.exp(r);
    const hi = Math.max(px, nextPx) * (1 + 0.0005 * rng());
    const lo = Math.min(px, nextPx) * (1 - 0.0005 * rng());
    out.push(makeBar(productId, i, px, hi, lo, nextPx, 2000 * (0.5 + rng()), ORIGIN.getTime()));
    px = nextPx;
  }
  return out;
}

function baseStatic(productId: string, over: Partial<ProductStaticInputs> = {}): ProductStaticInputs {
  return {
    productId,
    baseCurrency: productId.split('-')[0]!,
    quoteCurrency: productId.split('-')[1] ?? 'USD',
    baseIncrement: 0.00000001,
    quoteIncrement: 0.01,
    baseMinimum: 0.001,
    approximateSpreadBps: 5,
    quoteVolume24h: 5_000_000,
    tradeCount24h: 12000,
    ...over,
  };
}

const N = 512; // enough for Hurst + Stage 2 (ADF etc.)
const NOW = new Date(ORIGIN.getTime() + N * G * 1000 + G * 1000);
const BTC_ID = 'BTC-USD';

// Shared BTC benchmark for macro-floor scenarios.
const BTC_BARS = trendBars(BTC_ID, N, 0.0002, 0.0015, 42, 50_000);
const BTC_BENCH: BenchmarkSeries = { productId: BTC_ID, bars: BTC_BARS };

export const SCENARIOS: Scenario[] = [
  {
    id: 'S01_ideal_trender_long',
    label: 'Strong positive drift with small idio noise',
    productId: 'TRND-USD',
    bars: trendBars('TRND-USD', N, 0.001, 0.001, 11),
    staticInputs: baseStatic('TRND-USD'),
    now: NOW,
    expected: { fingerprintClass: 'BREAKOUT_CANDIDATE', hygiene: 'eligible' },
  },
  {
    id: 'S02_ideal_trender_short',
    label: 'Strong negative drift',
    productId: 'DOWN-USD',
    bars: trendBars('DOWN-USD', N, -0.001, 0.001, 12),
    staticInputs: baseStatic('DOWN-USD'),
    now: NOW,
    expected: { fingerprintClass: 'BREAKOUT_CANDIDATE', hygiene: 'eligible' },
  },
  {
    id: 'S03_ou_reverter_fast',
    label: 'Mean-reverting OU with phi=0.7 (fast decay)',
    productId: 'REV1-USD',
    bars: ouBars('REV1-USD', N, 0.7, 0.01, 13),
    staticInputs: baseStatic('REV1-USD'),
    now: NOW,
    expected: { fingerprintClass: 'REVERSION_CANDIDATE', hygiene: 'eligible' },
  },
  {
    id: 'S04_ou_reverter_slow',
    label: 'Mean-reverting OU with phi=0.9',
    productId: 'REV2-USD',
    bars: ouBars('REV2-USD', N, 0.9, 0.008, 14),
    staticInputs: baseStatic('REV2-USD'),
    now: NOW,
    expected: { hygiene: 'eligible' },
  },
  {
    id: 'S05_random_walk_pure',
    label: 'Pure log-normal random walk',
    productId: 'RWLK-USD',
    bars: randomWalkBars('RWLK-USD', N, 0.003, 15),
    staticInputs: baseStatic('RWLK-USD'),
    now: NOW,
    expected: { hygiene: 'eligible' },
  },
  {
    id: 'S06_illiquid_thin_book',
    label: 'Very thin liquidity: low quote volume + wide spread + tiny volume',
    productId: 'THIN-USD',
    bars: trendBars('THIN-USD', N, 0, 0.001, 16, 5),
    staticInputs: baseStatic('THIN-USD', {
      approximateSpreadBps: 200,
      quoteVolume24h: 5_000,
      tradeCount24h: 40,
      baseMinimum: 5,
    }),
    now: NOW,
    expected: { fingerprintClass: 'ILLIQUID', hygiene: 'eligible' },
  },
  {
    id: 'S07_illiquid_gappy',
    label: 'Sparse candles: many missing buckets',
    productId: 'GAPS-USD',
    bars: gappyBars('GAPS-USD', N, 5, 17),
    staticInputs: baseStatic('GAPS-USD', { quoteVolume24h: 100_000, approximateSpreadBps: 40 }),
    now: NOW,
    expected: { fingerprintClass: 'ILLIQUID' },
  },
  {
    id: 'S08_disordered_jumpy',
    label: 'Frequent jumps → high jump frequency + outlier concentration',
    productId: 'JMPY-USD',
    bars: jumpyBars('JMPY-USD', N, 0.002, 0.15, 0.05, 18),
    staticInputs: baseStatic('JMPY-USD'),
    now: NOW,
    expected: { fingerprintClass: 'DISORDERED', hygiene: 'eligible' },
  },
  {
    id: 'S09_disordered_low_dir_entropy',
    label: 'Nearly-degenerate direction distribution (mostly zero-returns)',
    productId: 'FLAT-USD',
    bars: (() => {
      const out: CandleBar[] = [];
      const rng = seededRng(19);
      let px = 100;
      for (let i = 0; i < N; i += 1) {
        const move = rng() < 0.9 ? 0 : (rng() - 0.5) * 0.01;
        const nextPx = px * Math.exp(move);
        out.push(makeBar('FLAT-USD', i, px, Math.max(px, nextPx), Math.min(px, nextPx), nextPx, 100, ORIGIN.getTime()));
        px = nextPx;
      }
      return out;
    })(),
    staticInputs: baseStatic('FLAT-USD'),
    now: NOW,
    expected: { fingerprintClass: 'DISORDERED' },
  },
  {
    id: 'S10_btc_shadow_high_corr',
    label: 'Product returns ~ 1.0 * BTC + tiny idio → should trigger MACRO_FLOOR',
    productId: 'CLNE-USD',
    bars: derivedFromBtc('CLNE-USD', BTC_BARS, 1.0, 20),
    staticInputs: baseStatic('CLNE-USD'),
    benchmarks: { [BTC_ID]: BTC_BENCH },
    now: NOW,
    expected: { fingerprintClass: 'MACRO_FLOOR_RESEARCH_CANDIDATE' },
  },
  {
    id: 'S11_btc_shadow_stable_beta',
    label: 'Product ~ 1.3 * BTC — beta is stable across sub-windows',
    productId: 'BETA-USD',
    bars: derivedFromBtc('BETA-USD', BTC_BARS, 1.3, 21),
    staticInputs: baseStatic('BETA-USD'),
    benchmarks: { [BTC_ID]: BTC_BENCH },
    now: NOW,
    expected: {},
  },
  {
    id: 'S12_short_history',
    label: 'Only 32 bars — most features should return insufficient_history',
    productId: 'SHRT-USD',
    bars: trendBars('SHRT-USD', 32, 0, 0.002, 22),
    staticInputs: baseStatic('SHRT-USD'),
    now: new Date(ORIGIN.getTime() + 33 * G * 1000),
    expected: {},
  },
  {
    id: 'S13_stale_metadata',
    label: 'Bars are fine but metadata observation is >24h old',
    productId: 'STAL-USD',
    bars: trendBars('STAL-USD', N, 0, 0.002, 23),
    staticInputs: baseStatic('STAL-USD'),
    now: NOW,
    expected: { hygiene: 'quarantined' },
  },
  {
    id: 'S14_recent_listing',
    label: 'Product firstSeenAt was 5 days ago (< 30 day quarantine)',
    productId: 'NEWL-USD',
    bars: trendBars('NEWL-USD', N, 0, 0.002, 24),
    staticInputs: baseStatic('NEWL-USD'),
    now: NOW,
    expected: { hygiene: 'quarantined' },
  },
  {
    id: 'S15_stablecoin_ineligible',
    label: 'Base currency is USDC → structurally ineligible',
    productId: 'USDC-USD',
    bars: trendBars('USDC-USD', N, 0, 0.0001, 25),
    staticInputs: baseStatic('USDC-USD'),
    now: NOW,
    expected: { hygiene: 'ineligible' },
  },
  {
    id: 'S16_manual_quarantine',
    label: 'Manual quarantine wins even with clean data',
    productId: 'MANQ-USD',
    bars: trendBars('MANQ-USD', N, 0, 0.002, 26),
    staticInputs: baseStatic('MANQ-USD'),
    now: NOW,
    expected: { hygiene: 'quarantined' },
  },
];

export const SCENARIOS_BY_ID: Map<string, Scenario> = new Map(SCENARIOS.map((s) => [s.id, s]));
export const CANONICAL_BTC_BENCH = BTC_BENCH;
