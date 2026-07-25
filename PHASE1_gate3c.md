# Phase 1.1 Gate 3C — Protection Capability, Validation, and Degradation

> **DRY_RUN remains `true`.** **ORDER_SUBMISSION_ENABLED remains `false`.**
> **No Coinbase Create Order request was made during Gate 3C.**

Gate 3C is the third of four commits that complete Gate 3. It creates a
versioned, auditable protection-control layer that determines whether a
specific Coinbase product and order configuration is eligible for
research, simulation, shadow-live, or (in a future gate) live-capital
operation. It records and validates capability. It does not activate
live trading.

## Deliverables

### 1. Protection architecture summary

Five append-only tables + one instance table, all reachable from the
Gate 2 decision chain:

```
protection_policy_versions   ─┬─→ protection_capabilities   ─┐
                              │                              │
                              └─→ protection_validation_runs ┘
                                          │
                                          ▼
                              protection_instances (1:1 positions)
                                          │
                                          ▼
                              protection_events (append-only)
```

`protection_instances.decisionChainId` is a FK to `decision_chains` so
`getDecisionChainAggregate(chainId)` returns the full protection chain.

### 2. Product/configuration capability model

`(policyVersionId, productId, side, entryOrderType, timeInForce, protectionType)`
is the UNIQUE identity of a capability row. Two rows with the same
identity are rejected at insert time. To change a capability's state, a
new row must be written under a new policy version (versioned, immutable
history — no update helper).

Protection types:

| type | description |
|---|---|
| `attached_trigger_bracket_gtc` | Coinbase-native attached trigger bracket, GTC. Inherits parent size — independent size forbidden. |
| `independent_stop_limit` | Standalone stop-limit order tied to the position. Requires independent size. |
| `independent_take_profit` | Standalone TP order tied to the position. Requires independent size. |
| `independent_bracket` | Both legs as independent orders. Requires independent size. |
| `application_polling` | Application-side polling fallback. **Never authorized for live capital.** |
| `none` | Explicit no-protection fixture, for simulation/research only. |

### 3. Validation-state hierarchy

```
unknown                                                    ← default
  ↓ (documentation review)
documented_unverified                                      ← capped by 'documentation_review'
  ↓ (preview fixture accepted)                             — capped by 'preview_fixture'
preview_supported          preview_rejected                — capped by 'preview_fixture'
  ↓ (shadow harness passes)
shadow_validated                                           ← capped by 'shadow_fixture'
  ↓ (sandbox execution passes)
sandbox_validated                                          ← capped by 'sandbox'
  ↓ (live canary passes)
live_canary_validated                                      ← capped by 'live_canary'

unsupported                                                ← hard exclude
temporarily_degraded                                       ← soft exclude (retry)
```

Each `capabilityState` cannot exceed the maximum the underlying
`validationType` can establish — enforced in `recordCapability`. A
documentation review can NEVER produce `preview_supported` or higher; a
mocked preview fixture can NEVER produce `sandbox_validated` or
`live_canary_validated`.

### 4. Configuration builder specification

`buildProtectedConfig(input) → BuildResult` — pure. Binds the config to
`productId × side × entryOrderType × timeInForce × previewId ×
decisionChainId × policyVersionId` and returns a deterministic
`configurationHash`.

Reject rules:

| reason | condition |
|---|---|
| `inverted_target_stop` | long: target ≤ stop; short: target ≥ stop |
| `unsupported_side` | side ∉ {BUY, SELL} |
| `unsupported_product` | productId not `AAA-BBB` shape |
| `unsupported_time_in_force` | tif ∉ {IOC, GTC, FOK, GTD} |
| `missing_trigger` | target or stop absent |
| `attached_size_forbidden` | attached type + `independentBaseQuantity` set |
| `independent_size_required` | independent type + no `independentBaseQuantity` |
| `stale_policy` | policy status ≠ `active` |

`configurationHash = sha256(canonical(config))` over exact-decimal fields.
Any mutation flips the hash — capability + validation records key off
the same hash.

### 5. Partial-fill protection policy

Every entry fill runs through
`recalculateInstanceAfterFill({instanceId, newFilledBase,
newConfirmedBase})`:

1. `requiredBaseQuantity ← newFilledBase` (actual exposure — NOT the
   original requested size).
2. `confirmedBaseQuantity ← newConfirmedBase` (authoritative exchange
   ack).
3. State classification:
   - `confirmed` when `confirmed ≥ required`.
   - `partially_confirmed` when `0 < confirmed < required`.
   - `missing` when `confirmed = 0` and required > 0.
4. `positions.protectionState` and `positions.lifecycleState` sync:
   - `confirmed` (native) → `attached_active` / `open_protected`
   - `confirmed` (polling) → `polling_only` / `open_protected`
   - `partially_confirmed` → `attached_partial` / `open_protected`
   - `missing` / `rejected` / `canceled` / `inconsistent` / `degraded`
     → `degraded` / `open_unprotected`
5. Every transition emits a `protection_event` AND a Gate 2
   `lineage_event` (actor=`protection`,
   componentVersion=`p1g3c-protection-1`).

A partially filled entry is **never** marked fully protected on the
basis of the original requested quantity.

### 6. Bracket state diagram

```
take_profit_leg:                stop_loss_leg:
  pending                         pending
    ↓                               ↓
  active                          active
    ↓                               ↓
  partially_filled                partially_filled
    ↓                               ↓
  filled  ─────(authoritative)────→  disabled
                                    │
  (from disabled/pending)  canceled | rejected | unknown
```

Rules encoded in `updateBracketLeg`:

- `authoritative=true` + `newState='filled'` on one leg ⇒ sibling forced
  to `disabled`. Instance state becomes `triggered`.
- `authoritative=false` (partial execution / heartbeat) ⇒ sibling
  UNTOUCHED. The other leg may still be `active` / `pending`.
- Both legs `filled` simultaneously ⇒ `inconsistent` ⇒ instance is
  degraded via `markInstanceDegraded`.
- Restart recovery: `loadInstanceForPosition(positionId)` reconstructs
  both leg states from the persisted row — no in-memory state is
  authoritative.

### 7. Degradation and recovery policy

`markInstanceDegraded({instanceId, reason})`:

1. `protection_instances.state ← 'degraded'`, `failureReason` set.
2. Emits a `protection_event` and a Gate 2 `lineage_event`.
3. `positions.protectionState ← 'degraded'`,
   `positions.lifecycleState ← 'open_unprotected'`.
4. Caller (RiskEngine + entry gate) reads `positions.protectionState`
   AND `botConfig.reconciliationStatus`; either being non-`ok` blocks
   new entries.

`clearDegradation(instanceId)`:

- Requires the reconciler to have already applied
  `recalculateInstanceAfterFill` with a confirmed quantity ≥ required.
- If not confirmed, `clearDegradation` returns the row UNCHANGED — the
  instance stays `degraded`.
- Only on confirmed authoritative protection does the instance return
  to `confirmed`, position `protectionState` to `attached_active`, and
  lifecycle to `open_protected`. A `degradation_cleared` event is
  emitted.

### 8. Gap-risk assumptions

`CONFIGURED_GAP_RISK_POLICY` (version `p1g3c-gap-configured-1`) — every
buffer is labeled configured, never empirical:

| field | value | meaning |
|---|---|---|
| `triggerLatencyMs` | 250 | round-trip latency budget |
| `stopLimitNonFillProbability` | 0.05 | non-zero — the model NEVER claims stop-limit always fills |
| `gapThroughTriggerBps` | 25 | modeled adverse execution shift on stop trigger |
| `partialStopExecutionProbability` | 0.02 | possibility a stop only partially fills |
| `spreadExpansionBps` | 15 | stress-time spread widening |
| `bookDepthCollapseProbability` | 0.01 | rare book-depth collapse |

`adverseStopExecutionPrice(side, stopTriggerPrice)` returns a price
strictly worse than the trigger, scaled by `gapThroughTriggerBps`.
**Stop-loss percentage is never labeled as a maximum guaranteed loss.**
The gap-risk policy remains configured until Gate 3D shadow
observations replace it with an empirical distribution.

### 9. Migration and snapshot files

**New**
- `apps/server/drizzle/migrations/0009_phase1_gate3c_protection_matrix.sql` — 5 new tables + FK to `decision_chains`
- `apps/server/drizzle/migrations/meta/0009_snapshot.json` — mechanical
- `apps/server/drizzle/fingerprints/0009_mariadb_fingerprint.json` — mechanical

**Modified**
- `apps/server/drizzle/migrations/meta/_journal.json` — entry 9 added

Migrations 0000–0008 remain byte-identical.

### 10. Gate 2 lineage integration

`getDecisionChainAggregate(chainId)` now returns a `.protection` field:

```
protection: {
  instance:      ProtectionInstanceRow | null,
  policy:        ProtectionPolicyVersionRow | null,
  capability:    ProtectionCapabilityRow | null,
  validationRuns: ProtectionValidationRunRow[],
  events:        ProtectionEventRow[],
  legStates:     { takeProfit, stopLoss } | null,
  degradationReason: string | null,
}
```

The audit route `lineage.getDecisionChain` now exposes this to any
authenticated caller. Every protection state change also appears in
`lineage_events` as `protection.<eventType>` so the chain's timeline
remains the single source of truth.

### 11. Test results

```
$ npx turbo run typecheck test build
Tasks:    9 successful, 9 total

Test Files  26 passed (26)
     Tests  349 passed (349)   ← +32 vs Gate 3B's 317
```

New this tranche: `tests/phase1_gate3c.test.ts` (32 tests).

Verbatim per-item mapping:

| # | test name |
|---|---|
| 1 | unknown capability rejects live operation |
| 2 | documented-only capability rejects live operation |
| 3 | preview rejection creates a rejected capability |
| 4 | polling protection authorizes simulation only |
| 5 | polling protection may authorize shadow mode under explicit shadow policy |
| 6 | polling protection never authorizes live capital |
| 7 | environment acknowledgement cannot override rejection |
| 8 | attached configuration omits independent attached size |
| 9 | target below entry is rejected for a long |
| 10 | stop above entry is rejected for a long (target ≤ stop) |
| 11 | configuration mutation changes its hash |
| 12 | stale capability fails closed |
| 13 | partial entry updates required protection quantity |
| 14 | confirmed quantity below exposure produces partial confirmation |
| 15 | missing protection marks the position unprotected |
| 16 | unprotected exposure blocks new entries |
| 17 | protection restoration can clear degradation only after reconciliation |
| 18 | completion of one bracket leg disables the other in the modeled state |
| 19 | partial leg execution preserves correct residual state |
| 20 | contradictory bracket states produce inconsistency (and degrade) |
| 21 | restart reconstructs the protection instance |
| 22 | gap-through-stop uses adverse modeled execution |
| 23 | stop-limit nonfill probability is a configured buffer, not zero |
| 24 | capability records are versioned per (policy, product, config) — duplicates rejected |
| 25 | validation evidence is sanitized (auth headers redacted) |
| 26 | Gate 2 lineage route returns protection records |
| 27 | migration paths produce equivalent schemas |
| 28 | snapshot regeneration is byte-stable |
| 29 | drizzle-kit generate returns no schema change |
| 30 | lowest network transport records zero Create Order requests |
| 31 | DRY_RUN=true default in test env |
| 32 | ORDER_SUBMISSION_ENABLED=false (killswitch remains engaged) |

Migration integrity holds across all 10 checkpoints:

| Path | Result |
|---|---|
| Fresh from zero (0000 → 0009) | ✅ same fingerprint |
| Upgrade from every earlier checkpoint | ✅ same fingerprint |
| Repeated invocation | ✅ no-op |
| `drizzle-kit generate` after Gate 3C | ✅ empty diff |

### 12. Modified-file list

**New**
- `apps/server/drizzle/migrations/0009_phase1_gate3c_protection_matrix.sql`
- `apps/server/drizzle/migrations/meta/0009_snapshot.json`
- `apps/server/drizzle/fingerprints/0009_mariadb_fingerprint.json`
- `apps/server/src/trading/protection/policy.ts`
- `apps/server/src/trading/protection/configBuilder.ts`
- `apps/server/src/trading/protection/instance.ts`
- `apps/server/src/trading/protection/capabilityGate.ts`
- `apps/server/tests/phase1_gate3c.test.ts`

**Modified**
- `apps/server/drizzle/migrations/meta/_journal.json` — entry 9 added
- `apps/server/src/db/schema.ts` — 5 new tables + type exports
- `apps/server/src/db/lineage.ts` — `loadProtectionChain` +
  `ProtectionChainAggregate` exposed via `getDecisionChainAggregate`
- `apps/server/src/routers/lineage.ts` — `protection` returned on the
  audit response
- `apps/server/tests/setup/db.ts` — 5 protection tables added to
  TRUNCATE (child-first FK order)

### 13. Known limitations

- **Protection is not yet wired into the executor's entry path.** Gate
  3C ships the module + schema + capability gate + tests. The
  automatic call site — `executor.openPosition` invoking
  `evaluateProtectionCapability` before authorizing an intent, and
  `createProtectionInstance` on the first fill — lands in Gate 3D
  behind the shadow flag so the two decision paths can be co-observed
  before the swap.
- **No shadow-observation feed exists yet.** Gap-risk buffers,
  stop-limit non-fill probability, and adverse-execution shifts
  remain `bufferSource='configured'` and `isEmpiricalBuffer=false`
  until Gate 3D's zero-order shadow harness populates a real
  distribution.
- **Live-capital authorization requires `live_canary_validated`.** No
  capability row in this build is at that state; the gate rejects
  every `operatingMode='live_capital'` call regardless of anything a
  caller passes in. This is intentional.

### 14. Remaining blockers before Gate 3D

**Gate 3D — integrated shadow-readiness:**
- `SIMULATION_MODE=SHADOW_LIVE` env plumbing.
- Zero-order network certification (fetch-layer instrumentation, not
  just the exported `createOrder` mock).
- Wire `buildCashFlowForecast` (Gate 3B) into the scanner before
  Claude / order intent.
- Wire `evaluateProtectionCapability` + `createProtectionInstance` +
  `recalculateInstanceAfterFill` (Gate 3C) into
  `executor.openPosition` and `closePosition`.
- Complete fixture matrix that walks a shadow round trip through every
  Gate 3B cost component AND every Gate 3C protection state.
- Reproducible shadow-readiness report with verdicts:
  `not_ready` | `mechanically_ready_for_shadow` | `degraded` — this
  gate NEVER produces `ready_for_live_capital`.
- Integrated Gate 3 certification: Gates 3A, 3B, 3C, 3D all reviewed
  together before Phase 2A can be considered.

### 15. Explicit safe-flag and zero-order confirmation

- `DRY_RUN=true` in `apps/server/.env` — unchanged
- `ORDER_SUBMISSION_ENABLED=false` in `apps/server/.env` — unchanged
- Phase 1 §Q killswitch inside `coinbase.createOrder` untouched
- **No real Coinbase order was placed during Gate 3C.** Test 30 spies
  on `globalThis.fetch`, invokes `createOrder`, and asserts the
  killswitch rejects the call BEFORE any HTTP request is issued.
  Test 32 repeats the assertion for the killswitch specifically.
- Migrations 0000–0008 SQL files remain byte-identical to their
  pre-3C versions. Only new migration `0009` was added.
- Token universe, strategy thresholds, allocations, TP, SL, routing,
  and Claude policy remain unchanged.
- Phase 2A remains **prohibited** until all four Gate 3 sub-gates
  (3A/3B/3C/3D) have been reviewed and the integrated Gate 3
  certification passes.
