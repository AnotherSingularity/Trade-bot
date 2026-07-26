# Phase 2E — Contextual Risk and Veto Observer

## Scope and status

Phase 2E adds a versioned external-context observer that evaluates funding,
premium, exchange flows, unlocks, ETF flows, stablecoin flows, sentiment,
sector rotation, macro-event calendar and cross-exchange dislocation. It
recommends one of:

```
no_op | reduce | reject | abstain | data_failure
```

It cannot generate a trade, rescue a Phase 2C/2D rejection, increase size,
alter TP/SL, or create a shadow execution plan.

**Verdict:** `phase2e_context_framework_complete + prospective_validation_pending + enforcement_disabled`.

## Architecture

- **Providers (§B)** — typed `ContextProvider` interface with
  `FixtureContextProvider` for tests and
  `DeferredProductionContextProvider` that throws on construction.
- **Health model (§C)** — 10-state health enum (`healthy / degraded /
  stale / conflicted / unavailable / disabled / schema_mismatch /
  clock_skew / authentication_failure / rate_limited`) computed by pure
  `projectProviderHealth` — always append-only.
- **Provider + signal registries (§D, §E)** — versioned, hash-checked,
  drift-rejecting.
- **12 signal families (§H)** — funding level / acceleration / venue
  divergence; cross-exchange premium (with strict timestamp alignment);
  exchange flow (with low-confidence classification that cannot hard
  veto); token unlocks (with unknown-supply blocking percentage
  conclusions and post-window expiration); ETF flow (with publication-
  delay enforcement); stablecoin (peg deviation + supply — cannot
  boost); sentiment (low authority); sector rotation (leadership cannot
  boost; unknown sector explicit); macro calendar (state machine over
  event windows — never predicts outcome); cross-exchange dislocation
  (conflicting reference → data failure).
- **Ensemble (§K)** — deterministic `min(...)` composition with a
  `maximumCombinedReduction` floor (default 0.5). Supportive signals
  never boost the multiplier above 1. Hard-veto signals collapse the
  multiplier to 0. Conflicting high-authority signals produce a
  `conflict` outcome. Every vote is recorded.
- **Candidate decision (§L)** — 5-value action space; invariants
  enforced (`no_op` requires multiplier 1, `reduce` requires strictly
  between 0 and 1, `reject`/`abstain`/`data_failure` require 0).
- **Champion comparison (§M)** — persisted post-hoc into
  `champion_context_comparisons`; never mutates champion.
- **Incidents (§N)** — append-only journal for provider / signal /
  policy failures at four severities.

## Migration 0018

17 additive tables:
`context_provider_definitions`, `context_provider_health`,
`context_signal_definitions`, `context_policy_versions`,
`context_observer_runs`, `context_observations`,
`context_signal_values`, `sector_definitions`, `sector_memberships`,
`macro_event_definitions`, `macro_event_observations`,
`global_context_snapshots`, `product_context_snapshots`,
`context_ensemble_evidence`, `candidate_context_decisions`,
`champion_context_comparisons`, `context_incidents`.

Migrations 0000–0017 remain byte-identical; snapshot 0018 regenerated
from a real MariaDB checkpoint; `drizzle-kit generate` returns empty
diff.

## Lineage extension (§P)

`getDecisionChainAggregate` now returns
`researchObserver.context` with the observer run, policy version,
provider definitions and health snapshots, observations, signal
definitions and values, global + product snapshots, ensemble evidence,
candidate decision, champion comparison and product-scoped incidents.
Loads independently of Phase 2A/2B/2C/2D records.

## Tests

- **78 acceptance tests** (`tests/research/phase2e_context.test.ts`)
  covering §T.1–§T.60 and every §Q scenario (funding extremes / venue
  divergence, premium alignment + missing venue, exchange flow, unlock
  states + expiration + unknown supply, ETF publication delay,
  stablecoin peg + supply, sentiment fear/greed + disagreement,
  sector leadership / breakdown / unknown, macro windows + reschedule,
  cross-exchange conflict, ensemble votes / floor / boost prohibition,
  hard veto, provider failure not favorable, insufficient-evidence
  abstain, no_op / reduce / reject invariants, rescue guards, champion
  comparison, incidents, audit route completeness, independent loading
  from Phases 2A-2D, fixture manifest 50/50, byte-stable replay,
  createOrder counters all zero, safe flags intact, migration
  presence, drizzle snapshot integrity).
- **7 isolation tests** (`tests/research/phase2e_isolation.test.ts`)
  proving no champion source imports context, no context file imports
  champion strategy, no writes to champion economic tables, no
  multiplier > 1, no `createOrder / fetch / /brokerage/orders`
  references, Phase 2C/2D do not import context, Claude prompt
  generation does not import context.

**Server suite: 85/85 Phase 2E tests passing.**

## Known limitations honestly declared

- **No production provider adapters.** Every provider used in this
  phase is a fixture provider. The
  `DeferredProductionContextProvider` placeholder throws on
  construction. Enabling live funding, premium, flow, unlock, ETF,
  stablecoin, sentiment, sector, macro, or dislocation data requires
  post-freeze operator approval.
- **No prospective validation.** Signals and ensemble outcomes have
  not been validated against realised outcomes.
- **Ensemble composition is deliberately blunt** — `min(...)` with a
  bounded floor. It does not attempt weighted composition; a stack of
  weak signals cannot collapse the multiplier to near-zero, and no
  supportive signal can lift it above 1.
- **Sector definitions and memberships are minimal.** A production
  sector registry needs deliberate curation; the tables exist and are
  versioned.
- **Macro event definitions in the fixture set are placeholders.**
  A real macro calendar requires timezone-verified curated events.
- **Full observer run-loop is deferred.** Persistence helpers exist and
  are idempotent; the ingestion loop that continuously pulls provider
  observations, updates health, and emits snapshots is deferred to a
  future operational sequence.

## Safe-flag confirmation

- `DRY_RUN=true`, `ORDER_SUBMISSION_ENABLED=false` unchanged.
- `createOrder` invocation / attempt / network counts in
  `src/research/context/*`: **0** (verified by §T.54–§T.56 and the
  isolation guardrail).
- `DeferredProductionContextProvider` throws on construction
  (verified by test).

## Verdict

**`phase2e_context_framework_complete + prospective_validation_pending + enforcement_disabled`**

Explicitly NOT claimed: `phase2e_validated`,
`context_improved_returns`, `predictive_context`, `profitable`,
`ready_for_live_capital`.

## Prerequisites for Phase 2F

- Phase 2E context observer emits `candidate_context_decisions` and
  `champion_context_comparisons` for every candidate the champion
  scanner selects.
- No context result may be treated as authorization for a trade.
- The validation framework (Phase 2F) may treat context signals as
  covariates but must not train on unverified prospective outcomes.
