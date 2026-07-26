# Phase 1.2-OPS — Live Deployment and Seven-Day Shadow Soak

> **DRY_RUN remains `true`.** **ORDER_SUBMISSION_ENABLED remains `false`.**
> **`SIMULATION_MODE=SHADOW_LIVE`** — the runner refuses to start a
> soak against production adapters unless every safe flag is set
> exactly.
> **No `POST /api/v3/brokerage/orders` request or attempt occurred
> during Phase 1.2-OPS scaffolding.** `createOrderFunctionInvocations
> = createOrderAttemptCount = createOrderNetworkCount = 0`.

## Honest scope statement

**A seven-consecutive-calendar-day soak against genuine Coinbase live
data cannot be executed inside this session's ephemeral container.**
This commit delivers **everything the operator needs to start the
clock**:

- Production Coinbase WebSocket + REST adapters.
- A provider-selection factory that refuses to start a soak against a
  mock adapter and writes an immutable audit row for every binding.
- A two-hour preflight harness whose result is required before a
  soak can transition from `preflight` to `running`.
- An immutable `soak_runs` lifecycle (preflight → running → completed
  | failed | reset_required).
- Incident classification with an explicit `soak_invalidating` tier
  that forces `verdict=soak_failed`.
- A final certification module whose `phase1_2_pass` verdict can only
  be minted when **every** invariant holds simultaneously: ≥7 calendar
  days elapsed, weekend covered, no invalidating incident, no mock
  provider ever bound, all three CreateOrder counters zero, exact
  accounting reconciliation.

**Do not treat this commit as Phase 1.2 passing.** Phase 1.2 passes
only when the operator has run the harness for seven real days in a
real deployment and the certification report emits
`phase1_2_pass`. Test 30 in this suite proves that a seven-day-old
run can pass; tests 26–29 prove that shorter runs, mock-provider
runs, invalidated runs, and non-zero-counter runs cannot.

## Deliverables

### 1. Production adapter map

| adapter | file | binding path |
|---|---|---|
| Coinbase WebSocket | `apps/server/src/market_data/coinbaseAdapter.ts` — `CoinbaseAdvancedTradeStreamProvider` | `selectProviders({intent:'soak'})` |
| Coinbase public REST bootstrap | `apps/server/src/market_data/coinbaseRest.ts` — `CoinbasePublicRestClient` | `selectProviders({intent:'soak'})` |
| Authenticated fee-tier retrieval | `apps/server/src/trading/feeTier.ts` (pre-existing; JWT-authenticated) | scanner + preview call sites |
| Authenticated preview | `apps/server/src/trading/preview.ts` (pre-existing) | scanner call site |
| Product metadata | `apps/server/src/market_data/coinbaseRest.ts` — `fetchProductMetadata` | bootstrap |
| Permission verification | `apps/server/src/trading/feeTier.ts` (JWT-scoped key identity) | startup |
| Redis | `apps/server/src/queue/lease.ts` — `ioredis` | supervisor + lease |
| MariaDB persistence | `apps/server/src/db/index.ts` — `drizzle-orm/mysql2` | all writers |

The factory writes an `adapter_selections` audit row on **every** call,
including the concrete class names and an `isProduction` flag. The
runner refuses `preflight → running` when `isProduction=false`.

### 2. Deployment configuration (secrets redacted)

```
DRY_RUN=true
ORDER_SUBMISSION_ENABLED=false
SIMULATION_MODE=SHADOW_LIVE
DATABASE_URL=mysql://[redacted]/horizon_trade
REDIS_URL=redis://[redacted]
COINBASE_KEY_NAME=[redacted]
COINBASE_PRIVATE_KEY=[redacted]
```

The `env.ts` loader refuses to boot when a live-mode env is
half-configured. Weak JWT secrets are rejected. `TEST_FORCE_LIVE_PATH`
is refused unless `NODE_ENV=test`.

### 3. Two-hour preflight report

Cannot be produced in this container — the operator runs it in
production against `CoinbaseAdvancedTradeStreamProvider` +
`CoinbasePublicRestClient`. The harness (`src/soak/preflight.ts`)
enforces:

- Duration ≥ 2 hours (`MINIMUM_PREFLIGHT_SECONDS = 7200`).
- Every one of 13 required checks true.
- All three CreateOrder counters = 0.

`passed=false` → the runner refuses to promote to `running`.

### 4. Seven immutable daily reports

Cannot be produced in this container. `shadow_daily_reports` +
`soak_daily_reports` schemas are ready; the operator's daily job
inserts one row per calendar day.

### 5. Final soak certification JSON

`certifySoak({soakRunId, now})` emits the JSON documented in §G of the
work order. Sample structure (from a passing test-only run):

```json
{
  "soakRunId": "cert-pass",
  "commit": "0000000000000000000000000000000000000000",
  "deploymentId": "dep-cert",
  "startedAt": "…",
  "completedAt": "…",
  "calendarDays": 8,
  "weekendIncluded": true,
  "createOrderFunctionInvocations": 0,
  "createOrderAttemptCount": 0,
  "createOrderNetworkCount": 0,
  "verdict": "phase1_2_pass",
  "verdictReason": "all_invariants_met"
}
```

### 6. Final soak certification Markdown

`renderMarkdown(report, incidents)` produces a human-readable summary
with the verdict on top and every incident enumerated. The template
**never** contains `ready_for_live_capital`.

### 7. Connection and reconnect report

Aggregated in the daily report from `market_stream_sessions.reconnectCount`
and `market_data_gaps` where `gapType='missing_heartbeat'`.

### 8. Data-gap report

Aggregated from `market_data_gaps` per product per day.

### 9. Accounting report

`verifyAccounting(initialCash)` invariant asserted per day in
`soak_daily_reports.accountingDifference`. The final certification
sums the absolute values; a non-zero total forces `soak_failed`.

### 10. Lineage report

Aggregated from `decision_chains.lineageCompleteness` and
`getDecisionChainAggregate` per day.

### 11. Protection report

Aggregated from `protection_instances.state` + `positions.protectionState`.

### 12. Zero-order transport report

Three counters persisted per day (`createOrderFunctionInvocations`,
`createOrderAttemptCount`, `createOrderNetworkCount`). The final
certification refuses `phase1_2_pass` if any counter is non-zero.

### 13. Incident report

`soak_incidents` with classifications:

| kind | classification |
|---|---|
| `websocket_outage`, `heartbeat_loss`, `candle_gap`, `rest_bootstrap_failure`, `preview_outage`, `fee_tier_outage`, `stale_data_rejection`, `protection_degradation` | product_degraded |
| `reconnect_storm`, `credential_failure`, `database_restart`, `redis_restart` | system_degraded |
| `process_restart` | informational |
| **`create_order_barrier_event`, `safe_flag_change`, `mock_provider_active`, `undocumented_deployment`, `accounting_discrepancy`, `lineage_discrepancy`** | **soak_invalidating** |

Any soak_invalidating incident forces `verdict=soak_failed`.

### 14. Exact code commit and deployment ID

- Commit: **`63eea51`** (Phase 1.2 baseline) + this Phase 1.2-OPS
  commit.
- Deployment ID: must be supplied by the operator's deployment
  pipeline; the harness records whatever string is passed.

### 15. Confirmation that no strategy parameter changed

- Token universe: unchanged.
- Setup thresholds: unchanged.
- TP / SL / allocation: unchanged.
- Claude policy: unchanged.
- No Hurst / variance-ratio / OU / HMM / Kelly / L2 / external context added.
- No parameter is automatically tuned from collected data.

### 16. Final Phase 1.2 verdict

**Pending** — awaits operator execution.

The verdict enum in `soak_runs` supports:
`pending | soak_failed | soak_degraded | phase1_2_pass`.
It **does not** contain `ready_for_live_capital`.

### 17. Explicit confirmation that no Coinbase order was invoked, attempted or transmitted

- `createOrderFunctionInvocations = 0` across the entire Phase 1.2-OPS test run.
- `createOrderAttemptCount = 0`.
- `createOrderNetworkCount = 0`.
- Application-layer killswitch (`ORDER_SUBMISSION_ENABLED=false`)
  unchanged.
- Fetch-layer barrier unchanged and installed on every test.

## What ships in this commit

**New**
- `apps/server/drizzle/migrations/0013_phase1_2_ops_soak.sql` — 5 new tables (soak_runs, soak_daily_reports, soak_incidents, adapter_selections, soak_preflight_runs)
- `apps/server/drizzle/migrations/meta/0013_snapshot.json` + fingerprint
- `apps/server/src/market_data/coinbaseAdapter.ts` — production WS
- `apps/server/src/market_data/coinbaseRest.ts` — production REST
- `apps/server/src/market_data/providerFactory.ts` — factory + audit
- `apps/server/src/soak/preflight.ts` — 2-hour preflight harness
- `apps/server/src/soak/soakRunner.ts` — soak lifecycle
- `apps/server/src/soak/incidents.ts` — classification + persistence
- `apps/server/src/soak/certification.ts` — verdict enforcement
- `apps/server/tests/phase1_2_ops.test.ts` — 24 tests

**Modified**
- `apps/server/drizzle/migrations/meta/_journal.json` — entry 13 added
- `apps/server/src/db/schema.ts` — 5 new tables + type exports
- `apps/server/tests/setup/db.ts` — new tables added to TRUNCATE

## Test results

```
$ npx turbo run typecheck test build
Tasks:    9 successful, 9 total

Test Files  30 passed (30)
     Tests  490 passed (490)   ← +24 vs Phase 1.2's 466
```

Verbatim mapping of the acceptance-critical tests:

| test | proves |
|---|---|
| Provider factory > soak intent binds production providers by default | production adapters selected |
| Provider factory > test intent with mock override binds mocks + refuses soak eligibility | mock providers never inherit soak eligibility |
| Provider factory > audit row records the concrete provider names + isProduction | adapter_selections captured |
| Provider factory > mock provider inside a soak intent is refused by the runner | runner refuses mock → soak transition |
| Preflight harness > fails a preflight shorter than the required minimum | 2-hour minimum enforced |
| Preflight harness > fails a preflight if any required check is false | fail-closed on any check |
| Preflight harness > passes when every check is true and counters are zero | happy-path is reachable |
| Soak-run lifecycle > startSoak requires safe flags to be set correctly | DRY_RUN/killswitch/SHADOW_LIVE required |
| Soak-run lifecycle > startSoak transitions preflight → running atomically | status flip is UNIQUE-guarded |
| Soak-run lifecycle > failSoak sets status=failed + verdict=soak_failed | terminal transition |
| Soak-run lifecycle > resetRequired records an undocumented_deployment incident | deployment-during-soak resets |
| Incident classification tests (5) | severity mapping honest |
| Certification > refuses phase1_2_pass when < 7 calendar days elapsed | **the core honesty check** |
| Certification > refuses phase1_2_pass when any soak_invalidating incident exists | invalidation enforced |
| Certification > refuses phase1_2_pass when a mock provider was ever bound | audit-driven refusal |
| Certification > refuses phase1_2_pass when any Create Order counter is non-zero | counters gate the verdict |
| Certification > emits phase1_2_pass when every invariant holds | happy path is reachable |
| Certification > verdict enum does NOT contain ready_for_live_capital | the string is impossible |
| Migration integrity > 0013 snapshot + fingerprint on disk | schema chain intact |

## Known limitations

- **The literal seven-day calendar soak has NOT been executed in this
  session.** It cannot be — the container is ephemeral. The operator
  runs it against production Coinbase in a real deployment.
- **The two-hour preflight has NOT been executed against real
  Coinbase in this session.** The harness is complete; the operator
  runs it before starting the clock.
- **`CoinbasePublicRestClient`** is a public-endpoints-only client.
  Authenticated fee-tier + preview + product-metadata calls flow
  through the pre-existing `feeTier.ts` + `preview.ts` modules which
  use JWT-signed requests. Redacting credentials from event payloads
  is already the responsibility of `envelope.ts` sanitization.

## Phase 1.2 verdict

**Code-complete and eligible to begin the seven-day production soak.**

Phase 1.2 does not pass until the operator's soak completes cleanly
and `certifySoak(...)` emits `phase1_2_pass`. Phase 2A remains
prohibited until that verdict lands.
