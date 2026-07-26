# Runbook 03 — Desktop uninstall + data preservation

## Trigger
Operator wishes to remove Horizon Trade from a Windows machine.

## Symptoms
- Uninstall requested from Start Menu → "Horizon Trade" → Uninstall.

## Immediate containment
Take a database snapshot (runbook 07) before uninstalling, in case
the operator wants to restore later.

## Diagnostic commands
```
powershell -c "Get-ChildItem '%APPDATA%\Horizon Trade' -Recurse | Measure-Object -Property Length -Sum"
```

## Recovery procedure
1. Close Horizon Trade if open.
2. Windows Settings → Apps → "Horizon Trade" → Uninstall.
3. The uninstaller removes program files ONLY; it does NOT remove
   `%APPDATA%\Horizon Trade` (logs, DB, credentials).
4. To fully purge, the operator must manually delete
   `%APPDATA%\Horizon Trade` AND remove keytar entries via the
   Windows Credential Manager (`control /name Microsoft.CredentialManager`).

## Verification
- `where.exe "Horizon Trade"` returns nothing.
- Uninstaller log at `%LOCALAPPDATA%\Horizon Trade\logs\uninstall.log`
  reports success.

## Escalation
- Uninstaller reports a partial failure → escalate to release owner
  with the uninstall log.

## Data preservation
- The default uninstall PRESERVES all operator data (logs, database,
  keytar credentials).
- Full purge is a manual, documented action — never automatic.

## Safety implications
- Removing the desktop does not affect any live capital because no
  live capital was ever authorized.
