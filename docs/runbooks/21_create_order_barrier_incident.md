# Runbook 21 — Create Order barrier incident

## Trigger
`createOrderFunctionInvocations`, `createOrderAttemptCount`, or
`createOrderNetworkCount` is non-zero when checked from Overview or
Safety, OR the guardrail test `phase3d_fix_barrier.test.ts` fails.

## Symptoms
- Overview shows any of the three counters greater than zero.
- Safety screen shows a red "CreateOrder counter is NON-ZERO" banner.

## Immediate containment
- **THIS IS A P0 INCIDENT.** Every previous phase committed to
  those counters being zero.
- Immediately stop the server via System → "Stop local services".
- Do NOT restart until the root cause is identified.

## Diagnostic commands
```
mysql -u root -p horizon_trade -e "SELECT function_invocations, attempt_count, network_count, last_invocation_at FROM create_order_counters ORDER BY id DESC LIMIT 1"
```

## Recovery procedure
1. Identify the caller. `fetchBarrier.recordCreateOrderFunctionInvocation`
   is only called from `apps/server/src/trading/coinbase.ts`.
2. Read the recent server logs to find the caller stack.
3. Open a compliance incident with the full stack, the exact
   ORDER_SUBMISSION_ENABLED value at invocation time, and the
   affected `intent_id` (if any).
4. Do NOT roll back. Do NOT restart the server. Do NOT toggle the
   safety flag.
5. Escalate to the risk owner. They decide whether to invoke
   runbook 27 (emergency shutdown of all future live-canary paths).

## Verification
- After root cause is identified, add a regression test to
  `phase3b_final_certification.test.ts`.
- Counter is reset to zero ONLY after the incident is closed.

## Escalation
- Immediate, unconditional.

## Data preservation
- Preserve every log file. Do not truncate `create_order_counters`.

## Safety implications
- This is the ultimate safety indicator. A non-zero counter is a
  compliance-grade event even if no live capital was at risk.
