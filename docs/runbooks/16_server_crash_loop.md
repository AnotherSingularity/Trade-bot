# Runbook 16 — Server crash loop

## Trigger
The `server` service enters a crash loop (supervisor `failed` +
`crashLoopDetected: true` → `recovery_required`).

## Symptoms
- Overview shows `server: recovery_required, crashLoopDetected: YES`.
- API-error banners on every data-dependent screen.

## Immediate containment
- Do NOT click "Restart server" repeatedly; the supervisor is
  intentionally refusing.

## Diagnostic commands
```
Get-Content '%LOCALAPPDATA%\Horizon Trade\logs\server.log' -Tail 300
```

## Recovery procedure
1. Read `server.log` and identify the cause. Common causes:
   - MariaDB unreachable → run runbook 13.
   - Redis unreachable → run runbook 14.
   - Schema fingerprint mismatch → run runbook 06.
   - Corrupt migration state → run runbook 07 (restore snapshot).
2. Fix the root cause.
3. On the System screen, click "Reset for recovery" for the server
   service.
4. Click "Start server".
5. The supervisor re-runs the state machine from `not_configured`.

## Verification
- Overview shows `server: healthy`.
- Reconciler runs its first cycle successfully.
- CreateOrder counters remain zero.

## Escalation
- Root cause unidentified → escalate to release owner with logs.

## Data preservation
- Do not truncate any table to "fix" a server crash. Restore from
  snapshot instead.

## Safety implications
- Server crash does not enable live trading.
