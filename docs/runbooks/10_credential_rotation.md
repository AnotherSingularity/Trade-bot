# Runbook 10 — Credential rotation

## Trigger
Scheduled rotation (90 days) or suspected credential compromise.

## Symptoms
- Configuration shows `coinbase.apiKey: expired` OR operator has
  been issued new credentials.

## Immediate containment
- If compromise is suspected, immediately revoke the credential on
  the Coinbase console BEFORE running this runbook.

## Diagnostic commands
None — the desktop cannot inspect the credential itself.

## Recovery procedure
1. Revoke the old credential on the exchange console.
2. Issue a new credential (no withdrawal/transfer scope).
3. Delete the old entry (runbook 11).
4. Create the new entry (runbook 09).

## Verification
- Configuration shows both keys as `present_encrypted`.
- Overview and System screens still show `providerMode: fixture` (Phase 3B).

## Escalation
- Compromise confirmed → run runbook 27 (live-canary emergency shutdown).

## Data preservation
- Never rotate a credential without first taking a database snapshot.

## Safety implications
- Rotation does not affect safe flags.
