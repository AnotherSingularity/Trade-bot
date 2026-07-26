# Runbook 19 — Accounting discrepancy

## Trigger
Reports → Daily shadow → "Unexplained cash difference" is non-zero.

## Symptoms
- Daily shadow report shows a non-zero unexplained difference.
- Or `phase3b_accounting.test.ts` fails on the local CI.

## Immediate containment
- Scanner is automatically paused when an accounting incident is
  raised (Phase 3D-FIX).

## Diagnostic commands
```
mysql -u root -p horizon_trade -e "SELECT id, round_trip_id, unexplained_amount FROM cost_attribution WHERE ABS(unexplained_amount) > 0"
```

## Recovery procedure
1. Enumerate every row with a non-zero unexplained amount.
2. For each round-trip, re-run `attributeRoundTrip(round_trip_id)`
   from the diagnostic CLI:
   ```
   npm run diag:attribute -- --round-trip <id>
   ```
3. The attribution engine is deterministic — re-running produces
   the same result. If the difference persists, escalate.

## Verification
- Every `cost_attribution.unexplained_amount = 0.00000000`.
- Daily shadow report shows zero unexplained.

## Escalation
- Difference persists after re-attribution → escalate to compliance
  and open a P0 incident. Do NOT clear the incident.

## Data preservation
- Never truncate `fills`, `ledger_entries`, or `round_trips`.

## Safety implications
- Discrepancy blocks scanner. Never enables live trading.
