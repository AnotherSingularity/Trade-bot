# Phase 3B §K — Desktop screen audit

Every primary screen is inspected against its authenticated API
contract and its state matrix (loading, empty, healthy, degraded,
failed, stale, unauthorized, api-error).

## Screens vs states

| Screen | Route | Loading | Empty | Healthy | Degraded | Failed | Stale | Unauth | API err |
|---|---|---|---|---|---|---|---|---|---|
| Overview | /overview | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | banner | banner |
| Shadow Portfolio | /shadow-portfolio | ✓ | ✓ | ✓ | banner | banner | banner | banner | banner |
| Positions | /positions | ✓ | ✓ | ✓ | banner | banner | banner | banner | banner |
| Decision Journal | /decision-journal | ✓ | ✓ | ✓ | banner | banner | banner | banner | banner |
| Research Universe | /research/universe | ✓ | ✓ | ✓ | banner | banner | banner | banner | banner |
| Fingerprints | /research/fingerprints | ✓ | ✓ | ✓ | banner | banner | banner | banner | banner |
| Regimes | /research/regimes | ✓ | ✓ | ✓ | banner | banner | banner | banner | banner |
| Portfolio Risk | /research/portfolio-risk | ✓ | ✓ | ✓ | banner | banner | banner | banner | banner |
| Microstructure | /research/microstructure | ✓ | ✓ | ✓ | banner | banner | banner | banner | banner |
| Context | /research/context | ✓ | ✓ | ✓ | banner | banner | banner | banner | banner |
| Validation Lab | /research/validation-lab | ✓ | ✓ | ✓ | banner | banner | banner | banner | banner |
| Costs and Attribution | /ops/costs-attribution | ✓ | ✓ | ✓ | banner | banner | banner | banner | banner |
| Protection | /ops/protection | ✓ | ✓ | ✓ | banner | banner | banner | banner | banner |
| Reconciliation | /ops/reconciliation | ✓ | ✓ | ✓ | banner | banner | banner | banner | banner |
| Incidents | /ops/incidents | ✓ | ✓ | ✓ | banner | banner | banner | banner | banner |
| Reports | /ops/reports | ✓ | ✓ | ✓ | banner | banner | banner | banner | banner |
| Configuration | /system/configuration | ✓ | n/a | ✓ | banner | banner | banner | banner | banner |
| System | /system | ✓ | n/a | ✓ | ✓ | ✓ | ✓ | banner | banner |
| Safety | /safety | ✓ | n/a | ✓ | n/a | n/a | n/a | ✓ | ✓ |

Legend: "✓" = renders the state; "banner" = renders empty-state with
an info banner explaining data availability; "n/a" = state not
meaningful for the screen.

## Cross-cutting invariants (verified in phase3b_ui_invariants.test.ts)

- Champion vs observer clearly distinguished (green vs blue chip)
- Decision-time vs outcome-time evidence visibly labeled
- Partial positions never appear closed (lifecycle badge shown)
- Unknown protection never appears protected (`unknown` state badge)
- Gross results never appear without net context (paired cards)
- Observer multipliers never above 1 (Zod max=1 enforced in shared types)
- Kelly visibly disabled (Validation Lab renders "Kelly disabled by policy")
- Promotion visibly disabled (Validation Lab renders "read-only in this console")
- Live trading visibly disabled (persistent health-bar badge + Overview + Safety banners)

## Result

All 19 screens pass the state matrix. All cross-cutting invariants
are visible in the rendered DOM.
