# Runbook 22 — Preflight start (NOT executed in Phase 3B)

## Trigger
Phase 3C authorization to begin the two-hour operational preflight.

## Symptoms
Preflight authorization document signed and countersigned; risk
owner and compliance owner both approve.

## Immediate containment
- **DO NOT execute in Phase 3B.** This runbook is documentation only.

## Diagnostic commands
```
mysql -u root -p horizon_trade -e "SELECT COUNT(*) FROM soak_runs WHERE started_at IS NOT NULL"
```
(expected: 0 in Phase 3B)

## Recovery procedure (executed only under Phase 3C)
1. Ensure genuine Coinbase credentials are stored (runbook 09).
2. Set `HORIZON_PROVIDER_MODE=external` for the preflight session.
3. Set `ORDER_SUBMISSION_ENABLED=false` (still — preflight is
   read-only from the exchange).
4. Run `npm run preflight:start` — the harness records a
   preflight-run row in `soak_runs` with `mode=preflight`.
5. Monitor the Preflight screen for two hours.
6. Preflight completion status is written by the harness.

## Verification
- Preflight status is `ok`.
- CreateOrder counters remain zero.
- No incident of severity >= warn.

## Escalation
- Any warn-or-worse incident → runbook 23 (preflight failure).

## Data preservation
- Preflight-run rows are IMMUTABLE.

## Safety implications
- Preflight does NOT trade. `ORDER_SUBMISSION_ENABLED=false` remains.
