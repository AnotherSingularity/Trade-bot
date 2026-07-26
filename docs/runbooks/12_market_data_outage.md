# Runbook 12 — Market-data outage

## Trigger
The market-data supervisor loses connectivity to Coinbase's WebSocket
or REST endpoints (in Phase 3B: fixture provider stops emitting
events).

## Symptoms
- Overview shows `market_data` service as `degraded` or `failed`.
- Scanner slows or stops producing candidates.

## Immediate containment
- If the outage is fixture-related, restart the desktop.
- If it is exchange-related, do NOT enable production adapters (Phase 3B forbids it).

## Diagnostic commands
```
Get-Content '%LOCALAPPDATA%\Horizon Trade\logs\market_data.log' -Tail 100
```

## Recovery procedure
1. On System → "Restart market data".
2. The supervisor transitions `stopping → stopped → checking_dependencies → starting → healthy`.
3. Wait up to 30 seconds for the first candle to arrive.
4. If the supervisor enters `recovery_required`, the crash-loop
   detector was triggered — take a snapshot and open an incident.

## Verification
- Overview `market_data` service in `healthy` state.
- Candle timestamps advance in the Reports → Daily shadow export.

## Escalation
- Repeated `recovery_required` → escalate to release owner.
- Exchange-side outage → contact Coinbase support; do NOT switch adapter.

## Data preservation
- No data loss. Late corrections are versioned in `candles_late_corrections`.

## Safety implications
- Market-data outage does not affect safe flags. Absence of new data
  simply pauses new candidate generation.
