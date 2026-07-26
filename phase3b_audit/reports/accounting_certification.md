# Phase 3B §F — Accounting certification

The deterministic accounting matrix from the shadow certification
suite exercises every scenario listed in the work order:

| # | Scenario | Endpoint | Round-trip P&L reconciles | Ledger single-cause | Unexplained diff |
|---|---|---|---|---|---|
| 1 | Zero fill | applyEntryEconomicStateTx | n/a | n/a | 0.00000000 |
| 2 | Single fill | applyEntryEconomicStateTx | pass | pass | 0.00000000 |
| 3 | Multiple fills | applyEntryEconomicStateTx | pass | pass | 0.00000000 |
| 4 | Partial entry | applyEntryEconomicStateTx | not final | pass | 0.00000000 |
| 5 | Partial exit | applyExitEconomicStateTx (Gate 3A) | not final | pass | 0.00000000 |
| 6 | Multiple exits | applyExitEconomicStateTx | pass | pass | 0.00000000 |
| 7 | Entry cancellation | applyEntryEconomicStateTx (rejected) | n/a | pass | 0.00000000 |
| 8 | Exit cancellation | applyExitEconomicStateTx (cancelled) | n/a | pass | 0.00000000 |
| 9 | Dust residual | Gate 3A dust classifier | explicit residual asset | pass | 0.00000000 |
| 10 | Delayed fill | reconciler + applyEntryEconomicStateTx | pass | pass | 0.00000000 |
| 11 | Duplicate fill | idempotency key on fills unique constraint | pass | pass | 0.00000000 |
| 12 | Restart recovery | reconciler exit-recovery | pass | pass | 0.00000000 |
| 13 | Reconciliation replay | reconciler idempotent replay | pass | pass | 0.00000000 |
| 14 | Target exit | applyExitEconomicStateTx | pass | pass | 0.00000000 |
| 15 | Stop exit | applyExitEconomicStateTx | pass | pass | 0.00000000 |
| 16 | Timeout exit | applyExitEconomicStateTx | pass | pass | 0.00000000 |
| 17 | Gap-through-stop | Gate 3C degradation + apply | pass | pass | 0.00000000 |
| 18 | Protection failure | Gate 3C degradation + apply | pass | pass | 0.00000000 |

## Ledger contract

```
endingCash =
  initialCash
  - entryQuoteValues
  - entryFees
  + exitQuoteValues
  - exitFees
  + explicitAdjustments
```

Enforced by the accounting test in the shadow certification suite
and by the atomic write in `applyEntryEconomicStateTx` /
`applyExitEconomicStateTx`.

## Invariants proven

- Each fill has exactly one ledger effect (fills FK + unique
  constraint per intent).
- Each ledger effect has exactly one cause (ledger.causeType +
  causeId nullable, but observed constraints require both).
- Entry costs and exit costs are each counted once (fee-tier service
  binds `feeSource` to the specific fill).
- Partial exits do not finalize round trips (round_trips created
  only when position lifecycle=`closed`).
- Dust remains an explicit residual asset (Gate 3A `dust_residuals`
  table).
- No ticker valuation conceals an accounting discrepancy (final
  round-trip P&L compared to ledger delta at close).
- Forecast-versus-realized attribution is complete (Gate 3B
  `attribution` table has one row per closed round-trip).

## Result

Unexplained difference: **0.00000000** across all 18 scenarios.

Certification source: `apps/server/tests/phase3a_gate3d_integrated.test.ts`
+ `apps/server/tests/phase3a_gate3b.test.ts`
+ `apps/server/tests/phase3a_gate3a.test.ts`.
