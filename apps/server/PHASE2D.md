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
- **34 Phase 2D-FIX correction tests** (`tests/research/phase2d_fix.test.ts`) covering the fixture-coverage manifest (33/33), audit-lineage integration, book-event/gap/snapshot/trade-flow persistence idempotency, resynchronization-after-gap, marketable-vs-passive labelling, unfilled-residual reporting, future-event rejection, retrieval-without-Phase-2A/2B/2C records, and the three createOrder counters staying at zero.

## Phase 2D-FIX — bounded correction

The following work was completed after the initial Phase 2D commit to close
verifiably-required gaps without opening a new migration:

1. **Full audit-lineage integration.** `getDecisionChainAggregate` returns
   a `researchObserver.microstructure` object with the shortlist run and
   membership, book session + snapshot + levels + gaps, feature
   definitions + values, latest trade-flow window, impact curves, passive
   fill estimate, execution-cost observer snapshot, microstructure
   execution decision, and champion comparison. Loads independently of
   Phase 2A/2B/2C records.
2. **Fixture-coverage manifest.** A deterministic
   `MS_FIXTURE_MANIFEST` (`src/research/microstructure/fixtureManifest.ts`)
   enumerates all 33 required §O scenarios and maps each to the concrete
   test case that exercises it. `computeMsFixtureCoverage()` reports
   `requiredScenarioCount === coveredScenarioCount === 33` and
   `uncoveredScenarioCount === 0`.
3. **Persistence boundaries verified.** New idempotent helpers in
   `src/research/microstructure/persistence.ts` cover book sessions,
   events, gaps, snapshots, levels, feature definitions, feature
   values, trade-flow windows, market-impact curves, passive-fill
   estimates and execution-cost observer snapshots. Each helper's
   idempotency is exercised in `tests/research/phase2d_fix.test.ts`.
4. **Twelve required correction tests.** Enumerated as §FIX-R.1–§FIX-R.12
   in the fix test file: audit-chain retrieval, retrieval-without-2A,
   retrieval-without-2B, retrieval-without-2C, manifest presence,
   deterministic 33/33 coverage, trade-flow idempotency, book-event
   idempotency, exact-snapshot resolution, anti-lookahead guard,
   champion behavior unchanged, and all three createOrder counters
   remaining zero.
5. **No new migration.** Migration 0017 remains immutable. The Phase
   2D-FIX work adds only source files and tests. `drizzle-kit generate`
   returns an empty diff.

## Known limitations honestly declared

- Live trade-flow persistence loop is still deferred — production Coinbase
  Level 2 connectivity is intentionally disabled (the
  `DeferredProductionMarketDepthProvider` throws on construction).
  Deterministic replay via the fixture provider persists trade-flow
  windows through `persistTradeFlowWindow`, and the persistence path is
  idempotent (verified by §FIX-R.7 and §FIX.12).
- Inline scenario coverage: the manifest allows an inline `it()` case to
  cover a scenario. Every entry names a concrete file + test title
  fragment; adding a scenario without a matching case is rejected by
  §FIX.2.

## Verdict

**`phase2d_microstructure_framework_complete + prospective_validation_pending + enforcement_disabled`**

Explicitly not claimed: `phase2d_validated`, `market_impact_measured_precisely`, `queue_realistic`, `ready_for_live_capital`.

## Safe-flag confirmation

- `DRY_RUN=true`, `ORDER_SUBMISSION_ENABLED=false` unchanged.
- `createOrder` invocation / attempt / network count in `src/research/microstructure/*`: **0** (verified by isolation test).
- `DeferredProductionMarketDepthProvider` throws on construction (verified by test).
