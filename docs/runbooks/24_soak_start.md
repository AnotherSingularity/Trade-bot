# Runbook 24 — Soak start (NOT executed in Phase 3B)

## Trigger
Successful preflight + Phase 3C authorization to begin the seven-day soak.

## Immediate containment
- **DO NOT execute in Phase 3B.** Phase 3B forbids soak start.

## Diagnostic commands
```
mysql -u root -p horizon_trade -e "SELECT MAX(started_at) FROM soak_runs WHERE mode='soak'"
```
(expected: NULL in Phase 3B)

## Recovery procedure (executed only under Phase 3C)
1. Verify preflight run status is `ok`.
2. `npm run soak:start` — inserts a soak_runs row with
   `mode=soak`, `duration_target='7d'`.
3. The harness enforces the seven-real-calendar-day minimum before
   allowing a `phase1_2_pass` verdict.
4. Monitor Overview + Reports → Daily shadow for the duration.
5. Every daily report is written to `soak_daily_reports` and
   exported as a signed artifact.

## Verification
- Soak reaches the 7-day target with no critical incident.

## Escalation
- Any critical incident → runbook 25 (soak reset).

## Data preservation
- Soak_runs, soak_daily_reports and soak_incidents are IMMUTABLE.

## Safety implications
- Soak requires DRY_RUN=true, ORDER_SUBMISSION_ENABLED=false in
  Phase 3B posture. Live capital remains prohibited.
