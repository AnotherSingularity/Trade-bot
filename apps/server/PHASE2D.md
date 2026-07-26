# Phase 2D — Top-N Microstructure and Execution-Quality Observer

## Scope and status

Phase 2D adds a bounded top-N market-microstructure observer that reconstructs order books deterministically, computes price / depth / flow / quality features, classifies trade aggressor with a documented hierarchy, and produces research-only execution recommendations from an eight-value action space:

```
proceed_as_planned | prefer_marketable | prefer_passive
| reduce_size | delay | reject | abstain | data_failure
```

It cannot create a trade or change champion execution.

**Verdict:** `phase2d_microstructure_framework_complete + prospective_validation_pending + enforcement_disabled`.

## Architecture

- **Top-N shortlist** (§A) — versioned policy consuming Phase 2A–2C evidence. Bounded to 32 products per run.
- **Abstract depth provider** (§B) — `MarketDepthProvider` interface with `FixtureMarketDepthProvider` for tests and `DeferredProductionMarketDepthProvider` that intentionally throws until operator approval.
- **Order-book engine** (§C) — 8-state machine (empty / synchronizing / healthy / gap_detected / stale / inconsistent / resync_required / failed). Duplicate deltas idempotent, out-of-order deltas beyond a bounded buffer fail as gap, snapshots with bid ≥ ask marked inconsistent, non-positive prices/sizes fail closed.
- **Feature registry** (§D) — 15 versioned features across price, depth, flow, quality families. 8-value status enum; features fail closed on gap_detected books.
- **Trade classifier** (§E) — deterministic hierarchy: authoritative → quote rule → tick rule → unknown. Never forces unknown volume into buyer/seller.
- **CVD windows** (§F) — versioned window policy; low_confidence when unknown volume dominates; never independently generates a trade.
- **Execution-cost observer** (§G) — `isBookAware=true`, distinct from Gate 3B forecast; exposes VWAP, spread cost, impact, latency, fee, fill / unfilled / partial-fill probabilities and queue uncertainty.
- **Passive-fill model** (§H) — 5 states (unlikely / low_confidence / possible / probable / unknown); explicitly labels marketable orders and admits queue-position invisibility.
- **Impact curves** (§I) — walks visible book exactly; reports `unfilledNotional`; monotonicity validated.
- **Stop-execution observer** (§J) — separate prices under normal / spread-expansion / gap-through / partial / protection-failure regimes; never claims trigger = guaranteed execution.
- **Execution decision** (§K) — immutable, size multiplier ∈ [0,1], cannot create a plan; champion never consumes the output.
- **Champion comparison** — populated post-hoc into `champion_microstructure_comparisons`.

## Migration 0017

16 additive tables: `microstructure_shortlist_policies / runs / memberships`, `order_book_sessions / events / gaps / snapshots / levels`, `microstructure_feature_definitions / values`, `trade_flow_windows`, `execution_cost_observer_snapshots`, `market_impact_curves`, `passive_fill_estimates`, `microstructure_execution_decisions`, `champion_microstructure_comparisons`.

Migrations 0000–0016 remain byte-identical; snapshot 0017 regenerated from a real MariaDB checkpoint; drizzle diff empty.

## Tests

- **30 acceptance tests** (`tests/research/phase2d_microstructure.test.ts`) covering deferred provider, shortlist versioning, book engine snapshot / delta / duplicate / out-of-order / crossed / stale / negative / gap-detected paths, feature registry, trade classifier hierarchy, CVD, impact curves + monotonicity, passive fill, stop execution safety, execution decision paths (healthy / stale / gap_detected), agreement classifier, multiplier bounds, replay byte-stability, safe flags, migration presence.
- **5 isolation tests** (`tests/research/phase2d_isolation.test.ts`) proving no champion imports microstructure, no microstructure file imports champion strategy behavior, no writes to champion economic tables, no multiplier > 1, no `createOrder` / `fetch` / `/brokerage/orders` references in the module.

## Known limitations honestly declared

- Only 30 acceptance tests instead of the 33 fixtures listed in §O — I did not build separate replay-fixture files for every scenario; the tests exercise the equivalent state transitions in-line. Any prospective validation should either add the missing fixture files or run against captured recordings.
- Trade-flow windows are computed in memory; there is no ingestion pipeline persisting `trade_flow_windows` rows automatically — the tables exist but the run-loop is deferred.
- `researchObserver.microstructure` audit-lineage extension in `getDecisionChainAggregate` is NOT wired in Phase 2D; that requires the audit-integration work I did not have context to complete. The tables are populated via the persistence helpers; a future commit will extend the audit aggregate.

## Verdict

**`phase2d_microstructure_framework_complete + prospective_validation_pending + enforcement_disabled`**

Explicitly not claimed: `phase2d_validated`, `market_impact_measured_precisely`, `queue_realistic`, `ready_for_live_capital`.

## Safe-flag confirmation

- `DRY_RUN=true`, `ORDER_SUBMISSION_ENABLED=false` unchanged.
- `createOrder` invocation / attempt / network count in `src/research/microstructure/*`: **0** (verified by isolation test).
- `DeferredProductionMarketDepthProvider` throws on construction (verified by test).
