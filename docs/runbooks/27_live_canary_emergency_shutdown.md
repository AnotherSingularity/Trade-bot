# Runbook 27 — Future live-canary emergency shutdown (NOT executed in Phase 3B)

## Trigger
Live-canary (only permissible after all Phase 3C authorization and a
successful preflight + soak) exhibits any of:

- Uncontrolled position accumulation.
- Repeated Coinbase error rates above the incident threshold.
- Unexplained P&L discrepancy > 0.
- Credential compromise.
- Loss of reconciliation for > 5 minutes.
- Any operator observation warranting immediate stop.

## Immediate containment
1. On the Safety screen, click "EMERGENCY STOP".
2. The desktop:
   a. Immediately sets ORDER_SUBMISSION_ENABLED=false in the runtime env.
   b. Stops the executor.
   c. Cancels every outstanding order via the canonical cancel path.
   d. Pauses the scanner.
   e. Records a P0 incident with the operator identity + timestamp.

## Diagnostic commands
```
mysql -u root -p horizon_trade -e "SELECT COUNT(*) FROM order_intents WHERE state='submitted' AND lifecycle NOT IN ('closed','cancelled')"
```

## Recovery procedure
1. Confirm no open positions and no unresolved orders on the Coinbase console.
2. If any position or order remains, cancel manually via the Coinbase console.
3. Take an immediate database snapshot (runbook 07).
4. Open a P0 compliance incident with the full timeline.
5. Do NOT re-enable ORDER_SUBMISSION_ENABLED until the risk owner
   authorizes a fresh Phase 3C round.

## Verification
- Zero open orders on the exchange.
- Zero positions.
- CreateOrder counters recorded and preserved.

## Escalation
- Immediate, unconditional. Notify risk owner + compliance owner.

## Data preservation
- Preserve every log, screenshot and DB row.

## Safety implications
- After emergency shutdown, the desktop returns to Phase 3B posture:
  DRY_RUN=true, ORDER_SUBMISSION_ENABLED=false.
- Recovery to live trading requires the full Phase 3C authorization
  sequence to repeat.
