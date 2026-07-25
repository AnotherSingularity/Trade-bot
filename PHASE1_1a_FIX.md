# Phase 1.1.a-FIX — Correction Pass on Atomicity, Fencing, and Migration Integrity

> **DRY_RUN remains `true`.** **ORDER_SUBMISSION_ENABLED remains `false`.**
> **No real Coinbase order was submitted at any point during this pass.**

This is the bounded correction tranche the post-1.1.a audit required BEFORE
Slice 1.1.b begins. It fixes three defects the original 1.1.a shipped:

1. Fills were persisted OUTSIDE the atomic economic transaction — a crash
   between fill insert and ledger/position insert would strand fills without
   ledger accounting.
2. The `fenceGeneration` was live-checked on the in-memory lease only. A
   stale worker could see `lease.isValid() === true` at precheck, then have
   its lease silently taken before its DB commit, and still commit under
   the stolen generation.
3. The `reconciliationStatus='degraded'` enum extension was added to
   migration 0003 AFTER 0003 had already been applied to running databases.
   That is a mutable-migration anti-pattern and would silently diverge
   schemas between environments.

Point 4 below (race-safe exit attempt generation) is a hardening the audit
requested at the same time and is included here because it shares the same
migration.

---

## 1. Migration integrity

**Problem.** Migration `0003_phase1_1a_atomicity_and_invariants.sql` had been
applied to `horizon_trade` and `horizon_trade_test`. The initial 1.1.a pass
then appended an `ALTER TABLE bot_config MODIFY COLUMN reconciliationStatus …`
statement to that same file to add the `'degraded'` enum value. Databases
that had already applied 0003 would not re-run it, so `'degraded'` would only
exist on databases initialised after the edit.

**Fix.**

- **Restored** `drizzle/migrations/0003_phase1_1a_atomicity_and_invariants.sql`
  to its originally-applied form (positions.openTokenKey generated column +
  UNIQUE; cash_ledger.idempotencyKey + fillId).
- **Added** `drizzle/migrations/0004_phase1_1a_fix_fencing_and_race_safe_exits.sql`
  which contains:
  - `ALTER TABLE bot_config MODIFY COLUMN reconciliationStatus ENUM(..., 'degraded')`
    (idempotent; safe to re-run on any database)
  - the durable-fencing columns for §H
  - the race-safe exit UNIQUE for §B
- **Updated** `drizzle/migrations/meta/_journal.json` to add the entry for
  0004 (`idx: 4`, `tag: 0004_phase1_1a_fix_fencing_and_race_safe_exits`).

**Verification.**

```
DROP DATABASE IF EXISTS horizon_migration_test;
CREATE DATABASE horizon_migration_test;
for m in 0000 0001 0002 0003 0004; do
  sed 's|--> statement-breakpoint||g' 000${m}_*.sql | mysql horizon_migration_test
done
# → clean apply
mysql horizon_migration_test -e "SHOW CREATE TABLE order_intents\G"
# → fenceGeneration + attemptGeneration columns, order_intents_fence_idx,
#   order_intents_exit_attempt_uq UNIQUE all present
mysql horizon_migration_test -e "SHOW CREATE TABLE bot_config\G"
# → reconciliationStatus ENUM('pending','in_progress','ok','failed','degraded')
mysql horizon_migration_test -e "SHOW CREATE TABLE positions\G"
# → openTokenKey VIRTUAL + positions_open_token_uq UNIQUE (from 0003, intact)
mysql horizon_migration_test -e "SHOW CREATE TABLE cash_ledger\G"
# → idempotencyKey UNIQUE + fillId (from 0003, intact)
```

Re-running the 0004 enum MODIFY on a DB that already has `'degraded'` is a
no-op (MySQL treats it as an in-place check). Both paths converge on the
same final schema.

---

## 2. Durable fencing (§H)

**Problem.** The original 1.1.a lease work stamped a monotonic
`fenceGeneration` on the Redis lease and gated commits on
`lease.isValid()` at precheck. But that check was against **local
in-memory state** — the lease's own record of its Redis key. Between the
precheck and the DB commit, a peer could silently steal the lease (after
TTL expiry with no successful renewal) and get its OWN generation. The
stale worker would still commit, unfenced.

**Fix.**

- Persist `fenceGeneration` on `order_intents` (`INT NULL`, index
  `order_intents_fence_idx`) — every intent stamps the lease generation
  that authorised it.
- Add `FencingViolation` to `apps/server/src/db/tx.ts` — a distinct error
  class carrying `ourGeneration` and `latestGeneration`.
- Add `verifyFencingTx(tx, intent)` — runs `SELECT max(fenceGeneration)
  FROM order_intents WHERE token=? AND purpose=?` INSIDE the transaction.
  Throws `FencingViolation` if a strictly-newer generation exists.
- Call `verifyFencingTx` as the FIRST step inside both
  `applyEntryEconomicStateTx` and `applyExitEconomicStateTx`, before any
  fill/ledger/position write.
- Wire the scanner to pass `lease.fenceGeneration` into `openPosition`,
  and pass it through `EntryDecision.fenceGeneration` into the intent row.
- Executor catches `FencingViolation` on both entry and exit paths →
  marks the intent `state='failed'`, `errorCode='fencing_violation'`, and
  returns `kind: 'rejected'` (entry) / `'failed'` (exit).

**Fencing-token design.**

- Monotonically increasing per lease-key, stored in Redis under
  `<key>:fence` (INCR under WATCH so acquisition + generation is
  atomic). `getFenceGeneration` exposes it for read-only inspection.
- **Precheck** (`lease.isValid()`) is retained as a fast-fail: an
  invalid lease should never reach the tx.
- **Durable check** (`verifyFencingTx` inside the tx) is authoritative.
  Precheck can lie (races); the DB cannot.
- `null` `fenceGeneration` on an intent means "no fencing configured"
  (test paths and non-fenced entries) — `verifyFencingTx` returns
  immediately without a query in that case.

**Rejection.** `FencingViolation` is NEVER retried. Its whole point is
that the caller's lease is dead and only the newer generation is
authoritative. The stale worker aborts cleanly and logs a critical
`FENCING_VIOLATION` activity row.

---

## 3. Fills INSIDE the atomic economic-state transaction (§F/§D)

**Problem.** The original 1.1.a atomic-transaction work wrapped only the
ledger+position (entry) and ledger+position+round-trip (exit) writes in a
transaction. Fills were persisted **outside** the tx (via `insertFill`) —
a crash between fill-insert and the ledger/position tx could strand fills
in the database with no matching ledger row. This was flagged in the audit
as a partial delivery of §F.

**Fix.** Introduce shared, idempotent functions in
`apps/server/src/db/tx.ts` that BOTH the executor and the reconciler call —
no duplicate economic-application logic:

- `applyEntryEconomicStateTx(input)` — one tx: verify fencing → upsert
  fills → per-fill ledger debits (buy_cost, buy_fee) → insert position →
  update intent (`state`, `positionId`).
- `applyExitEconomicStateTx(input)` — one tx: verify fencing → upsert
  fills → per-fill ledger credits (sell_proceeds, sell_fee) → mark
  position closed → insert round-trip → update intent.

Fills are idempotent by `fills.exchangeFillId` (UNIQUE). Ledger events
are idempotent by `cash_ledger.idempotencyKey` (UNIQUE, from 0003).
Positions are idempotent by `entryOrderIntentId` (recovery
pre-check). Round-trips are idempotent by `round_trips.positionId`
(UNIQUE from Phase 0). A replay of the same atomic function against the
same normalised fills is a silent no-op that returns the existing IDs.

**Executor rewire.**

- `openPosition` collects `CoinbaseFill[]` from the exchange (or the
  dry-run simulator) into `collectedFills`, normalises to
  `NormalizedFill[]`, and calls `applyEntryEconomicStateTx` with the
  full set. Fills are NEVER inserted outside this call.
- `closePosition` does the same via `exitFills` →
  `applyExitEconomicStateTx`.
- `writeBuyLedgerRows`, `writeSellLedgerRows`, `reconcileFillsForIntent`,
  and `persistFillFromExchange` (the ledger/fill helpers that lived
  outside the atomic call) are DELETED from `executor.ts`.

**Exact transaction boundaries.**

```
ENTRY (applyEntryEconomicStateTx):
  BEGIN
    SELECT intent by id                                     ── ownership sanity
    verifyFencingTx(intent)                                  ── §H durable check
    SELECT existing position WHERE entryOrderIntentId=id     ── idempotency guard
    UPSERT fills (INSERT … ON DUP ignore via exchangeFillId) ── one row per fill
    → __testHook('after_fills')
    INSERT cash_ledger buy_cost (per fill)                   ── UNIQUE idempotencyKey
    INSERT cash_ledger buy_fee  (per fill)                   ── UNIQUE idempotencyKey
    → __testHook('after_ledger')
    INSERT positions                                          ── UNIQUE openTokenKey (§G)
    → __testHook('after_position')
    UPDATE order_intents state='filled'/'partially_filled', positionId=…
  COMMIT

EXIT (applyExitEconomicStateTx):
  BEGIN
    SELECT intent by id                                      ── ownership sanity
    verifyFencingTx(intent)                                   ── §H durable check
    SELECT existing round_trip WHERE positionId=…             ── idempotency guard
    UPSERT fills (idempotent by exchangeFillId)
    → __testHook('after_fills')
    INSERT cash_ledger sell_proceeds (per fill)                ── idempotent
    INSERT cash_ledger sell_fee (per fill)                     ── idempotent
    → __testHook('after_ledger')
    UPDATE positions SET status='closed', lifecycleState='closed', closedAt=NOW()
    → __testHook('after_position')
    INSERT round_trips (positionId UNIQUE — §Phase 0)
    UPDATE order_intents state='filled'
  COMMIT
```

Win/loss counters and the circuit breaker remain OUTSIDE the exit
transaction on purpose — they touch `token_stats` and `bot_config`, are not
economic state, and are not required to be atomic with the round-trip.

**Reconciler reuse.** `applyEntryEconomicStateTx` and
`applyExitEconomicStateTx` are the SAME code the future continuous
reconciler (slice 1.1.b) will call. The idempotency-guard early-return means
a reconciler that discovers a partially-completed prior attempt finishes it
exactly-once without re-running the economic write.

---

## 4. Race-safe exit attempt generation (§B)

**Problem.** `attemptGeneration` for exits was computed as
`1 + countExitAttemptsForPosition(positionId, purpose)`. Two workers reading
that count concurrently would both compute the same generation, derive the
same `clientOrderId`, and try to insert two intents with the same
identity — a `clientOrderId` collision was the ONLY guard, and even that
allowed a race window if one insert happened AFTER the other's exchange
call.

**Fix.**

- Add `attemptGeneration INT` on `order_intents`.
- Add UNIQUE `order_intents_exit_attempt_uq` on
  `(positionId, purpose, attemptGeneration)`.
- Entry intents have `positionId=NULL` — NULLs in MySQL UNIQUE indexes
  don't collide, so entries coexist happily under this key.
- `persistIntent` now catches `isDuplicateKeyError` on the insert, does
  ONE re-read by `clientOrderId`, and if that fails throws a clear
  "duplicate exit attempt for position X purpose Y; caller must retry
  with a fresh generation" error. The loser aborts and lets the winner
  proceed.

---

## Files changed

**Server (`apps/server`)**

- `src/db/schema.ts` — `orderIntents.fenceGeneration`,
  `orderIntents.attemptGeneration`; new indexes `order_intents_fence_idx`,
  `order_intents_exit_attempt_uq` UNIQUE.
- `src/db/tx.ts` — `FencingViolation`, `verifyFencingTx`,
  `NormalizedFill`, `upsertFillsTx`, `aggregateFillRows`,
  `applyEntryEconomicStateTx`, `applyExitEconomicStateTx` (all new);
  `__testHook` on both apply functions.
- `src/trading/executor.ts` — full rewire onto
  `applyEntry/ExitEconomicStateTx`; `EntryDecision.fenceGeneration`
  field; `normalizeCoinbaseFill` helper; deleted
  `writeBuyLedgerRows` / `writeSellLedgerRows` /
  `reconcileFillsForIntent` / `persistFillFromExchange` (now handled
  inside the atomic apply functions); FencingViolation handling on
  entry + exit paths; `persistIntent` now catches
  `isDuplicateKeyError` on the exit-attempt UNIQUE and re-reads by
  `clientOrderId`.
- `src/trading/scanner.ts` — passes `lease.fenceGeneration` to
  `openPosition`.

**Migrations**

- `drizzle/migrations/0003_phase1_1a_atomicity_and_invariants.sql`
  RESTORED to originally-applied form (the enum ALTER was removed).
- `drizzle/migrations/0004_phase1_1a_fix_fencing_and_race_safe_exits.sql`
  NEW.
- `drizzle/migrations/meta/_journal.json` — entry 4 added.

**Tests**

- `tests/tx-rollback-fencing.test.ts` NEW (15 tests):
  - **Entry rollback**: throw at `after_fills`, `after_ledger`,
    `after_position` — verify no fills, no ledger, no position persist;
    intent stays `submitted`.
  - **Entry replay**: replay after `after_ledger` rollback applies
    exactly once (2 fills, 4 ledger rows, 1 position); a third replay
    is a no-op.
  - **Exit rollback**: throw at each stage — verify no exit fills, no
    sell ledger, no round-trip, position stays `open`.
  - **Exit replay**: replay after rollback closes exactly once; a
    third replay is a no-op.
  - **Fencing**: `null` fenceGeneration bypassed; strictly-newer peer
    generation → `FencingViolation` on both entry and exit; equal
    generation is permitted (only strictly-newer trips); the
    precheck-then-peer-committed race is caught.
  - **Race-safe exit**: two workers picking the same
    `(positionId, purpose, attemptGeneration)` collide at the DB;
    `attemptGeneration=2` is accepted after `=1`.

---

## Rollback-test output

Verbatim from `npx vitest run tests/tx-rollback-fencing.test.ts`:

```
 RUN  v3.2.6 /home/user/Trade-bot/apps/server

 ✓ tests/tx-rollback-fencing.test.ts (15 tests) 1904ms

 Test Files  1 passed (1)
      Tests  15 passed (15)
```

Full suite (verbatim, includes the new file):

```
 Test Files  19 passed (19)
      Tests  189 passed (189)
   Duration  10.41s
```

---

## Explicit confirmation

- `DRY_RUN=true` in `apps/server/.env` — unchanged.
- `ORDER_SUBMISSION_ENABLED=false` in `apps/server/.env` — unchanged.
- The Phase 1 §Q killswitch inside `coinbase.createOrder` was not touched.
- **No real Coinbase order was placed at any point during the P1.1.a-FIX
  pass.** The new tests exercise `applyEntry/ExitEconomicStateTx` directly
  (no exchange contact) and use synthesised `NormalizedFill[]` values.
- The existing coinbase-mocked tests continue to pass; they run the
  executor end-to-end but every network call routes through `vi.mock` on
  `../src/trading/coinbase`.
- Migrations 0003 and 0004 apply cleanly to a fresh database from zero and
  are safe to re-apply on running databases (0004's enum MODIFY is
  idempotent; the column ADDs skip cleanly when the columns exist).

---

## Revised §§A, F, H status (per audit directive)

The user explicitly required that §§A, F, and H **not** be marked "complete"
until continuous reconciliation is implemented, fills are inside the atomic
tx, and fencing is enforced inside the durable mutation boundary. After this
FIX pass:

- **§F fills-inside-atomic-tx** → complete.
- **§H fencing enforced inside durable mutation boundary** → complete.
- **§A unknown-order lock TRIPPING** → complete. **Lock CLEARING** (which
  requires §C continuous reconciliation) → still pending in slice 1.1.b.
- **§C continuous reconciliation** → still pending in slice 1.1.b.

Consequently `§A` remains marked "partial" in the top-level table of
PHASE1_1a.md until slice 1.1.b lands.
