# Runbook 09 — Credential creation

## Trigger
Operator has been issued Coinbase API credentials to store on this workstation.
(Not executed in Phase 3B — credentials are prohibited until Phase 3C authorization.)

## Symptoms
- Configuration screen shows `coinbase.apiKey: absent`, `coinbase.apiSecret: absent`.

## Immediate containment
- Do NOT proceed unless the operator has explicit Phase 3C
  authorization from the risk owner.

## Diagnostic commands
```
control /name Microsoft.CredentialManager
```
(observes but does not modify)

## Recovery procedure
1. Confirm the credentials do NOT have withdrawal/transfer scope.
2. Open Horizon Trade → System → "Manage credentials".
3. Enter the API key and secret in the modal (main-process only;
   the renderer never sees the plaintext).
4. The desktop writes the entries to Windows Credential Manager via
   keytar under the service name `horizon-trade-desktop`.
5. Configuration screen updates to `present_encrypted`.

## Verification
- Configuration screen shows both keys as `present_encrypted`.
- `phase3a_secrets.test.ts` REDACT_KEYS still guarantees no logging.
- No incident is recorded.

## Escalation
- Keytar refuses to write → escalate to workstation admin.

## Data preservation
- Credentials persist across desktop upgrades and uninstalls.

## Safety implications
- Storing credentials does NOT enable live trading. `ORDER_SUBMISSION_ENABLED`
  remains false and the double-lock in `createOrder` still refuses submission.
