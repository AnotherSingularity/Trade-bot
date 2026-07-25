# Phase 1.1 Gate 3B — Cash-Flow Cost Model

> **DRY_RUN remains `true`.** **ORDER_SUBMISSION_ENABLED remains `false`.**
> **No Coinbase Create Order request was made during Gate 3B.**

Gate 3B is the second of four commits that complete Gate 3. This one
delivers the cash-flow cost model: exact decimal cash flows for the four
economic outcomes (entry, target, stop, timeout), separated cost
components labeled as configured buffers (not "quantiles" or
"empirical"), a common target/stop price basis, an
`OutcomeProbabilityEstimate` interface pinned to `not_calibrated`, and a
forecast-vs-realized attribution row per completed round trip. Gates 3C /
3D follow in separate reviewed commits.

## Deliverables

### 1. Exact cash-flow economics (§I)

`src/trading/cashFlowForecast.ts` — pure builder. Every value is exact
decimal arithmetic on `Money` (bigint-scaled). No `Number`; no
percentage-shortcut.

```
Q             = preview.baseSize                    (base units)
F_entry       = preview.commissionTotal             (fee incurred at entry)
P_entry       = preview.estimatedAvgFillPrice       (preview VWAP)
basisPrice    = P_entry           if targetStopBasis='preview_entry'
              = arrivalMid        if targetStopBasis='reconciled_entry'

takeProfitPrice = basisPrice · (1 + takeProfitPct/100)
stopLossPrice   = basisPrice · (1 − stopLossPct/100)

conservativeTargetExitPrice  = takeProfitPrice · (1 − exitImpactBps/10000)
conservativeStopExitPrice    = stopLossPrice   · (1 − stopGapBps/10000)
conservativeTimeoutExitPrice = basisPrice      · (1 − exitImpactBps/10000)

entryOutflow  = Q · P_entry + F_entry
targetInflow  = Q · conservativeTargetExitPrice  − F_target_exit
stopInflow    = Q · conservativeStopExitPrice    − F_stop_exit
timeoutInflow = Q · conservativeTimeoutExitPrice − F_timeout_exit

netTargetPnl  = targetInflow  − entryOutflow
netStopPnl    = stopInflow    − entryOutflow
netTimeoutPnl = timeoutInflow − entryOutflow
```

The four cash flows and three net PnLs are the only quantities the gate
and the attribution row are computed from. No intermediate approximation
is layered in front.

### 2. Separated cost components (§J)

Every cost forecast row now carries the following independent components:

| component | source |
|---|---|
| `entryCommission` | preview `commissionTotal` |
| `targetExitCommission` | `Q · conservativeTargetExitPrice · takerFeeRate` |
| `stopExitCommission` | `Q · conservativeStopExitPrice · takerFeeRate` |
| `timeoutExitCommission` | `Q · conservativeTimeoutExitPrice · takerFeeRate` |
| `quotedSpread` | `(bestAsk − bestBid) · Q` |
| `effectiveSpread` | `|preview.estimatedAvgFillPrice − mid| · Q · 2` |
| `entryImpact` | `(preview.estimatedAvgFillPrice − arrivalMid) · Q` |
| `targetExitImpact` | `takeProfitPrice · (exitImpactBps/10000) · Q` |
| `stopExitImpact` | `stopLossPrice · (stopGapBps/10000) · Q` |
| `latencyBufferAbs` | `basisPrice · (latencyBps/10000) · Q` |
| `stopGapBufferAbs` | `stopLossPrice · (stopGapBps/10000) · Q` |
| `partialFillBufferAbs` | `basisPrice · (partialFillBps/10000) · Q` |
| `unfilledOpportunityEstimate` | `0` (informational placeholder) |
| `residualDustEstimate` | `0` (informational placeholder) |
| `totalForecastCost` | `entryCommission + targetExitCommission + max(entryImpact,0) + targetExitImpact + latencyBufferAbs` |

No component is aggregated into another. `costAdjustedPayoffGate` and
downstream attribution both read the components directly.

### 3. Common target/stop price basis (§K)

`CashFlowForecast.targetStopBasis` is an enum with two values:

- `'preview_entry'` (default) — TP and SL are computed off
  `preview.estimatedAvgFillPrice`. Used at authorization time.
- `'reconciled_entry'` — TP and SL are computed off `arrivalMid`. Used
  after a fill materially deviates from preview
  (`|actualWeightedAvgFill − previewFill| / previewFill > POST_FILL_DEVIATION_TOLERANCE_BPS`);
  the deviation triggers revalidation before any protective order is
  attached.

`checkPostFillDeviation(previewedEntryFill, actualWeightedAvgFill,
toleranceBps=50)` returns `{deviationBps, revalidationRequired,
toleranceBps}` — the deviation is exact bps against the preview.

### 4. Honest buffer labeling (§L)

Every buffer is labeled `bufferSource='configured'` /
`isEmpiricalBuffer=false` / `bufferSampleCount=0`. The word "quantile"
and the word "empirical" are never used in the row without a matching
`bufferSampleCount > 0`, which requires Gate 3D's shadow calibration
pipeline to be in place.

```
CASH_FLOW_BUFFER_VERSION       = 'p1g3b-configured-1'
CONFIGURED_EXIT_IMPACT_BUFFER_BPS = 10
CONFIGURED_LATENCY_BUFFER_BPS     = 5
CONFIGURED_STOP_GAP_BUFFER_BPS    = 20
CONFIGURED_PARTIAL_FILL_BUFFER_BPS = 5
CONFIGURED_ILLIQUID_EXIT_BUFFER_BPS = 15
POST_FILL_DEVIATION_TOLERANCE_BPS   = 50
```

### 5. `costAdjustedPayoffGate` honesty preserved (§M)

The gate signature is untouched. Gate 3B extends `CashFlowForecast` with
the legacy `CostForecast` field aliases (`netTpPnl`, `netSlPnl`,
`entryFee`, `entryImpactBps`, `estimatedEntryFillPrice`,
`filledBaseSize`, `exitFeeEstimate`, `exitImpactBpsEstimate`,
`latencySlippageBpsEstimate`, `roundTripCost`, `costToTargetPct`,
`spreadBps`, `exitCostQuantile`) so the same forecast row flows into
`applyCostAdjustedPayoffGate` without a schema break. The exit-cost
"quantile" field is retained as a raw 0.95 with the alias solely for
schema compatibility — the accompanying buffer metadata makes clear the
underlying number is configured, not empirical.

### 6. `OutcomeProbabilityEstimate` interface (§N)

```
interface OutcomeProbabilityEstimate {
  pTarget: number | null;
  pStop:   number | null;
  pTimeout: number | null;
  uncertaintyLower: number | null;
  uncertaintyUpper: number | null;
  modelVersion: string | null;
  sampleCount: number;
  calibrationStatus: 'not_calibrated' | 'calibrating' | 'calibrated';
}

UNCALIBRATED_PROBABILITY: OutcomeProbabilityEstimate = {
  pTarget: null, pStop: null, pTimeout: null,
  uncertaintyLower: null, uncertaintyUpper: null,
  modelVersion: null, sampleCount: 0,
  calibrationStatus: 'not_calibrated',
}
```

Every Gate 3B forecast row carries `probabilityCalibrationStatus =
'not_calibrated'`. Nothing in Gate 3B advances past that state —
`calibrating` requires Gate 3D shadow observations, `calibrated`
requires the calibration pipeline itself.

### 7. Forecast-vs-realized attribution (§O)

`src/trading/forecastAttribution.ts` — `persistForecastAttribution({
roundTripId, outcomeTaken })`. For every completed round trip:

- Loads the round trip, the entry `order_intent`, and the exact
  `execution_cost_forecast` row that authorized the entry (via
  `entryIntent.costForecastId`).
- Aggregates ALL exit fills across ALL exit intents for the position
  (multiple partial exits fold into one attribution row).
- Computes realized entry cost = Σ entry-fill fees; realized exit cost
  = Σ exit-fill fees; realized slippage = (realizedEntryFill −
  previewEntryFill) · Q; realized net PnL = `roundTrip.realizedNetPnl`.
- Picks the forecast branch matching the outcome
  (target / stop / timeout).
- Computes `absoluteForecastError = |realizedNetPnl − forecastForPathTaken|`
  and `forecastErrorBps = absoluteForecastError / entryValueGross · 10000`.
- Inserts one row into `forecast_vs_realized_attributions`
  (`UNIQUE(roundTripId)` — at most one attribution per round trip;
  corrections would require a versioned successor).

The row is joined back to the Gate 2 `decisionChainId` and to the exact
`costForecastId`, so a full audit can walk decision → forecast →
realized cost → outcome for any round trip.

### 8. Modified files

**New**
- `apps/server/drizzle/migrations/0008_phase1_gate3b_cash_flow_cost_model.sql` — additive DDL: ~30 new nullable columns on `execution_cost_forecasts` + new `forecast_vs_realized_attributions` table with FK to `decision_chains`
- `apps/server/drizzle/migrations/meta/0008_snapshot.json` — mechanical
- `apps/server/drizzle/fingerprints/0008_mariadb_fingerprint.json` — mechanical
- `apps/server/src/trading/cashFlowForecast.ts` — the cash-flow builder + configured buffers + `OutcomeProbabilityEstimate` + `checkPostFillDeviation`
- `apps/server/src/trading/forecastAttribution.ts` — the attribution builder
- `apps/server/tests/phase1_gate3b.test.ts` — 15 tests (§tests 21–35)

**Modified**
- `apps/server/drizzle/migrations/meta/_journal.json` — entry 8 added
- `apps/server/src/db/schema.ts` — added ~30 columns to `executionCostForecasts`; added `forecastVsRealizedAttributions` table + type exports
- `apps/server/tests/setup/db.ts` — added `'forecast_vs_realized_attributions'` to the TRUNCATE list

### 9. Migration integrity

Path verified by the existing Gate 1c integrity suite (dynamically
discovers checkpoints from `_journal.json`):

| Path | Result |
|---|---|
| Fresh from zero (0000 → 0008) | ✅ same fingerprint |
| Upgrade from 0000 | ✅ same fingerprint |
| Upgrade from 0003 | ✅ same fingerprint |
| Upgrade from 0004 | ✅ same fingerprint |
| Repeated invocation | ✅ no-op |
| `drizzle-kit generate` after Gate 3B | ✅ empty diff |

Migrations 0000–0007 SQL files remain byte-identical to their pre-3B
versions. Only new migration `0008` was added.

### 10. Test results

```
$ npx turbo run typecheck test build
Tasks:    9 successful, 9 total

Test Files  25 passed (25)
     Tests  317 passed (317)   ← +15 vs Gate 3A's 302
```

New this tranche: `tests/phase1_gate3b.test.ts` (15 tests).

Verbatim per-item mapping:

| # | test name |
|---|---|
| 21 | entry commission changes net target P&L |
| 22 | entry spread widens: `quotedSpread` and `effectiveSpread` components both change |
| 23 | entry impact (adverse fill vs mid) shows as a non-zero `entryImpact` component |
| 24 | target-exit commission (fee tier) changes net target P&L |
| 25 | target-exit impact (widening exit buffer) reduces net target P&L |
| 26 | stop-gap buffer changes net STOP P&L (widens loss on stop-out) |
| 27 | timeout outcome has an independent net result from target and stop |
| 28 | no cost component is counted twice (target path components sum consistently) |
| 29 | static buffer is NOT labeled empirical |
| 30 | negative net target rejected by the cost-adjusted payoff gate |
| 31 | excessive cost-to-target is rejected by the gate |
| 32 | forecast + execution use the SAME price basis (`preview_entry` by default) |
| 33 | actual fill deviation triggers revalidation when > tolerance bps |
| 34 | forecast-vs-realized error is EXACT (round-trip → attribution row) |
| 35 | probability model remains `not_calibrated` |

### 11. Known limitations

- **The cash-flow forecast is not yet wired into the live scanner
  path.** Gate 3B ships the builder + attribution as a standalone
  module; the scanner still calls the legacy `buildCostForecast`. Gate
  3D's shadow-readiness commit will switch the scanner over once the
  end-to-end shadow harness is in place, so the two forecasts can be
  co-observed on the same signals before the swap.
- **`forecast_vs_realized_attributions` is written by
  `persistForecastAttribution` on demand.** The executor's
  `closePosition` path does not yet auto-invoke the attribution — Gate
  3B lands the module and the row schema; wiring it into the
  round-trip commit landing site is a Gate 3D shadow-observation task
  once real round trips are being generated in shadow mode.
- **`OutcomeProbabilityEstimate` cannot advance past `not_calibrated`
  in this gate.** The pipeline that would produce calibrated
  per-mode / per-regime distributions requires Gate 3D shadow
  observations to exist first.
- **`unfilledOpportunityEstimate` and `residualDustEstimate` are
  informational zeros.** They exist as first-class columns so a
  future calibrated model can populate them without another schema
  change; the current value is `0` in every row.

### 12. Remaining prerequisites before Gate 3C / 3D

**Gate 3C — protection eligibility matrix:**
- `protection_capabilities`, `protection_validation_runs`,
  `protection_policy_versions` tables (versioned per
  productId/orderType/tif/side/protectionType).
- Capability states: `unknown / documented_unverified / preview_supported /
  preview_rejected / shadow_validated / sandbox_validated /
  live_canary_validated / unsupported / temporarily_degraded`.
- Live capability rule: polling-only NEVER authorizes live capital.

**Gate 3D — shadow-readiness certification:**
- `SIMULATION_MODE=SHADOW_LIVE` env plumbing.
- Zero-order network certification (fetch-layer instrumentation, not
  just the exported `createOrder` mock).
- Reproducible shadow-readiness report with verdicts:
  `not_ready` | `mechanically_ready_for_shadow` | `degraded` — this
  gate NEVER produces `ready_for_live_capital`.
- Wire `buildCashFlowForecast` into the scanner (behind the shadow
  flag) and auto-invoke `persistForecastAttribution` at round-trip
  landing.

### 13. Explicit confirmation

- `DRY_RUN=true` in `apps/server/.env` — unchanged
- `ORDER_SUBMISSION_ENABLED=false` in `apps/server/.env` — unchanged
- Phase 1 §Q killswitch inside `coinbase.createOrder` untouched
- **No real Coinbase order was placed during Gate 3B.** The 15-test
  suite exercises the pure builder + the attribution writer against
  the DB directly; no test contacts `api.coinbase.com`.
- Migrations 0000–0007 SQL files remain byte-identical to their
  pre-3B versions. Only new migration `0008` was added.
- Token universe, strategy thresholds, allocations, TP, SL, routing,
  and Claude policy remain unchanged.
- Phase 2A remains **prohibited** until all four Gate 3 sub-gates
  (3A/3B/3C/3D) have been reviewed and the integrated Gate 3
  certification passes.
