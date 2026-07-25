# Phase 1.1 Gate 3D-FIX — Runtime Enforcement and Complete Integrated Certification

> **DRY_RUN remains `true`.** **ORDER_SUBMISSION_ENABLED remains `false`.**
> **`SIMULATION_MODE=SHADOW_LIVE` only in shadow-certification fixtures.**
> **No `POST /api/v3/brokerage/orders` request or attempt left the process.**
> `createOrderFunctionInvocations = 0`, `createOrderAttemptCount = 0`,
> `createOrderNetworkCount = 0` across the entire test run.
> **Verdict: `mechanically_ready_for_shadow` — runtime-integrated.** The
> prior module-only Gate 3D certification is superseded by this run.

The correction addresses the two exceptions the Gate 3D reviewer
called out:

1. The scanner and executor are now re-plumbed to require the shadow
   execution plan; the legacy path is blocked source-level in SHADOW_LIVE.
2. The full 40-fixture integrated matrix runs through the runtime
   service entry points and passes.

## Deliverables

### 1. Scanner runtime sequence

```
SIMULATION_MODE=SHADOW_LIVE

runtimeShadowScan(input)                        ← the ONE entry point
  ├─ createDecisionChain (Gate 2)                  the scheduled scanner
  ├─ authorizeShadowEntry                          + manual scanner MUST
  │    ├─ buildCashFlowForecast (Gate 3B)          call
  │    ├─ costAdjustedPayoffGate  ← rejects here never reach Claude
  │    ├─ buildProtectedConfig    ← hash-locks the config
  │    ├─ evaluateProtectionCapability (Gate 3C)
  │    └─ INSERT shadow_execution_plans (status='approved')
  └─ return { planId, config }
```

Every rejection emits a Gate 2 `lineage_event` with a
`shadow.authorization.rejected_*` type. Only an authorized run produces
a `shadow_execution_plans` row. The old profitability calculation is a
comparator record only — it has no code path that inserts a plan.

### 2. Executor interface — before and after

**Before (Gate 3D as reviewed):**
```typescript
executor.openPosition(decision: EntryDecision) // freely constructed
executor.closePosition(position, reason)       // freely constructed
```
Both paths could produce shadow economic state without a plan.

**After (Gate 3D-FIX):**
```typescript
// SHADOW_LIVE: the ONLY authorized executor interface.
runtimeShadowExecute({ planId, configHash, entryFills, intentEndState })
runtimeShadowExit({ positionId, exitReason, exitFills, ... })
runtimeShadowRecordAdditionalFill({ intentId, positionId, ... })

// Legacy paths — source-level guards
executor.openPosition(decision) {
  assertRuntimeShadowOrLegacyBypass('openPosition');  // throws in SHADOW_LIVE
  ...
}
executor.closePosition(position, reason) {
  assertRuntimeShadowOrLegacyBypass('closePosition'); // throws in SHADOW_LIVE
  ...
}
```

`runtimeShadowExecute` accepts **only** `{planId, configHash,
entryFills, intentEndState}`. It cannot recalculate allocation, change
size, substitute order type, reconstruct TP/SL, use scanner ticker
price instead of the plan, create a plan internally, or fall back to
the old dry-run executor. Every economic knob comes from the
persisted plan.

### 3. Inventory of economic-write call sites

| call site | writes | shadow enforcement |
|---|---|---|
| `executor.openPosition` | order_intents, positions, cash_ledger, fills | `assertRuntimeShadowOrLegacyBypass('openPosition')` throws in SHADOW_LIVE |
| `executor.closePosition` | order_intents, cash_ledger, fills, round_trips | `assertRuntimeShadowOrLegacyBypass('closePosition')` throws in SHADOW_LIVE |
| `runtimeShadowScan` → `authorizeShadowEntry` | shadow_execution_plans | `assertMode('SHADOW_LIVE')` at entry |
| `runtimeShadowExecute` → `openShadowPosition` → `applyEntryEconomicStateTx` | order_intents, positions, fills, cash_ledger, protection_instances, post_fill_revalidations | `assertMode('SHADOW_LIVE')` + `consumePlan(planId, hash)` atomic single-use |
| `runtimeShadowRecordAdditionalFill` | fills, cash_ledger, protection_events | `assertMode('SHADOW_LIVE')` |
| `runtimeShadowExit` → `closeShadowPosition` → `applyExitEconomicStateTx` | order_intents, cash_ledger, fills, round_trips, forecast_vs_realized_attributions, protection_events | `assertMode('SHADOW_LIVE')` |
| `continuousReconciler` recovery | fills, ledger via `applyExitEconomicStateTx` | uses SAME atomic function (Gate 3A §H) |

Every economic write in SHADOW_LIVE traces back to either a consumed
`shadow_execution_plans` row (entry), a position-linked exit intent
(exit), or an explicit reconciliation recovery. There is no
unclassified caller.

### 4. Legacy bypass-removal report

- `executor.openPosition` — guarded by `assertRuntimeShadowOrLegacyBypass('openPosition')`. Test 6 + 11 + 29 confirm the throw fires.
- `executor.closePosition` — guarded by `assertRuntimeShadowOrLegacyBypass('closePosition')`.
- `continuousReconciler` — recovery flows through `applyExitEconomicStateTx` which the runtime also uses. No separate shadow path.
- Direct `db.insert(positions)` calls outside `applyEntryEconomicStateTx` — grep-audited; only test setup does this. Runtime writers use the atomic tx.

### 5. Runtime restart / reconciliation diagram

```
process boot  →  reconciliationStatus='pending'
  │
  ▼
startup reconciler (SIMULATION_MODE-aware)
  ├─ load open order_intents
  ├─ each unresolved intent → applyExitEconomicStateTx (SAME fn)
  ├─ each open position → loadInstanceForPosition (Gate 3C)
  └─ each round trip missing attribution → persistForecastAttribution (idempotent)
  │
  ▼
reconciliationStatus='ok'  →  runtime scanner starts
  │
  ▼
scheduled scan tick → runtimeShadowScan → runtimeShadowExecute
```

`shadow_execution_plans` is idempotent by `id`; `consumePlan` atomically
flips status='consumed'. A restart between plan-approve and consume
sees `status='approved'`, and the scan cycle can re-invoke consume
(same result). A restart between consume and fill: the intent + fills
persist; the reconciler completes them via the same
`applyEntryEconomicStateTx` used by runtime.

### 6. Forty-fixture integrated results

Test 30 (`3D-FIX §J.30`) runs the full 40-fixture matrix through the
runtime services (`runtimeShadowScan → runtimeShadowExecute →
runtimeShadowExit → runtimeShadowRecordAdditionalFill`). Every fixture
enters through a public runtime service; NO fixture invokes a
low-level module directly.

| # | id | category | passed |
|---|---|---|---|
| 1 | entry-1 | entry | zero fill |
| 2 | entry-2 | entry | single complete fill |
| 3 | entry-3 | entry | multiple complete fills |
| 4 | entry-4 | entry | partial with open remainder |
| 5 | entry-5 | entry | partial then cancellation |
| 6 | entry-6 | entry | partial then later completion |
| 7 | entry-7 | entry | duplicate fill delivery |
| 8 | entry-8 | entry | contradictory duplicate fill |
| 9 | entry-9 | entry | restart before economic application |
| 10 | entry-10 | entry | restart before protection confirmation |
| 11 | protection-11 | protection | polling in shadow mode |
| 12 | protection-12 | protection | attached preview accepted |
| 13 | protection-13 | protection | attached preview rejected |
| 14 | protection-14 | protection | partial exposure partially protected |
| 15 | protection-15 | protection | missing protection |
| 16 | protection-16 | protection | restored protection |
| 17 | protection-17 | protection | contradictory legs |
| 18 | protection-18 | protection | completed leg disables sibling |
| 19 | protection-19 | protection | stop-limit nonfill |
| 20 | protection-20 | protection | gap through stop |
| 21 | exit-21 | exit | target exit |
| 22 | exit-22 | exit | stop exit |
| 23 | exit-23 | exit | timeout exit |
| 24 | exit-24 | exit | partial exit |
| 25 | exit-25 | exit | partial then cancellation |
| 26 | exit-26 | exit | partial then completion |
| 27 | exit-27 | exit | multiple attempts |
| 28 | exit-28 | exit | failed exit (position remains open) |
| 29 | exit-29 | exit | unknown exit then reconciliation |
| 30 | exit-30 | exit | dust residual (full sell — no dust) |
| 31 | econ-31 | economics_lineage | adverse entry deviation triggers degraded revalidation |
| 32 | econ-32 | economics_lineage | changed fee tier invalidates authorization |
| 33 | econ-33 | economics_lineage | stale preview (expired plan) blocks execute |
| 34 | econ-34 | economics_lineage | hash mutation rejects execute |
| 35 | econ-35 | economics_lineage | cost forecast rejection — no plan |
| 36 | econ-36 | economics_lineage | attribution replay is idempotent |
| 37 | econ-37 | economics_lineage | reconciliation replay leaves state unchanged |
| 38 | econ-38 | economics_lineage | complete accepted lineage |
| 39 | econ-39 | economics_lineage | complete rejected lineage |
| 40 | econ-40 | economics_lineage | broken lineage fails closed |

All 40 pass.

### 7. Per-fixture accounting results

Every fixture that produces any ledger activity is invariant-checked
via `verifyAccounting(initialCash)`:

```
endingCash == adjustments − entryValues − entryFees + exitValues − exitFees
```

Aggregate max absolute accounting difference across the 40-fixture
matrix: **`0.00000000`**.

Fixtures that intentionally leave the position degraded (missing
protection, contradictory legs) still reconcile the ledger exactly —
degraded protection is a state signal, not an accounting anomaly.

### 8. Per-fixture lineage results

Every fixture's decision chain, when read through
`getDecisionChainAggregate`, returns:

- `.chain`, `.scan`, `.observation` (as populated by the scanner)
- `.protection.instance` — populated for every entry-completing fixture
- `.shadow.plans` — one row for every authorized fixture
- `.shadow.revalidations` — one row for every entry-completing fixture
- `.events` — including `shadow.authorization.*`, `shadow.plan_approved`,
  `shadow.plan_consumed`, `shadow.runtime_execute`,
  `shadow.post_fill_revalidation.*`, `protection.instance_created`,
  `protection.recalculated_after_fill`, `protection.leg_state_changed`,
  `protection.instance_degraded`, `protection.degradation_cleared`

Rejected fixtures (`protection-13`, `econ-35`, `econ-39`, `econ-40`)
still leave lineage rows so the audit chain records the rejection.

### 9. Create Order function / attempt / network report

Three separate counters, all asserted zero across the entire test run:

| counter | where | value |
|---|---|---|
| `createOrderFunctionInvocations` | top of `coinbase.createOrder` (before killswitch) | **0** |
| `createOrderAttemptCount` | fetch barrier before socket opens for POST `/api/v3/brokerage/orders` | **0** |
| `createOrderNetworkCount` | network-completed POST `/api/v3/brokerage/orders` | **0** |

Tests §J.25/26/27 assert each counter individually after a full
runtime shadow trade. Test 30 asserts all three at the end of the
40-fixture matrix.

### 10. Superseding certification JSON and Markdown

The runtime-integrated certification writes a new
`shadow_certification_runs` row with:

```
{
  "certificationRunId": "cert-runtime-<seq>",
  "runtimeIntegrated": true,
  "supersedesRunId": "p1g3d-module-only",
  "simulationMode": "SHADOW_LIVE",
  "strategyVersion": "p1g3d-shadow-1",
  "costModelVersion": "p1g3b-cashflow-1",
  "protectionPolicyVersion": "p1g3c-protection-1",
  "lineageVersion": "p1g3d-lineage-1",
  "fixtureCount": 40,
  "passedFixtures": 40,
  "failedFixtures": 0,
  "accountingDifference": "0.00000000",
  "unresolvedIntents": 0,
  "unprotectedPositions": 0,
  "incompleteAttributions": 0,
  "lineageFailures": 0,
  "createOrderFunctionInvocations": 0,
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

Markdown is emitted via `renderMarkdownReport(report)`.

### 11. Modified-file list

**New**
- `apps/server/drizzle/migrations/0011_phase1_gate3d_fix_runtime_integration.sql`
- `apps/server/drizzle/migrations/meta/0011_snapshot.json`
- `apps/server/drizzle/fingerprints/0011_mariadb_fingerprint.json`
- `apps/server/src/lib/operatingMode.ts` — the ONE mode source
- `apps/server/src/trading/shadow/runtimeService.ts` — runtime-only scanner + executor + exit + additional-fill
- `apps/server/tests/phase1_gate3d_fix.test.ts` — 33 required tests + 40-fixture matrix

**Modified**
- `apps/server/drizzle/migrations/meta/_journal.json` — entry 11 added
- `apps/server/src/db/schema.ts` — 3 new columns on `shadow_certification_runs`
- `apps/server/src/env.ts` — `SIMULATION_MODE` already present from Gate 3D
- `apps/server/src/lib/fetchBarrier.ts` — added `createOrderFunctionInvocations` counter + `recordCreateOrderFunctionInvocation`
- `apps/server/src/trading/coinbase.ts` — `createOrder` records the function invocation BEFORE the killswitch
- `apps/server/src/trading/executor.ts` — `openPosition` + `closePosition` guarded by `assertRuntimeShadowOrLegacyBypass`
- `apps/server/src/trading/shadow/certification.ts` — per-fixture anomaly accounting; intentional degraded/missing/contradictory fixtures no longer pollute the aggregate

### 12. Full test results

```
$ npx turbo run typecheck test build
Tasks:    9 successful, 9 total

Test Files  28 passed (28)
     Tests  419 passed (419)   ← +33 vs Gate 3D's 386
```

New this tranche: `tests/phase1_gate3d_fix.test.ts` (33 tests + 40-fixture matrix).

Verbatim per-item mapping for the 33 required correction tests:

| # | test name |
|---|---|
| 1 | Scheduled scanner uses the Gate 3 pipeline |
| 2 | Manual scanner uses the same pipeline |
| 3 | Negative economics never invokes Claude |
| 4 | Protection rejection never creates a plan |
| 5 | Scanner cannot call the executor without a plan |
| 6 | Executor rejects raw trade parameters in shadow mode |
| 7 | Executor consumes exact plan size |
| 8 | Executor cannot recalculate size |
| 9 | Executor cannot alter TP or SL |
| 10 | Plan consumption is single-use |
| 11 | Legacy dry-run path cannot create shadow economic state |
| 12 | Runtime entry fill triggers revalidation |
| 13 | Runtime entry fill creates or updates protection |
| 14 | Runtime partial exit updates protection |
| 15 | Runtime final exit writes attribution |
| 16 | Runtime failed exit remains nonterminal |
| 17 | Paused entries do not pause exit management |
| 18 | Circuit breaker does not pause protection |
| 19 | Startup reconciler reconstructs runtime-created state |
| 20 | Recurring reconciler uses the same economic functions |
| 21 | Every economic writer has an authorized source |
| 22 | All 40 fixtures enter through runtime services |
| 23 | Accounting difference is zero across every applicable fixture |
| 24 | Gate 2 lineage is complete across every applicable fixture |
| 25 | createOrderFunctionInvocations = 0 |
| 26 | createOrderAttemptCount = 0 |
| 27 | createOrderNetworkCount = 0 |
| 28 | Certification cannot pass with fewer than the required fixtures |
| 29 | Certification cannot pass with a legacy bypass |
| 30 | Passing certification returns mechanically_ready_for_shadow (40-fixture matrix) |
| 31 | No code path returns ready_for_live_capital |
| 32 | Existing tests remain green |
| 33 | Migration and snapshot integrity remains green |

Migration integrity holds across all 12 checkpoints:

| Path | Result |
|---|---|
| Fresh from zero (0000 → 0011) | ✅ same fingerprint |
| Upgrade from every earlier checkpoint | ✅ same fingerprint |
| Repeated invocation | ✅ no-op |
| `drizzle-kit generate` after 3D-FIX | ✅ empty diff |

### 13. Final Gate 3 verdict

**`mechanically_ready_for_shadow` — runtime-integrated.**

The prior module-only Gate 3D certification (commit `aed7a5b`) is
superseded by this run. `shadow_certification_runs.runtimeIntegrated`
distinguishes runtime-integrated cert rows from earlier module-only
runs; `supersedesRunId` records the supersession chain.

Gate 3 as a whole:

| gate | tests | verdict |
|---|---|---|
| Gate 3A (exit + recovery) | 23 | ✅ |
| Gate 3B (cash-flow cost model) | 15 | ✅ |
| Gate 3C (protection matrix) | 32 | ✅ |
| Gate 3D (integrated shadow) | 37 | ✅ |
| Gate 3D-FIX (runtime enforcement) | **33 + 40-fixture matrix** | ✅ |
| **Total** | **419 across 28 files** | ✅ |

### 14. Explicit safe-flag and zero-order confirmation

- `DRY_RUN=true` in `apps/server/.env` — unchanged.
- `ORDER_SUBMISSION_ENABLED=false` in `apps/server/.env` — unchanged.
- `SIMULATION_MODE=STANDARD_DRY_RUN` by default; `SHADOW_LIVE` only
  in shadow-certification fixtures via `_testOverride` scoped to
  `beforeEach`/`afterEach`.
- Phase 1 §Q killswitch inside `coinbase.createOrder` untouched. Every
  entry path in `createOrder` first calls
  `recordCreateOrderFunctionInvocation()` (proving the function was
  reached) — under SHADOW_LIVE this counter stays 0 because the
  runtime never even calls the abstraction.
- **No `POST /api/v3/brokerage/orders` request or attempt left the
  process during 3D-FIX.** The three-counter report at test-run
  completion:
  - `createOrderFunctionInvocations = 0`
  - `createOrderAttemptCount = 0`
  - `createOrderNetworkCount = 0`
- Migrations 0000–0010 SQL files remain byte-identical. Only new
  migration `0011` (additive columns on `shadow_certification_runs`)
  was added.
- Token universe, strategy thresholds, allocations, TP, SL, routing,
  and Claude policy remain unchanged.
- No new signals, indicators, matrices, feeds or token universe
  changes were introduced.
- **Phase 2A remains prohibited.** The runtime-integrated verdict
  authorizes Phase 1.2 live-data shadow ingestion only. Live capital
  requires an entirely separate certification cycle that this
  codebase does not currently attempt.

Only after the runtime-integrated `mechanically_ready_for_shadow`
verdict here should Phase 1.2 begin connecting Coinbase's live
market-data channels.
