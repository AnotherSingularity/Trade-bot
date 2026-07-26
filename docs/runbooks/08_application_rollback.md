# Runbook 08 — Application rollback

## Trigger
A newly installed Horizon Trade release fails to boot, fails a
migration, or introduces a regression.

## Symptoms
- Desktop refuses to start with an environment-invariants violation.
- Server crashes on boot with a migration error.
- Recently pushed code contains a defect discovered after install.

## Immediate containment
- Close the failing Horizon Trade.
- Note the failing `buildCommit`.

## Diagnostic commands
```
powershell -c "Get-Content '%LOCALAPPDATA%\Horizon Trade\logs\main.log' -Tail 200"
```

## Recovery procedure
1. Restore the pre-upgrade database snapshot (runbook 07).
2. Uninstall the failing version (runbook 03, but do NOT purge data).
3. Reinstall the previous known-good release (runbook 01) with the
   installer for that commit.
4. Launch and verify.

## Verification
- Overview shows the rolled-back `desktopVersion` + `buildCommit`.
- CreateOrder counters remain zero.
- Reconciler cycle succeeds.

## Escalation
- No known-good installer available → escalate to release owner.

## Data preservation
- Restore ONLY from a snapshot taken BEFORE the failed upgrade.
- Do not partially apply a newer release's migrations on the older code.

## Safety implications
- Safe flags remain enforced regardless of version.
