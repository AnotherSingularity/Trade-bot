# Phase 0 — Live-Capital Safety Rebuild

> **DRY_RUN remains `true`. No real Coinbase order has been placed. No real
> capital was at risk during this rebuild.**

This document summarises the Phase 0 rebuild required by the audit. It is the
gate between "software prototype" and "capital-safe execution engine". Live
trading (`DRY_RUN=false`) is still forbidden until the additional non-negotiable
items listed at the bottom are satisfied.

## Architecture changes

1. **Data model rebuilt around order identity.**
   New tables: `order_intents`, `fills`, `round_trips`, `cash_ledger`. The
   `positions` table now stores actual-fill fields
   (`avgEntryPrice`, `filledQuantity`, `entryFees`, `entryQuoteSpent`),
   protective-order links, protection mode, optimistic-locking `version`,
   and Claude model + confidence provenance. See
   `apps/server/drizzle/migrations/0001_phase0_execution_safety.sql`.

2. **Coinbase client corrected and re-typed.**
   `success_response.order_id` is now the canonical source of the order id
   (the previous top-level read returned `undefined`). Every request has a
   hard timeout via `AbortSignal`. Failures are classified —
   `definitely_rejected` / `definitely_not_submitted` / `submitted` /
   `unknown` / `retryable_transport` / `non_retryable_validation` — and the
   executor treats each class distinctly.

3. **Idempotent order state machine.**
   `deriveClientOrderId(purpose, token, mode, positionId?, seed)` yields a
   deterministic UUID. Intents are persisted BEFORE any HTTP submit;
   `clientOrderId` + `exchangeOrderId` are both `UNIQUE`. `unknown` outcomes
   are NEVER retried with a fresh id — the reconciler resolves them by
   looking up `clientOrderId` on Coinbase.

4. **Positions from actual fills, with fees.**
   `openPosition` now calls `reconcileFillsForIntent`, which reads fills
   (real via `listFillsForOrder`, or synthesized by the realistic dry-run
   simulator) and derives `avgEntryPrice` from the weighted average price
   and `filledQuantity` from the fill total. Zero fills produce
   `canceled` intents and no position. Partial fills are summed. Order
   sizes are rounded to the product's `base_increment`/`quote_increment` and
   validated against `min/max` size + `status` before submission.

5. **Bot-control semantics corrected.**
   `manageOpenRisk()` runs on every cycle regardless of `isRunning`,
   `isPaused`, `circuitBreakerUntil`, or `marketWindow`. `scanForEntries()`
   is separately gated and RELOADS config after risk management, so a
   circuit breaker tripped by an exit in the same cycle blocks entries in
   that same cycle. `emergencyKill` is a new operator-triggered flatten
   action.

6. **Startup reconciliation gate.**
   New `reconcileOnStartup()` queries every non-terminal intent, resolves
   it against Coinbase (or dry-run fill history), upserts missing fills,
   compares DB open positions against Coinbase spot holdings, and flags
   unexplained exposure. `bot_config.reconciliationStatus` gates entries —
   `.start()` refuses to enable entries until this reads `'ok'`.

7. **Redis leader lease.**
   `scanForEntries` runs under a distributed `SETNX`/CAS lease (with TTL).
   Only one replica submits entries at a time. Manual scans are also
   serialized.

8. **Dry-run accounting rebuilt.**
   New `cash_ledger` persists every buy/sell/fee/spread as a signed delta.
   Dry-run cash is seeded once (`initial_fund` = $10 000), debited by
   `entryQuoteSpent + entryFees`, and credited by `exitProceeds - exitFees`.
   `getRoundTripSummary()` counts `round_trips` (one row per completed
   position), so a completed trade is `1`, not `2`. `win` requires
   `realizedNetPnl > 0` after fees; a zero result is a `flat`.

9. **Claude parser hardened.**
   Strict `z.boolean()` schema — the string `"false"` is REJECTED (the
   previous `Boolean("false")` coerced to `true`). Confidence must be a
   finite `[0..1]` number; reason a bounded non-empty string. Any timeout,
   rate-limit, schema violation, or malformed response fails CLOSED
   (`shouldEnter=false, confidence=0`). Every decision records the exact
   `model` id and `strategyVersion`.

10. **Mobile safety UI.**
    New `SafetyBanner` mounted on all four authenticated screens.
    Dry-run vs. LIVE presentation is visually distinct (LIVE = red).
    Reconciliation status and protection mode are shown. All
    state-changing controls (start, stop, pause, kill, live activation)
    require confirmation. Auto-logout on any 401/403 from the tRPC client.

11. **Security hardening.**
    CORS collapsed to an explicit `CORS_ORIGINS` allowlist (dev-only `*`
    fallback). Login is rate-limited per IP with a 15-minute hard lock
    after 3× the limit. Live-mode boot rejects default/weak `JWT_SECRET`
    and requires `LIVE_SAFETY_ACK_POLLING_FALLBACK=true` — an explicit
    operator acknowledgement that positions rely on application-polling
    protection.

## Modified / added files

**Server (`apps/server`)**
- `src/env.ts` — live-mode secret validation, CORS/rate-limit env, test override
- `src/db/schema.ts` — new tables + rebuilt `positions`
- `src/db/queries.ts` — serializers, order-intent + fill + round-trip + ledger APIs, Bayesian shrinkage
- `src/trading/coinbase.ts` — full rewrite: nested `success_response`, timeouts, failure classification, `previewOrder`, `getOrder`, `findOrderByClientId`, `listFillsForOrder`, `cancelOrder`, product validation + increment normalization
- `src/trading/executor.ts` — state machine, dry-run simulator, fills-driven positions, round-trip P&L, circuit breaker, ledger integration, deterministic `deriveClientOrderId`, optimistic-locking exits
- `src/trading/scanner.ts` — split into `manageOpenRisk` (always) + `scanForEntries` (gated); leader lease; whole-universe ranking with shrunk win rate
- `src/trading/reconciler.ts` — new: startup reconciliation
- `src/trading/claude.ts` — strict `zod` schema, fail-closed, timeout, model + strategy provenance
- `src/jobs/lease.ts` — new: Redis leader lease with CAS release
- `src/routers/trading.ts` — reconciliation gate on start, ledger cash, `closePosition` returns `closed|failed|pending`, new `emergencyKill`
- `src/routers/history.ts` — reads from `round_trips`
- `src/lib/services.ts` — extended `BotStatusDTO` (dryRun, reconciliationStatus, protectionMode), login rate limiter
- `src/index.ts` — CORS allowlist, rate-limited login, reconciliation-under-lease boot
- Migration: `drizzle/migrations/0001_phase0_execution_safety.sql`
- Docs: `docs/order-lifecycle.md`
- Tests: `tests/executor-lifecycle.test.ts` (new, 15 tests), `tests/reconciler.test.ts` (new, 3), `tests/lease.test.ts` (new, 3), `tests/rate-limit.test.ts` (new, 3), `tests/coinbase-parsing.test.ts` (new, 13), `tests/claude.test.ts` (rewritten, 10), `tests/executor.test.ts` (updated for new schema, 8), `tests/setup/coinbase-mock.ts`, `tests/setup/db.ts`, `vitest.config.ts` (test-DB URL + sequential fork)

**Shared (`packages/shared`)**
- `src/types.ts` — `BotStatus` extended with `dryRun`, `reconciliationStatus`, `protectionMode`, `strategyVersion`

**Mobile (`apps/mobile`)**
- `components/trading/SafetyBanner.tsx` — new (mounted on all 4 tabs)
- `components/trading/BotControlBar.tsx` — confirmations, KILL button
- `components/ui/ConfirmButton.tsx` — new
- `hooks/useBotStatus.ts` — `emergencyKill`, `isLive`
- `lib/trpc.ts` — auto-logout on 401/403
- `app/(tabs)/_layout.tsx` — subscribes to unauthorized
- `app/(tabs)/{index,tokens,history,settings}.tsx` — SafetyBanner mounted

## Test results

- **83 tests / 10 files / all green.** `npm run test` at repo root.
- Coverage of the Phase-0 §M list (23 items) is folded into the suites above;
  key cases:
  - Nested `success_response.order_id` fixture — `coinbase-parsing.test.ts`
  - Rejected order → `definitely_rejected` — `executor-lifecycle.test.ts`
  - Partial fills → summed to one position — `executor-lifecycle.test.ts`
  - Zero fill → intent `canceled`, no position — `executor-lifecycle.test.ts`
  - Unknown (timeout) → intent `unknown`, no position, no retry — `executor-lifecycle.test.ts`
  - Mid-submit crash → intent still persisted (recoverable) — `executor-lifecycle.test.ts`
  - Startup reconciliation of ack / orphan / no-op — `reconciler.test.ts`
  - Manual close rejection → `closed=false` / `status=failed` — `executor-lifecycle.test.ts`
  - Manual close unknown → `status=pending` — `executor-lifecycle.test.ts`
  - Failed exit does NOT close the position — `executor-lifecycle.test.ts`
  - Product increment rounding + min-size rejection — `coinbase-parsing.test.ts`
  - Redis lease conflict → second scan skipped — `lease.test.ts`
  - Dry-run cash decreases on buy / increases on sell — `executor-lifecycle.test.ts`
  - Entry + exit fees applied in net P&L (zero-move produces a loss) — `executor-lifecycle.test.ts`
  - Third consecutive loss trips the circuit breaker — `executor-lifecycle.test.ts`
  - **String `"false"` for shouldEnter is REJECTED** — `claude.test.ts`
  - **One round-trip = one completed trade** — `executor-lifecycle.test.ts`
  - Login rate limit + hard lock — `rate-limit.test.ts`

## Coinbase behavior that could not be verified against the live exchange

- The nested `success_response` shape is documented; my parser handles both
  nested and top-level as a defensive fallback.
- Attached / bracket TP+SL orders on spot pairs: documentation is not
  consistent across products, and I could not test them against a live
  account here. Phase 0 therefore requires `LIVE_SAFETY_ACK_POLLING_FALLBACK=true`
  to boot with `DRY_RUN=false`, defaults `positions.protectionMode` to
  `polling_fallback`, and surfaces that fact on every authenticated screen.
- Historical batch-orders endpoint filter parameters (`order_status` list)
  and exact pagination semantics need to be validated against the sandbox
  before enabling live entries.
- `client_order_id` deduplication behavior on Coinbase (whether a repeated
  submission returns the original order id or a distinct error) needs
  live sandbox confirmation. The state machine treats either case
  correctly, but a specific integration test against the sandbox is a
  remaining blocker below.

## Remaining blockers before live trading (`DRY_RUN=false`)

These are the items still required by the audit's non-negotiable gate. Phase 0
established the DB, execution core, tests, and safety UI — but the following
are external / integration items that cannot be truly verified from here:

1. **Live sandbox integration test.** Run the executor's full state machine
   against Coinbase's paper/sandbox environment (if available for CDP) — or
   against a single, tightly-capped real product — to confirm: nested
   `success_response.order_id` parsing works against the real API; timeouts
   classify to `unknown`; `client_order_id` deduplication behaves as
   assumed; `listFillsForOrder` returns fills the way the reconciler
   expects; product `base_increment` handling is correct for the four
   micro-cap tokens in the universe.

2. **Exchange-native protective orders.** Decide the live protection model.
   If exchange brackets are supported for the intended products, wire them
   in and remove the polling-fallback acknowledgement requirement. If not,
   document the operational SLA on the polling fallback and ensure the
   Railway deployment guarantees single-replica plus a monitored heartbeat.

3. **Strategy specification.** The three modes are still the pre-audit
   heuristics. The Reversion payoff arithmetic (1.5% early exit vs. 3% TP
   after fees), the missing volume-multiplier in Breakout, and the "Macro
   Floor" ≠ trend-continuation gap are strategy problems that the code
   faithfully reflects but do not represent tested edge. Do NOT flip
   `DRY_RUN=false` until each mode has a versioned executable spec, a
   backtest against unseen data with realistic costs, and a shadow run
   compared to a quantitative-only baseline (Claude removed) so alpha
   attribution is honest.

4. **Coinbase API key permissions + IP allowlist.** Restrict the CDP key to
   view + trade (never transfer/withdraw), portfolio-scope the key, and
   allowlist the Railway deployment egress IP where operationally
   possible.

5. **Small-canary bring-up plan.** First live deployment should size to a
   fraction of the intended risk (e.g. $50 per position, `WIN_RATE_REDUCED_PCT`
   allocation cap globally) with a hard kill switch and daily manual
   review.

## Explicit confirmation

- `DRY_RUN=true` in `apps/server/.env` and in
  `apps/mobile/eas.json` production profile URL still points at a
  placeholder — no live client build has been produced.
- No real Coinbase order was placed during this rebuild.
- The full test suite runs against a local MariaDB + Redis with mocked
  Coinbase; no network I/O reaches `api.coinbase.com`.
