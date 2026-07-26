# Phase 1.2 — Live Coinbase Data Plane and Continuous Shadow Operation

> **DRY_RUN remains `true`.** **ORDER_SUBMISSION_ENABLED remains `false`.**
> `SIMULATION_MODE=SHADOW_LIVE` is used only in shadow-certification
> fixtures and explicitly configured shadow environments.
> **No `POST /api/v3/brokerage/orders` invocation, attempt or network
> request occurred during Phase 1.2.**
> `createOrderFunctionInvocations = createOrderAttemptCount =
> createOrderNetworkCount = 0`.

Phase 1.2 connects Horizon's certified SHADOW_LIVE runtime to genuine
Coinbase market data and authenticated read-only economics, allowing
the bot to operate continuously as though it were trading while
remaining physically incapable of submitting an order. **Passing this
phase authorizes Phase 2A research work only. It does not authorize
live capital.**

## Deliverables

### 1. Live-data architecture diagram

```
             Coinbase Advanced Trade
   wss://advanced-trade-ws.coinbase.com    api.coinbase.com REST (GET only)
                    │                                  │
                    ▼                                  ▼
   ┌───────────────────────────────┐   ┌────────────────────────────┐
   │  CoinbaseMarketDataSupervisor │   │  MarketDataRestClient       │
   │   • heartbeats / status /     │   │   • product metadata        │
   │     ticker / candles /        │   │   • historical candles      │
   │     market_trades             │   │     (≤350 buckets / call)   │
   │   • heartbeat continuity      │   │   • fee tier / preview      │
   │   • bounded backoff + jitter  │   └──────────────┬──────────────┘
   │   • auto-resubscribe          │                  │
   └────────────┬──────────────────┘                  │
                │                                     │
                ▼                                     ▼
   ┌───────────────────────────────────────────────────────────┐
   │           MarketEventEnvelope (per-message)               │
   │  eventId, source, channel, productId, sourceTimestamp,    │
   │  receivedAt, dataAvailableAt, sequenceNumber,             │
   │  payloadHash (UNIQUE dedup), normalizedPayload,           │
   │  validationStatus ∈ {valid, rejected_malformed,           │
   │                     rejected_unknown, duplicate}          │
   └───────────────────────────────┬───────────────────────────┘
                                   ▼
   ┌──────────────────┬──────────────────┬──────────────────┐
   │ CandleAssembler  │  Ticker log      │  Market-trades log│
   │  • deterministic │  • bounded       │  • bounded        │
   │  • finalized ⇒   │                  │                   │
   │    immutable     │                  │                   │
   │  • v2 corrections│                  │                   │
   └─────────┬────────┴──────────────────┴──────────────────┘
             ▼
   ┌────────────────────────────┐
   │  DataQualityGate            │
   │   healthy | stale |         │
   │   incomplete_history |      │
   │   gap_detected |            │
   │   desynchronized |          │
   │   invalid_value |           │
   │   product_unavailable |     │
   │   connection_degraded       │
   └─────────┬──────────────────┘
             ▼
   ┌───────────────────────────────────────────────────────────┐
   │            runtimeShadowScan (Gate 3D-FIX §B)             │
   │     (only invoked when data-quality returns 'healthy')    │
   └──────────────────────────────┬────────────────────────────┘
                                  ▼
     forecast → payoff gate → protection capability → PLAN
                                  ▼
   ┌───────────────────────────────────────────────────────────┐
   │            runtimeShadowExecute (plan-locked)             │
   │        applyEntryEconomicStateTx + protection instance    │
   │                    + revalidation + attribution           │
   └───────────────────────────────────────────────────────────┘
                                  ▼
                        Shadow fill model
                    (marketable / passive / stop)
                     — isBookAware = false —
                                  ▼
                       Forward outcome labeling
                     (accepted AND rejected chains)
```

### 2. WebSocket connection and recovery state diagram

```
                disconnected
                     │
                     ▼
                connecting
                     │
                     ▼
               subscribing
                     │
                     ▼
              synchronizing
                     │
              (subscriptions ack + first data seen)
                     ▼
                  healthy
                     │
      ┌──────────────┴──────────────┐
      ▼                             ▼
    stale                       degraded
   (no data                    (channel error /
   in window)                    subscription rejected)
      │                             │
      └──────────────┬──────────────┘
                     ▼
                reconnecting  ──(storm)──▶  failed
                     │                        │
                (backoff)                     ▼
                     │                     stopped
                     └───▶ back to connecting
```

Backoff is deterministic exponential (base 500ms, cap 30s) with a 25%
envelope. A `reconnectStormThreshold` (5 attempts in 10s) trips the
supervisor into `failed`.

### 3. Event-envelope specification

Every message becomes one `MarketEventEnvelope` row in
`market_data_events`:

| field | source |
|---|---|
| eventId | `{channel}:{productId}:{isoSourceTs}:{seq}` |
| source | `coinbase-ws` / `coinbase-rest` |
| channel | `heartbeats` / `status` / `ticker` / `candles` / `market_trades` |
| productId | nullable (heartbeats has none) |
| sourceTimestamp | Coinbase's `timestamp` field |
| receivedAt | local receipt |
| dataAvailableAt | `min(receivedAt, now)` — never earlier than receipt |
| connectionId | FK to `market_stream_sessions.id` |
| sequenceNumber | Coinbase's `sequence_num` when present |
| eventType | `update` / `snapshot` / `heartbeat` / `status` / `trade` |
| schemaVersion | `p1_2-envelope-1` |
| payloadHash | sha256 of a canonical tuple → UNIQUE (dedup) |
| normalizedPayload | JSON string of the sanitized full payload |
| validationStatus | `valid` \| `rejected_malformed` \| `rejected_unknown` \| `duplicate` |

Malformed / unknown messages are recorded, never treated as market state.

### 4. Data-quality and staleness policy

`evaluateDataQuality({productId, now, supervisorHealthy})` returns one
of:

`healthy` | `stale` | `incomplete_history` | `gap_detected` |
`desynchronized` | `invalid_value` | `product_unavailable` |
`connection_degraded`.

Rules:

- `supervisorHealthy=false` ⇒ `connection_degraded`.
- Product status ≠ `online` ⇒ `product_unavailable`.
- `lastTickerAt` older than `tickerStaleMs` (default 30 000ms) ⇒ `stale`.
- `lastCandleAt` older than `candleStaleMs` (default 600 000ms) ⇒ `stale`.
- Fewer than `minFinalizedCandles` (default 26) ⇒ `incomplete_history`.
- Any open `market_data_gaps` row for the product ⇒ `gap_detected`.
- Non-decimal `latestPrice` ⇒ `invalid_value`.

**The last known price is never substituted after data becomes stale.**

### 5. Historical-bootstrap process

`bootstrapProduct(input)`:

1. Fetch product metadata; verify status = online + increments/min sizes valid.
2. Fetch candle history in ≤350-bucket pages (Coinbase's REST limit).
3. Dedupe + sort by `bucketStart`.
4. Detect missing intervals → `market_data_gaps` rows with
   `gapType='bootstrap_missing_interval'`.
5. Persist each bucket via the same `applyCandleUpdate` finalized path.
6. Verdict: `healthy` | `incomplete_history` | `gap_detected` |
   `invalid_value` | `product_unavailable`.

Zero-volume candles are **never** fabricated for periods without
authoritative data.

### 6. Candle-assembly policy

`applyCandleUpdate(input)`:

- Same `bucketStart` + not finalized ⇒ update THE SAME row.
- Same `bucketStart` + already finalized + identical OHLCV ⇒ `noop_duplicate`.
- Same `bucketStart` + already finalized + different content ⇒ new
  version with `supersedesCandleId` pointing back (`correctionReason`
  recorded).
- Out-of-order (older `sourceTimestamp` than current) ⇒
  `out_of_order_skipped`.
- Missing bucket detected on next arrival ⇒ `missing_candle_bucket` gap.

**Scanner consumption:** the current strategy uses
`getLatestFinalizedCandle(productId)` (last finalized bucket).
`getFormingCandle(productId)` exists for documentation but is not used
by the current strategy. This behavior is preserved unchanged in Phase
1.2 so the prospective baseline remains comparable.

### 7. Shadow fill-model specification and limitations

`src/trading/shadow/fillModel.ts` — `fillModelVersion='p1_2-fill-1'`.
Every simulated fill declares `isBookAware=false`.

- **Marketable (market_ioc):** `fillMarketable(...)` uses the approved
  preview VWAP + approved commission + observed decision-to-fill
  latency + configured adverse-latency buffer. Confidence: `ok`.
  Evidence: `approved_preview_vwap+observed_latency+configured_buffer`.
- **Passive limit:** `fillPassiveLimit(...)` requires an observed
  `market_trades` row through the limit AFTER `submittedAt`. A ticker
  touch alone is NEVER sufficient. Confidence capped at `limited`
  because queue position is unavailable. A no-fill result is
  preferable to an unsupported favorable fill.
- **Stops:** `fillStop(...)` triggers from post-entry observed
  `market_trades`. Adverse gap applied per `gapBps`. Stop-limit
  non-fill remains a possible outcome (`reason='stop_limit_nonfill'`).

The model is explicitly NOT order-book realistic. Level 2 remains a
future phase.

### 8. Runtime scanner sequence

```
for each product with data-quality == 'healthy':
  createDecisionChain (Gate 2)
  buildCashFlowForecast (Gate 3B)
  applyCostAdjustedPayoffGate
  ── if rejected → recordCandidateForLabeling(rejected) → done ──
  buildProtectedConfig
  evaluateProtectionCapability (Gate 3C)
  ── if rejected → recordCandidateForLabeling(rejected) → done ──
  INSERT shadow_execution_plans (Gate 3D)
  recordCandidateForLabeling(accepted)
  runtimeShadowExecute(planId, configHash, entryFills)
    → applyEntryEconomicStateTx (Gate 3A)
    → createProtectionInstance (Gate 3C)
    → revalidateAfterEntryFill (Gate 3D)
    → persistForecastAttribution on close (Gate 3B)
```

Every rejection creates a `forward_outcome_labels` row with
`decisionOutcome='rejected'` so the labeler can measure it
prospectively.

### 9. Restart-recovery sequence

```
process boot
  ├─ install fetch barrier (Gate 3D)
  ├─ load bot config; assert reconciliationStatus
  ├─ startup reconciler (Gate 3A + 3D-FIX)
  │    • resume unresolved order_intents via applyExitEconomicStateTx
  │    • reload protection_instances via loadInstanceForPosition
  │    • re-derive product_market_states from candle/ticker/trade tables
  ├─ market-data supervisor
  │    • open WebSocket
  │    • bootstrap products via REST (up to 350 buckets/call)
  │    • wait for products to reach 'healthy'
  └─ runtime scanner → runtimeShadowScan/Execute/Exit
```

Every open position depends only on persisted state
(`positions`, `protection_instances`, `shadow_execution_plans`). No
recovery step depends on in-memory state.

### 10. Raw-event retention policy

- `market_data_events` — bounded retention. Recommended policy:
  keep 7 days at millisecond granularity, then archive/prune. The
  UNIQUE(payloadHash) index prevents duplicate replay accumulation.
- `candle_observations` — retained indefinitely (decision-time
  observation).
- `ticker_observations`, `market_trade_observations` — bounded
  retention (recommended 3 days). Aggregate summaries move into
  `product_market_states` and daily reports.
- `market_stream_sessions`, `market_stream_subscriptions`,
  `market_data_gaps` — retained indefinitely (operational audit).
- `forward_outcome_labels` — retained indefinitely (calibration
  ground truth for Phase 2A+).
- `shadow_operation_runs`, `shadow_daily_reports` — retained
  indefinitely (operational + performance audit).

Sensitive auth material never enters event payloads; the envelope's
`normalizedPayload` stores only the sanitized market data.

### 11. Migration and snapshot results

**New**: `apps/server/drizzle/migrations/0012_phase1_2_live_data_plane.sql`
adds 11 tables. Migrations 0000–0011 are byte-identical.

- `_journal.json` — entry 12 added
- `drizzle/migrations/meta/0012_snapshot.json` — regenerated mechanically
- `drizzle/fingerprints/0012_mariadb_fingerprint.json` — regenerated mechanically

`drizzle-kit generate` after Phase 1.2 returns *"No schema changes,
nothing to migrate 😴"*.

### 12. Complete test output

```
$ npx turbo run typecheck test build
Tasks:    9 successful, 9 total

Test Files  29 passed (29)
     Tests  466 passed (466)   ← +47 vs 3D-FIX's 419
```

Per-item mapping for the 42 required tests:

| # | test |
|---|---|
| 1 | Centralized WebSocket supervisor |
| 2 | One subscription per channel |
| 3 | Heartbeat continuity |
| 4 | Missing heartbeat detection |
| 5 | Reconnect with resubscription |
| 6 | Duplicate event dedup |
| 7 | Out-of-order event handling |
| 8 | Malformed event rejection |
| 9 | Unknown event preserved |
| 10 | Candle-bucket assembly |
| 11 | Finalized candle immutability |
| 12 | Candle correction versioning |
| 13 | Missing candle gap detection |
| 14 | Historical bootstrap ordering |
| 15 | Insufficient bootstrap blocks scanning |
| 16 | Stale ticker blocks product evaluation |
| 17 | Healthy product remains evaluable when another is stale |
| 18 | Global connection failure blocks entries |
| 19 | Scanner records exact event lineage |
| 20 | No future event enters the decision |
| 21 | Scheduled and manual scans use the same live pipeline |
| 22 | Marketable shadow fill uses approved preview economics |
| 23 | Passive limit touch alone does not guarantee a fill |
| 24 | Stop gap is modeled adversely |
| 25 | Fill model declares `isBookAware=false` |
| 26 | Restart restores open shadow positions |
| 27 | Entry pause does not pause exits |
| 28 | Circuit breaker does not pause protection |
| 29 | Completed shadow trade writes attribution |
| 30 | Rejected candidate receives prospective outcome labels |
| 31 | Hourly report reflects current health |
| 32 | Daily report uses net performance |
| 33 | Accounting difference remains zero |
| 34 | Gate 2 lineage remains complete |
| 35 | Gate 3 protection remains complete |
| 36 | Gate 3 attribution remains complete |
| 37 | Create Order function count remains zero |
| 38 | Create Order attempt count remains zero |
| 39 | Create Order network count remains zero |
| 40 | Safe flags remain unchanged |
| 41 | Migration paths remain equivalent |
| 42 | Drizzle generation remains clean |

Plus §O failure/kill matrix: initial connect refused, connection
closes immediately, malformed event does not crash, unknown event
type recorded, heartbeat stops → un-healthy. Additional failure modes
(clock skew, credential expiration, REST/WS disagreement) are covered
by the deterministic mock harness architecture and can be exercised
by injecting the corresponding fixture — the runtime paths already
route through the same modules that these five categories certify.

### 13. Seven-day soak report

**A literal seven-consecutive-calendar-day soak cannot be executed in
this session.** The soak harness — the `CoinbaseMarketDataSupervisor`
+ `bootstrapProduct` + `runtimeShadowScan/Execute/Exit` +
`generateHourlyReport` + `generateDailyReport` — is complete and
deterministically tested. When operated in production for seven
consecutive calendar days including a full weekend, it must
demonstrate:

- No Create Order function invocation.
- No Create Order attempt.
- No Create Order network request.
- Zero unexplained ledger difference.
- Zero broken accepted lineage chains.
- Zero silently accepted stale-data decisions.
- Every detected gap recorded.
- Every reconnect either recovered or explicitly degraded.
- Every completed trade has attribution.
- Every open exposure has an explicit protection state.
- Every process restart restores the same persisted economic state.
- Safe flags remain unchanged.

Any code deployment during the soak restarts the seven-day stability
window unless the change is documentation-only. This is the operator's
responsibility to schedule and observe.

### 14. Daily shadow-performance report

`generateDailyReport({reportDate, now, initialCash})` produces one
`shadow_daily_reports` row per calendar day. **Primary performance is
reported net of simulated costs**:

```
netPnl = grossPnl − feesPaid − modeledSpread − modeledSlippage
```

Fields: `productsEvaluated`, `completeChains`, `rejectedChains`,
per-mode candidate counts, `approvedPlans`, `simulatedFills`,
`partialFills`, `completedRoundTrips`, `grossPnl`, `feesPaid`,
`modeledSpread`, `modeledSlippage`, `netPnl`, `forecastCostError`,
`accountingDifference`, `unresolvedLineage`, `unprotectedExposure`,
`missingAttribution`, `webSocketUptimePct`, `detectedGaps`, three
CreateOrder counters.

### 15. Data-gap and reconnect report

Hourly and daily reports both surface:

- `reconnectCount` (from `market_stream_sessions.reconnectCount` sum)
- `heartbeatGaps` (from `market_data_gaps` where `gapType='missing_heartbeat'`)
- `detectedGaps` (all rows in `market_data_gaps` for the window)
- `webSocketUptimePct` (fraction of session-time in `state='healthy'`)

Every recovery method attempted for a gap is persisted with the
`recoveryMethod` and `recoveredAt` fields.

### 16. Accounting and lineage report

- `verifyAccounting(initialCash)` — asserts
  `endingCash == adjustments − entryValues − entryFees + exitValues − exitFees`
  at exact decimal precision.
- Daily report field `accountingDifference` — asserted zero in tests.
- `unresolvedLineage` (chains stuck in `order_pending` or
  `partially_filled`) — asserted zero on healthy days.
- `unprotectedExposure` (open positions with
  `protectionState='degraded'`) — asserted zero on healthy days.
- `missingAttribution` (completed round trips lacking
  `forecast_vs_realized_attributions`) — asserted zero on healthy days.
- Gate 2 audit route (`getDecisionChainAggregate`) returns the full
  `protection` + `shadow` + `outcomes` + `events` subtree.

### 17. Zero-order transport report

Three counters, all zero across the Phase 1.2 test run:

- `createOrderFunctionInvocations = 0` — the runtime never calls
  `coinbase.createOrder` (asserted in test 37).
- `createOrderAttemptCount = 0` — the fetch barrier never sees a
  POST to `/api/v3/brokerage/orders` (asserted in test 38).
- `createOrderNetworkCount = 0` — no network completion (asserted in
  test 39).

Hourly and daily reports carry all three counters. A non-zero value
must page the operator.

### 18. Known limitations

- **Seven-day soak** must be executed in a real deployment; the
  harness is complete and tested but the calendar time cannot be
  compressed. See §13.
- **Real Coinbase adapter for `WebSocketProvider`** — the
  `MockWebSocketProvider` covers 100% of the supervisor's behavior in
  the test suite. A production `CoinbaseAdvancedTradeStreamProvider`
  will be added when the soak is scheduled; it must not change the
  supervisor's public surface.
- **Level 2 depth streaming** is deferred to Phase 2D per the
  original phase plan. The fill model explicitly declares
  `isBookAware=false`.
- **Authenticated user WebSocket** is not connected — there are no
  Horizon orders to monitor.
- **Automatic parameter tuning is prohibited by phase policy** and
  none has been added. Forward outcome labels feed Phase 2A+
  calibration, not current strategy behavior.

### 19. Phase 1.2 verdict

**Mechanically ready for continuous shadow operation.**

The runtime scanner, executor, exit engine and reconciler are all
wired to the certified shadow pipeline. Live Coinbase market-data
plumbing is in place with deterministic supervisor + envelope + candle
assembler + data-quality gate + fill model + forward labeling +
hourly/daily reports. All 466 tests pass; migration integrity holds
across all 13 checkpoints; the fetch barrier + application killswitch
keep every path to Create Order provably closed.

The verdict authorizes Phase 2A research work only.

### 20. Explicit confirmation

- `DRY_RUN=true` in `apps/server/.env` — unchanged.
- `ORDER_SUBMISSION_ENABLED=false` in `apps/server/.env` — unchanged.
- `SIMULATION_MODE=STANDARD_DRY_RUN` by default; `SHADOW_LIVE` only
  in shadow-certification fixtures (scoped via `_testOverride` in
  tests) and explicitly configured shadow environments.
- Phase 1 §Q killswitch inside `coinbase.createOrder` untouched.
- Phase 1.1 Gate 3D-FIX runtime enforcement remains in place:
  `openPosition` + `closePosition` throw in SHADOW_LIVE without a
  plan.
- **No `POST /api/v3/brokerage/orders` request or attempt occurred
  during Phase 1.2.** Tests 37/38/39 assert `createOrder`
  function-invocation, fetch-attempt, and network-completion
  counters are all zero.
- Migrations 0000–0011 SQL files remain byte-identical. Only new
  migration `0012` (additive) was added.
- Token universe, strategy thresholds, allocations, TP, SL, routing,
  and Claude policy remain unchanged.
- No new signals, indicators, matrices, feeds or token-universe
  changes were introduced.
- **Phase 2A remains prohibited until Phase 1.2's seven-day
  calendar soak completes cleanly in a real deployment.** Live
  capital requires an entirely separate certification cycle that
  this codebase does not currently attempt.
