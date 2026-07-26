# Runbook 17 — Reconciliation degradation

## Trigger
Reconciler run count stalls, unresolved actions accumulate, or a
reconciliation cycle exits with `degraded` state.

## Symptoms
- Reconciliation screen shows a growing "Unresolved actions" count.
- Server logs contain `reconciliation_degraded` or `reconciliation_failed`.

## Immediate containment
- Scanner is automatically blocked while reconciliation is degraded
  (Phase 1 startup reconciliation gate).

## Diagnostic commands
```
mysql -u root -p horizon_trade -e "SELECT run_id, ended_at, action_count, unresolved_count FROM reconciliation_runs ORDER BY started_at DESC LIMIT 5"
```

## Recovery procedure
1. Inspect the unresolved actions on the Reconciliation screen.
2. If the unresolved actions reference unknown Coinbase order IDs,
   run runbook 12 (market-data outage) and let reconciler retry.
3. If an unresolved action is a definite orphan (order does not
   exist on exchange), record an incident and manually resolve the
   action via the diagnostic CLI:
   ```
   npm run reconcile:resolve -- --action <id> --resolution orphan_confirmed
   ```
4. Run a fresh reconciliation cycle from the Reconciliation screen.

## Verification
- Unresolved actions count returns to zero.
- Scanner leases can be acquired again.

## Escalation
- Manual resolution required → escalate to compliance owner.

## Data preservation
- Never delete a reconciliation_action row. Mark it resolved with
  the correct resolution enum instead.

## Safety implications
- Reconciler degradation blocks scanner but never enables live
  trading. All exit paths still use `applyExitEconomicStateTx`.
