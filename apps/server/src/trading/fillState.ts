import { Money } from '@horizon/shared';

/**
 * Strict partial-fill state classifier (Phase 1.1.b §E).
 *
 * The reconciler and executor must not guess "did this order really finish?"
 * from a single field. This classifier consumes every relevant signal from
 * Coinbase and produces one of eight explicit states.
 *
 * Design rules:
 *   • Never compare a base quantity to a quote-currency amount. Base/quote
 *     mixing is a red-flag inconsistency, and the classifier surfaces it as
 *     `inconsistent` rather than picking one.
 *   • Every result carries a `filledBase`, `filledQuote`, `residualBase`,
 *     and Money-typed inputs so callers work only in decimal-safe values.
 *   • The classifier is a pure function — no I/O, no logging, no side
 *     effects. The reconciler calls it per intent and persists the result.
 *
 * Coinbase's `status` values are:
 *   OPEN         — still working
 *   FILLED       — every base unit filled (per Coinbase's own accounting)
 *   CANCELLED    — user or system canceled; may have partial fills
 *   EXPIRED      — expired unfilled or partially filled
 *   FAILED       — routing / validation failure
 *   PENDING      — pre-flight
 *
 * `completion_percentage` is a Coinbase-derived value that we recompute
 * independently from filled/requested; a divergence flags `inconsistent`.
 */

export type FillStateKind =
  | 'unfilled_open'
  | 'unfilled_terminal'
  | 'partially_filled_open'
  | 'partially_filled_terminal'
  | 'completely_filled'
  | 'filled_with_dust_residual'
  | 'inconsistent'
  | 'unknown';

export type CoinbaseTerminalStatus = 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
export type CoinbaseWorkingStatus = 'OPEN' | 'PENDING';
export type CoinbaseAnyStatus = CoinbaseTerminalStatus | CoinbaseWorkingStatus | 'UNKNOWN';

export interface FillStateInput {
  /** BUY = base bought against quote; SELL = base sold for quote. */
  side: 'BUY' | 'SELL';
  /**
   * The requested quote size (USD to spend), when known. BUY intents
   * usually specify this; SELL intents usually do not.
   */
  requestedQuote?: Money;
  /** The requested base size (token quantity), when known. */
  requestedBase?: Money;
  /**
   * Actual filled base quantity (aggregated from fills, decimal-safe).
   * REQUIRED — the classifier's only source of truth for "what filled."
   */
  filledBase: Money;
  /**
   * Actual filled quote value (aggregated from fills * price, decimal-safe).
   * REQUIRED — used only to compare against Coinbase's own totals for
   * consistency checking, NOT to derive base quantity.
   */
  filledQuote: Money;
  /**
   * Coinbase's own filled_size when available. Used only for the
   * consistency check.
   */
  coinbaseFilledSize?: Money;
  /**
   * Coinbase's own completion_percentage (0..100). If provided, we
   * recompute independently and flag inconsistency on divergence
   * beyond a small tolerance.
   */
  coinbaseCompletionPct?: number;
  /** Coinbase's order.status. */
  coinbaseStatus?: CoinbaseAnyStatus;
  /** Product's base_increment as a Money-safe string ("0.00000001"). */
  baseIncrement: string;
  /**
   * Threshold below which a remaining base quantity counts as dust and
   * the order is considered `filled_with_dust_residual`. Expressed as a
   * multiplier of `baseIncrement` (e.g. 3 = up to 3 increments of dust).
   * Default 1 (one increment of dust tolerated).
   */
  dustMultiplier?: number;
}

export interface FillStateResult {
  kind: FillStateKind;
  filledBase: Money;
  filledQuote: Money;
  residualBase: Money; // best-effort remaining base; zero when unknown
  isTerminal: boolean;
  reason: string;
  inconsistencyDetail?: string;
}

const CONSISTENCY_PCT_TOLERANCE = 0.5; // percentage points

/**
 * Classifier. Pure function; safe to call inside a transaction or a tight loop.
 */
export function classifyFillState(input: FillStateInput): FillStateResult {
  const { side, filledBase, filledQuote, coinbaseStatus } = input;
  const baseIncrement = Money.fromString(input.baseIncrement);
  const dustMultiplier = input.dustMultiplier ?? 1;
  const dustCeiling = baseIncrement.mul(Money.fromNumber(dustMultiplier));
  const terminalStatuses: readonly CoinbaseAnyStatus[] = [
    'FILLED',
    'CANCELLED',
    'EXPIRED',
    'FAILED',
  ];
  const isTerminal =
    coinbaseStatus === undefined ? false : terminalStatuses.includes(coinbaseStatus);

  // 1. Base-unit sanity — filledBase must not be negative.
  if (filledBase.isNegative() || filledQuote.isNegative()) {
    return {
      kind: 'inconsistent',
      filledBase,
      filledQuote,
      residualBase: Money.zero(),
      isTerminal,
      reason: 'negative_filled_value',
      inconsistencyDetail: `filledBase=${filledBase.toDecimalString()} filledQuote=${filledQuote.toDecimalString()}`,
    };
  }

  // 2. Cross-check Coinbase's filled_size against our aggregate.
  if (input.coinbaseFilledSize && !input.coinbaseFilledSize.eq(filledBase)) {
    const diff = input.coinbaseFilledSize.sub(filledBase).abs();
    // Tolerate a single base_increment of drift (Coinbase rounding vs. our sum).
    if (diff.gt(baseIncrement)) {
      return {
        kind: 'inconsistent',
        filledBase,
        filledQuote,
        residualBase: Money.zero(),
        isTerminal,
        reason: 'coinbase_filled_size_disagrees_with_fills',
        inconsistencyDetail: `cb=${input.coinbaseFilledSize.toDecimalString()} ours=${filledBase.toDecimalString()} diff=${diff.toDecimalString()}`,
      };
    }
  }

  // 3. Compute residualBase — must be in base units. We can compute it two ways
  //    depending on what the caller requested. NEVER compare requestedQuote to
  //    filledBase directly.
  let residualBase = Money.zero();
  let requestedForResidual: Money | null = null;

  if (side === 'BUY') {
    // BUY: caller usually knows requestedQuote. residualBase can only be
    // derived from `requestedBase` (rare for market buys) or by inferring from
    // the exchange status. We do NOT convert requestedQuote to base via the
    // fill price — that would be a base/quote mix.
    if (input.requestedBase) {
      requestedForResidual = input.requestedBase;
      residualBase = input.requestedBase.sub(filledBase);
    } else {
      // No requestedBase: residual is unknown, we lean on status.
      residualBase = Money.zero();
    }
  } else {
    // SELL: caller usually specifies requestedBase.
    if (input.requestedBase) {
      requestedForResidual = input.requestedBase;
      residualBase = input.requestedBase.sub(filledBase);
    } else if (input.requestedQuote) {
      // requestedQuote for a SELL is unusual (usually market sells specify base).
      // We can't compare it to filledBase in base units — flag inconsistent.
      return {
        kind: 'inconsistent',
        filledBase,
        filledQuote,
        residualBase: Money.zero(),
        isTerminal,
        reason: 'sell_requested_quote_without_base',
        inconsistencyDetail: 'SELL specified requestedQuote but not requestedBase; cannot compute base residual without base/quote mixing',
      };
    }
  }
  if (residualBase.isNegative()) {
    // Filled MORE than requested — impossible.
    return {
      kind: 'inconsistent',
      filledBase,
      filledQuote,
      residualBase: Money.zero(),
      isTerminal,
      reason: 'overfill',
      inconsistencyDetail: `requested=${requestedForResidual?.toDecimalString()} filled=${filledBase.toDecimalString()}`,
    };
  }

  // 4. Cross-check completion percentage when provided.
  if (input.coinbaseCompletionPct !== undefined && requestedForResidual !== null && requestedForResidual.isPositive()) {
    const ours = filledBase.div(requestedForResidual).mul(Money.fromString('100'));
    const oursNumber = Number(ours.toDecimalString(4));
    if (Math.abs(oursNumber - input.coinbaseCompletionPct) > CONSISTENCY_PCT_TOLERANCE) {
      return {
        kind: 'inconsistent',
        filledBase,
        filledQuote,
        residualBase,
        isTerminal,
        reason: 'completion_pct_disagreement',
        inconsistencyDetail: `cb=${input.coinbaseCompletionPct}% ours=${oursNumber.toFixed(2)}%`,
      };
    }
  }

  // 5. Classify. Note: the ORDER of these checks matters — dust > completely
  //    is only allowed at terminal; open orders with residual are still open.
  const zeroFill = !filledBase.isPositive();
  const anyFill = filledBase.isPositive();

  if (zeroFill) {
    if (isTerminal) {
      return {
        kind: 'unfilled_terminal',
        filledBase,
        filledQuote,
        residualBase,
        isTerminal: true,
        reason: `terminal ${coinbaseStatus} with zero fills`,
      };
    }
    if (coinbaseStatus === undefined) {
      return {
        kind: 'unknown',
        filledBase,
        filledQuote,
        residualBase,
        isTerminal: false,
        reason: 'no_coinbase_status_and_zero_fills',
      };
    }
    return {
      kind: 'unfilled_open',
      filledBase,
      filledQuote,
      residualBase,
      isTerminal: false,
      reason: `open ${coinbaseStatus} with zero fills`,
    };
  }

  // At least one fill.
  const residualIsDust = requestedForResidual !== null && !residualBase.isZero() && residualBase.lte(dustCeiling);
  const residualIsZero = requestedForResidual !== null && residualBase.isZero();
  const residualUnknown = requestedForResidual === null;

  if (anyFill && (residualIsZero || residualUnknown)) {
    if (isTerminal || coinbaseStatus === 'FILLED') {
      return {
        kind: 'completely_filled',
        filledBase,
        filledQuote,
        residualBase: Money.zero(),
        isTerminal: true,
        reason: `terminal ${coinbaseStatus} fully filled`,
      };
    }
    // Filled everything requested but still OPEN? Possible for IOC that
    // filled entirely and Coinbase hasn't updated status yet. Classify as
    // partially_filled_open since we don't have terminal confirmation.
    return {
      kind: 'partially_filled_open',
      filledBase,
      filledQuote,
      residualBase,
      isTerminal: false,
      reason: `filled but status still ${coinbaseStatus ?? 'unknown'}`,
    };
  }

  if (residualIsDust && isTerminal) {
    return {
      kind: 'filled_with_dust_residual',
      filledBase,
      filledQuote,
      residualBase,
      isTerminal: true,
      reason: `dust residual ${residualBase.toDecimalString()} ≤ ${dustCeiling.toDecimalString()}`,
    };
  }

  if (isTerminal) {
    return {
      kind: 'partially_filled_terminal',
      filledBase,
      filledQuote,
      residualBase,
      isTerminal: true,
      reason: `terminal ${coinbaseStatus} with residual ${residualBase.toDecimalString()}`,
    };
  }

  return {
    kind: 'partially_filled_open',
    filledBase,
    filledQuote,
    residualBase,
    isTerminal: false,
    reason: `open ${coinbaseStatus ?? 'unknown'} with residual ${residualBase.toDecimalString()}`,
  };
}
