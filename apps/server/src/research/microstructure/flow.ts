import type { MarketDepthEvent } from './provider';

/**
 * Phase 2D §E, §F — Trade aggressor classifier + CVD policy.
 *
 * Classification hierarchy (each step is TRIED IN ORDER):
 *   1. Authoritative side when the provider supplied one.
 *   2. Price vs prevailing bid/ask (Lee-Ready quote rule).
 *   3. Tick rule (uptick → buyer, downtick → seller).
 *   4. Unknown when evidence is insufficient.
 *
 * CVD is a diagnostic. Missing trade data invalidates the window.
 * CVD divergence is EVIDENCE, not authorization.
 */

export const TRADE_CLASSIFIER_VERSION = 'p2d-classifier-1';
export const CVD_WINDOW_POLICY_VERSION = 'p2d-cvd-1';

export type TradeSide = 'buyer_initiated' | 'seller_initiated' | 'unknown';
export type ClassificationSource = 'authoritative' | 'quote_rule' | 'tick_rule' | 'unknown';

export interface ClassifiedTrade {
  sequence: number;
  price: number;
  size: number;
  side: TradeSide;
  source: ClassificationSource;
  confidence: number;
  sourceTimestamp: Date;
  dataAvailableAt: Date;
}

export interface QuoteAtTrade {
  bestBid: number | null;
  bestAsk: number | null;
}

export interface ClassifyInput {
  event: MarketDepthEvent;
  quoteAtTrade: QuoteAtTrade;
  previousPrice: number | null;
}

export function classifyTrade(input: ClassifyInput): ClassifiedTrade | null {
  const ev = input.event;
  if (ev.kind !== 'trade' || !ev.trade) return null;
  const price = Number(ev.trade.price);
  const size = Number(ev.trade.size);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) {
    return {
      sequence: ev.sequence,
      price,
      size,
      side: 'unknown',
      source: 'unknown',
      confidence: 0,
      sourceTimestamp: ev.sourceTimestamp,
      dataAvailableAt: ev.dataAvailableAt,
    };
  }
  // 1. Authoritative.
  if (ev.trade.side === 'buyer_initiated' || ev.trade.side === 'seller_initiated') {
    return {
      sequence: ev.sequence,
      price,
      size,
      side: ev.trade.side,
      source: 'authoritative',
      confidence: 1,
      sourceTimestamp: ev.sourceTimestamp,
      dataAvailableAt: ev.dataAvailableAt,
    };
  }
  // 2. Quote rule.
  const { bestBid, bestAsk } = input.quoteAtTrade;
  if (bestBid != null && bestAsk != null) {
    if (price >= bestAsk) {
      return {
        sequence: ev.sequence,
        price,
        size,
        side: 'buyer_initiated',
        source: 'quote_rule',
        confidence: 0.9,
        sourceTimestamp: ev.sourceTimestamp,
        dataAvailableAt: ev.dataAvailableAt,
      };
    }
    if (price <= bestBid) {
      return {
        sequence: ev.sequence,
        price,
        size,
        side: 'seller_initiated',
        source: 'quote_rule',
        confidence: 0.9,
        sourceTimestamp: ev.sourceTimestamp,
        dataAvailableAt: ev.dataAvailableAt,
      };
    }
  }
  // 3. Tick rule.
  if (input.previousPrice != null && Number.isFinite(input.previousPrice)) {
    if (price > input.previousPrice) {
      return {
        sequence: ev.sequence,
        price,
        size,
        side: 'buyer_initiated',
        source: 'tick_rule',
        confidence: 0.5,
        sourceTimestamp: ev.sourceTimestamp,
        dataAvailableAt: ev.dataAvailableAt,
      };
    }
    if (price < input.previousPrice) {
      return {
        sequence: ev.sequence,
        price,
        size,
        side: 'seller_initiated',
        source: 'tick_rule',
        confidence: 0.5,
        sourceTimestamp: ev.sourceTimestamp,
        dataAvailableAt: ev.dataAvailableAt,
      };
    }
  }
  // 4. Unknown.
  return {
    sequence: ev.sequence,
    price,
    size,
    side: 'unknown',
    source: 'unknown',
    confidence: 0,
    sourceTimestamp: ev.sourceTimestamp,
    dataAvailableAt: ev.dataAvailableAt,
  };
}

// ---------------------------------------------------------------------------
// CVD window
// ---------------------------------------------------------------------------

export interface FlowWindow {
  windowStart: Date;
  windowEnd: Date;
  buyerVolume: number;
  sellerVolume: number;
  unknownVolume: number;
  cvd: number;
  imbalance: number | null;
  classifierVersion: string;
  windowPolicyVersion: string;
  status: 'valid' | 'low_confidence' | 'insufficient_history' | 'invalid_input';
  dataAvailableAt: Date;
}

export function buildFlowWindow(
  trades: readonly ClassifiedTrade[],
  windowStart: Date,
  windowEnd: Date,
): FlowWindow {
  const inWindow = trades.filter((t) => t.sourceTimestamp >= windowStart && t.sourceTimestamp <= windowEnd);
  if (inWindow.length === 0) {
    return {
      windowStart,
      windowEnd,
      buyerVolume: 0,
      sellerVolume: 0,
      unknownVolume: 0,
      cvd: 0,
      imbalance: null,
      classifierVersion: TRADE_CLASSIFIER_VERSION,
      windowPolicyVersion: CVD_WINDOW_POLICY_VERSION,
      status: 'insufficient_history',
      dataAvailableAt: windowEnd,
    };
  }
  let buy = 0;
  let sell = 0;
  let unk = 0;
  for (const t of inWindow) {
    if (t.side === 'buyer_initiated') buy += t.price * t.size;
    else if (t.side === 'seller_initiated') sell += t.price * t.size;
    else unk += t.price * t.size;
  }
  const cvd = buy - sell;
  const total = buy + sell;
  const imbalance = total > 0 ? cvd / total : null;
  const unknownRatio = unk / (unk + total);
  return {
    windowStart,
    windowEnd,
    buyerVolume: buy,
    sellerVolume: sell,
    unknownVolume: unk,
    cvd,
    imbalance,
    classifierVersion: TRADE_CLASSIFIER_VERSION,
    windowPolicyVersion: CVD_WINDOW_POLICY_VERSION,
    status: unknownRatio > 0.5 ? 'low_confidence' : 'valid',
    dataAvailableAt: windowEnd,
  };
}
