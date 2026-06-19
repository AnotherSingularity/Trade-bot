import { STRATEGY, type TradingMode } from '@horizon/shared';
import {
  bollingerBands,
  ema,
  macd,
  percentChange,
  rsi,
  type BollingerBands,
} from './indicators';
import type { CoinbaseCandle } from './coinbase';

/**
 * Mode detection + signal counting.
 *
 * For each token we compute the technical indicator set once, then evaluate it
 * against each of the three strategy modes. A mode "qualifies" when it meets at
 * least `signalsRequired` of `signalsTotal` boolean signals. Claude then confirms.
 */

export interface TokenSignals {
  token: string;
  price: number;
  volume24h: number;
  changePct24h: number;
  rsi: number | null;
  macdHistogram: number | null;
  bollingerPosition: string | null; // 'below-lower' | 'above-upper' | 'inside'
  emaTrend: string | null; // 'bullish' | 'bearish' | 'flat'
  passedSignals: number;
  totalSignals: number;
  winRate: number | null;
}

export interface ModeEvaluation {
  mode: TradingMode;
  qualifies: boolean;
  passedSignals: number;
  totalSignals: number;
  signalDetail: Record<string, boolean>;
}

export interface MarketSnapshot {
  token: string;
  price: number;
  volume24h: number;
  changePct24h: number;
  closes: number[];
  candles: CoinbaseCandle[];
  winRate: number | null;
}

export interface IndicatorSet {
  rsiValue: number | null;
  macdHistogram: number | null;
  bands: BollingerBands | null;
  ema9: number | null;
  ema21: number | null;
  intradayGainPct: number | null;
}

export function computeIndicators(snap: MarketSnapshot): IndicatorSet {
  const { closes } = snap;
  const macdResult = macd(closes);
  return {
    rsiValue: rsi(closes, 14),
    macdHistogram: macdResult ? macdResult.histogram : null,
    bands: bollingerBands(closes, 20, 2),
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    // Use the most recent ~24 candles as an intraday window proxy.
    intradayGainPct: percentChange(closes.slice(-24)),
  };
}

function bollingerPosition(price: number, bands: BollingerBands | null): string | null {
  if (!bands) return null;
  if (price <= bands.lower) return 'below-lower';
  if (price >= bands.upper) return 'above-upper';
  return 'inside';
}

function emaTrend(ema9: number | null, ema21: number | null): string | null {
  if (ema9 === null || ema21 === null) return null;
  const diffPct = ((ema9 - ema21) / ema21) * 100;
  if (diffPct > 0.25) return 'bullish';
  if (diffPct < -0.25) return 'bearish';
  return 'flat';
}

// ---------------------------------------------------------------------------
// Per-mode signal evaluation
// ---------------------------------------------------------------------------

/** Mean-reversion: oversold bounce setups. */
export function evaluateReversion(snap: MarketSnapshot, ind: IndicatorSet): ModeEvaluation {
  const cfg = STRATEGY.MODES.reversion;
  const signalDetail = {
    rsiOversold: ind.rsiValue !== null && ind.rsiValue < 35,
    belowLowerBand: ind.bands !== null && snap.price <= ind.bands.lower,
    macdTurningUp: ind.macdHistogram !== null && ind.macdHistogram > 0,
    notDowntrend: emaTrend(ind.ema9, ind.ema21) !== 'bearish',
    volumeOk: snap.volume24h >= STRATEGY.MIN_VOLUME_24HR,
  };
  const passedSignals = Object.values(signalDetail).filter(Boolean).length;
  return {
    mode: 'reversion',
    passedSignals,
    totalSignals: cfg.signalsTotal,
    qualifies: passedSignals >= cfg.signalsRequired,
    signalDetail,
  };
}

/** Breakout: strong intraday momentum with volume expansion. */
export function evaluateBreakout(_snap: MarketSnapshot, ind: IndicatorSet): ModeEvaluation {
  const cfg = STRATEGY.MODES.breakout;
  const rsiInRange =
    ind.rsiValue !== null &&
    ind.rsiValue >= (cfg.rsiMin ?? 55) &&
    ind.rsiValue <= (cfg.rsiMax ?? 65);
  const signalDetail = {
    strongIntradayGain:
      ind.intradayGainPct !== null && ind.intradayGainPct >= (cfg.minIntradayGainPct ?? 30),
    rsiMomentumBand: rsiInRange,
    bullishEma: emaTrend(ind.ema9, ind.ema21) === 'bullish',
    macdPositive: ind.macdHistogram !== null && ind.macdHistogram > 0,
  };
  const passedSignals = Object.values(signalDetail).filter(Boolean).length;
  return {
    mode: 'breakout',
    passedSignals,
    totalSignals: cfg.signalsTotal,
    qualifies: passedSignals >= cfg.signalsRequired,
    signalDetail,
  };
}

/** Macro: established multi-period trend continuation. */
export function evaluateMacro(snap: MarketSnapshot, ind: IndicatorSet): ModeEvaluation {
  const cfg = STRATEGY.MODES.macro;
  const signalDetail = {
    bullishTrend: emaTrend(ind.ema9, ind.ema21) === 'bullish',
    rsiHealthy: ind.rsiValue !== null && ind.rsiValue >= 50 && ind.rsiValue < 70,
    macdPositive: ind.macdHistogram !== null && ind.macdHistogram > 0,
    aboveMiddleBand: ind.bands !== null && snap.price >= ind.bands.middle,
  };
  const passedSignals = Object.values(signalDetail).filter(Boolean).length;
  return {
    mode: 'macro',
    passedSignals,
    totalSignals: cfg.signalsTotal,
    qualifies: passedSignals >= cfg.signalsRequired,
    signalDetail,
  };
}

/**
 * Evaluates all three modes and returns the best-qualifying one (highest signal
 * ratio), or null if none qualify.
 */
export function detectBestMode(snap: MarketSnapshot): {
  evaluation: ModeEvaluation;
  signals: TokenSignals;
} | null {
  const ind = computeIndicators(snap);
  const evaluations = [
    evaluateBreakout(snap, ind),
    evaluateMacro(snap, ind),
    evaluateReversion(snap, ind),
  ].filter((e) => e.qualifies);

  if (evaluations.length === 0) return null;

  evaluations.sort((a, b) => b.passedSignals / b.totalSignals - a.passedSignals / a.totalSignals);
  const best = evaluations[0];

  const signals: TokenSignals = {
    token: snap.token,
    price: snap.price,
    volume24h: snap.volume24h,
    changePct24h: snap.changePct24h,
    rsi: ind.rsiValue,
    macdHistogram: ind.macdHistogram,
    bollingerPosition: bollingerPosition(snap.price, ind.bands),
    emaTrend: emaTrend(ind.ema9, ind.ema21),
    passedSignals: best.passedSignals,
    totalSignals: best.totalSignals,
    winRate: snap.winRate,
  };

  return { evaluation: best, signals };
}
