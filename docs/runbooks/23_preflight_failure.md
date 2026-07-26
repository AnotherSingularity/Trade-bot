# Runbook 23 — Preflight failure

## Trigger
Preflight harness reports a warn-or-worse incident, or exits with
`status=failed`.

## Symptoms
- Preflight screen shows failure banner.
- `soak_runs` row has `status=failed` or `unresolved_incidents > 0`.

## Immediate containment
- Do NOT re-run preflight.
- Do NOT authorize the soak (runbook 24).

## Diagnostic commands
```
mysql -u root -p horizon_trade -e "SELECT * FROM soak_incidents WHERE run_id=<preflight_run_id> ORDER BY reported_at ASC"
```

## Recovery procedure
1. Inspect every incident.
2. If the failure was operator-inflicted (wrong credentials, wrong
   env), close the run and open a new preflight session under
   correct configuration.
3. If the failure was code-side, open a Phase 3B-FIX correction
   ticket and re-run the full Phase 3B audit + Windows verification
   before scheduling another preflight.

## Verification
- New preflight session completes with `status=ok`.

## Escalation
- Repeated failures → escalate to risk owner and pause Phase 3C
  authorization.

## Data preservation
- Never delete a soak_runs row. Never re-use a run_id.

## Safety implications
- Failing preflight blocks soak start. Safe flags remain enforced.
