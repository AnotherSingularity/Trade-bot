# Phase 2A — Dynamic Universe and Quantitative Fingerprint Observer

## Scope and status

Phase 2A adds an **observer-only** research framework that consumes a dynamically enumerated Coinbase spot-product universe and produces deterministic per-product fingerprints for research and shadow comparison.

The framework MUST NOT:

- Alter champion strategy behavior
- Authorize, reject, resize, or reroute champion trades
- Import from `src/trading/*`, `src/jobs/*`, `src/routers/*` (source-level isolation is enforced by a test)
- Emit trade signals or profitability claims

The framework runs against deterministic fixtures and captured datasets. No live Coinbase connection is required for any Phase 2A functionality or acceptance test.

**Verdict on completion:** `phase2a_observer_framework_complete + prospective_validation_pending`.

`phase2a_validated`, `profitable`, `ready_for_live_capital` are NOT claimed. Prospective validation and any downstream promotion decisions are outside the scope of this phase.

## What was built

### Data model (migration 0014)

Additive-only. 13 new tables:

| Table | Purpose |
|---|---|
| `universe_snapshots` | One row per enumerated product universe, with `payloadHash` for replay |
| `universe_products` | Per-snapshot product listing |
| `product_metadata_observations` | Immutable metadata snapshots deduped by `payloadHash` |
| `product_hygiene_decisions` | Stage-0 hygiene classification with reason codes and `policyVersion` |
| `product_quarantines` | Append-only quarantine records with severity and manual-override flag |
| `feature_definitions` | Immutable `(featureKey, featureVersion)` catalogue |
| `feature_calculation_runs` | Per-stage run identifiers |
| `feature_values` | One row per computed feature with a fully-typed status |
| `shortlist_decisions` | Stage-2-candidate selection with reason codes |
| `fingerprint_definitions` | Classifier versioning and override-rule text |
| `fingerprint_snapshots` | Per-product classification into one of 7 classes |
| `fingerprint_evidence` | Supporting / conflicting / missing per feature |
| `research_observer_runs` | Aggregate run summaries |

Migrations 0000–0013 remain immutable. Snapshots regenerated for checkpoint 14 and drizzle-kit diff is empty.

### Universe enumerator (`src/research/universe/enumerator.ts`)

- Abstract `ProductUniverseProvider` interface — a fixture provider is used for tests, and a production Coinbase provider can plug in later.
- Deterministic dedupe by `productId` (keeps the latest `metadataObservedAt`).
- Snapshot `payloadHash` is order-invariant.
- Metadata observations deduped by content hash.

### Hygiene gate (`src/research/hygiene/gate.ts`)

Stage-0 hygiene classifies each product per §C into one of:

- `eligible` — passes all rules
- `ineligible` — structurally rejected (non-SPOT, unsupported quote currency, stablecoin, leveraged token, invalid increment, etc.)
- `quarantined` — recent listing, stale metadata, manual review, duplicate/alias
- `insufficient_data` — reserved

All decisions include reason codes, `policyVersion`, and an `inputHash`. Quarantine records are **append-only**; `clearQuarantine` marks a row cleared but never deletes.

### Feature registry + `FeatureResult` contract (`src/research/features/*.ts`)

- **Contract** (`contract.ts`): 9 statuses (`valid | insufficient_history | stale | invalid_input | numerical_failure | low_confidence | gap_detected | unsupported | quarantined`), fail-closed rules. NaN/Infinity → `numerical_failure` with `value=null`. No failure status ever returns a neutral zero.
- **Registry** (`registry.ts`): definitions are immutable per `(featureKey, featureVersion)`. Registering a modified definition with an existing pair throws.
- **Inputs** (`inputs.ts`): honesty barrier (bars whose `dataAvailableAt > now` are excluded), `alignedSeries` drops unaligned buckets rather than zero-filling.
- **Math** (`math.ts`): deterministic helpers (log returns, variance ratio with Lo–MacKinlay SE, R/S Hurst with fit-quality R², autocorrelation, correlation, OLS beta, residual stdev, Shannon entropy, MAD).

### Stage 1 catalog — 36 features (`src/research/features/stage1.ts`)

Grouped by family:

- **Market structure (9)** — mean/stdev log return, positive-return fraction, lag-1 autocorrelation, variance ratio (low_confidence when |VR-1| < 2·SE), R/S Hurst (low_confidence when fit R² < 0.85), trend efficiency, range efficiency, directional persistence.
- **Volatility (6)** — realized, downside, vol-of-vol, Parkinson range vol, ATR-normalized range, expansion ratio.
- **Liquidity / tradability (9)** — approximate spread (bps), quote volume 24h, trade count 24h, Amihud illiquidity, turnover CoV, candle gap frequency, zero-volume frequency, increment burden, min-order notional.
- **Information / disorder (6)** — return entropy, directional entropy, jump frequency (5·MAD threshold), outlier concentration, |return| autocorrelation, composite data-quality penalty.
- **Benchmark relationships (6)** — BTC/ETH beta, correlation, BTC residual vol, relative strength (aligned-only, missing buckets dropped).

Hurst is NEVER read as "trend/reversion" without the fit-quality gate: the composer refuses to consider `ms.hurst_rs` unless `status = valid` AND `confidence ≥ 0.85`.

### Stage 2 confirmation catalog — 6 features (`src/research/features/stage2.ts`)

- ADF-lite regression t-statistic (no p-values — thresholded conservatively)
- KPSS-lite level-stationarity statistic
- OU AR(1) half-life (low_confidence when phi ∉ (0,1) or R² < 0.5)
- Range stability across 4 sub-windows
- BTC-correlation stability across 4 sub-windows
- AR(1) residual whiteness (max |autocorrelation| at lags 1..5)

### Shortlist policy (`src/research/shortlist/policy.ts`)

Deterministic Top-N filter:

1. Rejects products missing required features
2. Rejects products below a minimum viable feature count
3. Scores remaining candidates (illiquidity, quote-volume, quality penalty, benchmark correlation)
4. Rank ascending by score; ties break lexically on `productId`

Every outcome carries the policy version and an input hash so a change in scoring or thresholds triggers a new row (never a silent overwrite).

### Fingerprint composer + evidence (`src/research/fingerprint/composer.ts`)

Seven classes:

```
REVERSION_CANDIDATE
BREAKOUT_CANDIDATE
MACRO_FLOOR_RESEARCH_CANDIDATE
RANDOM_OR_NOISY
ILLIQUID
DISORDERED
UNCLASSIFIED
```

Override rules:

- `ILLIQUID` overrides directional classes (≥2 liquidity red flags)
- `DISORDERED` overrides directional classes (≥2 disorder red flags)
- Directional classes require a **quorum of ≥3 supporting `valid` features** AND a ≥1 margin over the runner-up
- `low_confidence` NEVER counts toward a directional quorum
- Missing critical features → `UNCLASSIFIED` (no default direction)
- No signal → `RANDOM_OR_NOISY` fallback → otherwise `UNCLASSIFIED`

Evidence is persisted per feature with roles `supporting | conflicting | missing`. Every fingerprint row carries `classificationVersion`, `metadataVersion`, and an `inputHash` of the sorted result map.

### Research lineage extension (`src/db/lineage.ts`)

`getDecisionChainAggregate` now returns a `researchObserver` section for the champion-decision-chain's product at the most recent universe snapshot at or before the chain's `observedAt`. Includes: universe snapshot, hygiene decision, active quarantines, shortlist decision, fingerprint snapshot, and evidence rows.

This is READ-ONLY. The champion pipeline never consumes any research state.

### Replay fixture catalog (`tests/research/fixtures/scenarios.ts`)

Sixteen deterministic scenarios covering all 7 fingerprint classes plus hygiene edge cases:

```
S01_ideal_trender_long        S09_disordered_low_dir_entropy
S02_ideal_trender_short       S10_btc_shadow_high_corr
S03_ou_reverter_fast          S11_btc_shadow_stable_beta
S04_ou_reverter_slow          S12_short_history
S05_random_walk_pure          S13_stale_metadata
S06_illiquid_thin_book        S14_recent_listing
S07_illiquid_gappy            S15_stablecoin_ineligible
S08_disordered_jumpy          S16_manual_quarantine
```

All fixtures use a seeded LCG — no `Math.random`, no clocks — so identical inputs always produce identical bars.

### Source-level isolation guardrail (`tests/research/phase2a_isolation.test.ts`)

Three assertions:

1. No champion source file (`trading/`, `jobs/`, `labeling/`, `market_data/`, `reporting/`, `routers/`, `soak/`, `lib/`, `middleware/`, `db/`) imports from `src/research/*`.
2. No `src/research/*` file imports champion strategy behavior (executor, scanner, allocator, protection state, Claude prompt, shadow pipeline, scan job).
3. The 13 observer tables are only written from `src/research/*` or `src/db/lineage.ts` (audit-only).

## Tests

- 50 required §R observer tests (`tests/research/phase2a_observer.test.ts`)
- 3 source-isolation tests (`tests/research/phase2a_isolation.test.ts`)
- All pre-existing Phase 0–1.2 tests continue to pass (490 tests)

Total: 543 tests, all passing.

## Governance and non-claims

Per the Phase 2A work order:

- The observer framework is **complete**; prospective validation is deferred.
- The seven-day operational soak is intentionally deferred until the full development agenda is complete and the application reaches code freeze.
- No live-capital authorization is implied. `DRY_RUN=true` and `ORDER_SUBMISSION_ENABLED=false` remain the enforced defaults.

Verdict: **`phase2a_observer_framework_complete + prospective_validation_pending`**.

The framework does not claim:

- `phase2a_validated` — no prospective real-market validation was performed
- `profitable` — the observer emits classifications, not returns
- `ready_for_live_capital` — deferred by governance
