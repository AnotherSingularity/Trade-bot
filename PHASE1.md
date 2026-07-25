# Phase 1 — Coinbase Execution Economics + Risk + Strategy Rebuild

> **DRY_RUN remains `true` and `ORDER_SUBMISSION_ENABLED` remains `false`.**
> **No real Coinbase order has been submitted at any point in Phase 1.**

Phase 1 is the audit's "make it a laboratory before making it a business" phase.
It is large enough that it is being delivered in slices. Each slice is genuinely
complete on its own — no stubs, no half-implementations. The user reviews each
slice before the next begins.

---

## Slice 1 — Killswitch, Money, Fee Tier, Preview, Cost Model, EV Gate, Snapshots

Status: **complete**. 149 tests / 17 files / all green. Full monorepo
typechecks. DB migrations applied to both dev and test databases.

The strongest capital-safety improvement in this slice is the **EV gate**.
Every scanner candidate now flows through:

```
signal → fee_tier → preview → cost_forecast → EV gate → (Claude only if accepted)
```

Claude cannot receive — much less approve — a mathematically unprofitable
candidate. The audit's specific "3% TP / 2% SL / 1.5% early exit at 60 bps
taker" configuration is caught before any LLM call and recorded as a rejection
with a machine-readable reason.

### Files added

**Server** (`apps/server/src`)
- `env.ts` — `ORDER_SUBMISSION_ENABLED` env, required in live mode (double-lock)
- `trading/coinbase.ts` — `getTransactionSummary`, richer `CoinbasePreviewResponse`, killswitch inside `createOrder`
- `trading/feeTier.ts` — cached authenticated fee-tier service with 1h TTL, 3h hard staleness limit, fail-closed, DB snapshot persistence, synthetic conservative fallback for dry-run
- `trading/preview.ts` — typed preview service: rejects on any `errs`, any `warning`, missing `commission_total`, missing avg-fill, or network errors
- `trading/costModel.ts` — MV cost model: entry/exit fees from tier + preview, exit-impact bps by liquidity tier, latency-slippage buffer, round-trip cost, net TP/SL P&L, R/R, break-even prob. Stamps `COST_MODEL_VERSION`
- `trading/evGate.ts` — profitability + EV gate: rejects `net_tp_not_positive_after_costs`, `round_trip_cost_consumes_too_much_of_target`, `net_reward_risk_below_threshold`, or `expected_value_below_minimum` (each is a machine-readable enum value)
- `trading/scanner.ts` — refactored entry loop to insert `signal_candidates`, call preview, insert `execution_cost_forecasts`, apply EV gate, insert `quantitative_decisions` (accepted OR rejected), then call Claude only on acceptance
- `db/schema.ts` — added `feeTierSnapshots`, `signalCandidates`, `executionCostForecasts`, `quantitativeDecisions` (+ typed exports)
- `db/queries.ts` — `insertSignalCandidate`, `insertExecutionCostForecast`, `insertQuantitativeDecision`, `countDecisionsForSeed`

**Shared** (`packages/shared/src`)
- `money.ts` — new decimal-safe Money type. bigint scaled by 1e8, HALF_EVEN/HALF_UP/DOWN/UP/FLOOR/CEIL rounding modes, `fromString`/`fromBps`/`fromNumber`, `mul`/`div`/`pct`/`add`/`sub`, `roundToIncrement`, `Money.sum/max/min`. Foundation for all Phase 1 cost math

**Migration**
- `drizzle/migrations/0002_phase1_slice1_immutable_decisions.sql` — 4 tables with indexes + FKs. Applied to `horizon_trade` (dev) and `horizon_trade_test` (test) DBs

**Tests** (all under `apps/server/tests`)
- `money.test.ts` (23) — 0.1+0.2=0.3 exactly, thousand-cent addition, HALF_EVEN behavior, roundToIncrement, comparison invariants, JSON round-trip
- `killswitch.test.ts` (3) — `createOrder` throws inside the client with `code=order_submission_disabled`, `fetch` is never called
- `feeTier.test.ts` (7) — happy-path parse, synthetic fallback, cache hits without network, fail-closed on error + no cache, DB warm-load, `missing fee_tier` rejection, implausible-rate rejection
- `preview.test.ts` (8) — happy path, `errs[]` rejection, `preview_failure_reason` rejection, warning rejection, missing commission, mid fallback when avg-fill missing, network-error classification, synthetic path
- `costModel-evGate.test.ts` (16) — model version stamped, spread bps math, fees on both sides, the audit's reversion 3%/2%/60bps case rejected, macro 8%/3% accepted, breakout 15%/6% accepted, EV gate reject reasons enumerated
- `decisionSnapshots.test.ts` (4) — every candidate persisted, both accepted + rejected reasons + all three version stamps, forecast/decision FK linkage, immutability (fresh id per insert)
- `scanner-flow.test.ts` (5) — contract test that `previewCandidate`, `buildCostForecast`, and `applyEvGate` all appear before `evaluateSignal` in `scanner.ts`; the gate's `continue` short-circuits before Claude; every candidate writes a decision row

### Data flow (immutable-snapshot side)

```
              ┌──────────────────────┐
              │  fee_tier_snapshots  │  ← refreshed hourly, persisted per fetch
              └──────────┬───────────┘
                         │ (feeTierSnapshotId FK)
                         ▼
scan candidate ────▶ signal_candidates ─────┐
                                             │
                                             ▼
                                execution_cost_forecasts   ← immutable at
                                             │              decision time;
                                             │              realized_* fields
                                             │              filled later by
                                             │              slice-3 reconciler
                                             ▼
                                quantitative_decisions    ← every candidate:
                                                            accept OR reject_*
                                             │
                                             │ (only when decision='accept')
                                             ▼
                                    Claude (evaluateSignal)
                                             │
                                             ▼
                                 (existing openPosition flow)
```

### Version stamps

Every decision row carries:
- `strategyVersion` (from `@horizon/shared/STRATEGY_VERSION`, currently `2.0.0`)
- `costModelVersion` (`p1s1-mv-1`)
- `evGateVersion` (`p1s1-1`)
- Every candidate row also carries `featureVersion` (`p1s1-1`) and a placeholder `regimeLabel='unclassified'` (regime engine arrives in slice 2)

### Killswitch summary

- `ORDER_SUBMISSION_ENABLED` env var defaults `false`
- Enforced INSIDE `coinbase.createOrder()` — throws a
  `non_retryable_validation` `CoinbaseError` before any HTTP
- Live boot (`DRY_RUN=false`) requires it be explicitly `true` in addition
  to all Phase 0 live-mode requirements

### DB migration state

Applied to both `horizon_trade` and `horizon_trade_test`:
```
mysql> SHOW TABLES;
+----------------------------+
| Tables_in_horizon_trade    |
+----------------------------+
| ... (Phase 0 tables) ...   |
| execution_cost_forecasts   |
| fee_tier_snapshots         |
| quantitative_decisions     |
| signal_candidates          |
+----------------------------+
```

---

## What is NOT yet in slice 1

These are deliberately deferred to keep slice 1 shippable and reviewable, and
will land in subsequent slices in this priority order:

### Slice 2 — Live-book cost model + regime engine + Claude discipline
- Level 2 WebSocket order-book service with sync detection + book-walk API
  (replaces the MV cost model's static illiquid buffer with live depth)
- Realized-cost distribution store + rolling quantile estimator (replaces the
  hardcoded 95th %ile buffer with a per-token/regime empirical estimate)
- Regime engine: 5m / 1h / 6h / daily classification into TREND_UP,
  TREND_DOWN, RANGE, VOLATILITY_EXPANSION, CAPITULATION, DISORDERED, UNKNOWN
  (blocks entries in DISORDERED / UNKNOWN)
- Claude decisions table + APPROVE / REJECT / ABSTAIN protocol + calibration
  metrics (approval rate, Brier, incremental EV vs. quant-only baseline)

### Slice 3 — Portfolio risk engine + risk-based sizing + shadow-live lab
- Independent `RiskEngine` with veto authority over scanner/Claude/executor
- Factor decomposition, correlation clustering, stress tests, Expected
  Shortfall
- Risk-based sizing (allowed-risk-dollars / effective-stop-distance) replaces
  allocation-percentage sizing
- Drawdown / exposure ladder that auto-reduces size and blocks entries when
  thresholds are approached
- `SIMULATION_MODE=SHADOW_LIVE` operating mode with paper execution engine
  (walks the live book, applies latency, models partial fills, queue-aware
  limit fills, stop-through-book slippage)
- `paper_orders`, `paper_fills`, `shadow_positions`, `completed_round_trips`
  tables + realized-cost reconciliation into the slice-1 forecast rows

### Slice 4 — Strategy rebuild + controlled learning + dashboard
- Reversion, Breakout, Macro Floor rebuilt to their audit specifications
  (range regime + reclaim, volatility contraction + relative volume,
  20-40% drawdown + support hold — respectively)
- Whole-universe ranking + correlation penalty + concentration penalty
- Controlled online learning (spread/slippage/latency/fill/calibration only;
  never strategy parameters) with champion/challenger workflow requiring
  explicit human promotion
- Full dashboard: fee tier, cost forecast vs. realized, portfolio risk /
  Expected Shortfall / stress-test loss, regime, data freshness, gross vs.
  net performance, Claude vs. quant-only

---

## Test results (verbatim)

```
Test Files  17 passed (17)
     Tests  149 passed (149)
```

Full monorepo typecheck passes (`turbo run typecheck`).

## Explicit confirmation

- `DRY_RUN=true` in `apps/server/.env` (unchanged from Phase 0)
- `ORDER_SUBMISSION_ENABLED=false` in `apps/server/.env` (Phase 1 double-lock)
- No real Coinbase order was placed during Phase 1 slice 1
- No production `POST /api/v3/brokerage/orders` call reached the wire during
  any test — killswitch enforced at the client, `fetch` spy verifies zero
  invocations in the killswitch tests
- All Coinbase interactions in the test suite go through the mocked module or
  the vitest fetch spy; no test hits `api.coinbase.com`
- The slice-2 slice-3 items above (L2 book, regime engine, risk engine,
  shadow-live lab, mode rebuild) are still required before any consideration
  of `DRY_RUN=false`
