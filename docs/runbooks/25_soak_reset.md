# Runbook 25 — Soak reset

## Trigger
Critical incident during the soak requires the soak to be reset.

## Symptoms
- `soak_incidents` has severity `critical`.
- Compliance owner requests a reset.

## Immediate containment
- Stop the soak harness via System → "Stop soak".

## Diagnostic commands
```
mysql -u root -p horizon_trade -e "SELECT run_id, severity, reported_at, description FROM soak_incidents WHERE severity='critical'"
```

## Recovery procedure
1. Mark the current soak_run as `status=reset` in-place via the
   diagnostic CLI:
   ```
   npm run soak:reset -- --run-id <id> --reason "<free text>"
   ```
2. The row is NOT deleted; the `reset_reason` column is populated
   and the run cannot be counted toward Phase 3C acceptance.
3. If the root cause is code-side, open a Phase 3B-FIX correction.
4. Once the root cause is fixed, run runbook 22 (preflight start)
   again — the seven-day soak clock restarts from zero.

## Verification
- New preflight session completes with `status=ok`.
- New soak run begins with a fresh timeline.

## Escalation
- Multiple resets → escalate to risk owner; suspend all Phase 3C
  authorization until strategy owner reviews.

## Data preservation
- Never delete the reset run row.

## Safety implications
- Soak reset does not affect safe flags.
