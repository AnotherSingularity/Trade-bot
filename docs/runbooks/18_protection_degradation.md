# Runbook 18 — Protection degradation

## Trigger
Protection policy evaluator returns `degraded` (§Phase 3C capability gate).

## Symptoms
- Protection screen shows "Degraded" state.
- New candidate decisions are rejected with reason `protection_unavailable`.

## Immediate containment
- Scanner stops opening new positions automatically (Phase 3C
  degradation policy).

## Diagnostic commands
```
mysql -u root -p horizon_trade -e "SELECT * FROM protection_events ORDER BY event_at DESC LIMIT 20"
```

## Recovery procedure
1. Read `protection_events` and identify the capability that failed
   (e.g. bracket-leg unsupported for a specific product).
2. If the failure is transient, wait one reconciliation cycle and
   re-check.
3. If the failure is persistent, update the protection policy to
   fall back to an allowed configuration; the policy is versioned
   so no historical record is mutated.

## Verification
- Protection screen returns to Healthy.
- New candidate decisions gain `protection_ready` status.

## Escalation
- Policy update is required → escalate to strategy owner; treat
  as a policy change, not a runtime hotfix.

## Data preservation
- Never modify a `protection_policies` row. Add a new version.

## Safety implications
- Degradation blocks entries but never enables live trading.
