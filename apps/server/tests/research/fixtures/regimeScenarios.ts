/**
 * Phase 2B §Q — Replay fixture catalog (30 multi-period scenarios).
 *
 * Every fixture is a pure function of its scenario id. No wall clock,
 * no Math.random. All series generators are seeded LCG.
 *
 * Scenarios cover:
 *   - stable trend up / down
 *   - stable range
 *   - volatility expansion (no direction)
 *   - upward breakout / downward breakdown
 *   - capitulation-like decline
 *   - noisy high-entropy market
 *   - illiquid product
 *   - regime change (range→trend, trend→range, false break)
 *   - HMM/rule agreement + disagreement
 *   - single-detector triggers, both detectors, detector conflict
 *   - missing benchmark, stale evidence, severe data gap
 *   - state hysteresis, immediate disorder override, state expiry
 *   - challenger/champion agreement + disagreement + abstention
 *   - low confidence, global vs isolated selloff
 */

import type { CandleBar } from '../../../src/research/features/inputs';

export interface RegimeScenario {
  id: string;
  label: string;
  productId: string;
  bars: CandleBar[];
  benchmarkBars?: CandleBar[]; // BTC-USD benchmark for cross-sectional
  now: Date;
  gapCount?: number;
  expected?: {
    baselineState?:
      | 'TREND_UP'
      | 'TREND_DOWN'
      | 'RANGE'
      | 'VOLATILITY_EXPANSION'
      | 'CAPITULATION'
      | 'DISORDERED'
      | 'UNKNOWN';
    changePointTriggered?: boolean;
  };
}

const G = 300;
const ORIGIN = new Date('2026-03-01T00:00:00.000Z');
const N = 512;

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
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
): CandleBar {
  const t = new Date(ORIGIN.getTime() + i * G * 1000);
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
  drift: number,
  sigma: number,
  seed: number,
  volume = 1000,
): CandleBar[] {
  const rng = seededRng(seed);
  const out: CandleBar[] = [];
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    const shock = (rng() - 0.5) * 2 * sigma;
    const next = px * Math.exp(drift + shock);
    const hi = Math.max(px, next) * (1 + 0.001 * rng());
    const lo = Math.min(px, next) * (1 - 0.001 * rng());
    out.push(makeBar(productId, i, px, hi, lo, next, volume * (0.5 + rng())));
    px = next;
  }
  return out;
}

function rangeBars(productId: string, n: number, sigma: number, seed: number): CandleBar[] {
  const rng = seededRng(seed);
  const out: CandleBar[] = [];
  const baseline = 100;
  let px = baseline;
  for (let i = 0; i < n; i += 1) {
    const eps = (rng() - 0.5) * 2 * sigma;
    const next = baseline + 0.9 * (px - baseline) + baseline * eps;
    const hi = Math.max(px, next) * (1 + 0.0005 * rng());
    const lo = Math.min(px, next) * (1 - 0.0005 * rng());
    out.push(makeBar(productId, i, px, hi, lo, next, 1200 * (0.5 + rng())));
    px = next;
  }
  return out;
}

function volatilityExpansionBars(productId: string, n: number, seed: number): CandleBar[] {
  const rng = seededRng(seed);
  const out: CandleBar[] = [];
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    const sigma = i < n / 2 ? 0.001 : 0.006; // step change
    const eps = (rng() - 0.5) * 2 * sigma;
    const next = px * Math.exp(eps);
    const hi = Math.max(px, next) * (1 + 0.002 * rng());
    const lo = Math.min(px, next) * (1 - 0.002 * rng());
    out.push(makeBar(productId, i, px, hi, lo, next, 900 * (0.5 + rng())));
    px = next;
  }
  return out;
}

function breakoutBars(
  productId: string,
  n: number,
  direction: 'up' | 'down',
  seed: number,
): CandleBar[] {
  const rng = seededRng(seed);
  const out: CandleBar[] = [];
  const sign = direction === 'up' ? 1 : -1;
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    const inRange = i < 0.6 * n;
    const drift = inRange ? 0 : sign * 0.002;
    const sigma = inRange ? 0.0015 : 0.0025;
    const eps = (rng() - 0.5) * 2 * sigma;
    const next = px * Math.exp(drift + eps);
    const hi = Math.max(px, next) * (1 + 0.001 * rng());
    const lo = Math.min(px, next) * (1 - 0.001 * rng());
    out.push(makeBar(productId, i, px, hi, lo, next, 1000 * (0.5 + rng())));
    px = next;
  }
  return out;
}

function capitulationBars(productId: string, n: number, seed: number): CandleBar[] {
  const rng = seededRng(seed);
  const out: CandleBar[] = [];
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    const late = i > 0.8 * n;
    const drift = late ? -0.008 : -0.0005;
    const sigma = late ? 0.01 : 0.002;
    const eps = (rng() - 0.5) * 2 * sigma;
    const next = px * Math.exp(drift + eps);
    const hi = Math.max(px, next) * (1 + 0.004 * rng());
    const lo = Math.min(px, next) * (1 - 0.004 * rng());
    out.push(makeBar(productId, i, px, hi, lo, next, late ? 3500 : 1000 * (0.5 + rng())));
    px = next;
  }
  return out;
}

function noisyBars(productId: string, n: number, seed: number): CandleBar[] {
  const rng = seededRng(seed);
  const out: CandleBar[] = [];
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    const eps = (rng() - 0.5) * 0.02;
    const next = px * Math.exp(eps);
    const hi = Math.max(px, next) * (1 + 0.008 * rng());
    const lo = Math.min(px, next) * (1 - 0.008 * rng());
    out.push(makeBar(productId, i, px, hi, lo, next, 500 * (0.5 + rng())));
    px = next;
  }
  return out;
}

function illiquidBars(productId: string, n: number, seed: number): CandleBar[] {
  const rng = seededRng(seed);
  const out: CandleBar[] = [];
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    const zero = rng() < 0.4;
    const eps = zero ? 0 : (rng() - 0.5) * 0.004;
    const next = px * Math.exp(eps);
    const hi = Math.max(px, next) * 1.001;
    const lo = Math.min(px, next) * 0.999;
    out.push(makeBar(productId, i, px, hi, lo, next, zero ? 0 : 20 * (0.5 + rng())));
    px = next;
  }
  return out;
}

function regimeChangeBars(
  productId: string,
  n: number,
  seed: number,
  before: 'range' | 'trend',
  after: 'range' | 'trend',
  direction: 'up' | 'down' = 'up',
): CandleBar[] {
  const half = Math.floor(n / 2);
  const firstHalf =
    before === 'range' ? rangeBars(productId, half, 0.002, seed) : trendBars(productId, half, 0.001, 0.001, seed);
  const secondHalfDrift = direction === 'up' ? 0.001 : -0.001;
  const secondHalf =
    after === 'trend'
      ? trendBars(productId, n - half, secondHalfDrift, 0.001, seed + 1)
      : rangeBars(productId, n - half, 0.002, seed + 1);
  // Chain price continuity: start the second half at the first half's last close.
  const lastPx = firstHalf[firstHalf.length - 1].close;
  const scaled = secondHalf.map((b, i) => {
    const factor = lastPx / 100;
    const idx = half + i;
    const t = new Date(ORIGIN.getTime() + idx * G * 1000);
    return {
      ...b,
      productId,
      bucketStart: t,
      dataAvailableAt: new Date(t.getTime() + G * 1000),
      open: b.open * factor,
      high: b.high * factor,
      low: b.low * factor,
      close: b.close * factor,
    };
  });
  return [...firstHalf, ...scaled];
}

function shortLivedBreakBars(productId: string, n: number, seed: number): CandleBar[] {
  const rng = seededRng(seed);
  const out: CandleBar[] = [];
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    // Short burst up in the last 15 bars, otherwise flat.
    const burst = i >= n - 25 && i < n - 10;
    const drift = burst ? 0.002 : 0;
    const sigma = burst ? 0.002 : 0.0008;
    const eps = (rng() - 0.5) * 2 * sigma;
    const next = px * Math.exp(drift + eps);
    const hi = Math.max(px, next) * 1.001;
    const lo = Math.min(px, next) * 0.999;
    out.push(makeBar(productId, i, px, hi, lo, next, 900 * (0.5 + rng())));
    px = next;
  }
  return out;
}

function gappyBars(productId: string, n: number, seed: number): CandleBar[] {
  return trendBars(productId, n, 0.0, 0.002, seed).filter((_, i) => i % 4 !== 0);
}

function staleBars(productId: string, n: number, seed: number): CandleBar[] {
  return trendBars(productId, n, 0.0005, 0.001, seed).map((b) => ({
    ...b,
    // simulate stale: bars finalized long ago.
    dataAvailableAt: new Date(b.dataAvailableAt.getTime() - 20 * 60 * 60 * 1000),
  }));
}

// Base benchmark (BTC-like) trend series used by the global observer.
const btcBench = trendBars('BTC-USD', N, 0.0005, 0.0015, 42, 50_000);
const btcBenchDown = trendBars('BTC-USD', N, -0.0007, 0.002, 43, 50_000);
const btcBenchExpand = volatilityExpansionBars('BTC-USD', N, 44);

const NOW = new Date(ORIGIN.getTime() + (N + 1) * G * 1000);

export const REGIME_SCENARIOS: RegimeScenario[] = [
  {
    id: 'R01_stable_trend_up',
    label: 'Stable upward trend',
    productId: 'UP1-USD',
    bars: trendBars('UP1-USD', N, 0.001, 0.001, 101),
    benchmarkBars: btcBench,
    now: NOW,
    expected: { baselineState: 'TREND_UP' },
  },
  {
    id: 'R02_stable_trend_down',
    label: 'Stable downward trend',
    productId: 'DN1-USD',
    bars: trendBars('DN1-USD', N, -0.001, 0.001, 102),
    benchmarkBars: btcBenchDown,
    now: NOW,
    expected: { baselineState: 'TREND_DOWN' },
  },
  {
    id: 'R03_stable_range',
    label: 'Stable mean-reverting range',
    productId: 'RG1-USD',
    bars: rangeBars('RG1-USD', N, 0.003, 103),
    benchmarkBars: btcBench,
    now: NOW,
    expected: { baselineState: 'RANGE' },
  },
  {
    id: 'R04_vol_expansion',
    label: 'Volatility expansion without direction',
    productId: 'VX1-USD',
    bars: volatilityExpansionBars('VX1-USD', N, 104),
    benchmarkBars: btcBench,
    now: NOW,
    expected: { baselineState: 'VOLATILITY_EXPANSION' },
  },
  {
    id: 'R05_upward_breakout',
    label: 'Upward breakout after range',
    productId: 'UB1-USD',
    bars: breakoutBars('UB1-USD', N, 'up', 105),
    benchmarkBars: btcBench,
    now: NOW,
    expected: { baselineState: 'TREND_UP', changePointTriggered: true },
  },
  {
    id: 'R06_downward_breakdown',
    label: 'Downward breakdown after range',
    productId: 'DB1-USD',
    bars: breakoutBars('DB1-USD', N, 'down', 106),
    benchmarkBars: btcBenchDown,
    now: NOW,
    expected: { baselineState: 'TREND_DOWN', changePointTriggered: true },
  },
  {
    id: 'R07_capitulation',
    label: 'Capitulation-like decline',
    productId: 'CAP-USD',
    bars: capitulationBars('CAP-USD', N, 107),
    benchmarkBars: btcBenchDown,
    now: NOW,
    expected: { baselineState: 'CAPITULATION', changePointTriggered: true },
  },
  {
    id: 'R08_noisy_high_entropy',
    label: 'High-entropy noise',
    productId: 'NZY-USD',
    bars: noisyBars('NZY-USD', N, 108),
    benchmarkBars: btcBench,
    now: NOW,
    expected: { baselineState: 'DISORDERED' },
  },
  {
    id: 'R09_illiquid_product',
    label: 'Very thin volume, zero-volume bars, degenerate returns',
    productId: 'ILQ-USD',
    bars: illiquidBars('ILQ-USD', N, 109),
    benchmarkBars: btcBench,
    now: NOW,
    expected: { baselineState: 'DISORDERED' },
  },
  {
    id: 'R10_range_to_trend',
    label: 'Structural break: range → trend',
    productId: 'RT1-USD',
    bars: regimeChangeBars('RT1-USD', N, 110, 'range', 'trend', 'up'),
    benchmarkBars: btcBench,
    now: NOW,
    expected: { changePointTriggered: true },
  },
  {
    id: 'R11_trend_to_range',
    label: 'Structural break: trend → range',
    productId: 'TR1-USD',
    bars: regimeChangeBars('TR1-USD', N, 111, 'trend', 'range'),
    benchmarkBars: btcBench,
    now: NOW,
    expected: { changePointTriggered: true },
  },
  {
    id: 'R12_short_lived_break',
    label: 'Short-lived false break',
    productId: 'SLB-USD',
    bars: shortLivedBreakBars('SLB-USD', N, 112),
    benchmarkBars: btcBench,
    now: NOW,
    expected: {},
  },
  {
    id: 'R13_hmm_rule_agree',
    label: 'HMM and rule agreement on trend up',
    productId: 'AGR-USD',
    bars: trendBars('AGR-USD', N, 0.0012, 0.0008, 113),
    benchmarkBars: btcBench,
    now: NOW,
    expected: { baselineState: 'TREND_UP' },
  },
  {
    id: 'R14_hmm_rule_disagree',
    label: 'HMM and rule disagreement — mixed evidence',
    productId: 'DIS-USD',
    bars: trendBars('DIS-USD', N, 0.0002, 0.006, 114),
    benchmarkBars: btcBench,
    now: NOW,
    expected: {},
  },
  {
    id: 'R15_cusum_only_up',
    label: 'CUSUM detects positive shift; segmented variance does not',
    productId: 'CU1-USD',
    bars: (() => {
      const first = trendBars('CU1-USD', N / 2, 0.0002, 0.001, 115);
      const second = trendBars('CU1-USD', N / 2, 0.0018, 0.001, 116);
      return [
        ...first,
        ...second.map((b, i) => {
          const idx = N / 2 + i;
          const t = new Date(ORIGIN.getTime() + idx * G * 1000);
          return {
            ...b,
            productId: 'CU1-USD',
            bucketStart: t,
            dataAvailableAt: new Date(t.getTime() + G * 1000),
          };
        }),
      ];
    })(),
    benchmarkBars: btcBench,
    now: NOW,
    expected: { changePointTriggered: true },
  },
  {
    id: 'R16_segvar_only',
    label: 'Segmented-variance detects change; CUSUM does not',
    productId: 'SG1-USD',
    bars: (() => {
      const first = trendBars('SG1-USD', N / 2, 0, 0.0005, 117);
      const second = trendBars('SG1-USD', N / 2, 0, 0.008, 118);
      return [
        ...first,
        ...second.map((b, i) => {
          const idx = N / 2 + i;
          const t = new Date(ORIGIN.getTime() + idx * G * 1000);
          return {
            ...b,
            productId: 'SG1-USD',
            bucketStart: t,
            dataAvailableAt: new Date(t.getTime() + G * 1000),
          };
        }),
      ];
    })(),
    benchmarkBars: btcBench,
    now: NOW,
    expected: { changePointTriggered: true },
  },
  {
    id: 'R17_both_detectors_agree',
    label: 'Both detectors fire on the same shift',
    productId: 'BT1-USD',
    bars: (() => {
      const first = trendBars('BT1-USD', N / 2, 0, 0.001, 119);
      const second = trendBars('BT1-USD', N / 2, 0.003, 0.005, 120);
      return [
        ...first,
        ...second.map((b, i) => {
          const idx = N / 2 + i;
          const t = new Date(ORIGIN.getTime() + idx * G * 1000);
          return {
            ...b,
            productId: 'BT1-USD',
            bucketStart: t,
            dataAvailableAt: new Date(t.getTime() + G * 1000),
          };
        }),
      ];
    })(),
    benchmarkBars: btcBench,
    now: NOW,
    expected: { changePointTriggered: true },
  },
  {
    id: 'R18_detector_conflict',
    label: 'One detector fires positive, the other fires negative-var',
    productId: 'DC1-USD',
    bars: (() => {
      // First half stable, second half calmer (variance drop) with a slow positive drift.
      const first = trendBars('DC1-USD', N / 2, 0.0, 0.005, 121);
      const second = trendBars('DC1-USD', N / 2, 0.0009, 0.0008, 122);
      return [
        ...first,
        ...second.map((b, i) => {
          const idx = N / 2 + i;
          const t = new Date(ORIGIN.getTime() + idx * G * 1000);
          return {
            ...b,
            productId: 'DC1-USD',
            bucketStart: t,
            dataAvailableAt: new Date(t.getTime() + G * 1000),
          };
        }),
      ];
    })(),
    benchmarkBars: btcBench,
    now: NOW,
    expected: {},
  },
  {
    id: 'R19_missing_benchmark',
    label: 'Global observer with BTC benchmark absent',
    productId: 'MB1-USD',
    bars: trendBars('MB1-USD', N, 0.0005, 0.001, 123),
    now: NOW,
    expected: {},
  },
  {
    id: 'R20_stale_evidence',
    label: 'Bars finalized long ago — evidence should be treated as stale',
    productId: 'ST1-USD',
    bars: staleBars('ST1-USD', N, 124),
    benchmarkBars: btcBench,
    now: NOW,
    expected: {},
  },
  {
    id: 'R21_severe_data_gap',
    label: 'Severe candle gaps — quality penalty should push disordered',
    productId: 'GAP-USD',
    bars: gappyBars('GAP-USD', N, 125),
    benchmarkBars: btcBench,
    now: NOW,
    gapCount: 128,
    expected: { baselineState: 'DISORDERED' },
  },
  {
    id: 'R22_hysteresis_flip',
    label: 'One-observation candidate must not flip smoothed state',
    productId: 'HY1-USD',
    bars: trendBars('HY1-USD', N, 0.0, 0.001, 126),
    benchmarkBars: btcBench,
    now: NOW,
    expected: {},
  },
  {
    id: 'R23_immediate_disorder_override',
    label: 'Sudden disorder should be accepted immediately by hysteresis',
    productId: 'DIS2-USD',
    bars: noisyBars('DIS2-USD', N, 127),
    benchmarkBars: btcBench,
    now: NOW,
    expected: { baselineState: 'DISORDERED' },
  },
  {
    id: 'R24_state_expiry_to_unknown',
    label: 'Long inactivity should expire state to UNKNOWN',
    productId: 'EXP-USD',
    bars: trendBars('EXP-USD', N, 0, 0.001, 128),
    benchmarkBars: btcBench,
    now: NOW,
    expected: {},
  },
  {
    id: 'R25_challenger_champion_agree',
    label: 'Range + reversion fingerprint → challenger REVERSION matches champion enter_long',
    productId: 'AG2-USD',
    bars: rangeBars('AG2-USD', N, 0.0025, 129),
    benchmarkBars: btcBench,
    now: NOW,
    expected: { baselineState: 'RANGE' },
  },
  {
    id: 'R26_challenger_champion_disagree',
    label: 'Trend + no fingerprint → challenger abstains while champion enters',
    productId: 'DA2-USD',
    bars: trendBars('DA2-USD', N, 0.001, 0.001, 130),
    benchmarkBars: btcBench,
    now: NOW,
    expected: {},
  },
  {
    id: 'R27_challenger_abstention',
    label: 'Low confidence should produce ABSTAIN',
    productId: 'AB1-USD',
    bars: noisyBars('AB1-USD', N, 131),
    benchmarkBars: btcBench,
    now: NOW,
    expected: {},
  },
  {
    id: 'R28_low_confidence_regime',
    label: 'Just enough evidence but below directional threshold',
    productId: 'LC1-USD',
    bars: trendBars('LC1-USD', N, 0.0003, 0.001, 132),
    benchmarkBars: btcBench,
    now: NOW,
    expected: {},
  },
  {
    id: 'R29_global_selloff',
    label: 'Cross-sectional global selloff with BTC bench',
    productId: 'GX1-USD',
    bars: capitulationBars('GX1-USD', N, 133),
    benchmarkBars: btcBenchDown,
    now: NOW,
    expected: { baselineState: 'CAPITULATION' },
  },
  {
    id: 'R30_isolated_product_selloff',
    label: 'One product sold off while BTC is expanding volatility',
    productId: 'IS1-USD',
    bars: capitulationBars('IS1-USD', N, 134),
    benchmarkBars: btcBenchExpand,
    now: NOW,
    expected: {},
  },
];

export const REGIME_SCENARIOS_BY_ID: Map<string, RegimeScenario> = new Map(
  REGIME_SCENARIOS.map((s) => [s.id, s]),
);

export const CANONICAL_BTC_BENCH_UP = btcBench;
export const CANONICAL_BTC_BENCH_DOWN = btcBenchDown;
export const CANONICAL_BTC_BENCH_EXPAND = btcBenchExpand;
