# Runbook 11 — Credential deletion

## Trigger
Operator leaves the role or credential is rotated.

## Immediate containment
None.

## Diagnostic commands
```
control /name Microsoft.CredentialManager
```

## Recovery procedure
1. Open Horizon Trade → System → "Manage credentials" → "Delete".
2. Confirm deletion.
3. The desktop removes the entry via `keytar.deletePassword` under
   the `horizon-trade-desktop` service.
4. Configuration screen updates the status to `absent`.

## Verification
- Configuration shows the deleted key as `absent`.
- Windows Credential Manager no longer lists the entry.

## Escalation
- Deletion fails → escalate to workstation admin.

## Data preservation
- Deletion is irreversible. Re-adding requires runbook 09.

## Safety implications
- After deletion, the desktop remains fully safe. No live trade is
  possible without credentials AND `ORDER_SUBMISSION_ENABLED=true`.
