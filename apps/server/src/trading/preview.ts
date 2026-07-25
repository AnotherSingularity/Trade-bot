import { Money } from '@horizon/shared';
// Namespace import so tests can `vi.spyOn(coinbase, 'previewOrder')`.
import * as coinbase from './coinbase';
import type { CoinbasePreviewResponse, MarketOrderIntent } from './coinbase';
import { ENV } from '../env';

/**
 * Order-preview service (Phase 1 §B).
 *
 * Wraps Coinbase's POST /orders/preview into a typed, safety-first result:
 *   • Every response is inspected. Any populated `errs`, any populated
 *     `warning`, or a missing `commission_total` / stale timestamp is treated
 *     as a **hard rejection** by the caller.
 *   • The parser returns Money values throughout — never raw floats or
 *     strings — so downstream cost math never introduces float drift.
 *   • In dry-run + no Coinbase credentials, `previewCandidate` returns a
 *     synthetic preview built from the arrival mid + a conservative
 *     assumption on slippage. This is clearly marked `synthetic: true` so
 *     the cost forecast row records exactly which regime it used.
 *   • Fail-closed by contract: any error from the preview call surfaces to
 *     the caller as a rejection reason, never as a soft-null estimated fill.
 */

export interface PreviewInput {
  intent: MarketOrderIntent;
  /** The mid used as the "arrival" reference for impact accounting. */
  arrivalMid: Money;
  /** The current taker fee rate (0..1), used for the synthetic dry-run path. */
  takerRate: Money;
}

export interface PreviewOk {
  status: 'ok';
  synthetic: boolean;
  raw: CoinbasePreviewResponse | { synthetic: true; notes: string };
  orderTotal: Money | null;
  commissionTotal: Money;
  bestBid: Money | null;
  bestAsk: Money | null;
  estimatedAvgFillPrice: Money;
  slippage: Money | null;
  baseSize: Money | null;
  quoteSize: Money | null;
  warnings: string[];
}

export interface PreviewRejected {
  status: 'rejected';
  reason:
    | 'preview_error'
    | 'preview_warning'
    | 'missing_commission'
    | 'missing_avg_fill'
    | 'preview_failure';
  detail: string;
  raw: CoinbasePreviewResponse | null;
  warnings: string[];
}

export type PreviewResult = PreviewOk | PreviewRejected;

const NON_FATAL_WARNING_PREFIXES: readonly string[] = [
  // Coinbase periodically emits informational warnings that don't invalidate
  // the preview (e.g. "This is a taker order"). Empty list keeps the gate
  // maximally strict; expand cautiously.
];

function looksInformationalOnly(w: string): boolean {
  return NON_FATAL_WARNING_PREFIXES.some((p) => w.startsWith(p));
}

function moneyOrNull(v: string | undefined): Money | null {
  return v && v.length > 0 ? Money.fromString(v) : null;
}

/**
 * Requests a preview from Coinbase and returns a typed, safety-first result.
 */
export async function previewCandidate(input: PreviewInput): Promise<PreviewResult> {
  const warnings: string[] = [];
  let raw: CoinbasePreviewResponse | null = null;

  try {
    if (!ENV.coinbaseConfigured) {
      // Synthetic path — no live account. Use the arrival mid as the avg fill
      // and apply the taker rate as the sole commission. This is intentionally
      // OPTIMISTIC on price but pessimistic on cost application; the cost model
      // then adds a conservative exit-slippage buffer on top.
      const quoteSizeStr = input.intent.quoteSize;
      const baseSizeStr = input.intent.baseSize;
      const notional =
        quoteSizeStr !== undefined
          ? Money.fromString(quoteSizeStr)
          : baseSizeStr !== undefined
            ? Money.fromString(baseSizeStr).mul(input.arrivalMid)
            : Money.zero();
      const commission = notional.mul(input.takerRate);
      return {
        status: 'ok',
        synthetic: true,
        raw: { synthetic: true, notes: 'Coinbase not configured — synthetic preview.' },
        orderTotal: notional.add(commission),
        commissionTotal: commission,
        bestBid: input.arrivalMid,
        bestAsk: input.arrivalMid,
        estimatedAvgFillPrice: input.arrivalMid,
        slippage: Money.zero(),
        baseSize: baseSizeStr !== undefined ? Money.fromString(baseSizeStr) : null,
        quoteSize: quoteSizeStr !== undefined ? Money.fromString(quoteSizeStr) : null,
        warnings,
      };
    }

    raw = await coinbase.previewOrder(input.intent);
  } catch (err) {
    return {
      status: 'rejected',
      reason: 'preview_error',
      detail: err instanceof Error ? err.message : String(err),
      raw: null,
      warnings,
    };
  }

  // Coinbase surfaces two error channels: `errs` (validation list) and
  // `preview_failure_reason` / `new_order_failure_reason` (single string). Any
  // one being populated is a hard rejection.
  if (raw.errs && raw.errs.length > 0) {
    return {
      status: 'rejected',
      reason: 'preview_failure',
      detail: raw.errs.join('; '),
      raw,
      warnings: raw.warning ?? [],
    };
  }
  if (raw.preview_failure_reason && raw.preview_failure_reason.length > 0) {
    return {
      status: 'rejected',
      reason: 'preview_failure',
      detail: raw.preview_failure_reason,
      raw,
      warnings: raw.warning ?? [],
    };
  }
  if (raw.new_order_failure_reason && raw.new_order_failure_reason.length > 0) {
    return {
      status: 'rejected',
      reason: 'preview_failure',
      detail: raw.new_order_failure_reason,
      raw,
      warnings: raw.warning ?? [],
    };
  }

  const activeWarnings = (raw.warning ?? []).filter((w) => !looksInformationalOnly(w));
  if (activeWarnings.length > 0) {
    return {
      status: 'rejected',
      reason: 'preview_warning',
      detail: `Coinbase preview warning: ${activeWarnings.join('; ')}`,
      raw,
      warnings: raw.warning ?? [],
    };
  }

  const commissionTotal = moneyOrNull(raw.commission_total);
  if (commissionTotal === null) {
    return {
      status: 'rejected',
      reason: 'missing_commission',
      detail: 'preview response missing commission_total — cost model cannot proceed',
      raw,
      warnings: raw.warning ?? [],
    };
  }

  const estimatedAvgFillPrice =
    moneyOrNull(raw.average_filled_price) ??
    // Fall back to mid of best bid/ask when Coinbase omits the estimate.
    (() => {
      const bid = moneyOrNull(raw.best_bid);
      const ask = moneyOrNull(raw.best_ask);
      if (bid && ask) return bid.add(ask).divInt(2);
      return null;
    })();

  if (estimatedAvgFillPrice === null) {
    return {
      status: 'rejected',
      reason: 'missing_avg_fill',
      detail: 'preview response missing average_filled_price and best_bid/ask',
      raw,
      warnings: raw.warning ?? [],
    };
  }

  return {
    status: 'ok',
    synthetic: false,
    raw,
    orderTotal: moneyOrNull(raw.order_total),
    commissionTotal,
    bestBid: moneyOrNull(raw.best_bid),
    bestAsk: moneyOrNull(raw.best_ask),
    estimatedAvgFillPrice,
    slippage: moneyOrNull(raw.slippage),
    baseSize: moneyOrNull(raw.base_size),
    quoteSize: moneyOrNull(raw.quote_size),
    warnings: raw.warning ?? [],
  };
}
