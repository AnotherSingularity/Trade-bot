# Live-canary evidence template

For each canary session, populate the fields below. Blank fields invalidate the session record.

## Session identity

- Session runId (unique):
- Operator (initials, timestamp):
- Release-candidate SHA (40-hex):
- Anchor SoakId (from SOAK_ANCHOR.json):
- Certification body sha256 (from `docs/audit/shadow_certification_<sha>.json`):
- Session start UTC:
- Session end UTC:
- Session verdict: [ ] `canary_completed_within_bounds`  [ ] `canary_aborted_within_policy`  [ ] `canary_aborted_by_operator`  [ ] `canary_bounds_breached`

## Pre-flight gate values (§4 of plan.md)

For each gate, record `expected` and `observed`:

- `DRY_RUN` (expected `false` for canary process only): observed=
- `ORDER_SUBMISSION_ENABLED` (expected `true` for canary process only): observed=
- `liveCapitalAuthorized` (expected `true` for canary process only): observed=
- `promotionEnabled` (expected `false`): observed=
- `kellyEnabled` (expected `false`): observed=
- UTC hour within window [14:00, 18:00): observed=
- Router health-check green for ≥ 60 s: observed=
- `HORIZON_CANARY_ABORT` present in env: observed=

## Bounds (§2 of plan.md)

- Max notional per order: US$50 (config); observed peak notional=
- Orders per 60 min cap: 3; observed peak per 60 min=
- Orders per window cap: 20; observed total orders=
- Max simultaneous open positions: 1; observed peak=
- Max total exposure: US$50; observed peak=
- Max modeled loss (per-order): US$25; observed peak=
- Max modeled loss (total): US$25; observed cumulative=
- Fee threshold (8 bps forecast): observed peak forecast bps=
- Spread threshold (12 bps observed): observed peak spread bps=
- Liquidity participation threshold (1%): observed peak participation=

## Per-order records

Attach `session-<runId>/order-<n>.json` for each order. Each record MUST contain:

- Decision-chain id (seed)
- Preview response (bytes only — no raw credential)
- Fill(s) (partial or full)
- Realized cost breakdown (fees + spread + slippage)
- Counter snapshot before + after
- Provider snapshot (WS heartbeat age at submit)
- Reconciliation state at submit

## Incident records

For each abort trigger fired (per abort_matrix.md), attach `session-<runId>/incident-<n>.json`:

- Trigger id (T01..T30)
- Trigger condition observed (verbatim)
- Detection surface
- Action taken
- Post-abort steps

## Counter snapshot at session end

- `functionInvocations` after session=
- `attemptCount` after session=
- `networkCount` after session=
- Sum of `functionInvocations` across canary session (should equal the number of orders submitted):
- Counter divergence (any `attempt - function > 1` OR `network - attempt > 1`)? [ ] no  [ ] yes → INVALIDATE

## Attachments

- `session-<runId>/pre-flight.json`
- `session-<runId>/order-*.json`
- `session-<runId>/incident-*.json`
- `session-<runId>/observer.json`
- `session-<runId>/post-session.json`

## Attachments NOT allowed

- No Coinbase credential, no session cookie, no bearer, no session token, no database dump, no environment variable dump, no raw log with any of the above.

## Post-review commitment

- `docs/live_canary/session-<runId>/post-review.md` will be filled within 24 h.
- If any deviation from forecast > 20 % on any metric → an additional shadow soak MUST be run before another canary session.
- If the verdict is `canary_bounds_breached` → the release candidate is INVALIDATED; Stage 13 rerun REQUIRED.

## Operator signature

Reviewer initials + UTC timestamp: ______________________
