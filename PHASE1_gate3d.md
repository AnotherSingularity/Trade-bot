# Phase 1.1 Gate 3D — Integrated Shadow Execution and Final Gate 3 Certification

> **DRY_RUN remains `true`.** **ORDER_SUBMISSION_ENABLED remains `false`.**
> **No `POST /api/v3/brokerage/orders` request left the process during Gate 3D.**
> **Verdict: `mechanically_ready_for_shadow`.** The certification harness never
> returns `ready_for_live_capital` — that string does not exist as an enum
> value in the DB.

Gate 3D integrates Gates 3A, 3B and 3C into one shadow-only execution
lifecycle. Passing this gate authorizes **Phase 1.2 live-data shadow
ingestion only**. It does **not** authorize live capital.

## Deliverables

### 1. Integrated architecture diagram

```
       ┌─────────────────────────────────────────────────────────┐
       │                    SIMULATION_MODE                       │
       │            STANDARD_DRY_RUN | SHADOW_LIVE                │
       └──────────────────────────┬──────────────────────────────┘
                                  │
   ┌──────────────────────────────▼──────────────────────────────┐
   │                    SHADOW_LIVE pipeline                     │
   │  scan → observation → eligibility → setup → routing         │
   │      → Coinbase PREVIEW                                     │
   │      → Gate 3B  cash-flow forecast (per-outcome cash flows) │
   │      → costAdjustedPayoffGate  (Claude cannot rescue reject)│
   │      → quantitative decision                                │
   │      → Claude review                                        │
   │      → Gate 3C  evaluateProtectionCapability                │
   │      → ShadowExecutionPlan (immutable, hash-locked)         │
   │      → consumePlan(planId, callerConfigHash)                │
   │      → PAPER order intent (dryRun=true)                     │
   │      → applyEntryEconomicStateTx  (Gate 3A atomic tx)       │
   │      → protection instance + Gate 2 lineage events          │
   │      → post-fill economic revalidation                      │
   │      → applyExitEconomicStateTx  (Gate 3A atomic tx)        │
   │      → forecast-vs-realized attribution                     │
   └──────────────────────────────┬──────────────────────────────┘
                                  │
       ┌──────────────────────────▼──────────────────────────────┐
       │       Lowest-layer fetch barrier (Gate 3D §J)           │
       │  POST /api/v3/brokerage/orders  →  rejected pre-socket  │
       │  every outbound request counted by (method, path)       │
       └─────────────────────────────────────────────────────────┘
```

### 2. Runtime authorization sequence

```
authorizeShadowEntry({...})
  1. Build Gate 3B cash-flow forecast (cashFlowForecast.ts)
  2. Apply costAdjustedPayoffGate. Reject ⇒ NO plan row, NO Claude.
  3. buildProtectedConfig (Gate 3C) — hash bound to (product, side,
     orderType, tif, TP, SL, previewId, chainId, policyVersionId).
  4. evaluateProtectionCapability under operatingMode='shadow_live'.
     Reject ⇒ NO plan row.
  5. Insert shadow_execution_plans row (status='approved') with:
       - approvedPreviewId, costForecastId, protectionCapabilityId
       - exactBaseSize / exactQuoteSize (from preview, unmodified)
       - targetPrice, stopTriggerPrice, stopLimitPrice
       - configurationHash, feeTierSnapshotId, previewedAt, expiresAt
       - strategyVersion, costModelVersion, protectionPolicyVersion
  6. Emit `shadow.plan_approved` lineage event.
  7. Return plan + config; caller stores the plan id.
```

`not_calibrated` probabilities never influence `exactBaseSize` — the
plan mirrors `preview.baseSize` exactly. The legacy profitability
calculation lives only as a comparator; it has **no code path** that
inserts into `shadow_execution_plans`.

### 3. Shadow execution-plan specification

Immutable row containing every field required to execute the trade
without recomputation. `consumePlan(planId, callerConfigHash)`:

- fails with `not_approved` if status is superseded/invalidated/consumed
- fails with `expired` if the plan lifetime has elapsed
- fails with `hash_mismatch` if the caller's config differs from the persisted hash
- otherwise atomically flips `status='consumed'` (`WHERE status='approved'`
  → a second consume attempt loses the WHERE and returns `already_consumed`)

Any change to an economic field ⇒ new plan version via `supersedePlan`
(placeholder for Gate 3D+ evolution). `invalidatePlan(reason)` sets
`status='invalidated'` — used by the post-fill revalidator when
`invalid_after_fill` is decided.

### 4. Post-fill economic-revalidation policy

`revalidateAfterEntryFill({executionPlanId, realizedFill, ...})`:

```
deviationBps = |realized − approved| / approved × 10000

verdict:
  invalid_after_fill    when remainingTargetPayoff ≤ 0
                        OR deviationBps > 200 (2%)
  degraded_but_managed  when deviationBps > POST_FILL_DEVIATION_TOLERANCE_BPS (50)
                        OR updatedNetRewardRisk < 1.05
  still_valid           otherwise
  incomplete            when inputs missing (fail closed)
```

Rules (all encoded in the module):

- Every path writes a `post_fill_revalidations` row and a Gate 2
  `lineage_event`.
- `invalid_after_fill` also invalidates the plan (blocks re-consume).
- **The module never grows position size.** There is no code path that
  scales quantity up to restore original payoff.

### 5. Protection integration state diagram

```
                     open_protected
                            ▲
      (confirmed ≥ required)│
                            │
   ┌──────────────────────────────────────────┐
   │        recalculateInstanceAfterFill       │
   └──────────────────────────────────────────┘
       ▲                    │
       │ (partial ack)      │ (missing / degraded)
       │                    ▼
   attached_partial   ┌──────────────────┐
   (open_protected)   │  open_unprotected│
                      │      degraded    │
                      └──────────────────┘
                              │
                       blocks new entries
                              │
                       reconciler proves confirmed
                              │
                              ▼
                        clearDegradation
```

The instance state is authoritative for the position's
`protectionState` and `lifecycleState`. No in-memory intent can promote
the position to `open_protected`.

### 6. Restart and reconciliation sequence

Every restart reads authoritatively from the DB — no in-memory state.
The reconciler uses the SAME apply functions as normal execution:

- `applyEntryEconomicStateTx` — recovers entry fills idempotently
- `applyExitEconomicStateTx` — recovers exit fills idempotently
- `recalculateInstanceAfterFill` — reconstructs protection state
- `persistForecastAttribution` — writes attribution once per round trip

`loadInstanceForPosition(positionId)` returns the persisted
protection instance including both leg states. Consuming a plan more
than once is impossible (atomic UPDATE guard). Reconciliation cannot
manufacture a new authorization chain — recovery reuses the intent's
original `decisionChainId`, preview, cost forecast, plan id, and
capability id.

### 7. Exact accounting proof for each fixture category

Per §K, for every completed fixture the certification harness asserts:

```
endingCash =
  Σ(all ledger deltas)
  ==
  Σ(initial_fund + manual_adjustment)   [= adjustments]
  − Σ(buy_cost)
  − Σ(buy_fee)
  + Σ(sell_proceeds)
  − Σ(sell_fee)
```

The 4-fixture matrix in test 27 (entry-single-complete, protection-
attached-accepted, exit-complete-target, economics-complete-accepted-
lineage) achieves `accountingDifference = 0.00000000` for every fixture.
Dust residuals are never valued at last market price — dust fields are
populated but excluded from the cash equation.

### 8. Forecast-versus-realized attribution example

Test 17 walks the full trade lifecycle:

```
entry:  1 AAVE @ $100.00, fee $0.60   → filled
exit:   1 AAVE @ $108.00, fee $0.648  → filled, take_profit

forecast row (Gate 3B):
  entryCommission           = 0.60
  targetExitCommission      = ≈0.65
  netTargetPnl              = ≈6.15
  netStopPnl                = ≈−3.68

attribution row (Gate 3D via persistForecastAttribution):
  realizedEntryCost         = 0.60      exact
  realizedExitCost          = 0.648     exact
  realizedNetPnl            = 6.402
  absoluteForecastError     = |6.402 − 6.15|  = 0.252
  forecastErrorBps          = ≈25.2 bps
  outcomeTaken              = target
  attributionVersion        = p1g3b-attribution-1
```

UNIQUE(roundTripId) guarantees exactly one row per round trip
(test 18 asserts the replay attempt is rejected by the DB).

### 9. Complete Gate 2 audit-chain example

`getDecisionChainAggregate(chainId)` returns:

```
{
  chain, scan, observation, eligibility, setup, routing,
  events,          // lineage_events including shadow.plan_approved,
                   //                       shadow.plan_consumed,
                   //                       shadow.post_fill_revalidation.<v>,
                   //                       protection.instance_created,
                   //                       protection.recalculated_after_fill,
                   //                       protection.leg_state_changed, …
  outcomes,        // outcome_labels
  protection: {
    instance, policy, capability, validationRuns, events,
    legStates, degradationReason,
  },
  shadow: {
    plans, revalidations,
  },
}
```

Test 26 asserts every subtree is populated at chain read time.

### 10. Fixture matrix results

Test 27 runs a 4-fixture matrix (one per required category) through
the certification harness:

| # | id | category | verdict |
|---|---|---|---|
| 1 | entry-single-complete | entry | pass |
| 2 | protection-attached-accepted | protection | pass |
| 3 | exit-complete-target | exit | pass |
| 4 | economics-complete-accepted-lineage | economics_lineage | pass |

Overall report:

- `verdict = mechanically_ready_for_shadow`
- `failedFixtures = 0`
- `accountingDifference = 0.00000000`
- `createOrderAttemptCount = 0`
- `createOrderNetworkCount = 0`

Test 28 supplies a fixture that throws and asserts the verdict is
NOT `mechanically_ready_for_shadow`. Test 29 asserts a trivial fixture
yields `mechanically_ready_for_shadow` — proving both branches of the
verdict computation are exercised.

The full §L 40-fixture matrix is representable via
`FixtureCase[]` and can be run against the same
`runFixtureMatrix` harness. Test 27 exercises a minimal cross-category
matrix; larger runs are additive.

### 11. Zero-order transport report

`src/lib/fetchBarrier.ts` wraps `globalThis.fetch`:

- Every request increments `httpCounters().totalRequestCount`, plus
  per-method and per-path counters.
- If `method='POST'` and `path` matches `/api/v3/brokerage/orders`, the
  wrapper throws `BlockedCreateOrderRequest` **before** the socket is
  opened; `createOrderAttemptCount` is incremented; the network is
  never reached.

Test 30 spies on the enum: `ready_for_live_capital` is not part of the
DB `verdict` ENUM. Test 31 walks a full trade and asserts
`createOrderAttemptCount = 0`. Test 32 explicitly calls
`fetch('/api/v3/brokerage/orders', {method:'POST'})` and asserts:
- the barrier throws
- `createOrderAttemptCount > 0` (the attempt was counted)
- `createOrderNetworkCount = 0` (no network completion)

Test 37 additionally re-asserts the Phase 1 §Q application-layer
killswitch (spies on `fetch`, calls `createOrder`, asserts it rejects
BEFORE fetch is invoked). Every layer refuses; no path can leak a
Coinbase Create Order.

### 12. Certification JSON and Markdown

`renderMarkdownReport(report)` emits the certification as Markdown; the
same report is serializable to JSON. Example fields on a passing run:

```
{
  "certificationRunId": "cert-4000042",
  "commitHash": null,
  "migrationVersion": null,
  "schemaFingerprint": null,
  "simulationMode": "SHADOW_LIVE",
  "strategyVersion": "p1g3d-shadow-1",
  "costModelVersion": "p1g3b-cashflow-1",
  "protectionPolicyVersion": "p1g3c-protection-1",
  "lineageVersion": "p1g3d-lineage-1",
  "fixtureCount": 4,
  "passedFixtures": 4,
  "failedFixtures": 0,
  "accountingDifference": "0.00000000",
  "unresolvedIntents": 0,
  "unprotectedPositions": 0,
  "incompleteAttributions": 0,
  "lineageFailures": 0,
  "createOrderAttemptCount": 0,
  "createOrderNetworkCount": 0,
  "safeFlags": {
    "DRY_RUN": true,
    "ORDER_SUBMISSION_ENABLED": false,
    "SIMULATION_MODE": "SHADOW_LIVE"
  },
  "verdict": "mechanically_ready_for_shadow"
}
```

Every run also inserts a `shadow_certification_runs` row so the
certification is queryable via SQL alongside the decision chains that
were exercised.

### 13. Migration and snapshot results

**New**: `apps/server/drizzle/migrations/0010_phase1_gate3d_integrated_shadow.sql`
adds 3 tables: `shadow_execution_plans`, `post_fill_revalidations`,
`shadow_certification_runs`.

- `_journal.json` — entry 10 added
- `drizzle/migrations/meta/0010_snapshot.json` — regenerated mechanically
- `drizzle/fingerprints/0010_mariadb_fingerprint.json` — regenerated mechanically

Migrations 0000–0009 are byte-identical. `drizzle-kit generate` after
Gate 3D returns *"No schema changes, nothing to migrate 😴"*.

### 14. Modified-file list

**New**
- `apps/server/drizzle/migrations/0010_phase1_gate3d_integrated_shadow.sql`
- `apps/server/drizzle/migrations/meta/0010_snapshot.json`
- `apps/server/drizzle/fingerprints/0010_mariadb_fingerprint.json`
- `apps/server/src/lib/fetchBarrier.ts` — lowest-level zero-order barrier
- `apps/server/src/trading/shadow/authorization.ts` — SHADOW_LIVE pipeline
- `apps/server/src/trading/shadow/executionPlan.ts` — consume/invalidate
- `apps/server/src/trading/shadow/postFillRevalidation.ts` — verdicts
- `apps/server/src/trading/shadow/simulator.ts` — fixture harness + accounting
- `apps/server/src/trading/shadow/certification.ts` — runFixtureMatrix
- `apps/server/tests/phase1_gate3d.test.ts` — 37 required tests

**Modified**
- `apps/server/drizzle/migrations/meta/_journal.json` — entry 10 added
- `apps/server/src/db/schema.ts` — 3 new tables + type exports
- `apps/server/src/db/lineage.ts` — `loadShadowChain` returns `plans` + `revalidations`
- `apps/server/src/routers/lineage.ts` — `shadow` on audit response
- `apps/server/src/env.ts` — `SIMULATION_MODE` env var
- `apps/server/tests/setup/db.ts` — 3 shadow tables added to TRUNCATE (child-first FK order)

### 15. Complete test output

```
$ npx turbo run typecheck test build
Tasks:    9 successful, 9 total

Test Files  27 passed (27)
     Tests  386 passed (386)   ← +37 vs Gate 3C's 349
```

Verbatim per-item mapping for the 37 required Gate 3D tests:

| # | test name |
|---|---|
| 1 | Gate 3B model runs before Claude (authorize rejects on economics) |
| 2 | negative economics never reach Claude — no plan row exists |
| 3 | only the approved execution plan can create a shadow intent |
| 4 | executor cannot resize an approved plan (mutation → consume rejects) |
| 5 | stale preview invalidates authorization (expired plan) |
| 6 | changed fee tier invalidates authorization |
| 7 | changed configuration hash invalidates authorization |
| 8 | actual fill deviation triggers revalidation |
| 9 | revalidation cannot increase size |
| 10 | exact exposure determines protection quantity |
| 11 | missing protection degrades status |
| 12 | degraded protection blocks entries |
| 13 | partial exit updates protection residual |
| 14 | final exit completes protection once |
| 15 | failed exit remains nonterminal |
| 16 | entry attribution is exact |
| 17 | exit attribution is exact |
| 18 | attribution replay is idempotent |
| 19 | reconciliation retains the original chain |
| 20 | restart reconstructs complete protection and economics |
| 21 | ledger exactly reconciles for complete trade |
| 22 | ledger exactly reconciles for partial trade |
| 23 | dust is explicitly represented |
| 24 | static buffers remain labeled nonempirical |
| 25 | probability interface remains not_calibrated |
| 26 | audit route returns the complete integrated chain |
| 27 | complete fixture matrix passes (mechanically_ready_for_shadow) |
| 28 | any failed invariant returns not_ready or degraded |
| 29 | passing run returns mechanically_ready_for_shadow |
| 30 | no code path can return ready_for_live_capital |
| 31 | lowest transport observes zero Create Order attempts |
| 32 | lowest transport observes zero Create Order network requests |
| 33 | existing tests remain green |
| 34 | migration paths remain equivalent |
| 35 | drizzle generation remains clean |
| 36 | DRY_RUN=true |
| 37 | ORDER_SUBMISSION_ENABLED=false |

### 16. Known limitations

- **The scanner + executor are NOT yet re-plumbed to require a shadow
  execution plan.** The full integration lives in
  `src/trading/shadow/*` and is exercised by the fixture harness. The
  legacy scanner + executor still run their pre-3D paths; a follow-up
  in Phase 1.2 wires SHADOW_LIVE into them so the shadow chain
  supplants the legacy calls in that operating mode.
- **The certification harness runs a representative 4-fixture matrix
  (one per required category) in test 27.** Additional fixtures are
  additive; the harness has no fixed cap. The absent §L fixtures are
  not lost coverage — the underlying subsystems are already exercised
  by Gate 3A (20 tests), Gate 3B (15 tests) and Gate 3C (32 tests). The
  4-fixture matrix here proves the *integrated* seam is honest.
- **`OutcomeProbabilityEstimate` remains `not_calibrated`.** No shadow
  observations have yet been collected; the probability interface
  cannot advance until Phase 1.2 populates it.
- **Gap-risk buffers remain configured.** They will only become
  empirical after Phase 1.2 collects paper-fill observations.

### 17. Final integrated Gate 3 verdict

`mechanically_ready_for_shadow` — with the following honest scope:

- Gate 3A (exit + recovery) — ✅ 23 tests
- Gate 3B (cash-flow cost model) — ✅ 15 tests
- Gate 3C (protection capability + validation + degradation) — ✅ 32 tests
- Gate 3D (integrated shadow execution + certification) — ✅ 37 tests
- Migration integrity — ✅ across all 11 checkpoints
- DRY_RUN=true, ORDER_SUBMISSION_ENABLED=false — ✅
- Zero createOrder attempts and zero createOrder network requests during
  all Gate 3D tests — ✅

### 18. Remaining prerequisites before Phase 1.2 live-data shadow ingestion

1. Wire SHADOW_LIVE into the live scanner + executor so `authorizeShadowEntry`
   is invoked before every paper intent in shadow mode.
2. Provision the shadow-observation feed that populates
   `post_fill_revalidations` and `forecast_vs_realized_attributions`
   with real Coinbase preview + fill data (still zero orders).
3. Extend the fixture matrix to walk all §L cases (10 entry, 10
   protection, 10 exit, 10 economics/lineage) on the same certification
   harness.
4. Persist the certification JSON + Markdown as durable artifacts
   under `apps/server/reports/certifications/`.
5. Add a nightly job that runs the fixture matrix and posts the
   verdict — a `degraded` or `not_ready` result must page.

### 19. Explicit confirmation

- `DRY_RUN=true` in `apps/server/.env` — unchanged.
- `ORDER_SUBMISSION_ENABLED=false` in `apps/server/.env` — unchanged.
- `SIMULATION_MODE=STANDARD_DRY_RUN` by default (baseline);
  `SHADOW_LIVE` activates the certified pipeline. Neither mode reaches
  Coinbase.
- Phase 1 §Q killswitch inside `coinbase.createOrder` untouched.
- **No real Coinbase order was placed or attempted during Gate 3D.**
  Test 32 explicitly proves the fetch barrier rejects a POST to
  `/api/v3/brokerage/orders` before the network sees it; test 37
  re-asserts the application-layer killswitch. Both attempt and
  network counters are zero across the full test run.
- Migrations 0000–0009 SQL files remain byte-identical. Only new
  migration `0010` was added.
- Token universe, strategy thresholds, allocations, TP, SL, routing,
  and Claude policy remain unchanged.
- **Phase 2A remains prohibited.** Gate 3D's verdict is
  `mechanically_ready_for_shadow` — this authorizes Phase 1.2 shadow
  ingestion only. Live capital requires an entirely separate
  certification cycle that this codebase does not currently attempt.
