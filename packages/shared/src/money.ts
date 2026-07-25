/**
 * Decimal-safe money arithmetic (Phase 1 Absolute Constraint).
 *
 * All monetary values — USD amounts, fees, spreads, prices, base sizes, and
 * P&L — are represented as bigint integers scaled by 1e8. This matches the
 * eight-decimal precision the Coinbase API uses for price/size fields and the
 * `decimal(20,8)` columns in MySQL. Rationale: JavaScript `number` is IEEE-754
 * binary float, which cannot exactly represent common decimal fractions
 * (0.1 + 0.2 !== 0.3), so any monetary calculation done as a number can drift
 * over long-running processes and compound into meaningful loss.
 *
 * SCALE choices:
 *   • 8 decimal places (SCALE = 100_000_000n) — sufficient for BTC-level
 *     precision. Higher precision (e.g. wei / 18) would be needed for on-chain
 *     token amounts but is unnecessary for spot trading through Coinbase.
 *   • Basis-point conversion is separately supported.
 *
 * SERIALIZATION:
 *   • `toDecimalString()` — canonical decimal notation for DB `decimal(20,8)`
 *     columns and API responses.
 *   • `toNumber()` — ONLY for display / logging. Never use the returned
 *     number back in arithmetic.
 *   • JSON round-trips via `toDecimalString()` + `Money.fromString()`.
 *
 * ROUNDING:
 *   • Explicit RoundingMode. Division and multiplication of non-integer
 *     ratios must specify how to round the discarded digits.
 *   • Default HALF_EVEN (banker's rounding) — matches IEEE-754 default and
 *     avoids the systematic bias of HALF_UP.
 */

export const MONEY_SCALE = 8 as const;
export const MONEY_SCALE_BIGINT = 100_000_000n; // 10n ** 8n

/** Rounding mode applied to the discarded digits of a scaled result. */
export type RoundingMode =
  | 'HALF_EVEN' // banker's — default
  | 'HALF_UP' // 0.5 → away from zero
  | 'DOWN' // truncate toward zero
  | 'UP' // away from zero
  | 'FLOOR' // toward -inf
  | 'CEIL'; // toward +inf

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function signOf(x: bigint): 1n | -1n | 0n {
  return x > 0n ? 1n : x < 0n ? -1n : 0n;
}

/**
 * Round a bigint value (already scaled by `scale`) that carries `discarded`
 * extra low digits, using the given mode. Returns the rounded value at the
 * caller's requested scale.
 *
 * Precondition: `discardedScale > 0n`. `raw` is the exact value at
 * `scale * discardedScale`; the returned value is at `scale`.
 */
function roundScaled(raw: bigint, discardedScale: bigint, mode: RoundingMode): bigint {
  if (discardedScale <= 0n) throw new Error('discardedScale must be positive');
  const quotient = raw / discardedScale;
  const remainder = raw - quotient * discardedScale;
  if (remainder === 0n) return quotient;

  const sign = raw < 0n ? -1n : 1n;
  const absRem = absBig(remainder);
  const absQuo = absBig(quotient);
  const half = discardedScale / 2n;
  const isExactHalf = absRem * 2n === discardedScale;

  let bumpAbs = 0n;
  switch (mode) {
    case 'DOWN':
      bumpAbs = 0n;
      break;
    case 'UP':
      bumpAbs = 1n;
      break;
    case 'FLOOR':
      bumpAbs = sign < 0n ? 1n : 0n;
      break;
    case 'CEIL':
      bumpAbs = sign > 0n ? 1n : 0n;
      break;
    case 'HALF_UP':
      bumpAbs = absRem >= discardedScale - half ? 1n : 0n;
      break;
    case 'HALF_EVEN':
      if (!isExactHalf) {
        bumpAbs = absRem > half ? 1n : 0n;
      } else {
        // Round to even: bump only when the current quotient is odd.
        bumpAbs = absQuo % 2n === 1n ? 1n : 0n;
      }
      break;
  }
  return quotient + bumpAbs * sign;
}

/**
 * Parses a decimal string into a bigint scaled by 1e8. Supports optional
 * leading sign and up to 8 fractional digits (extra digits are rounded per
 * `mode`, default HALF_EVEN).
 */
function parseDecimalToScaled(input: string, mode: RoundingMode = 'HALF_EVEN'): bigint {
  const trimmed = input.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Money: invalid decimal string "${input}"`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracRaw = ''] = unsigned.split('.');
  const s = MONEY_SCALE;
  let scaled: bigint;
  if (fracRaw.length === s) {
    scaled = BigInt(intPart + fracRaw);
  } else if (fracRaw.length < s) {
    scaled = BigInt(intPart + fracRaw.padEnd(s, '0'));
  } else {
    // Extra fractional digits — round.
    const keep = fracRaw.slice(0, s);
    const discard = fracRaw.slice(s);
    const rawExact = BigInt(intPart + keep + discard);
    const discardedScale = 10n ** BigInt(discard.length);
    scaled = roundScaled(rawExact, discardedScale, mode);
  }
  return negative ? -scaled : scaled;
}

// ---------------------------------------------------------------------------
// Money class
// ---------------------------------------------------------------------------

/**
 * Fixed-point decimal money, stored as bigint scaled by 1e8. Immutable.
 *
 * `Money` is unitless — it can represent USD, a base-asset quantity, a price,
 * a percentage, or a ratio. Callers are responsible for using compatible units
 * in an expression (e.g. multiplying USD-per-unit by units yields USD).
 */
export class Money {
  /** Raw bigint value scaled by 1e8. Exposed for zero-cost interop. */
  readonly scaled: bigint;

  private constructor(scaled: bigint) {
    this.scaled = scaled;
  }

  // -------- constructors --------

  static zero(): Money {
    return new Money(0n);
  }

  static fromScaled(scaled: bigint): Money {
    return new Money(scaled);
  }

  /** Construct from a canonical decimal string, e.g. "0.30000000". */
  static fromString(input: string, mode: RoundingMode = 'HALF_EVEN'): Money {
    return new Money(parseDecimalToScaled(input, mode));
  }

  /**
   * Construct from a JS `number`. LOSSY at the input boundary — use only for
   * external values that were themselves floats (e.g. legacy code, test
   * fixtures). Prefer `fromString` for values originating from the exchange or
   * database.
   */
  static fromNumber(n: number, mode: RoundingMode = 'HALF_EVEN'): Money {
    if (!Number.isFinite(n)) throw new Error('Money: input must be finite');
    // Route through the string representation to leverage the same rounding
    // path and avoid float-arithmetic drift here.
    return Money.fromString(n.toFixed(MONEY_SCALE + 2), mode);
  }

  /** Construct from basis points, e.g. `fromBps(50)` = 0.005. */
  static fromBps(bps: number | bigint): Money {
    const b = typeof bps === 'bigint' ? bps : BigInt(Math.trunc(bps));
    // 1 bp = 0.0001 = MONEY_SCALE_BIGINT / 10_000
    return new Money((b * MONEY_SCALE_BIGINT) / 10_000n);
  }

  // -------- serialization --------

  /**
   * Canonical decimal string with `digits` fractional places (default 8).
   * Directly usable in MySQL `decimal(20,8)` inserts.
   */
  toDecimalString(digits: number = MONEY_SCALE): string {
    if (!Number.isInteger(digits) || digits < 0 || digits > MONEY_SCALE) {
      throw new Error(`toDecimalString: digits must be an integer 0..${MONEY_SCALE}`);
    }
    const negative = this.scaled < 0n;
    const abs = absBig(this.scaled);
    const div = 10n ** BigInt(MONEY_SCALE - digits);
    const rounded = roundScaled(abs, div, 'HALF_EVEN');
    const scaleAtDigits = MONEY_SCALE_BIGINT / div;
    const int = rounded / scaleAtDigits;
    const frac = rounded % scaleAtDigits;
    const fracStr = digits === 0 ? '' : '.' + frac.toString().padStart(digits, '0');
    return (negative && rounded !== 0n ? '-' : '') + int.toString() + fracStr;
  }

  /**
   * LOSSY conversion to number for display/logging only. Never feed back into
   * money arithmetic.
   */
  toNumber(): number {
    return Number(this.toDecimalString(MONEY_SCALE));
  }

  toJSON(): string {
    return this.toDecimalString();
  }

  toString(): string {
    return this.toDecimalString();
  }

  // -------- arithmetic --------

  add(other: Money): Money {
    return new Money(this.scaled + other.scaled);
  }

  sub(other: Money): Money {
    return new Money(this.scaled - other.scaled);
  }

  /**
   * Multiplies by a dimensionless Money value (typically a rate/quantity).
   * Result is scaled back to 1e8. Rounding applies to the discarded digits.
   */
  mul(other: Money, mode: RoundingMode = 'HALF_EVEN'): Money {
    const raw = this.scaled * other.scaled;
    return new Money(roundScaled(raw, MONEY_SCALE_BIGINT, mode));
  }

  /** Multiply by an integer factor (exact, no rounding). */
  mulInt(n: bigint | number): Money {
    const b = typeof n === 'bigint' ? n : BigInt(Math.trunc(n));
    return new Money(this.scaled * b);
  }

  /**
   * Divides by a Money value (result is dimensionless — a ratio at 1e8).
   * Rounding applies to the final scaled result.
   */
  div(other: Money, mode: RoundingMode = 'HALF_EVEN'): Money {
    if (other.scaled === 0n) throw new Error('Money.div: division by zero');
    const raw = this.scaled * MONEY_SCALE_BIGINT;
    return new Money(roundScaled(raw, other.scaled, mode));
  }

  /** Divide by an integer (exact remainder rounded). */
  divInt(n: bigint | number, mode: RoundingMode = 'HALF_EVEN'): Money {
    const b = typeof n === 'bigint' ? n : BigInt(Math.trunc(n));
    if (b === 0n) throw new Error('Money.divInt: division by zero');
    return new Money(roundScaled(this.scaled, b, mode));
  }

  /**
   * Multiplies by a percentage. E.g. `Money.fromString("100").pct(3)` = 3.
   * Rounding applies.
   */
  pct(percent: number | Money, mode: RoundingMode = 'HALF_EVEN'): Money {
    const p = typeof percent === 'number' ? Money.fromNumber(percent) : percent;
    // percent / 100
    const raw = this.scaled * p.scaled;
    // Divide by MONEY_SCALE (undo Money*Money) then by 100.
    return new Money(roundScaled(raw, MONEY_SCALE_BIGINT * 100n, mode));
  }

  /** Absolute value. */
  abs(): Money {
    return new Money(absBig(this.scaled));
  }

  /** Negation. */
  neg(): Money {
    return new Money(-this.scaled);
  }

  // -------- comparison --------

  cmp(other: Money): -1 | 0 | 1 {
    return this.scaled === other.scaled ? 0 : this.scaled < other.scaled ? -1 : 1;
  }

  eq(other: Money): boolean {
    return this.scaled === other.scaled;
  }

  lt(other: Money): boolean {
    return this.scaled < other.scaled;
  }

  lte(other: Money): boolean {
    return this.scaled <= other.scaled;
  }

  gt(other: Money): boolean {
    return this.scaled > other.scaled;
  }

  gte(other: Money): boolean {
    return this.scaled >= other.scaled;
  }

  isZero(): boolean {
    return this.scaled === 0n;
  }

  isPositive(): boolean {
    return this.scaled > 0n;
  }

  isNegative(): boolean {
    return this.scaled < 0n;
  }

  sign(): -1 | 0 | 1 {
    const s = signOf(this.scaled);
    return s === 1n ? 1 : s === -1n ? -1 : 0;
  }

  // -------- rounding to an increment (Coinbase base_increment / quote_increment) --------

  /**
   * Rounds down to the nearest multiple of `increment` (typical for order
   * sizes, where you must not submit a size Coinbase would reject).
   */
  roundToIncrement(increment: Money, mode: RoundingMode = 'DOWN'): Money {
    if (increment.scaled <= 0n) throw new Error('roundToIncrement: increment must be positive');
    const raw = this.scaled;
    const step = increment.scaled;
    const rounded = roundScaled(raw, step, mode) * step;
    return new Money(rounded);
  }

  // -------- static combinators --------

  static max(a: Money, b: Money): Money {
    return a.gte(b) ? a : b;
  }
  static min(a: Money, b: Money): Money {
    return a.lte(b) ? a : b;
  }

  /** Sum of a series (empty → zero). */
  static sum(values: Iterable<Money>): Money {
    let acc = 0n;
    for (const v of values) acc += v.scaled;
    return new Money(acc);
  }
}

/**
 * Common denominations, exported for readability.
 */
export const ZERO_MONEY = Money.zero();
export const ONE_MONEY = Money.fromString('1');
export const ONE_HUNDRED_MONEY = Money.fromString('100');
