import type { BookLevel, BookSnapshot } from './bookEngine';

/**
 * Phase 2D §D — Microstructure feature registry.
 *
 * Every feature returns a status-carrying result. Missing/invalid/gap
 * evidence never becomes zero. Feature versioning is per-feature.
 */

export const MS_FEATURE_MODEL_VERSION = 'p2d-feat-1';

export type MsFeatureStatus =
  | 'valid'
  | 'low_confidence'
  | 'insufficient_history'
  | 'stale'
  | 'gap_detected'
  | 'invalid_input'
  | 'numerical_failure'
  | 'unsupported';

export interface MsFeatureResult {
  featureKey: string;
  featureVersion: string;
  family: 'price' | 'depth' | 'flow' | 'quality';
  status: MsFeatureStatus;
  value: number | null;
  unit: string;
  confidence: number | null;
  sampleCount: number | null;
  failureReason: string | null;
  diagnostics: Record<string, unknown> | null;
}

function fail(
  featureKey: string,
  family: MsFeatureResult['family'],
  status: Exclude<MsFeatureStatus, 'valid' | 'low_confidence'>,
  reason: string,
  unit: string,
): MsFeatureResult {
  return {
    featureKey,
    featureVersion: MS_FEATURE_MODEL_VERSION,
    family,
    status,
    value: null,
    unit,
    confidence: 0,
    sampleCount: null,
    failureReason: reason,
    diagnostics: null,
  };
}

function ok(
  featureKey: string,
  family: MsFeatureResult['family'],
  value: number,
  unit: string,
  extras: Partial<MsFeatureResult> = {},
): MsFeatureResult {
  if (!Number.isFinite(value)) {
    return fail(featureKey, family, 'numerical_failure', 'value non-finite', unit);
  }
  return {
    featureKey,
    featureVersion: MS_FEATURE_MODEL_VERSION,
    family,
    status: 'valid',
    value,
    unit,
    confidence: 1,
    sampleCount: null,
    failureReason: null,
    diagnostics: null,
    ...extras,
  };
}

/** True if the snapshot's `bookHealth` permits any read at all. */
function isReadable(snap: BookSnapshot): boolean {
  return snap.bookHealth === 'healthy' || snap.bookHealth === 'degraded' || snap.bookHealth === 'stale';
}

function reasonForUnreadable(snap: BookSnapshot): 'gap_detected' | 'invalid_input' | 'unsupported' {
  if (snap.bookHealth === 'gap_detected') return 'gap_detected';
  if (snap.bookHealth === 'inconsistent') return 'invalid_input';
  return 'unsupported';
}

// ---------------------------------------------------------------------------
// Price features
// ---------------------------------------------------------------------------

export function bestBid(snap: BookSnapshot): MsFeatureResult {
  const key = 'price.best_bid';
  if (!isReadable(snap) || snap.bids.length === 0) return fail(key, 'price', reasonForUnreadable(snap), 'no bids', 'quote');
  return ok(key, 'price', snap.bids[0].price, 'quote');
}

export function bestAsk(snap: BookSnapshot): MsFeatureResult {
  const key = 'price.best_ask';
  if (!isReadable(snap) || snap.asks.length === 0) return fail(key, 'price', reasonForUnreadable(snap), 'no asks', 'quote');
  return ok(key, 'price', snap.asks[0].price, 'quote');
}

export function midprice(snap: BookSnapshot): MsFeatureResult {
  const key = 'price.midprice';
  if (!isReadable(snap) || snap.bids.length === 0 || snap.asks.length === 0)
    return fail(key, 'price', reasonForUnreadable(snap), 'missing bid or ask', 'quote');
  return ok(key, 'price', (snap.bids[0].price + snap.asks[0].price) / 2, 'quote');
}

export function quotedSpread(snap: BookSnapshot): MsFeatureResult {
  const key = 'price.quoted_spread';
  if (!isReadable(snap) || snap.bids.length === 0 || snap.asks.length === 0)
    return fail(key, 'price', reasonForUnreadable(snap), 'missing bid or ask', 'quote');
  return ok(key, 'price', snap.asks[0].price - snap.bids[0].price, 'quote');
}

export function spreadBps(snap: BookSnapshot): MsFeatureResult {
  const key = 'price.spread_bps';
  const bb = snap.bids[0]?.price;
  const ba = snap.asks[0]?.price;
  if (!isReadable(snap) || bb == null || ba == null || bb <= 0) return fail(key, 'price', reasonForUnreadable(snap), 'missing bid or ask', 'bps');
  return ok(key, 'price', ((ba - bb) / bb) * 10_000, 'bps');
}

export function microprice(snap: BookSnapshot): MsFeatureResult {
  const key = 'price.microprice';
  if (!isReadable(snap) || snap.bids.length === 0 || snap.asks.length === 0)
    return fail(key, 'price', reasonForUnreadable(snap), 'missing bid or ask', 'quote');
  const bb = snap.bids[0];
  const ba = snap.asks[0];
  const denom = bb.size + ba.size;
  if (!(denom > 0)) return fail(key, 'price', 'numerical_failure', 'zero top-of-book size', 'quote');
  return ok(key, 'price', (bb.price * ba.size + ba.price * bb.size) / denom, 'quote');
}

// ---------------------------------------------------------------------------
// Depth features
// ---------------------------------------------------------------------------

function depthWithinBps(levels: readonly BookLevel[], anchor: number, bps: number, side: 'bid' | 'ask'): number {
  const cutoff = side === 'bid' ? anchor * (1 - bps / 10_000) : anchor * (1 + bps / 10_000);
  let total = 0;
  for (const l of levels) {
    const inBand = side === 'bid' ? l.price >= cutoff : l.price <= cutoff;
    if (!inBand) break;
    total += l.price * l.size;
  }
  return total;
}

export function bidDepthQuote(snap: BookSnapshot, bps = 25): MsFeatureResult {
  const key = 'depth.bid_quote_25bps';
  if (!isReadable(snap) || snap.bids.length === 0)
    return fail(key, 'depth', reasonForUnreadable(snap), 'no bids', 'quote');
  return ok(key, 'depth', depthWithinBps(snap.bids, snap.bids[0].price, bps, 'bid'), 'quote', { diagnostics: { bps } });
}

export function askDepthQuote(snap: BookSnapshot, bps = 25): MsFeatureResult {
  const key = 'depth.ask_quote_25bps';
  if (!isReadable(snap) || snap.asks.length === 0)
    return fail(key, 'depth', reasonForUnreadable(snap), 'no asks', 'quote');
  return ok(key, 'depth', depthWithinBps(snap.asks, snap.asks[0].price, bps, 'ask'), 'quote', { diagnostics: { bps } });
}

export function depthImbalance(snap: BookSnapshot, bps = 25): MsFeatureResult {
  const key = 'depth.imbalance_25bps';
  const b = bidDepthQuote(snap, bps);
  const a = askDepthQuote(snap, bps);
  if (b.status !== 'valid' || a.status !== 'valid') return fail(key, 'depth', reasonForUnreadable(snap), 'missing depth', 'ratio');
  const total = (b.value ?? 0) + (a.value ?? 0);
  if (total <= 0) return fail(key, 'depth', 'numerical_failure', 'zero total depth', 'ratio');
  return ok(key, 'depth', ((b.value ?? 0) - (a.value ?? 0)) / total, 'ratio', { diagnostics: { bps } });
}

export function depthSlope(snap: BookSnapshot, side: 'bid' | 'ask'): MsFeatureResult {
  const key = `depth.${side}_slope`;
  const levels = side === 'bid' ? snap.bids : snap.asks;
  if (!isReadable(snap) || levels.length < 3) return fail(key, 'depth', reasonForUnreadable(snap), 'too few levels', 'quote_per_bps');
  const anchor = levels[0].price;
  let cum = 0;
  const points: Array<[number, number]> = [];
  for (const l of levels) {
    cum += l.price * l.size;
    const bpsAway = Math.abs((l.price - anchor) / anchor) * 10_000;
    points.push([bpsAway, cum]);
  }
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p[0] - mx) * (p[1] - my);
    den += (p[0] - mx) ** 2;
  }
  if (!(den > 0)) return fail(key, 'depth', 'numerical_failure', 'zero variance', 'quote_per_bps');
  return ok(key, 'depth', num / den, 'quote_per_bps');
}

// ---------------------------------------------------------------------------
// Quality features
// ---------------------------------------------------------------------------

export function bookAgeMs(snap: BookSnapshot): MsFeatureResult {
  const key = 'quality.book_age_ms';
  if (snap.staleAgeMs == null) return fail(key, 'quality', 'unsupported', 'no timestamp evidence', 'ms');
  return ok(key, 'quality', Math.max(0, snap.staleAgeMs), 'ms');
}

export function gapCountFeature(snap: BookSnapshot): MsFeatureResult {
  return ok('quality.gap_count', 'quality', snap.gapCount, 'count');
}

export function resyncCountFeature(snap: BookSnapshot): MsFeatureResult {
  return ok('quality.resync_count', 'quality', snap.resyncCount, 'count');
}

export function crossedCountFeature(snap: BookSnapshot): MsFeatureResult {
  return ok('quality.crossed_count', 'quality', snap.crossedCount, 'count');
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface MsFeatureDef {
  key: string;
  version: string;
  family: MsFeatureResult['family'];
  description: string;
  unit: string;
}

export const MS_FEATURE_REGISTRY: readonly MsFeatureDef[] = [
  { key: 'price.best_bid', version: MS_FEATURE_MODEL_VERSION, family: 'price', description: 'Best bid price', unit: 'quote' },
  { key: 'price.best_ask', version: MS_FEATURE_MODEL_VERSION, family: 'price', description: 'Best ask price', unit: 'quote' },
  { key: 'price.midprice', version: MS_FEATURE_MODEL_VERSION, family: 'price', description: 'Midprice', unit: 'quote' },
  { key: 'price.quoted_spread', version: MS_FEATURE_MODEL_VERSION, family: 'price', description: 'Bid-ask spread', unit: 'quote' },
  { key: 'price.spread_bps', version: MS_FEATURE_MODEL_VERSION, family: 'price', description: 'Spread in bps', unit: 'bps' },
  { key: 'price.microprice', version: MS_FEATURE_MODEL_VERSION, family: 'price', description: 'Microprice weighted by top-of-book size', unit: 'quote' },
  { key: 'depth.bid_quote_25bps', version: MS_FEATURE_MODEL_VERSION, family: 'depth', description: 'Bid quote depth within 25 bps', unit: 'quote' },
  { key: 'depth.ask_quote_25bps', version: MS_FEATURE_MODEL_VERSION, family: 'depth', description: 'Ask quote depth within 25 bps', unit: 'quote' },
  { key: 'depth.imbalance_25bps', version: MS_FEATURE_MODEL_VERSION, family: 'depth', description: 'Depth imbalance within 25 bps', unit: 'ratio' },
  { key: 'depth.bid_slope', version: MS_FEATURE_MODEL_VERSION, family: 'depth', description: 'Bid-side cumulative depth slope', unit: 'quote_per_bps' },
  { key: 'depth.ask_slope', version: MS_FEATURE_MODEL_VERSION, family: 'depth', description: 'Ask-side cumulative depth slope', unit: 'quote_per_bps' },
  { key: 'quality.book_age_ms', version: MS_FEATURE_MODEL_VERSION, family: 'quality', description: 'Age of the book in ms', unit: 'ms' },
  { key: 'quality.gap_count', version: MS_FEATURE_MODEL_VERSION, family: 'quality', description: 'Cumulative gap events', unit: 'count' },
  { key: 'quality.resync_count', version: MS_FEATURE_MODEL_VERSION, family: 'quality', description: 'Cumulative resynchronization events', unit: 'count' },
  { key: 'quality.crossed_count', version: MS_FEATURE_MODEL_VERSION, family: 'quality', description: 'Cumulative crossed-book events', unit: 'count' },
];

export function computeAllFeatures(snap: BookSnapshot): MsFeatureResult[] {
  return [
    bestBid(snap),
    bestAsk(snap),
    midprice(snap),
    quotedSpread(snap),
    spreadBps(snap),
    microprice(snap),
    bidDepthQuote(snap),
    askDepthQuote(snap),
    depthImbalance(snap),
    depthSlope(snap, 'bid'),
    depthSlope(snap, 'ask'),
    bookAgeMs(snap),
    gapCountFeature(snap),
    resyncCountFeature(snap),
    crossedCountFeature(snap),
  ];
}
