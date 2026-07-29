# Live-canary plan — prepared, NOT authorized to execute

**Status.** This document is authored per Stage 14 of the roadmap directive. It **PREPARES** a bounded live-canary. It does **NOT** authorize execution. Enabling live capital requires a separate explicit user directive granting live-capital authorization AND flipping the `liveCapitalAuthorized` constant in `SoakSafetyFlagsSchema` (a schema change that itself requires review).

**Precondition.** Every one of these MUST already be true:

- Stage 13 emitted `shadow_certified_for_live_canary_review` for the release-candidate SHA.
- `SoakManifestSchema` + `ShadowCertificationSchema` both parse the certification body.
- Every safety flag remains at its `z.literal` value.
- Every Create Order counter remains 0/0/0.
- Provider-selection policy still refuses to promote a mock provider to `production`.
- No credential of any kind is in the repository, in CI, or in this session's environment.
- The `SOAK_ANCHOR.json` still references the release-candidate SHA and the manifest's `finalVerdict` is `passed`.

**Nothing in this document defines strategy, market-timing, or user-facing entitlement.** It defines the *canary discipline*.

## §1 Eligible-product criteria

A product is eligible for the canary if AND ONLY IF:

- It appears in the release candidate's `universe_snapshots` with `status='healthy'` AND is NOT in the quarantine set for the entire soak window.
- Its 30-day (UTC) mean spread (from `microstructure` observations) is ≤ **10 bps**.
- Its 30-day mean liquidity participation is ≤ **1%** of `topOfBookDepth` at the max-notional level.
- It passes the restricted-products filter (per `provider_incidents` with `classification='soak_invalidating'` absent for this product).
- Its `minimumNotional` is known and ≤ the canary's max-notional.
- Its `baseIncrement` and `quoteIncrement` are both known.
- Fee tier for the operator is known and non-null.

## §2 Bounded volume — hard caps

Every cap is a HARD ceiling. Any breach → immediate abort (§5 kill switches).

| Bound | Cap | Enforcement site |
|---|---|---|
| Max notional per single order | **US$50** | canary router pre-flight; refuses if exceeded |
| Max order count per rolling 60 min | **3** | canary router counter, resets on UTC hour |
| Max order count per canary window | **20** | canary router counter, resets on window end |
| Max simultaneous open positions | **1** | position ledger uniqueness (existing invariant) |
| Max total exposure | **US$50** | portfolio-risk observer computes; abort if breached |
| Max modeled loss (per-order + total) | **US$25** | pre-trade cost + risk observer; abort if breached |
| Fee threshold — refuse entry if forecast fee > | **8 bps** of notional | cost-forecast gate |
| Spread threshold — refuse entry if observed spread > | **12 bps** | microstructure gate |
| Liquidity threshold — refuse if participation > | **1%** of depth | risk observer gate |
| Provider health — refuse if last heartbeat older than | **10 s** | provider health monitor |
| Reconciliation — refuse if any unresolved action | **> 0** | reconciler gate |

## §3 Credential scope

- Coinbase credentials MUST be **read-only + trade-only** (permission-separated). A single credential with account-management scope is REJECTED.
- Credentials MUST NOT enter public CI. The canary runs on a durable environment whose secret-store the operator manages OUTSIDE this repository.
- Credentials MUST NOT be logged, printed to stdout/stderr, or written to evidence files. The redaction wrapper covers this at the report boundary; the canary runner adds an additional stderr sanitizer.
- Credentials MUST have a documented rotation policy (recommended: rotated on any operator personnel change; MAX 90 days between rotations).

## §4 Kill switches

The canary router refuses to submit an order unless EVERY switch below is in the `authorized` position at pre-flight AND at each subsequent order:

1. `DRY_RUN` MUST equal false for the canary process only — the schema-level `z.literal(true)` remains for every other process.
2. `ORDER_SUBMISSION_ENABLED` MUST equal true for the canary process only.
3. `liveCapitalAuthorized` MUST equal true for the canary process only.
4. `promotionEnabled` MUST remain false (observer promotions never during canary).
5. `kellyEnabled` MUST remain false.
6. Canary session start-time within a documented UTC window (default: 14:00-18:00 UTC on weekdays).
7. Canary router health-check green for ≥ 60 s continuous.
8. Kill flag `HORIZON_CANARY_ABORT` absent in env (any presence → hard abort).

## §5 Abort matrix

Any of the following triggers an IMMEDIATE abort. Abort means:
- Send `cancel_batch` for any live open working order for the canary product.
- Do NOT open any new order.
- Wait for reconciliation to resolve; if any open live position exists at abort, DO NOT auto-flatten — operator manual step only.
- Preserve every log + evidence file; do not truncate.

| Trigger | Abort |
|---|---|
| Any safety flag flips unexpectedly | yes |
| Any Create Order counter reaches its cap OR increments unexpectedly by > 1 in a second | yes |
| Provider disconnect > 30 s | yes |
| Data-quality incident classified `soak_invalidating` | yes |
| Reconciliation unresolved > 60 s | yes |
| Modeled loss exceeds max modeled loss cap | yes |
| Realized daily loss exceeds daily loss cap | yes |
| Any secret-scan hit in output | yes |
| Any container-leak or process-leak observed | yes |
| Kill flag `HORIZON_CANARY_ABORT` set | yes |
| Operator manual abort via signed command | yes |

## §6 Evidence template

Every canary session produces:

- `docs/live_canary/session-<runId>/pre-flight.json` — every gate + its satisfied-value at start.
- `docs/live_canary/session-<runId>/order-<n>.json` — for each order: seed decision-chain id, preview response, fill (if any), realized cost, updated counters. NEVER the raw credential, NEVER the raw session token.
- `docs/live_canary/session-<runId>/incident-<n>.json` — each abort / recovery.
- `docs/live_canary/session-<runId>/post-session.json` — verdict (`canary_completed_within_bounds`, `canary_aborted_within_policy`, `canary_aborted_by_operator`, `canary_bounds_breached`), realized totals, updated counters.
- `docs/live_canary/session-<runId>/observer.json` — champion vs observer disagreement across the session.

All evidence sanitized by the existing redact + sanitizeDetail wrappers before being written.

## §7 Post-canary review

Within 24 h of session end, the operator MUST:

1. Compare realized outcomes against forecast (cost, slippage, fees, spread, fills).
2. Assemble a `docs/live_canary/session-<runId>/post-review.md` with: what worked, what failed, what surprised, what did NOT reproduce from shadow evidence.
3. Update `docs/live_canary/canary_history.jsonl` (append-only) with a compact record.
4. Any deviation from forecast > 20 % on ANY metric → require an additional shadow soak before another canary session.
5. If the canary produced a `canary_bounds_breached` verdict → the release candidate is INVALIDATED and Stage 13 must be re-run.

## §8 What this document does NOT authorize

- ANY order submission
- ANY environment change flipping the safety flags
- ANY credential loading
- ANY provider switch to production
- ANY change to bounds — a change requires a new canary plan revision (versioned)
- Kelly sizing (remains disabled)
- Observer promotion (remains disabled)
- Household-fund use (never — the roadmap explicitly forbids)

## §9 Safety invariants that CANNOT be flipped by this plan

```
DRY_RUN = true             (SoakSafetyFlagsSchema.z.literal(true))
ORDER_SUBMISSION_ENABLED = false  (SoakSafetyFlagsSchema.z.literal(false))
liveCapitalAuthorized = false     (SoakSafetyFlagsSchema.z.literal(false))
promotionEnabled = false          (SoakSafetyFlagsSchema.z.literal(false))
kellyEnabled = false              (SoakSafetyFlagsSchema.z.literal(false))

Create Order counters:
  functionInvocations = 0  (SoakCreateOrderCountersSchema.z.literal(0))
  attemptCount         = 0
  networkCount         = 0
```

Any relaxation is a repository change, subject to review, subject to Stage 13 rerun.
