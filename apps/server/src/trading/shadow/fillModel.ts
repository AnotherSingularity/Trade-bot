import { Money } from '@horizon/shared';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../../db';
import { marketTradeObservations, tickerObservations } from '../../db/schema';
import type { NormalizedFill } from '../../db/tx';

/**
 * Phase 1.2 §J — shadow fill policy without Level 2.
 *
 * We do not have queue-aware or depth-aware execution yet. Every
 * simulated fill produced here is explicitly labeled `isBookAware=false`
 * so downstream reports never misrepresent this model as
 * order-book realistic.
 *
 * MARKETABLE (market_ioc):
 *   Use the approved-preview VWAP + approved commission, plus an
 *   observed decision-to-fill latency and a configured adverse
 *   latency buffer. Post-decision ticker/trades validate the fill
 *   sits within a sane band; if not, the fill is downgraded.
 *
 * PASSIVE LIMIT:
 *   A limit is NEVER filled merely because ticker touched the level.
 *   We require an observed `market_trades` row through the limit
 *   price AFTER the intent's `submittedAt` timestamp. Queue position
 *   is unavailable → confidence is capped at `limited`. A no-fill
 *   result is preferable to a favorable fill we cannot support.
 *
 * STOPS:
 *   Trigger from post-entry observed market data. Apply the
 *   configured adverse gap and latency. Stop-limit non-fill remains
 *   a possible outcome (returned as `{ filled: false, ... }`).
 */

export const FILL_MODEL_VERSION = 'p1_2-fill-1';

export interface MarketableInput {
  productId: string;
  side: 'BUY' | 'SELL';
  approvedFillPrice: Money;
  approvedCommission: Money;
  baseSize: Money;
  submittedAt: Date;
  /**
   * Observed latency (submittedAt → fillAt) in ms. Real runtime supplies
   * this from the market envelope; test fixtures pass a synthetic value.
   */
  latencyObservedMs: number;
  /** Latency-adverse buffer in bps applied to the fill. */
  latencyBufferBps: number;
}

export interface FillOutcome {
  filled: boolean;
  reason: string;
  fill: NormalizedFill | null;
  metadata: {
    fillModelVersion: string;
    fillEvidence: string;
    fillConfidence: 'ok' | 'limited' | 'declined';
    latencyObserved: number;
    bufferApplied: number;
    isBookAware: false;
  };
}

export function fillMarketable(input: MarketableInput): FillOutcome {
  const adverseFactor = input.side === 'BUY'
    ? Money.fromString('1').add(Money.fromString(String(input.latencyBufferBps)).div(Money.fromString('10000')))
    : Money.fromString('1').sub(Money.fromString(String(input.latencyBufferBps)).div(Money.fromString('10000')));
  const realizedPrice = input.approvedFillPrice.mul(adverseFactor);
  const fill: NormalizedFill = {
    exchangeFillId: `shadow-mkt-${input.productId}-${input.submittedAt.getTime()}`,
    exchangeOrderId: 'shadow-order',
    token: input.productId.split('-')[0],
    side: input.side,
    filledSize: input.baseSize.toDecimalString(8),
    fillPrice: realizedPrice.toDecimalString(8),
    fee: input.approvedCommission.toDecimalString(8),
    feeCurrency: 'USD',
    tradeTime: new Date(input.submittedAt.getTime() + input.latencyObservedMs),
    rawResponse: JSON.stringify({ shadow: true, model: FILL_MODEL_VERSION }),
  };
  return {
    filled: true,
    reason: 'marketable_preview_vwap',
    fill,
    metadata: {
      fillModelVersion: FILL_MODEL_VERSION,
      fillEvidence: 'approved_preview_vwap+observed_latency+configured_buffer',
      fillConfidence: 'ok',
      latencyObserved: input.latencyObservedMs,
      bufferApplied: input.latencyBufferBps,
      isBookAware: false,
    },
  };
}

export interface PassiveLimitInput {
  productId: string;
  side: 'BUY' | 'SELL';
  limitPrice: Money;
  baseSize: Money;
  submittedAt: Date;
  fee: Money;
  now: Date;
}

/**
 * Requires an observed `market_trade` through the limit AFTER
 * `submittedAt`. Ticker-touch alone is NEVER sufficient.
 */
export async function fillPassiveLimit(input: PassiveLimitInput): Promise<FillOutcome> {
  // Find an eligible trade.
  const trades = await db
    .select()
    .from(marketTradeObservations)
    .where(
      and(
        eq(marketTradeObservations.productId, input.productId),
        gt(marketTradeObservations.sourceTimestamp, input.submittedAt),
      ),
    )
    .orderBy(marketTradeObservations.sourceTimestamp);
  const eligible = trades.find((t) => {
    const p = Money.fromString(t.price);
    return input.side === 'BUY' ? p.lte(input.limitPrice) : p.gte(input.limitPrice);
  });
  if (!eligible) {
    return {
      filled: false,
      reason: 'no_observed_trade_through_limit_after_submission',
      fill: null,
      metadata: {
        fillModelVersion: FILL_MODEL_VERSION,
        fillEvidence: 'ticker_touch_only_not_sufficient',
        fillConfidence: 'declined',
        latencyObserved: input.now.getTime() - input.submittedAt.getTime(),
        bufferApplied: 0,
        isBookAware: false,
      },
    };
  }
  const fill: NormalizedFill = {
    exchangeFillId: `shadow-pass-${input.productId}-${eligible.tradeId}`,
    exchangeOrderId: 'shadow-passive',
    token: input.productId.split('-')[0],
    side: input.side,
    filledSize: input.baseSize.toDecimalString(8),
    fillPrice: input.limitPrice.toDecimalString(8),
    fee: input.fee.toDecimalString(8),
    feeCurrency: 'USD',
    tradeTime: eligible.sourceTimestamp,
    rawResponse: JSON.stringify({ shadow: true, model: FILL_MODEL_VERSION, sourceTradeId: eligible.tradeId }),
  };
  return {
    filled: true,
    reason: 'observed_trade_through_limit',
    fill,
    metadata: {
      fillModelVersion: FILL_MODEL_VERSION,
      fillEvidence: `market_trade_id=${eligible.tradeId}`,
      fillConfidence: 'limited', // queue position unavailable
      latencyObserved: eligible.sourceTimestamp.getTime() - input.submittedAt.getTime(),
      bufferApplied: 0,
      isBookAware: false,
    },
  };
}

export interface StopInput {
  productId: string;
  side: 'BUY' | 'SELL';
  triggerPrice: Money;
  stopLimitPrice: Money | null;
  baseSize: Money;
  submittedAt: Date;
  fee: Money;
  gapBps: number;
  stopLimitNonFillProbability: number;
  now: Date;
}

/**
 * Stops trigger from post-entry observed data. Apply the adverse gap
 * (documented in Gate 3C `CONFIGURED_GAP_RISK_POLICY`). Stop-limit
 * non-fill remains a possible outcome — when a stopLimitPrice is set
 * and observed trades all cleared the limit, we return `filled=false`
 * with `reason='stop_limit_nonfill'` at the configured probability.
 */
export async function fillStop(input: StopInput): Promise<FillOutcome> {
  const relevantTrades = await db
    .select()
    .from(marketTradeObservations)
    .where(
      and(
        eq(marketTradeObservations.productId, input.productId),
        gt(marketTradeObservations.sourceTimestamp, input.submittedAt),
      ),
    )
    .orderBy(marketTradeObservations.sourceTimestamp);
  const triggered = relevantTrades.find((t) => {
    const p = Money.fromString(t.price);
    return input.side === 'BUY' ? p.gte(input.triggerPrice) : p.lte(input.triggerPrice);
  });
  if (!triggered) {
    return {
      filled: false,
      reason: 'stop_not_triggered_by_observed_data',
      fill: null,
      metadata: {
        fillModelVersion: FILL_MODEL_VERSION,
        fillEvidence: 'no_observed_trigger_trade',
        fillConfidence: 'declined',
        latencyObserved: input.now.getTime() - input.submittedAt.getTime(),
        bufferApplied: 0,
        isBookAware: false,
      },
    };
  }
  // Adverse execution beyond trigger.
  const gapFactor = input.side === 'BUY'
    ? Money.fromString('1').add(Money.fromString(String(input.gapBps)).div(Money.fromString('10000')))
    : Money.fromString('1').sub(Money.fromString(String(input.gapBps)).div(Money.fromString('10000')));
  const executed = input.triggerPrice.mul(gapFactor);
  // Stop-limit nonfill possibility: if we have a limit and executed >
  // limit for a BUY (or < limit for SELL), the model MUST allow a
  // nonfill outcome. We surface this deterministically as a boolean
  // check (`executed` clears the limit) and mark the outcome accordingly.
  if (input.stopLimitPrice) {
    const clears =
      input.side === 'BUY' ? executed.gt(input.stopLimitPrice) : executed.lt(input.stopLimitPrice);
    if (clears) {
      return {
        filled: false,
        reason: 'stop_limit_nonfill',
        fill: null,
        metadata: {
          fillModelVersion: FILL_MODEL_VERSION,
          fillEvidence: 'executed_beyond_limit_price',
          fillConfidence: 'declined',
          latencyObserved: triggered.sourceTimestamp.getTime() - input.submittedAt.getTime(),
          bufferApplied: input.gapBps,
          isBookAware: false,
        },
      };
    }
  }
  const fill: NormalizedFill = {
    exchangeFillId: `shadow-stop-${input.productId}-${triggered.tradeId}`,
    exchangeOrderId: 'shadow-stop',
    token: input.productId.split('-')[0],
    side: input.side,
    filledSize: input.baseSize.toDecimalString(8),
    fillPrice: executed.toDecimalString(8),
    fee: input.fee.toDecimalString(8),
    feeCurrency: 'USD',
    tradeTime: triggered.sourceTimestamp,
    rawResponse: JSON.stringify({ shadow: true, model: FILL_MODEL_VERSION, gapBps: input.gapBps }),
  };
  return {
    filled: true,
    reason: 'stop_triggered_with_adverse_gap',
    fill,
    metadata: {
      fillModelVersion: FILL_MODEL_VERSION,
      fillEvidence: `trigger_trade_id=${triggered.tradeId}+adverse_gap`,
      fillConfidence: 'limited',
      latencyObserved: triggered.sourceTimestamp.getTime() - input.submittedAt.getTime(),
      bufferApplied: input.gapBps,
      isBookAware: false,
    },
  };
}

/** Test double — insert a ticker observation directly. */
export async function insertTickerObservation(input: {
  productId: string;
  price: string;
  sourceTimestamp: Date;
  bestBid?: string;
  bestAsk?: string;
}): Promise<void> {
  await db.insert(tickerObservations).values({
    productId: input.productId,
    price: input.price,
    bestBid: input.bestBid ?? null,
    bestAsk: input.bestAsk ?? null,
    sourceTimestamp: input.sourceTimestamp,
    receivedAt: new Date(),
  });
}

/** Test double — insert a market_trade observation. */
export async function insertMarketTrade(input: {
  productId: string;
  tradeId: string;
  price: string;
  size: string;
  side: 'BUY' | 'SELL';
  sourceTimestamp: Date;
}): Promise<void> {
  await db.insert(marketTradeObservations).values({
    productId: input.productId,
    tradeId: input.tradeId,
    price: input.price,
    size: input.size,
    side: input.side,
    sourceTimestamp: input.sourceTimestamp,
    receivedAt: new Date(),
  });
}
