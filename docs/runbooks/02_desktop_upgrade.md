# Runbook 02 — Desktop upgrade

## Trigger
A newer signed Horizon Trade release is available and the operator
wishes to upgrade the current install.

## Symptoms
- Overview screen shows an older `desktopVersion` than the release.

## Immediate containment
None required.

## Diagnostic commands
```
powershell -c "(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\horizon-trade' -EA SilentlyContinue).DisplayVersion"
```

## Recovery procedure
1. Take a database snapshot via runbook 07.
2. Note the current `desktopVersion` and `buildCommit` from Overview.
3. Close the Horizon Trade window (graceful shutdown; supervisor stops services).
4. Run the new `Horizon Trade Setup.exe` — installer detects the
   existing install and offers an in-place upgrade.
5. Accept license; installer preserves user data (logs, credentials, DB).
6. Launch the upgraded application.
7. On boot, the desktop applies any new migration (should be no-op
   in Phase 3B — migration count is 0020).

## Verification
- Overview shows the new `desktopVersion` + `buildCommit`.
- Overview `schemaVersion` matches the migration count in the release.
- CreateOrder counters remain zero.
- Every previous open incident is still present in the Incidents screen.

## Escalation
- Migration fails on upgrade → run runbook 08 (application rollback).

## Data preservation
- Do NOT uncheck "preserve user data" during the upgrade wizard.
- Do NOT delete `%APPDATA%\Horizon Trade`.

## Safety implications
- Upgrade never re-enables `ORDER_SUBMISSION_ENABLED`.
- Any new release that would change safe-flag policy must be
  documented in the release notes; the desktop refuses to start if
  the invariants are violated (see runbook 15).
