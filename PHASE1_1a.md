# Phase 1.1.a — Execution Integrity & Decimal-Safe Core

> **DRY_RUN remains `true`.** **ORDER_SUBMISSION_ENABLED remains `false`.**
> **No real Coinbase order was submitted at any point during this tranche
> (including the P1.1.a-FIX pass — see PHASE1_1a_FIX.md).**

Phase 1.1.a is the correction tranche the post-Slice-1 audit required BEFORE
Slice 2 (L2 book / regime engine / risk engine / mode rebuilds). Its purpose
is to close the execution-integrity gaps that would let dry-run-only theatre
become real capital risk once ORDER_SUBMISSION_ENABLED flipped.

> **Follow-up P1.1.a-FIX**: after the initial 1.1.a pass, an audit found that
> §§A, F, and H were only PARTIALLY delivered. See **PHASE1_1a_FIX.md** for the
> corrections and the revised status below.

## What shipped

| Audit item | Status | Where |
|---|---|---|
| §M decimal-safe execution core | done | `Money` end-to-end in coinbase increment rounding, fill aggregation, ledger, sizing, TP/SL, dry-run simulator, round-trip P&L |
| §F atomic entry / exit transactions | **partial → completed in FIX** | Original 1.1.a wrapped intent-state transitions in a tx but persisted fills OUTSIDE the tx (fill row → separate tx for ledger/position). FIX moved fills INSIDE the tx via `applyEntryEconomicStateTx` / `applyExitEconomicStateTx`. See PHASE1_1a_FIX.md §F/§D. |
| §G DB-enforced one-open-position-per-token | done | migration 0003 generated column `openTokenKey` + UNIQUE index |
| §H renewable lease + fencing token | **partial → completed in FIX** | Original 1.1.a added `withRenewingLease` + monotonic `fenceGeneration` on the LEASE, and gated commits on `lease.isValid()` at precheck. But the fencing token was **not persisted on the intent** and was **not verified inside the atomic mutation boundary** — a stale worker whose lease was silently taken could still commit. FIX persists `fenceGeneration` on `order_intents` and calls `verifyFencingTx` inside `applyEntry/ExitEconomicStateTx`. See PHASE1_1a_FIX.md §H. |
| §A global unknown-order lock | **partial → completed in FIX** | Original 1.1.a trips `reconciliationStatus='degraded'` on any unknown outcome and blocks new sells for a position with an unknown intent. But the lock is only cleared by **continuous reconciliation**, which is **still deferred to slice 1.1.b**. The lock-tripping half of §A is done; the lock-clearing half (which requires continuous reconciliation) remains open. See PHASE1_1a_FIX.md §A. |
| §B stable economic identities | done (extended in FIX) | `deriveClientOrderId` pure function of (decisionId) for entries and (positionId, purpose, attemptGeneration) for exits. FIX adds a **UNIQUE (positionId, purpose, attemptGeneration)** index so two workers cannot race to allocate the same generation. |
| §I correct preview schema | done | reads `est_average_filled_price`; NO midpoint fallback for marketable orders |
| §O rename EV gate → cost-adjusted payoff gate + third-outcome interface | done | `costAdjustedPayoffGate.ts` with `OutcomeProbabilities {pTp, pSl, pTimeout}` |

**Correction-tranche items still deferred to slice 1.1.b** (documented in
"Remaining work" and in PHASE1_1a_FIX.md):

- §A **lock CLEARING** — depends on §C continuous reconciliation
- §F/§D **reconciler-side economic recovery** — the FIX made
  `applyEntry/ExitEconomicStateTx` callable by both the executor AND the
  reconciler, but the continuous reconciler itself is still to be built
- §C **continuous reconciliation loop** — not delivered

## Files changed

**Server (`apps/server`)**
- `src/env.ts` — (unchanged) `ORDER_SUBMISSION_ENABLED` from Slice 1 stays in place
- `src/db/schema.ts` — `openTokenKey` generated column on positions; `idempotencyKey` + `fillId` on cash_ledger; `reconciliationStatus` enum extended with `degraded`
- `src/db/queries.ts` — Money-native `aggregateFills` (returns `FillAggregate` of Money), `recordCash`/`getCashBalance`/`ensureInitialFund` all Money-native and idempotent, new `getUnknownOrderIntents`, `hasUnknownIntentForPosition`, `countExitAttemptsForPosition`
- `src/db/tx.ts` **(new)** — `withTransaction` helper + Money-typed `insertCashLedgerEvent` (idempotency-key aware) + tx-scoped `insertPositionTx`/`markPositionClosedTx`/`insertRoundTripTx`/`updateOrderIntentTx` + `isDuplicateKeyError` (unwraps Drizzle's error wrapper)
- `src/trading/coinbase.ts` — `roundToIncrement`, `normalizeBuyQuoteSize`, `normalizeSellBaseSize` all Money-in, decimal-string-out; new `decimalDigitsForIncrement`; preview response gains `est_average_filled_price`
- `src/trading/preview.ts` — reads `est_average_filled_price` (correct field); midpoint fallback removed; `missing_est_avg_fill` reject reason
- `src/trading/executor.ts` — full Money migration through simulator + reconciliation + sizing + TP/SL + P&L; entry/exit blocks wrapped in `withTransaction`; ledger rows keyed by fill for idempotent replay; `tripGlobalUnknownLock` on any unknown outcome; `closePosition` refuses when an unknown intent exists; `deriveClientOrderId` is now a pure function of stable inputs (decisionId or positionId+purpose+attemptGeneration)
- `src/trading/scanner.ts` — passes `decisionId` (not scanSeed) to `openPosition`; uses `withRenewingLease` and rechecks `lease.isValid()` before each entry commit; degraded-lock log improved
- `src/jobs/lease.ts` — added `withRenewingLease`, `getFenceGeneration`, `Lease.isValid()`/`renew()` and Lua-backed CAS-scoped renewal
- `src/trading/costAdjustedPayoffGate.ts` **(new)** — honest naming, three-outcome interface `{pTp, pSl, pTimeout}`, `computeCostAdjustedPayoff` helper
- `src/trading/evGate.ts` — collapsed to a deprecated re-export shim (removed in 1.1.b)
- `docs/decimal-arithmetic-policy.md` **(new)** — the authoritative policy for the money boundary

**Migrations**
- `drizzle/migrations/0003_phase1_1a_atomicity_and_invariants.sql` — `openTokenKey` UNIQUE, `cash_ledger.idempotencyKey` UNIQUE + `fillId` FK. **Migration history integrity note:** the initial 1.1.a pass added the `reconciliationStatus` enum extension INSIDE 0003 after 0003 had already been applied to running databases. The FIX restored 0003 to its originally-applied form and moved the enum change to a new immutable migration 0004. See PHASE1_1a_FIX.md §migration-integrity.
- `drizzle/migrations/0004_phase1_1a_fix_fencing_and_race_safe_exits.sql` (FIX) — `bot_config.reconciliationStatus` enum + `degraded`; `order_intents.fenceGeneration` + `order_intents.attemptGeneration` columns + `order_intents_fence_idx`; UNIQUE `order_intents_exit_attempt_uq` on `(positionId, purpose, attemptGeneration)`.

**Shared (`packages/shared`)**
- `src/types.ts` — `BotStatus.reconciliationStatus` union extended with `'degraded'`

**Tests (`apps/server/tests`)**
- `p11a-safety.test.ts` **(new)** — 19 tranche-specific tests: weighted-fill exactness, 1000-cent invariant, DB-uniqueness rejection, ledger idempotency, fence-generation monotonicity, lease renewal survival, stolen-lease invalidation, unknown-outcome global lock, closePosition refusal under unknown-in-flight, stable-identity across timeout, deriveClientOrderId purity, missing_est_avg_fill enum, payoff-gate rename shims + third-outcome payoff math
- `preview.test.ts` — updated for `est_average_filled_price` + no-midpoint-fallback contract
- `executor.test.ts` — `deriveClientOrderId` tests rewritten against stable identities; `shouldExit` takes Money
- `executor-lifecycle.test.ts` — `decision()` factory now emits fresh `decisionId`; capture-and-derive pattern used where clientOrderIds are looked up
- `costModel-evGate.test.ts` — one test updated for `minCostAdjustedPayoff` rename
- `coinbase-parsing.test.ts` — increment-rounding tests use Money; adds `0.10000001` no-drift check + negative-size test + `decimalDigitsForIncrement` test
- `setup/coinbase-mock.ts` — normalize helpers migrated to Money

## Decimal-arithmetic policy (canonical)

See `apps/server/docs/decimal-arithmetic-policy.md`.

Summary:
- **Ingress** (exchange responses, DB reads): decimal string → `Money.fromString`
- **Internal computation**: `Money` only; no `Number`, no `.toFixed`, no `Math.floor`
- **DB writes**: `Money.toDecimalString()` (decimal-safe representation)
- **API boundary** (tRPC → mobile): convert to `number` ONCE at the boundary, never round-trip back into math
- **Presentation**: `.toDecimalString(2/4)` for display; log messages excluded from the migration by design
- **What stayed as `Number`**: mobile display formatting, dashboard summary at API boundary, indicator library (RSI/EMA/MACD/Bollinger — these are market observations, not money), scanner ticker prices used only for sizing multipliers

## Reconciliation state machine (updated)

```
                                ┌──────────────────────────────────────┐
                                │ bot_config.reconciliationStatus      │
                                ├──────────────────────────────────────┤
     boot ────► pending ───reconciler────► ok ────entries allowed────►
                             │
                             ├──failed────► entries BLOCKED (§G Phase 0)
                             │
     any unknown outcome ────► degraded ──► entries BLOCKED (§A P1.1.a)
                                 │
                                 └──(slice 1.1.b: continuous reconciler resolves)──► ok
```

Trip conditions:
- **pending → in_progress → ok**: startup reconciler (Phase 0 §G)
- **ok → degraded**: any executor path that observes `CoinbaseError.class === 'unknown'` calls `tripGlobalUnknownLock` (this tranche §A)
- **degraded → ok**: only cleared once all `order_intents.state='unknown'` rows are terminally resolved. That resolution is done by the continuous reconciler in slice 1.1.b (§C).

Behavioral consequences:
- `scanner.scanForEntries` gates on `reconciliationStatus === 'ok'` — so entries are blocked in both `pending` (never fully reconciled) and `degraded` (mid-flight unknown) states
- `closePosition` additionally refuses to CREATE a new exit intent for a position that has an existing `order_intents.state='unknown'` row (`hasUnknownIntentForPosition`). Existing risk monitoring still runs; only the sell attempt is blocked.

## Stable economic-intent identity (§B)

```
ENTRY: deriveClientOrderId({ purpose:'entry', token, mode, decisionId })
       — decisionId = accepted quantitative_decisions.id
       — retry after timeout REUSES the same clientOrderId
       — two different accepted signals produce two different ids

EXIT:  deriveClientOrderId({ purpose:<TP|SL|manual|emergency>, token, mode,
                             positionId, attemptGeneration })
       — attemptGeneration = 1 + count of prior exit intents for (position, purpose)
       — timeout retry of the SAME attempt reuses the same clientOrderId
         (persistIntent finds the existing row and returns it)
       — a NEW attempt AFTER the prior one is terminal bumps the generation
```

Wall-clock is never mixed into the derivation. `deriveClientOrderId` is a pure
function of its arguments; equal inputs → equal ids across any elapsed time
between calls. This is the property that makes retry-after-timeout safe.

## Coinbase behaviour that could not be verified against a live account

- Whether Coinbase's sandbox returns `est_average_filled_price` vs
  `average_filled_price` for market-IOC previews on the four micro-cap tokens
  in the universe. The parser reads `est_average_filled_price` first (per
  the public docs) with `average_filled_price` retained as a defensive
  fallback; a missing estimate REJECTS regardless.
- Actual `client_order_id` dedup behavior on submitted-then-timed-out orders.
  The state machine handles both "returns the original order id" and "returns
  ER_DUP" correctly; a live sandbox integration test remains a slice-1.1.b /
  1.1.c blocker.
- Attached-order / bracket eligibility per product. Polling-only protection
  remains the default; live-mode still requires
  `LIVE_SAFETY_ACK_POLLING_FALLBACK=true` from Phase 0 (unchanged).

## Remaining work before Slice 2

Deferred from Phase 1.1 into 1.1.b / 1.1.c / 1.1.d:

- **§C** — continuous reconciliation loop that runs on schedule + after any
  unknown, plus paginated list-orders / list-fills so Coinbase results beyond
  page 1 are found (slice 1.1.b)
- **§D** — full idempotent economic-state recovery function that applies
  reconciled fills to positions, ledger, round-trips exactly once (slice 1.1.b)
- **§E** — richer partial-fill classification using Coinbase's order status +
  completion percentage + remaining quantity, replacing today's cushion heuristic
  (slice 1.1.b)
- **§J** — bind approved preview `preview_id` through to submitted order;
  re-preview + re-approve when the order config drifts (slice 1.1.b)
- **§K** — parse `advanced_trade_only_volume`, `advanced_trade_only_fees`,
  `coinbase_pro_volume`, `volume_breakdown` fields on the fee-tier response
  (slice 1.1.c)
- **§L** — exhaustive pagination fixtures (slice 1.1.b)
- **§N** — cash-flow-based cost model + rename "quantile" buffer accurately
  until we have a real distribution (slice 1.1.c)
- **§P** — capture EVERY evaluated token (including volume-filter failures,
  no-setup tokens, exclusion-window skips) so the training population isn't
  survivor-biased (slice 1.1.d)
- **§Q** — full observation-through-outcome lineage with join keys (slice 1.1.d)
- **§R** — per-product protection eligibility matrix (slice 1.1.b or 1.1.c
  depending on whether Coinbase sandbox access is available)
- **§S** — Drizzle migration snapshot integrity so `drizzle-kit generate`
  produces clean diffs from the current schema (slice 1.1.d)
- Ongoing decimal-safe rollout for the small residual `Number` usage in
  `reconciler.ts` account balance + Coinbase `getCashBalance` boundary
  conversion (slice 1.1.b, tied to §D)

## Test results (verbatim)

Initial 1.1.a pass:
```
Test Files  18 passed (18)
     Tests  174 passed (174)
Tasks:      9 successful, 9 total   (turbo run typecheck test build)
```

After the P1.1.a-FIX tranche (see PHASE1_1a_FIX.md for the exact scope):
```
Test Files  19 passed (19)
     Tests  189 passed (189)
```

The new file `tests/tx-rollback-fencing.test.ts` adds 15 tests covering the
atomic-boundary rollback (three throw stages × entry + exit + replay), the
durable fencing check (equal / older / precheck-then-peer-committed / exit
path), and the race-safe exit UNIQUE constraint.

## Explicit confirmation

- `DRY_RUN=true` in `apps/server/.env` — unchanged
- `ORDER_SUBMISSION_ENABLED=false` in `apps/server/.env` — unchanged
- The Phase 1 §Q killswitch inside `coinbase.createOrder` remains active; the
  new atomic-transaction path (both the original and the FIX) did not touch
  that guard.
- No real Coinbase order was placed at any point during Phase 1.1.a or the
  P1.1.a-FIX pass.
- All Coinbase interactions in the test suite are mocked (either via
  `vi.mock` on the module or the killswitch test's `fetch` spy); no test
  hits `api.coinbase.com`.
- Migrations `0003` and `0004` applied cleanly to a fresh database
  (`horizon_migration_test`) from zero and to the existing
  `horizon_trade` / `horizon_trade_test` databases.
