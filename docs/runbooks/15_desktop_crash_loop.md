# Runbook 15 — Desktop crash loop

## Trigger
Horizon Trade Desktop repeatedly crashes on launch OR enters
`recovery_required` for `desktop_shell`.

## Symptoms
- Windows event viewer shows repeated `Horizon Trade.exe` crashes.
- Or the desktop launches but immediately displays the environment
  invariants violation dialog.

## Immediate containment
- Do NOT run the installer again.

## Diagnostic commands
```
powershell -c "Get-Content '%LOCALAPPDATA%\Horizon Trade\logs\main.log' -Tail 200"
```

## Recovery procedure
1. Inspect `main.log`. If the invariant violation reads
   "DRY_RUN must be true" or "ORDER_SUBMISSION_ENABLED must be false"
   the operator's env vars are unsafe — remove the offending
   variable and restart.
2. If a service supervisor entered `recovery_required`, open a
   controlled shell:
   ```
   set HORIZON_DIAGNOSTIC_MODE=true
   "%LOCALAPPDATA%\Programs\Horizon Trade\Horizon Trade.exe"
   ```
   The diagnostic mode disables the auto-start of services so the
   operator can inspect state before recovery.
3. If diagnostic mode also crashes, run runbook 08 (rollback).

## Verification
- Overview loads.
- Every service transitions to `healthy` at least once.
- CreateOrder counters remain zero.

## Escalation
- Crash persists after rollback → escalate with `main.log` + crash dump.

## Data preservation
- Never delete `%APPDATA%\Horizon Trade` while diagnosing a crash.

## Safety implications
- The crash-loop detector is DESIGNED to escalate to
  `recovery_required` rather than restart uncontrolled. Do not
  disable it.
