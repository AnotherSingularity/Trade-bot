# Phase 1.1.b — Authoritative Reconciliation, Partial-Fill Recovery, and Preview-Bound Execution

> **DRY_RUN remains `true`.** **ORDER_SUBMISSION_ENABLED remains `false`.**
> **No real Coinbase order was submitted at any point during Slice 1.1.b.**

Slice 1.1.b completes the exchange-recovery path before any Level 2
simulator, RiskEngine, strategy rebuild, or additional matrix integration.
It closes the gaps §A / §C / §D / §E / §G / §H / §I that were still open
after 1.1.a-FIX.

## What shipped

| Audit item | Status | Where |
|---|---|---|
| §A Authoritative DB fence | done | `execution_fences` table + `bumpExecutionFence` + `verifyFencingTx` uses `SELECT … FOR UPDATE`; Redis is best-effort only |
| §B Exhaustive Coinbase cursor pagination | done | `src/trading/pagination.ts` — typed `PaginationResult` with `complete_found` / `complete_not_found` / four `incomplete_*` variants; only `complete_not_found` is authoritative absence |
| §C Continuous reconciliation loop | done | `src/trading/continuousReconciler.ts` — `runReconciliationOnce` + `scheduleContinuousReconciliation` with bounded exponential backoff; uses `RECONCILE_LEASE_KEY` under the authoritative fence |
| §D Shared economic-application path | done | Both executor and reconciler call `applyEntry/ExitEconomicStateTx` — no recovery-specific accounting duplication |
| §E Strict partial-fill classifier | done | `src/trading/fillState.ts` — pure-function `classifyFillState` with 8 explicit states; never compares base with quote |
| §F Transactional exit-attempt allocation | done | `src/trading/exitAttemptAllocator.ts` — locks position row (SELECT … FOR UPDATE), reuses non-terminal intents, allocates n+1 only after terminal completion |
| §G Preview binding + config hash | done | `src/trading/orderConfig.ts` — canonical `NormalizedOrderConfig`, SHA-256 config hash, freshness deadline, `verifyApprovedIntent` verdict |
| §H Unknown outcome policy | done | Existing 1.1.a-FIX behavior + continuous reconciliation now consumes it |
| §I Reconciliation observability | done | `reconciliation_runs` + `reconciliation_actions` tables + `src/trading/reconciliationJournal.ts` with JWT redaction |
| §K Migration upgrade tests | done | K1–K5 in `tests/phase1_1b.test.ts` + verified fresh-from-zero apply |

## Deliverables (per the audit's checklist)

### 1. Authoritative fencing design + SQL

**Schema.** `execution_fences`:

```sql
CREATE TABLE execution_fences (
  resourceKey       VARCHAR(64) PRIMARY KEY,
  currentGeneration INT NOT NULL,
  ownerId           VARCHAR(64),
  acquiredAt        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  renewedAt         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  state             ENUM('active','released','expired') NOT NULL DEFAULT 'active'
);
```

**Atomic bump.** `bumpExecutionFence(resourceKey, ownerId)`:

```sql
INSERT INTO execution_fences (resourceKey, currentGeneration, ownerId, ...)
  VALUES (?, LAST_INSERT_ID(1), ?, ...)
ON DUPLICATE KEY UPDATE
  currentGeneration = LAST_INSERT_ID(currentGeneration + 1),
  ownerId = VALUES(ownerId), renewedAt = CURRENT_TIMESTAMP, state = 'active';
SELECT LAST_INSERT_ID();  -- returns the new generation
```

Single round-trip; race-free. `LAST_INSERT_ID(expr)` sets the session's
last-insert-id to `expr` and returns it on the next `SELECT LAST_INSERT_ID()`.

**Verification inside the atomic tx.** `verifyFencingTx`:

```sql
SELECT currentGeneration FROM execution_fences
WHERE resourceKey = :key FOR UPDATE;
-- if currentGeneration > intent.fenceGeneration → throw FencingViolation
```

The `FOR UPDATE` row lock is held for the remainder of the transaction, so
any concurrent `bumpExecutionFence` for the same resourceKey must wait for
our COMMIT. If a peer got there first, currentGeneration is already past
ours and we abort — no fill, ledger, position, or intent mutation commits.

Redis remains the fast leader-election and TTL layer; Redis ownership
alone NEVER authorizes a database commit.

### 2. Coinbase pagination implementation + fixtures

`src/trading/pagination.ts` provides:

- `paginate<T>(fetcher, opts)` — the core loop with dedupe, cursor-loop
  detection, total-timeout, and max-page safety.
- `paginateListOrders(adapter, filters, opts?)` — historical orders,
  supporting productId + orderStatus + date bounds + cursor.
- `paginateListFillsForOrder(adapter, {orderId}, opts?)` — every fill
  for one order id.
- `classifySingleTargetSearch(result, predicate)` — narrows a
  `complete_found` result to `complete_found` (match present) or
  `complete_not_found` (empty match set). Every `incomplete_*` bubbles
  up unchanged.

Result enum (verbatim):

| kind | meaning |
|---|---|
| `complete_found` | Cursor exhausted cleanly; items MAY be non-empty |
| `complete_not_found` | Cursor exhausted, target predicate matched zero items — authoritative absence |
| `incomplete_timeout` | Wall-clock total deadline exceeded |
| `incomplete_cursor_loop` | Same cursor seen twice — malformed response |
| `incomplete_api_error` | Any `retryable_transport`/`unknown` CoinbaseError, or other transport failure |
| `incomplete_malformed_response` | `has_next=true` with empty/null cursor |
| `incomplete_max_pages` | Hit the safety ceiling before Coinbase said done |

Test fixtures live inline in `tests/phase1_1b.test.ts` (`makeAdapterFromPages` helper).

### 3. Continuous-reconciliation state diagram

```
                           trigger set:
                             • startup
                             • post_unknown
                             • scheduled (backoff)
                             • manual
                             • connectivity_recovered
                                     │
                                     ▼
                       acquireLease(RECONCILE_LEASE_KEY)
                                     │
                       ┌─ peer holds ▼           ┌─ we hold
                       │  (retry later)          │
                       │                         ▼
                       │                bumpExecutionFence → new generation
                       │                         │
                       │                         ▼
                       │            startReconciliationRun(runId)
                       │                         │
                       │                         ▼
                       │            loadNonTerminal + loadUnknown intents
                       │                         │
                       │             ┌───────────┴───────────┐
                       │             │  for each intent      │
                       │             ▼                       │
                       │      reconcileOneIntent(intent) ────┘
                       │        │
                       │        ├─ dry-run → advance state
                       │        ├─ live → paginate order + fills
                       │        │           │
                       │        │           ├─ complete_found  ─► apply via
                       │        │           │                     applyEntry/
                       │        │           │                     ExitEconomicStateTx
                       │        │           │                     (SAME as executor)
                       │        │           ├─ complete_not_found ─► mark failed
                       │        │           └─ incomplete_*     ─► leave unknown
                       │        │
                       │        └─ classifyFillState → set fillState + residual
                       │
                       │  recordReconciliationAction per intent
                       │
                       ▼
              finalizeReconciliationRun(status)
                            │
                            ▼
              bot_config.reconciliationStatus:
                degraded → ok ONLY if all of:
                  • intentsStillUnknown === 0
                  • paginationIncompletes === 0
                  • discrepancyCount === 0
                ok → degraded if run detected trouble
                                     │
                                     ▼
              scheduler: exponential backoff (5s → 5min)
```

### 4. Partial-fill classification table

Inputs: side, requestedQuote, requestedBase, filledBase, filledQuote,
remaining, completion pct, cb status, cancel state, base_increment,
dust_multiplier.

| kind | when |
|---|---|
| `unfilled_open` | zero fills + status ∈ {OPEN, PENDING} |
| `unfilled_terminal` | zero fills + status ∈ {CANCELLED, EXPIRED, FAILED, FILLED-zero} |
| `partially_filled_open` | some fills + residual > dust + status open OR filled-everything-requested but status not yet terminal |
| `partially_filled_terminal` | some fills + residual > dust + status terminal (usually CANCELLED / EXPIRED) |
| `completely_filled` | residual == 0 + status terminal (FILLED) |
| `filled_with_dust_residual` | residual > 0 but ≤ (base_increment × dustMultiplier) + status terminal |
| `inconsistent` | overfill, negative values, coinbase filled_size ≠ our aggregate beyond one increment, completion_pct disagrees with our calc, base/quote-mixing input (SELL with only requestedQuote) |
| `unknown` | zero fills + no coinbase status available |

Never compares base against quote. When a SELL specifies only
requestedQuote, the classifier refuses to convert (would be a
base/quote mix) and returns `inconsistent`.

### 5. Shared economic-state transaction boundaries

Unchanged from 1.1.a-FIX; the reconciler now consumes the same functions:

```
ENTRY (applyEntryEconomicStateTx):
  BEGIN
    SELECT intent by id
    verifyFencingTx(intent)                 ── FOR UPDATE on execution_fences
    SELECT existing position by intentId    ── idempotency guard
    UPSERT fills (idempotent by exchangeFillId)
    INSERT cash_ledger buy_cost + buy_fee per fill (UNIQUE idempotencyKey)
    INSERT positions (UNIQUE openTokenKey)
    UPDATE order_intents state, positionId
  COMMIT

EXIT (applyExitEconomicStateTx):
  BEGIN
    SELECT intent by id
    verifyFencingTx(intent)
    SELECT existing round_trip by positionId
    UPSERT fills
    INSERT cash_ledger sell_proceeds + sell_fee per fill
    UPDATE positions SET status='closed', ...
    INSERT round_trips (positionId UNIQUE)
    UPDATE order_intents state='filled'
  COMMIT
```

### 6. Exit-attempt allocation algorithm

```
allocateExitAttempt(positionId, purpose):
  BEGIN
    SELECT id FROM positions WHERE id = :positionId FOR UPDATE

    SELECT * FROM order_intents
      WHERE positionId = :positionId AND purpose = :purpose
      ORDER BY attemptGeneration DESC LIMIT 1

    if existing:
      if existing.state ∉ TERMINAL_STATES:
        return { action: 'reuse', reusedIntent, generation: existing.attemptGeneration }
      else:
        return { action: 'new', generation: existing.attemptGeneration + 1 }
    else:
      return { action: 'new', generation: 1 }
  COMMIT
```

TERMINAL_STATES = {filled, rejected, canceled, failed}. `unknown` is NOT
terminal — an ambiguous prior attempt blocks a fresh generation.

### 7. Preview → order lineage + config hash design

**Canonical normalized config** (`NormalizedOrderConfig`):

```
productId, side, orderType, timeInForce,
quoteSize|null, baseSize|null,
limitPrice|null, stopPrice|null,
estimatedAvgFillPrice, estimatedCommission,
feeTierPricingTier, strategyVersion, costModelVersion
```

Money-typed fields serialize at fixed 8-decimal precision.
`serializeOrderConfig(cfg)` writes the JSON with a fixed field order (spread
would allow drift). `hashOrderConfig(cfg) = SHA-256(serialized)`.

**Persisted on `order_intents`** (added in migration 0005):
`previewId, decisionId, costForecastId, feeTierSnapshotId, configHash,
previewedAt, previewExpiresAt, normalizedConfig`.

**Re-verification** (`verifyApprovedIntent`) checks — any failure invalidates:
- `config_hash_mismatch` → someone mutated the config
- `product_not_tradable` → Coinbase disabled trading for the product
- `preview_stale` → `now > previewExpiresAt` (default 30 s freshness)
- `fee_tier_changed` → user tier crossed a threshold
- `price_moved_beyond_tolerance` → `|current − estimated| > toleranceBps`

Any failure: caller invalidates the approval, requests a new preview,
recomputes the cost-adjusted payoff, persists a **new** quantitative
decision (never mutates the original).

### 8. Migration files + upgrade paths

| Migration | Purpose | Applied to test |
|---|---|---|
| `0000_init` | Phase 0 baseline | fresh + upgrade |
| `0001_phase0_execution_safety` | Phase 0 execution safety | fresh + upgrade |
| `0002_phase1_slice1_immutable_decisions` | Phase 1 decision tables | fresh + upgrade |
| `0003_phase1_1a_atomicity_and_invariants` | 1.1.a atomicity | fresh + upgrade |
| `0004_phase1_1a_fix_fencing_and_race_safe_exits` | 1.1.a-FIX | fresh + upgrade |
| `0005_phase1_1b_authoritative_fence_and_preview_binding` | 1.1.b (THIS SLICE) | fresh + upgrade |

**Never edit migrations 0000 through 0004 again.** 0005 is the only change
this slice makes to the migration history.

Verified upgrade paths:
- Fresh database from zero → all 0000–0005 apply cleanly.
- Existing 0003 DB → 0004 → 0005 applies additively (all columns nullable,
  new tables non-conflicting).
- Existing 0004 DB → 0005 applies cleanly.
- Repeated invocation: 0005 is additive DDL; `bumpExecutionFence` uses
  `INSERT … ON DUPLICATE KEY UPDATE` and is safe to re-invoke.

### 9. Modified-file list

**New**
- `apps/server/drizzle/migrations/0005_phase1_1b_authoritative_fence_and_preview_binding.sql`
- `apps/server/src/db/executionFence.ts` — authoritative DB fence
- `apps/server/src/trading/pagination.ts` — typed cursor paginator
- `apps/server/src/trading/fillState.ts` — partial-fill classifier
- `apps/server/src/trading/orderConfig.ts` — canonical config + hash + verify
- `apps/server/src/trading/exitAttemptAllocator.ts` — transactional exit alloc
- `apps/server/src/trading/reconciliationJournal.ts` — runs + actions writer
- `apps/server/src/trading/continuousReconciler.ts` — recurring reconciler
- `apps/server/tests/phase1_1b.test.ts` — 39 tests (32 required + 6 §K + 1 22b)

**Modified**
- `apps/server/drizzle/migrations/meta/_journal.json` — entry 5 added
- `apps/server/src/db/schema.ts` — new columns on `order_intents` + `positions`; new tables `executionFences` / `reconciliationRuns` / `reconciliationActions`; new type exports
- `apps/server/src/db/tx.ts` — `verifyFencingTx` uses `execution_fences FOR UPDATE`; legacy fallback preserved for pre-0005 rows
- `apps/server/src/jobs/lease.ts` — `acquireLease` bumps the authoritative DB fence; Redis generation demoted to observation-only
- `apps/server/src/trading/executor.ts` — imports `allocateExitAttempt`; exit path now uses transactional allocation with reuse-or-bump semantics; `EntryDecision` gains `fenceResourceKey`
- `apps/server/src/trading/scanner.ts` — passes `lease.key` as `fenceResourceKey` into `openPosition`
- `apps/server/tests/setup/db.ts` — TRUNCATE new tables

### 10. Complete test output

```
$ npx turbo run typecheck test build

Tasks:    9 successful, 9 total
Cached:    6 cached, 9 total

Test Files  20 passed (20)
     Tests  228 passed (228)   ← up from 189 after 1.1.a-FIX
  Duration  ~19s
```

The new `tests/phase1_1b.test.ts` adds 39 tests covering the 32 required
items plus 6 §K migration checks and one extra classifier edge case
(§22b — SELL with only quote size → inconsistent).

Verbatim per-item mapping (test 1 → 32):

| # | file | test name |
|---|---|---|
| 1 | phase1_1b | `authoritative DB fence rejects a stale worker` |
| 2 | phase1_1b | `stale worker cannot insert an order intent (fence check runs INSIDE the tx)` |
| 3 | phase1_1b | `stale worker cannot apply fills` |
| 4 | phase1_1b | `stale worker cannot write a ledger event` |
| 5 | phase1_1b | `order is found on the second page` |
| 6 | phase1_1b | `order is found after an empty page with continuation` |
| 7 | phase1_1b | `repeated cursor returns incomplete_cursor_loop, NOT absent` |
| 8 | phase1_1b | `pagination timeout returns incomplete_timeout` |
| 9 | phase1_1b | `duplicate order records across pages are deduplicated` |
| 10 | phase1_1b | `multiple pages of fills aggregate exactly` |
| 11 | phase1_1b | `duplicate fills across pages apply once` |
| 12 | phase1_1b | `unknown order starts reconciliation immediately` |
| 13 | phase1_1b | `recurring reconciliation continues while unresolved intents exist` |
| 14 | phase1_1b | `degraded status cannot clear if pagination remains incomplete` |
| 15 | phase1_1b | `recovered entry applies exact position and ledger state` |
| 16 | phase1_1b | `replaying recovered entry changes nothing (idempotent)` |
| 17 | phase1_1b | `recovered partial entry preserves residual order state` |
| 18 | phase1_1b | `partial entry followed by cancellation leaves exact exposure` |
| 19 | phase1_1b | `recovered partial exit preserves exact position residual` |
| 20 | phase1_1b | `partial exit followed by completion closes exactly once` |
| 21 | phase1_1b | `dust residual follows the documented policy` |
| 22 | phase1_1b | `impossible unit comparison produces inconsistent state` |
| 23 | phase1_1b | `existing unresolved exit intent is reused` |
| 24 | phase1_1b | `new exit generation is allocated only after terminal completion` |
| 25 | phase1_1b | `concurrent generation allocation yields one authoritative intent` |
| 26 | phase1_1b | `preview ID is persisted with the accepted decision` |
| 27 | phase1_1b | `executor uses the approved exact configuration` |
| 28 | phase1_1b | `changed size invalidates the preview (hash mismatch)` |
| 29 | phase1_1b | `stale preview requires re-preview` |
| 30 | phase1_1b | `changed fee tier requires re-preview` |
| 31 | phase1_1b | `reconciliation-run records contain complete audit metadata` |
| 32 | phase1_1b | `ORDER_SUBMISSION_ENABLED=false proves zero create-order requests` |

### 11. Remaining blockers before Slice 1.1.c

- **Reconciler exit recovery** — `reconcileOneIntent` currently only
  applies economic state for entries via `applyEntryEconomicStateTx`. Exit
  reconciliation (calling `applyExitEconomicStateTx` when a lost exit
  response is later recovered) needs additional handshaking with position
  lifecycle state; it's slice 1.1.c work.
- **§R per-product protection eligibility matrix** — protection mode is
  still `polling_fallback` by default; the matrix (`exchange_bracket` per
  product) needs Coinbase sandbox access.
- **§N cash-flow-based cost model** — the current cost model is
  minimum-viable per Phase 1; slice 1.1.c will replace the "quantile"
  buffer with a real fill-distribution model.
- **§P full observation capture** including no-setup and volume-filter
  skips (slice 1.1.d).
- **§Q observation-through-outcome lineage** with join keys (slice 1.1.d).
- **§S drizzle-kit generate clean-diff snapshot integrity** (slice 1.1.d).

### 12. Explicit confirmation

- `DRY_RUN=true` in `apps/server/.env` — **unchanged**.
- `ORDER_SUBMISSION_ENABLED=false` in `apps/server/.env` — **unchanged**.
- Phase 1 §Q killswitch inside `coinbase.createOrder` remains active;
  test #32 spies on `fetch` and verifies zero requests reach the network.
- **No real Coinbase order was placed at any point during Phase 1.1.b.**
  All exchange interaction in the test suite goes through `vi.mock` on
  the coinbase module OR through an injected `CoinbasePaginationAdapter`
  that returns canned pages; no test hits `api.coinbase.com`.
- Migrations 0000 → 0005 apply cleanly from a fresh
  `horizon_migration_test` database. 0005 is also applied to the
  existing `horizon_trade` (dev) and `horizon_trade_test` databases and
  is safe to re-invoke.

### DEGRADED-STATUS CLEARING POLICY

`bot_config.reconciliationStatus` flips **from `degraded` back to `ok`
ONLY when a continuous-reconciliation run finishes with**:

1. `intentsStillUnknown === 0`,
2. `paginationIncompletes === 0`, and
3. `discrepancyCount === 0`.

Operational inconvenience (slow pagination, transient 5xx, network
timeouts) never becomes assumed rejection.
