# Live-canary abort matrix — every trigger + response

**Status.** Reference contract. The canary router refuses to load unless every row here has a corresponding runtime check. This document defines the shape; the runtime checks live at `apps/server/src/trading/*` and are enforced by tests before any canary can begin.

| Trigger ID | Trigger condition | Detection surface | Abort action | Post-abort |
|---|---|---|---|---|
| T01 | `DRY_RUN` observed = false anywhere it should be true | Every safety-observation event checks | Immediate — do NOT submit next order | Preserve session evidence; investigate before ANY retry |
| T02 | `ORDER_SUBMISSION_ENABLED` observed = true outside canary process | Killswitch + canary router | Immediate | Investigate |
| T03 | `liveCapitalAuthorized` observed = true outside canary process | Killswitch | Immediate | Investigate |
| T04 | `promotionEnabled` = true | Observer harness | Immediate | Investigate |
| T05 | `kellyEnabled` = true | Sizing module | Immediate | Investigate |
| T06 | `createOrderCounters.functionInvocations` exceeds cap (20/window) | Counter monitor | Immediate | Preserve; do NOT continue this window |
| T07 | `createOrderCounters.attemptCount` OR `.networkCount` diverges from `.functionInvocations` by > 1 | Counter monitor | Immediate | Investigate — indicates retry storm or double-tap |
| T08 | Provider disconnect > 30 s | WS supervisor | Immediate + attempt reconciliation | Wait for provider recovery + reconciliation |
| T09 | REST 429 rate limited > 3× in 60 s | REST client | Backoff + resume; abort if exceeds 5× in 60 s | Continue with backoff |
| T10 | Data-quality incident classified `soak_invalidating` | Data-quality gate | Immediate | Preserve; new shadow soak required |
| T11 | Reconciliation unresolved > 60 s | Reconciler | Immediate | Manual operator step |
| T12 | Modeled cost exceeds `max modeled loss` cap | Cost forecast + gate | Refuse specific order; log; continue if under global cap | — |
| T13 | Realized daily loss exceeds cap | Risk observer | Immediate | Preserve; next canary requires plan revision |
| T14 | Realized weekly loss exceeds cap | Risk observer | Immediate | — |
| T15 | Notional per order exceeds cap | Router pre-flight | Refuse specific order | — |
| T16 | Total open exposure exceeds cap | Portfolio observer | Refuse specific order | — |
| T17 | Spread observed > `spread threshold` | Microstructure observer | Refuse specific order | — |
| T18 | Liquidity participation > `liquidity threshold` | Risk observer | Refuse specific order | — |
| T19 | Fee forecast > `fee threshold` | Fee-tier + cost model | Refuse specific order | — |
| T20 | Product no longer eligible (§1 of plan.md) | Universe hygiene | Refuse specific order; halt further orders for that product | — |
| T21 | Champion vs observer disagreement exceeds `50 %` for last 5 chains | Observer diagnostics | Refuse specific order; log | — |
| T22 | Secret-scan hit anywhere in output | Redaction wrapper + secret scanner | Immediate | Preserve; do NOT publish evidence externally |
| T23 | Container-leak or process-leak observed | Managed-Docker orchestrator | Immediate | Investigate before next session |
| T24 | Kill flag `HORIZON_CANARY_ABORT` present in env | Router pre-flight + every order | Immediate | — |
| T25 | Operator manual abort via signed command | Router pre-flight | Immediate | — |
| T26 | Session start-time outside allowed UTC window | Router pre-flight | Refuse session start | — |
| T27 | Canary router health check red for > 60 s | Router self-check | Immediate | Investigate |
| T28 | Migration head or migration chain digest drifted from anchor | Anchor check | Immediate | Rerun Stages 6-13 |
| T29 | Report-spec version drifted | Anchor check | Immediate | — |
| T30 | Any child process not tracked by supervisor | Process supervisor | Immediate | Investigate — potential resource leak |

## Response ladder

- **Refuse specific order** — the router skips this single order; the session continues subject to bounds.
- **Immediate** — cancel any working order via `cancel_batch`; do NOT open any new order; write incident evidence; DO NOT auto-flatten open positions; operator manual step.
- **Investigate** — session preserved; do NOT re-arm the canary until root cause is identified and documented in `post-review.md`.

## No auto-flatten

The canary router NEVER auto-flattens an open position on abort. Flattening is an economic action requiring the same safety envelope — an abort means "stop opening, stop working orders" not "close positions blindly." The operator manually decides how (or whether) to flatten.
