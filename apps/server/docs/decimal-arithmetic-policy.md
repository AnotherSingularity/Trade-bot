# Decimal Arithmetic Policy (Phase 1.1.a)

Established by Phase 1.1.a §M. This file is the source of truth for how money
values flow through the codebase — audit item #15 called out that Slice 1's
Money type was scoped to the new gate but the execution core still used
`Number`. This policy corrects that.

## Layers

| Layer | Representation | Rationale |
|---|---|---|
| **Coinbase HTTP request** | decimal string (e.g. `"0.10000000"`) | matches the Advanced Trade JSON schema exactly |
| **Coinbase HTTP response** | decimal string as received | never `parseFloat` — keep exact |
| **MySQL `decimal(20,8)` column** | decimal string on read AND write | Drizzle returns/accepts strings for `decimal` |
| **Server internal computation** | `Money` (bigint scaled by 1e8) | one representation for every add/sub/mul/div/pct |
| **tRPC response to mobile** | `number` (display only) | at the boundary, once, via `Money.toNumber()` — never round-tripped back into math |
| **Log messages / user-visible strings** | `.toDecimalString(2)` / `.toDecimalString(4)` | display only |

## Rules

1. **Never call `Number()` on a monetary value inside the execution core.**
   Use `Money.fromString()` at the ingress boundary (exchange response, DB read,
   env-var parse), do all math with `Money`, and serialize with
   `.toDecimalString()` at the egress boundary (DB write, log, tRPC boundary).

2. **Never use `parseFloat`, `Math.floor`, `Math.round`, or `.toFixed()` on a
   monetary value.** Use `Money.roundToIncrement(inc, mode)` and
   `Money.toDecimalString(digits)`.

3. **`Number` is allowed** only for:
   * timestamps (`Date.now() / 1000` in JWT signing),
   * counts (`filledSize > 0` when `filledSize: Money` — use `.isPositive()`
     or `.isZero()` instead if the value is `Money`),
   * bookkeeping that never flows into money math (loop indices, array
     lengths).

4. **`.toFixed()` on a Money value is banned.** Use `Money.toDecimalString(n)`
   which routes through the same HALF_EVEN rounder as internal math.

5. **Presentation-only paths (dashboard summaries, log strings, activity
   detail messages) may compute a display number** via `Money.toNumber()` or
   `.toDecimalString(n)`. They must not feed the resulting number back into
   any monetary computation.

## Boundary responsibilities

| Function | Ingress converts to Money | Egress converts from Money |
|---|---|---|
| `aggregateFills` | fill rows (decimal strings) → Money | returns Money |
| `simulateBuyFill` / `simulateSellFill` | Money in, Money in fields | fills the CoinbaseFill with decimal strings |
| `debitBuyToLedger` / `creditSellToLedger` | Money agg fields | records ledger via decimal strings |
| `openPosition` / `closePosition` | reads product/prices via Money | writes DB via `.toDecimalString(8)` |
| `getPortfolioCash` | reads ledger via Money | **returns Money** (was `number`) |
| `getCashBalance` (query) | sql sum returns string | returns Money |
| `getBotStatusDTO` (API) | may accept Money | returns `number` at tRPC boundary |
| `shouldExit` | reads position TP/SL via Money | boolean out |

## What NOT to migrate (scoped out of 1.1.a)

* **Mobile app formatting** — the app receives `number` from tRPC and formats
  for display; no monetary math occurs there. It stays as-is.
* **Dashboard aggregate summary fields** — presentation only, computed at the
  API boundary.
* **`activityLog.detail` strings** — human-readable; may use `.toDecimalString(4)`.
* **Ticker prices for scanner display / historical candles for indicator math**
  — these are market observations, not money. The indicator library (RSI, EMA,
  MACD, Bollinger) is pure math over `number[]` closing prices and stays that
  way.

## Migration schedule

Phase 1.1.a migrates the execution-critical monetary paths listed above.
Later slices will not add new `Number`-based monetary code — any future money
operation must start on `Money` from the beginning.
