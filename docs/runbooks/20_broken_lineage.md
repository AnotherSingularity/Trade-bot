# Runbook 20 — Broken lineage

## Trigger
Audit route `/lineage/getDecisionChain/<chainId>` returns a chain
whose parents cannot be resolved, OR the isolation guardrail test
fails on the local CI.

## Symptoms
- Decision Journal → chain detail shows "missing parent".
- Isolation test `phase2f_lineage_integration.test.ts` fails.

## Immediate containment
- Scanner pauses when the lineage-integrity check fails.

## Diagnostic commands
```
mysql -u root -p horizon_trade -e "SELECT parent_id FROM decision_chains WHERE parent_id NOT IN (SELECT id FROM decision_chains)"
```

## Recovery procedure
1. Enumerate every orphan parent reference.
2. If the orphan was produced by an interrupted transaction, restore
   from the most recent snapshot (runbook 07).
3. If the orphan was produced by a deliberate delete (never
   authorized), open a P0 compliance incident.
4. Never re-insert a "reconstructed" parent — the historical chain
   is immutable.

## Verification
- Isolation test passes.
- Audit route returns complete chains for every recent round-trip.

## Escalation
- Orphan cause unknown → escalate to compliance.

## Data preservation
- Decision-chain rows are IMMUTABLE. Never UPDATE or DELETE.

## Safety implications
- Broken lineage blocks promotion and pauses the scanner.
