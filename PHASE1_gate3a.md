# Phase 1.1 Gate 3A — Exit + Recovery Completion

> **DRY_RUN remains `true`.** **ORDER_SUBMISSION_ENABLED remains `false`.**
> **No Coinbase Create Order request was made during Gate 3A.**

Gate 3A is the first of four commits that complete Gate 3. This one
delivers exit and recovery semantics: the canonical position lifecycle
state model, partial-exit accounting that preserves exact residual
quantity, the dust policy classifier, exit-attempt allocator
config-verification, and reconciler exit recovery. Gates 3B / 3C / 3D
follow in separate reviewed commits.

## Deliverables

### 1. Execution-lifecycle state diagram

```
                  pending_entry
                        │
                        ▼
                  (fills arrive)
                        │
             ┌──────────┴──────────┐
             ▼                     ▼
      partially_open       open ─(protection assessed)
             │                     │
             │            ┌────────┴────────┐
             │            ▼                 ▼
             │    open_unprotected   open_protected
             │            │                 │
             └────────────┼─────────────────┘
                          │
                    (exit intent)
                          │
                          ▼
                  partially_closing (partial exit; residual > dust)
                          │
                    (more exit fills)
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
           closed              dust_residual (residual > 0 but ≤ dust threshold)
                                       │
                              (dust fields populated)
                                       │
                                       ▼
                                    closed

Anywhere → failed | reconciliation_required
                          │
             (unresolved discrepancy)
                          │
                          ▼
                  blocks new entries
```

Every transition emits a Gate 2 `lineage_event`. Nullable-field
combinations are never used to infer state.

### 2. Partial-fill classification table

Unchanged from Gate 1.1.b §E — the classifier still returns
`unfilled_open` / `unfilled_terminal` / `partially_filled_open` /
`partially_filled_terminal` / `completely_filled` /
`filled_with_dust_residual` / `inconsistent` / `unknown`.

Gate 3A ADDS the **operational** consequences of each classification:

| classification | executor action | ledger action | position update |
|---|---|---|---|
| `unfilled_open` | wait / poll | none | none |
| `unfilled_terminal` | mark intent canceled | none | none |
| `partially_filled_open` | update residualBaseSize; keep intent nonterminal | debit per-fill | update filledQuantity if entry; update residualBaseSize if exit |
| `partially_filled_terminal` | mark intent partially_filled | debit per-fill | keep exposure at exact filled base |
| `completely_filled` | mark intent filled | debit per-fill | position closed if exit; opened if entry |
| `filled_with_dust_residual` | mark intent filled; close position `dust_residual` | debit per-fill; dust fields populated | position closed, dust remains recorded |
| `inconsistent` | degrade reconciliation; block entries | no ledger change | no position change |
| `unknown` | trip global unknown lock | no ledger change | no position change |

### 3. Entry + exit transaction boundaries

Both remain single transactions via
`applyEntryEconomicStateTx` / `applyExitEconomicStateTx`. Gate 3A
extends the exit boundary:

```
EXIT (applyExitEconomicStateTx):
  BEGIN
    verify fencing (Gate 1.1.b §H — SELECT ... FOR UPDATE on execution_fences)
    SELECT LIVE position (in case a prior partial-close changed it)
    IF round_trip already exists for this position:
      return { kind: 'closed', roundTripId, outcome, residualBase: 0 }
    upsert fills (idempotent by exchangeFillId)
    INSERT cash_ledger sell_proceeds + sell_fee per fill (UNIQUE idempotencyKey)
    Σ ALL exit fills across ALL exit intents for this position
      → totalExitBase, totalExitQuote, totalExitFees
    residual = entryFilledQty - totalExitBase
    IF residual > dustThreshold:
      UPDATE positions SET residualBaseSize=residual, lifecycleState='partially_closing'
      UPDATE order_intents state='partially_filled' | 'filled' (per this intent)
      → return { kind: 'partial', residualBaseSize, newlyAppliedBase }
    ELSE:
      IF residual > 0 AND residual ≤ dustThreshold:
        UPDATE positions SET status='closed', lifecycleState='dust_residual',
                             closedAt, residualBaseSize=residual,
                             dustQuantity=residual, dustReason='below_dust_threshold',
                             dustDetectedAt, dustPolicyVersion
      ELSE:
        UPDATE positions SET status='closed', lifecycleState='closed', closedAt
      INSERT round_trip (positionId UNIQUE)
        aggregating totalExitQuote and totalExitFees across ALL exit intents;
        entry/finalExit decisionChainId + orderIntentId back-references populated
      UPDATE order_intents state='partially_filled' | 'filled' (per this intent)
      → return { kind: 'closed' | 'dust_closed', roundTripId, outcome, residualBaseSize }
  COMMIT
```

Idempotent on replay: fills dedupe by `exchangeFillId`; ledger by
`idempotencyKey`; the residual math re-derives from the DB every time.

### 4. Exit-attempt sequencing specification

The transactional allocator from 1.1.b §F now pairs with
`verifyExitConfigMatches` (Gate 3A §G) — when a duplicate-key error is
raised by the UNIQUE `(positionId, purpose, attemptGeneration)` index,
the caller must NOT blindly adopt the winning intent. It must re-read
it and verify its economic configuration matches the intended action.
Any mismatch (different `baseSize`, `purpose`, `positionId`, `orderType`,
`mode`) is a hard-fail: the caller aborts the current attempt and lets
a fresh allocation happen.

### 5. Dust policy

`src/trading/dustPolicy.ts` — pure classifier:

```
Inputs:  residualBase, baseIncrement, baseMinSize?, incrementMultiplier?,
         lastKnownPrice?, policyKind?, policyVersion?

DustReason:
  below_base_min_size      residualBase < product.base_min_size
  below_increment_multiplier residualBase ≤ N × base_increment (N default 1)
  zero_residual            residualBase ≤ 0

DustPolicyKind:
  retain_unpriced          (default) dust stays on the position row; no
                                     value assigned; never fabricated as
                                     a sale
  mark_for_consolidation   dust flagged for a future consolidation sweep
  include_as_residual_asset dust counted as unrealized residual at
                                     last-known price (documentation only —
                                     never used as a synthetic sale)

Persisted on positions:
  dustQuantity, dustEstimatedValue, dustReason, dustDetectedAt,
  dustPolicyVersion
```

**Never fabricate a sale at the last market price.** `applyExitEconomicStateTx`
sets `lifecycleState='dust_residual'` and populates dust fields when
the residual is ≤ `dustThresholdBase`, but no synthetic fill is
recorded and no additional proceeds are credited.

### 6. Reconciler exit recovery (§H)

`continuousReconciler.ts` now dispatches recovered exit fills through
`applyExitEconomicStateTx` — the SAME function normal execution uses.
Rules:

- **Reuse the original position** (`intent.positionId`).
- **Reuse the original intent id** — never create a replacement.
- **Reuse the original decision chain** (`intent.decisionChainId`).
- **Reuse the original preview + configuration hash** (Gate 1.1.b §G
  fields carried on the intent).
- **Reuse the original clientOrderId** — never generate a fresh one.
- Discovered fills attach to the existing intent.
- The economic state applies exactly once per fill via the transactional
  helper's idempotency.

Test §17 verifies the recovered intent's `decisionChainId` is unchanged
from the original chain.

### 7. Modified files

**New**
- `apps/server/drizzle/migrations/0007_phase1_gate3a_exit_completion.sql` — lifecycle enum + dust fields + protectionState
- `apps/server/drizzle/migrations/meta/0007_snapshot.json` — mechanical
- `apps/server/drizzle/fingerprints/0007_mariadb_fingerprint.json` — mechanical
- `apps/server/src/trading/dustPolicy.ts` — pure classifier + policy kinds
- `apps/server/tests/phase1_gate3a.test.ts` — 23 tests (20 required + 3 additional coverage)

**Modified**
- `apps/server/drizzle/migrations/meta/_journal.json` — entry 7 added
- `apps/server/src/db/schema.ts` — extended positions.lifecycleState enum, added dust fields + protectionState
- `apps/server/src/db/tx.ts` — `ApplyExitInput` gains `dustThresholdBase` + `dustPolicyVersion`; `ApplyExitResult` becomes a discriminated union (`partial` / `closed` / `dust_closed`); `applyExitEconomicStateTx` now correctly handles partial exits by aggregating ALL exit fills across ALL exit intents for the position; round-trip creation is deferred until residual ≤ dust threshold; multiple exit attempts fold into ONE round trip
- `apps/server/src/trading/executor.ts` — `closePosition` branches on `result.kind`; partial results return `kind: 'pending'` with `reason: 'partial_exit_residual_remains'`
- `apps/server/src/trading/exitAttemptAllocator.ts` — `verifyExitConfigMatches` + `IntendedExitConfig` + `ConfigMatchVerdict`
- `apps/server/src/trading/continuousReconciler.ts` — exit-recovery branch that calls `applyExitEconomicStateTx` with the ORIGINAL intent + position + chain; never creates a new authorization
- `apps/server/tests/tx-rollback-fencing.test.ts` — updated for the new discriminated union return type

### 8. Migration integrity

Path verified by the existing Gate 1c integrity suite (dynamically
discovers checkpoints from `_journal.json`):

| Path | Result |
|---|---|
| Fresh from zero (0000 → 0007) | ✅ same fingerprint |
| Upgrade from 0000 | ✅ same fingerprint |
| Upgrade from 0003 | ✅ same fingerprint |
| Upgrade from 0004 | ✅ same fingerprint |
| Upgrade from 0005 | ✅ same fingerprint |
| Upgrade from 0006 | ✅ same fingerprint (new checkpoint) |
| Repeated invocation | ✅ no-op |
| drizzle-kit generate after Gate 3A | ✅ empty diff |

### 9. Test results

```
$ npx turbo run typecheck test build
Tasks:    9 successful, 9 total

Test Files  24 passed (24)
     Tests  302 passed (302)   ← +23 vs Gate 2's 279
```

New this tranche: `tests/phase1_gate3a.test.ts` (23 tests).

Verbatim per-item mapping:

| # | test name |
|---|---|
| 1 | zero-fill entry changes no cash or position |
| 2 | partial entry debits exact applied fills |
| 3 | partial entry then cancellation → exact partial position remains |
| 4 | later entry fill updates the SAME position (no second position) |
| 5 | duplicate entry fill replay changes nothing (idempotent) |
| 6 | partial exit credits exact applied proceeds |
| 7 | partial exit preserves exact residual base quantity |
| 8 | partial exit does NOT finalize the round trip |
| 9 | final exit closes position exactly once + creates exactly one round trip |
| 10 | multiple exit attempts remain ONE position lifecycle (one round trip) |
| 11 | failed exit reports failure and does NOT close |
| 12 | dust residual follows the documented policy |
| 12b | dust-close on partial-exit near-zero remainder marks position dust_residual |
| 13 | restart recovers partial entry (idempotent re-apply) |
| 14 | restart recovers partial exit (idempotent re-apply) |
| 15 | delayed fill discovery applies exactly once |
| 16 | reconciliation preserves Gate 2 lineage (chain + entry chain intact) |
| 17 | reconciliation cannot manufacture a new authorization chain |
| 18 | ledger + position + intent rollback together (throw at after_position) |
| 19 | contradictory duplicate fill fails closed |
| 20 | impossible residual (over-sell) is impossible — position not over-drawn |
| §G-1 | verifyExitConfigMatches returns ok for a matching intent |
| §G-2 | verifyExitConfigMatches returns not ok when baseSize differs |

### 10. Known limitations

- The **executor's** `closePosition` path invokes
  `applyExitEconomicStateTx` with the caller-supplied `baseSize` per
  intent; the reconciler recovery path always uses
  `exitReason='reconciled'` and does not yet auto-size the exit
  attempt based on discovered residual. Recovery of an exit whose fill
  set doesn't match the intent's declared baseSize will still apply
  the fills correctly (residual math is authoritative), but the intent
  state may land as `partially_filled` even after a clean recovery.
- **Protection eligibility** — the `protectionState` field on
  `positions` is populated only at insert time (`'unknown'`). The
  runtime wiring that assesses attached-TP/SL vs polling-fallback per
  product + order configuration lands in Gate 3C.
- **Exit-attempt allocator's config verification** (§G) is available
  as `verifyExitConfigMatches` but not yet automatically invoked from
  `persistIntent`. Callers who catch `isDuplicateKeyError` on the
  exit-attempt UNIQUE index MUST re-read the winning intent and pass
  it through `verifyExitConfigMatches` before adopting it. The
  executor's `persistIntent` already re-reads by clientOrderId, and
  the clientOrderId is deterministically derived from
  (purpose, positionId, attemptGeneration) so a match is expected —
  but any future caller allocating exits through a different path
  must add the verification.

### 11. Remaining prerequisites before Gate 3B / 3C / 3D

**Gate 3B — cash-flow cost model:**
- Replace percentage-approximation cost forecast with exact decimal
  cash flows (entryOutflow, targetInflow, stopInflow, timeoutInflow).
- Separate cost components (entry commission, exit commission,
  spread, effective spread, entry/target/stop impact, latency buffer,
  stop-gap buffer, partial-fill buffer, unfilled-opportunity estimate,
  residual/dust estimate).
- Rename "quantile" buffers to `configuredExitImpactBuffer` etc. with
  `bufferSource / bufferVersion / sampleCount / isEmpirical` metadata.
- `OutcomeProbabilityEstimate` interface defined + status
  `not_calibrated` until §V's shadow observations exist.
- Forecast-vs-realized attribution on every completed shadow round trip.

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

### 12. Explicit confirmation

- `DRY_RUN=true` in `apps/server/.env` — unchanged
- `ORDER_SUBMISSION_ENABLED=false` in `apps/server/.env` — unchanged
- Phase 1 §Q killswitch inside `coinbase.createOrder` untouched
- **No real Coinbase order was placed during Gate 3A.** The 23-test
  suite exercises the atomic apply functions directly against
  synthetic `NormalizedFill[]` values; no test contacts
  `api.coinbase.com`.
- Migrations 0000–0006 SQL files remain byte-identical to their
  pre-Gate-3 versions. Only new migration `0007` was added.
- Token universe, strategy thresholds, allocations, TP, SL, routing,
  and Claude policy remain unchanged.
