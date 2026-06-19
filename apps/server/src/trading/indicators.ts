/**
 * Technical indicator math — pure functions over price series.
 *
 * All functions take an array of closing prices (oldest first) and return the
 * latest value, or `null` when there is insufficient data. Kept dependency-free
 * and fully unit-tested so the strategy math is auditable.
 */

/** Simple Moving Average over the last `period` values. */
export function sma(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Exponential Moving Average (returns the final EMA value). */
export function ema(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  // Seed with SMA of the first `period` values.
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

/** Full EMA series (same length as input, leading entries are null). */
export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period || period <= 0) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Relative Strength Index using Wilder's smoothing. Returns 0..100.
 */
export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
}

/**
 * MACD (12, 26, 9 by default). Returns the latest macd/signal/histogram.
 */
export function macd(
  values: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult | null {
  if (values.length < slowPeriod + signalPeriod) return null;

  const fast = emaSeries(values, fastPeriod);
  const slow = emaSeries(values, slowPeriod);

  const macdLine: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (fast[i] !== null && slow[i] !== null) {
      macdLine.push((fast[i] as number) - (slow[i] as number));
    }
  }
  if (macdLine.length < signalPeriod) return null;

  const signalLine = ema(macdLine, signalPeriod);
  if (signalLine === null) return null;

  const macdValue = macdLine[macdLine.length - 1];
  return {
    macd: macdValue,
    signal: signalLine,
    histogram: macdValue - signalLine,
  };
}

export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
}

/**
 * Bollinger Bands (period 20, 2 std dev by default).
 */
export function bollingerBands(
  values: number[],
  period = 20,
  stdDevMultiplier = 2,
): BollingerBands | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((acc, v) => acc + (v - middle) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = middle + stdDevMultiplier * stdDev;
  const lower = middle - stdDevMultiplier * stdDev;
  return {
    upper,
    middle,
    lower,
    bandwidth: middle === 0 ? 0 : ((upper - lower) / middle) * 100,
  };
}

/** Percentage change between the first and last value of a series. */
export function percentChange(values: number[]): number | null {
  if (values.length < 2) return null;
  const first = values[0];
  const last = values[values.length - 1];
  if (first === 0) return null;
  return ((last - first) / first) * 100;
}
