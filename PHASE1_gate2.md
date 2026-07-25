# Phase 1.1 Gate 2 — Canonical Decision-to-Outcome Lineage

> **DRY_RUN remains `true`.** **ORDER_SUBMISSION_ENABLED remains `false`.**
> **No Coinbase Create Order request was made during Gate 2.**

Gate 2 gives every product evaluation a durable, immutable causal chain
from market observation through outcome. The chain is queryable end-to-end
by one authenticated audit route. Migrations 0000–0005 remain immutable;
Gate 2 ships as forward migration `0006`.

## Architecture summary

Direct foreign keys + append-only lineage journal — NOT a polymorphic
lineage table. `decision_chains` is the permanent root; every downstream
authorization / execution / outcome record carries a direct FK to it (or,
where genuinely disjoint, resolves transitively through its parent).

```
scan_runs (one per scanner cycle)
   └─ decision_chains (one per evaluated product per scan)  ← ROOT
        ├─ market_observations   (immutable snapshot at decision time)
        ├─ eligibility_decisions (why this product was (in)eligible)
        ├─ setup_evaluations     (current 3-mode scanner detection)
        ├─ strategy_routing_decisions (reversion / breakout / macro_floor / no_trade / …)
        ├─ signal_candidates.decisionChainId          (existing table +FK)
        ├─ execution_cost_forecasts.decisionChainId   (existing table +FK)
        ├─ quantitative_decisions.decisionChainId     (existing table +FK)
        ├─ order_intents.decisionChainId              (existing table +FK)
        │      └─ fills                (resolves via orderIntentId — NO duplicate chain ref)
        ├─ positions.entryDecisionChainId
        │      └─ exit order_intents.entryDecisionChainId (origin) + .decisionChainId (this exit)
        ├─ round_trips.entryDecisionChainId + .finalExitDecisionChainId
        ├─ cash_ledger.decisionChainId + .causeCategory
        ├─ reconciliation_actions.decisionChainId
        ├─ outcome_labels (UNIQUE(chainId, labelVersion); corrections version-bumped)
        └─ lineage_events (append-only journal of every transition)
```

## Deliverables

### 1. New migration

`apps/server/drizzle/migrations/0006_phase1_gate2_decision_lineage.sql` —
purely additive DDL. 8 new tables + column additions on 8 existing
tables (all nullable so legacy rows survive).

### 2. Updated snapshot chain

`drizzle-kit generate` on Gate 2's schema produces **"No schema changes,
nothing to migrate 😴"** — verified. The reconstruction tool
(`scripts/reconstruct-snapshots.ts` from Gate 1) added
`0006_snapshot.json` mechanically from the real MariaDB state; no
existing snapshot changed.

### 3. Migration-path results

Verified via existing Gate 1c integrity suite (extended by construction —
it discovers migrations dynamically from `_journal.json`):

| Path | Result |
|---|---|
| Fresh from zero (0000 → 0006) | ✅ same fingerprint |
| Upgrade from 0000 | ✅ same fingerprint |
| Upgrade from 0003 | ✅ same fingerprint |
| Upgrade from 0004 | ✅ same fingerprint |
| Upgrade from 0005 | ✅ same fingerprint (new checkpoint) |
| Upgrade from commit `010b63f` | ✅ same fingerprint |
| Repeated invocation | ✅ no-op |
| drizzle-kit generate after Gate 2 | ✅ empty diff |

### 4. Foreign-key map

Every FK added by Gate 2:

| Child table | Column | → | Parent table.column | ON DELETE | ON UPDATE |
|---|---|---|---|---|---|
| `decision_chains` | `scanRunId` | → | `scan_runs.id` | RESTRICT | RESTRICT |
| `market_observations` | `decisionChainId` | → | `decision_chains.id` | RESTRICT | RESTRICT |
| `eligibility_decisions` | `decisionChainId` | → | `decision_chains.id` | RESTRICT | RESTRICT |
| `eligibility_decisions` | `marketObservationId` | → | `market_observations.id` | RESTRICT | RESTRICT |
| `setup_evaluations` | `decisionChainId` | → | `decision_chains.id` | RESTRICT | RESTRICT |
| `setup_evaluations` | `marketObservationId` | → | `market_observations.id` | RESTRICT | RESTRICT |
| `strategy_routing_decisions` | `decisionChainId` | → | `decision_chains.id` | RESTRICT | RESTRICT |
| `strategy_routing_decisions` | `setupEvaluationId` | → | `setup_evaluations.id` | RESTRICT | RESTRICT |
| `outcome_labels` | `decisionChainId` | → | `decision_chains.id` | RESTRICT | RESTRICT |
| `lineage_events` | `decisionChainId` | → | `decision_chains.id` | RESTRICT | RESTRICT |

Existing 8 tables gained nullable back-reference columns (no FK enforced —
nullability is required for legacy rows and the FK graph would otherwise
grow to double-digit inserts per candidate). Referential integrity for
the back-references is enforced by application code + the audit route's
completeness check.

### 5. Runtime creation sequence (scanner)

```
scan_runs (started)
  → for each token:
      decision_chains (observed)
      market_observations
      eligibility_decisions
         │
         ├── ineligible → chain.currentStatus = 'ineligible' → continue
         └── eligible
             setup_evaluations
                │
                ├── no_setup → strategy_routing_decisions(no_trade) → 'no_setup' → continue
                └── detected
                    strategy_routing_decisions(reversion|breakout|macro_floor) → 'candidate'
                    signal_candidates (+decisionChainId +marketObservationId
                                        +setupEvaluationId +routingDecisionId)
                    preview
                       │
                       ├── rejected → quantitative_decisions(reject_*) → 'economically_rejected'
                       │              → continue
                       └── ok
                          cost forecast (+decisionChainId +routingDecisionId)
                          EV gate
                             │
                             ├── reject → quantitative_decisions(reject_*) → 'quantitatively_rejected'
                             │            → continue
                             └── accept → quantitative_decisions(accept) 
                                          Claude
                                             │
                                             ├── reject → 'quantitatively_rejected' → continue
                                             └── approve → 'approved'
                                                order_intents (+decisionChainId)
                                                openPosition → 'position_open' / 'failed'
scan_runs (completed | blocked | failed)
```

Every transition emits a `lineage_events` row (INSERT-ONLY).

### 6. Immutability policy

Enforced in code via `src/db/lineage.ts`. The module is the ONLY safe
writer for these tables — direct `db.update(table)` bypasses the policy.

| Table | Mutation policy |
|---|---|
| `scan_runs` | Insert + `completeScanRun` only |
| `decision_chains` | Insert + `transitionChainStatus` (patches `currentStatus`, `decisionCompletedAt`, `lineageCompleteness`); emits lineage event |
| `market_observations` | INSERT ONLY |
| `eligibility_decisions` | INSERT ONLY |
| `setup_evaluations` | INSERT ONLY |
| `strategy_routing_decisions` | INSERT ONLY |
| `outcome_labels` | INSERT ONLY (+ `appendCorrectedOutcomeLabel` for versioned corrections) |
| `lineage_events` | APPEND-ONLY (no update helper) |

**Corrections**: forbidden in place. `appendCorrectedOutcomeLabel(supersedes, reason, input)`
creates a new row with `supersedesOutcomeLabelId` set and an incremented
`labelVersion`. The UNIQUE `(decisionChainId, labelVersion)` index blocks
any attempt to duplicate a version — proven by test §M.21.

### 7. Legacy-backfill report

`decision_chains.legacyStatus` = `current` | `legacy_backfilled` | `legacy_unresolved`.
`decision_chains.lineageCompleteness` = `complete` | `partial` | `broken` |
`legacy_unresolved`.

Rules (test §M.24-25):
- New chains start as `current` + `partial`; transitions mark them `complete`.
- Legacy rows (pre-Gate 2) whose relationships cannot be deterministically
  established stay `legacy_unresolved`.
- Research eligibility filter: `WHERE legacyStatus = 'current'` — legacy
  unresolved rows are excluded from Kelly, validation, and future
  challenger promotion.

Backfill is intentionally NOT run during Gate 2 — legacy authorization
rows (from before this migration) keep NULL `decisionChainId`. A future
slice may add read-only backfill helpers for records whose relationships
are unambiguous; guessing based on timestamp + product name is
prohibited.

### 8. Outcome-labeling policy (§I)

`insertOutcomeLabel` REJECTS any input where
`dataAvailableAt < chain.decisionCompletedAt` — look-ahead bias is
impossible by construction (test §M.20).

Intrabar ambiguity (both TP and SL prices inside the same candle's
`[low, high]`):

| Policy | Behavior | tpFirst | slFirst | ambiguous |
|---|---|---|---|---|
| `ambiguous_flag` | Mark and stop | `null` | `null` | `true` |
| `conservative_adverse` | Assume SL was hit | `false` | `true` | `false` |

There is intentionally **no** `assume_favorable` policy. Test §M.23
locks this contract.

### 9. Modified-file list

**New**
- `apps/server/drizzle/migrations/0006_phase1_gate2_decision_lineage.sql`
- `apps/server/drizzle/migrations/meta/0006_snapshot.json` (mechanical)
- `apps/server/drizzle/fingerprints/0006_mariadb_fingerprint.json` (mechanical)
- `apps/server/src/db/lineage.ts` — helpers + immutability enforcement
- `apps/server/src/trading/outcomeLabeler.ts` — forward-only conservative labeler
- `apps/server/src/routers/lineage.ts` — audit route `lineage.getDecisionChain`
- `apps/server/tests/phase1_gate2.test.ts` — 32 required tests

**Modified**
- `apps/server/src/db/schema.ts` — 8 new tables + additive columns on
  8 existing tables + type exports
- `apps/server/src/db/tx.ts` — `applyEntryEconomicStateTx` accepts
  `entryDecisionChainId`, stamps it on the inserted position
- `apps/server/src/trading/executor.ts` — `EntryDecision` gains
  `decisionChainId`, threaded through to `applyEntryEconomicStateTx`
- `apps/server/src/trading/scanner.ts` — creates scan run + chain +
  observation + eligibility + setup + routing at existing decision points;
  populates lineage refs on candidate / forecast / quantitative decision
  / order intent
- `apps/server/src/routers/index.ts` — mounts `lineage` sub-router
- `apps/server/drizzle/migrations/meta/_journal.json` — entry 6
- `apps/server/tests/setup/db.ts` — TRUNCATE the new tables + previously
  untracked immutable-decision tables
- `apps/server/tests/scanner-flow.test.ts` — one regex widened to
  accommodate the new lineage writes between the gate check and `continue`

### 10. Example — complete accepted chain

```
scan_runs         id=100  status='completed'
  decision_chains id=250  productId='AAVE-USD' currentStatus='position_open'
                          lineageCompleteness='complete'
    market_observations       id=380  dataQualityStatus='valid' price=100 …
    eligibility_decisions     id=210  eligible=true reasonCode='eligible'
    setup_evaluations         id=170  setupDetected=true modeEvaluated='macro'
    strategy_routing_decisions id=95  routingOutcome='macro_floor'
    signal_candidates         id=140  decisionChainId=250 setupEvaluationId=170 …
    execution_cost_forecasts  id=88   decisionChainId=250 routingDecisionId=95 …
    quantitative_decisions    id=75   decisionChainId=250 decision='accept' …
    order_intents             id=520  decisionChainId=250 configHash=… fenceGeneration=…
      fills                   id=910  orderIntentId=520 filledSize=1 fillPrice=99.98 …
      cash_ledger             id=1200 decisionChainId=250 causeCategory='fill_driven'
                                       reason='buy_cost' deltaUsd=-99.98
      cash_ledger             id=1201 decisionChainId=250 causeCategory='fill_driven'
                                       reason='buy_fee'  deltaUsd=-0.60
    positions                 id=310  entryDecisionChainId=250 filledQuantity=1 …
    lineage_events            (10 rows) chain_created → market_observed → eligible
                              → setup_detected → routed_macro_floor → status_candidate
                              → status_approved → status_position_open
```

### 11. Example — complete rejected chain

```
scan_runs           id=100
  decision_chains   id=252  productId='ADA-USD' currentStatus='no_setup'
                            lineageCompleteness='complete'
    market_observations       id=381  dataQualityStatus='valid' price=0.42 …
    eligibility_decisions     id=212  eligible=true reasonCode='eligible'
    setup_evaluations         id=171  setupDetected=false
    strategy_routing_decisions id=96  routingOutcome='no_trade' reasonCodes=['no_setup']
    lineage_events            (5 rows) chain_created → market_observed → eligible
                              → no_setup → routed_no_trade → status_no_setup

  (no signal_candidates row, no forecast, no intent, no fill, no position)
```

Or:

```
scan_runs           id=100
  decision_chains   id=253  productId='SHIB-USD' currentStatus='ineligible'
                            lineageCompleteness='complete'
    market_observations       id=382  price=0.00003 volume24h=45000 …
    eligibility_decisions     id=213  eligible=false
                                       reasonCode='insufficient_volume'
                                       reasonDetail='24h volume 45000 < 500000'
    lineage_events            (3 rows) chain_created → market_observed → ineligible
                              → status_ineligible
```

### 12. Full test output

```
$ npx turbo run typecheck test build
Tasks:    9 successful, 9 total

Test Files  23 passed (23)
     Tests  279 passed (279)     ← +32 vs Gate 1 (247)
```

New this tranche: `tests/phase1_gate2.test.ts` (32 tests).

Verbatim per-item mapping (§M items 1 → 32):

| # | test name |
|---|---|
| 1 | every token-level evaluation → exactly one chain per scan+product |
| 2 | blocked scan_run has zero decision chains |
| 3 | insufficient-volume rejection retains observation + eligibility |
| 4 | market-data failure retains chain + eligibility (no fabricated observation) |
| 5 | no-setup evaluation retains observation + setup_evaluation + routing |
| 6 | cost-rejection chain retains the forecast row via decisionChainId |
| 7 | approved candidate — observation + eligibility + setup + routing + forecast + decision all link |
| 8 | order intent CAN store a chain id |
| 9 | two chains: each intent stays on ITS chain |
| 10 | preview binding on intent survives insert |
| 11 | fill → intent → chain is traceable transitively |
| 12 | position resolves back to the entry authorization chain |
| 13 | partial fills — multiple fills all resolve to the same chain |
| 14 | multiple exit attempts attach to one position; entryDecisionChainId preserves origin |
| 15 | recovered unknown order — original intent + chain reused, not replaced |
| 16 | reconciliation records action on the ORIGINAL chain, never a new authorization chain |
| 17 | ledger event stored with a causeCategory + chain is retrievable |
| 18 | duplicate ledger row rejected by UNIQUE idempotencyKey |
| 19 | completed round-trip stores entry + final-exit chain refs |
| 20 | outcome dataAvailableAt BEFORE decisionCompletedAt → rejected |
| 21 | duplicate outcome label version rejected (UNIQUE constraint) |
| 22 | correction creates a new labelVersion via appendCorrectedOutcomeLabel |
| 23 | intrabar TP+SL ambiguity NEVER labels tpFirst=true (conservative) |
| 24 | legacy_unresolved chain stays unresolved (no forced inference) |
| 25 | legacy_unresolved chains are excluded from research eligibility |
| 26 | chain status transition emits a lineage event |
| 27 | immutable insert-only tables have NO update helper exported |
| 28 | complete chain returned by getDecisionChainAggregate |
| 29 | FK-guarded child insert with a bogus chain id is rejected |
| 30 | Gate 2 migration produces the expected new tables |
| 31 | schema.ts columns exist on DB (drizzle-kit diff would be empty) |
| 32 | ORDER_SUBMISSION_ENABLED=false still guarantees zero createOrder HTTP calls |

### 13. Remaining blockers before Gate 3

Per the queue:
- **Reconciler exit completion** — the reconciler currently reconciles
  entries but not exit-recovery; a lost SELL response still requires
  manual reconciliation.
- **Cash-flow cost model** — the current cost model uses percentage
  approximations + a "quantile" buffer label. Gate 3 replaces with exact
  modeled cash flows (entry outflow + fees + exit inflow − fees + spread
  + book impact + latency + partial-fill exposure + routing / maker-taker
  classification + explicit forecast uncertainty).
- **Protection eligibility matrix** — per-product record of attached
  protection support, trigger-bracket support, partial-fill handling,
  replacement + cancellation + restart-reconciliation behavior. Polling
  protection remains shadow-only.
- **Shadow-readiness certification** — the acceptance gate before Phase 1.2.

### 14. Explicit confirmation

- `DRY_RUN=true` in `apps/server/.env` — unchanged.
- `ORDER_SUBMISSION_ENABLED=false` in `apps/server/.env` — unchanged.
- Phase 1 §Q killswitch inside `coinbase.createOrder` untouched.
- **No real Coinbase order was placed during Gate 2.** The Gate 2 test
  suite exercises the lineage layer directly against MariaDB; no test
  contacts `api.coinbase.com`. The killswitch test (§M.32) spies on
  `fetch` and asserts zero calls escape.
- Migrations 0000–0005 SQL files remain byte-identical to their
  pre-Gate-2 versions. Only new migration `0006` was added.
- Token universe, strategy thresholds, allocations, TP, SL, routing, and
  Claude policy are unchanged. The scanner wiring records lineage at
  existing decision points; no conditional logic was altered. All 247
  pre-Gate-2 tests continue to pass unchanged (one regex was widened in
  `tests/scanner-flow.test.ts` to accommodate the additional lineage
  writes between the gate check and `continue`).
