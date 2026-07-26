# Phase 2F — Validation, Anti-Overfitting, Attribution and Promotion Governance

## Scope and status

Phase 2F adds the complete research-validation and governance framework:
dataset provenance and identity, experiment registration, walk-forward
and CPCV split policies, a strict leakage firewall, Probability of
Backtest Overfitting (PBO), Deflated Sharpe Ratio (DSR), statistical
implementation audits, net performance metrics + 16 subgroup slicers,
unified challenger composition of Phase 2A–2E outputs, incremental
observer attribution, a Claude attribution framework (pending),
promotion registry, immutable rollback, and a Kelly gate that stays
disabled.

**Verdict:** `phase2f_validation_framework_complete + prospective_validation_pending + promotion_disabled`.

## Architecture

- **Datasets (§A)** — `dataset_definitions` (immutable key + source
  category) and `dataset_versions` (append-only, per-run snapshot of
  every relevant version). Source-category relabels forbidden
  (`historical_replay → prospective_shadow` throws). Membership /
  exclusion / feature-version changes require a new dataset version.
- **Experiments (§B)** — `research_experiments` registered BEFORE
  evaluation with primary metric, parameter search space, random
  seed and code commit. Failed experiments remain visible. Primary
  metric or code-commit change in place is rejected.
- **Split policies + folds (§C, §E)** — versioned `expanding /
  rolling / anchored` walk-forward folds with explicit purge, embargo
  and label horizon. `generateWalkForwardFolds` is deterministic;
  final holdout is always the last window.
- **Leakage firewall (§D)** — 15 checks that fail closed: future
  observation, future label, revised-data leak, overlapping label
  horizon, train/test overlap, embargo violation, final holdout
  contamination, product survivorship, future universe selection,
  outcome-informed exclusion, cost-model version leak, feature-version
  mismatch, champion/challenger version mismatch, statistical audit
  failure, other. Every detected violation writes a
  `validation_incidents` row at `blocking` severity.
- **CPCV (§F)** — `generateCpcvTestGroups` is deterministic. Path
  generation preserves purge + embargo. Failed paths remain in the
  aggregate.
- **PBO (§G)** — full Bailey & López de Prado implementation:
  N candidates, S partitions, S/2 in-sample combos, logit-rank
  aggregation. Single-candidate → `insufficient_candidates`.
- **DSR (§H)** — full Bailey & López de Prado deflation with
  Beasley-Springer-Moro inverse normal CDF, skewness + kurtosis
  correction, and expected-max-Sharpe under N trials. One trial
  receives no multiple-testing penalty (`E[max SR₁] = 0`). Zero
  variance fails explicitly.
- **Statistical audit (§I)** — `STATISTICAL_AUDIT_CATALOG` covers 18
  quantitative diagnostics (Hurst, variance ratio, ADF-lite,
  KPSS-lite, OU fit + half-life, CUSUM, segmented variance, HMM,
  correlation Pearson + shrinkage, VaR, ES, cluster, impact curve,
  passive fill, premium, funding). Honest labels
  (`audited_approximation`, `research_heuristic`, `known_deviation`)
  are preserved even after passing a reference vector check.
  `isAuditStatusPromotionEligible` returns `true` ONLY for `canonical`
  and `audited_approximation`.
- **Net metrics (§J)** — `validation_metrics` records the 21 metrics
  from §J with `netOfCosts` boolean. Gross may be displayed alongside
  net; a negative net is honestly persisted.
- **Subgroups (§K)** — 16 slice keys (`product`, `strategy_mode`,
  `fingerprint_class`, `raw_regime`, `smoothed_regime`,
  `liquidity_class`, `volatility_class`, `correlation_cluster`,
  `btc_beta_band`, `eth_beta_band`,
  `microstructure_confidence_state`, `context_state`,
  `data_quality_state`, `time_period`, `provider_health_state`,
  `protection_state`). Catastrophic slices remain visible with a
  `catastrophic` status and a `validation_slice_failures` row.
- **Unified challenger (§L)** — `evaluateUnifiedChallenger` composes
  Phase 2C risk, Phase 2D microstructure and Phase 2E context
  multipliers under `min(...)` with strict clamping to `[0,1]`.
  Hard rejections collapse the multiplier to 0; conflicts produce
  `conflict`; missing critical evidence produces `abstain` or
  `data_failure`. Cannot create a plan; cannot mutate champion.
- **Attribution (§M, §N)** — `observer_incremental_attribution`
  records what each observer would have decided using only
  decision-time evidence. `champion_challenger_outcome_comparisons`
  labels the attribution mode (construction / replay / historical /
  captured / prospective). `claude_attribution_snapshots` stays at
  `prospective_evidence_unavailable`.
- **Promotion (§O, §P, §Q)** — 18-criterion promotion gate.
  `requestModelPromotion` is the ONLY entry point; it always writes a
  `model_promotion_decisions` row. Missing prospective evidence,
  missing human approval, or any failed criterion writes a
  `blocked` record. Approved decisions never populate
  `newChampionVersion` in Phase 2F. Rollback target persisted via
  `rollback_records`.
- **Kelly gate (§R)** — `evaluateKellyActivation` writes a
  `kelly_activation_evaluations` row with outcome
  `rejected_not_calibrated`. No code path anywhere else in the tree
  imports Kelly.

## Migration 0019

38 additive tables covering the full validation framework. Migrations
0000–0018 remain byte-identical; snapshot 0019 regenerated from a real
MariaDB checkpoint; `drizzle-kit generate` returns empty diff.

## Lineage extension (§S)

`getDecisionChainAggregate` now returns `researchObserver.validation`
with the observer's unified challenger decision, unified evidence,
incremental attribution rows and the outcome comparison. The aggregate
loads INDEPENDENTLY of Phase 2A/2B/2C/2D/2E records where foreign keys
permit.

## Tests

- **90 acceptance tests** (`tests/research/phase2f_validation.test.ts`)
  covering §X.1–§X.73 and every §Q fixture scenario.
- **10 isolation tests** (`tests/research/phase2f_isolation.test.ts`)
  proving no champion source imports validation, no validation file
  imports champion strategy, no writes to champion economic tables,
  no unified challenger multiplier above 1, promotion requires
  explicit human actor, no non-interactive approval identifier
  exists, Kelly cannot affect allocation, Claude prompt generation
  does not import validation, no `createOrder` / `fetch` /
  `/brokerage/orders` refs, Phase 2A-2E do not import Phase 2F.

**Phase 2F test result: 100/100 passing.**

## Fixture manifest

`computeValidationFixtureCoverage()` returns
`{ requiredScenarioCount: 52, coveredScenarioCount: 52, uncoveredScenarioCount: 0 }`.
Every §U scenario names a concrete file + test title fragment.

## Server verification (per updated acceptance criteria)

| Check | Result |
|---|---|
| Server lint / typecheck | clean |
| Server tests | passing |
| Server build | success |
| Shared package typecheck | clean |
| Migration-path integrity | 0000–0018 byte-identical; 0019 reconstructed from real MariaDB checkpoint |
| Snapshot byte stability | verified via reconstruct-snapshots script |
| `drizzle-kit generate` diff | empty |
| Safe flags | `DRY_RUN=true`, `ORDER_SUBMISSION_ENABLED=false` unchanged |
| createOrder function / attempt / network counts | 0 |

Mobile companion workspace excluded from acceptance surface per
updated project policy — non-blocking.

## Known limitations honestly declared

- **No prospective validation evidence anywhere.** Every dataset in
  the test suite is `synthetic_fixture` or `deterministic_replay`.
  Every promotion attempt is `blocked` at the
  `prospective_shadow_evidence` criterion. Phase 2F CANNOT approve a
  real promotion.
- **Statistical implementations retain honest labels.** ADF-lite and
  KPSS-lite are `research_heuristic` and cannot gate a promotion.
- **Kelly stays `rejected_not_calibrated`.** No code path applies
  Kelly to allocation, and `kelly_activation_evaluations.outcome` is
  fixed regardless of input.
- **Claude attribution stays `prospective_evidence_unavailable`.** No
  approval or rejection rate metric is materialized.
- **Statistical reference vectors are declared but not populated.**
  The catalog registers 18 audit records; reference-vector tests are
  a future task.
- **CPCV path aggregation is minimal.** Path results have
  `netReturn`, `netSharpe`, `maximumDrawdown`, `sampleCount`; the
  full per-metric aggregation-across-paths pipeline is deferred.

## Safe-flag confirmation

- `DRY_RUN=true`, `ORDER_SUBMISSION_ENABLED=false` unchanged.
- `createOrder` function / attempt / network counts in
  `src/research/validation/*`: **0** (verified by §X.67–§X.69 and by
  the isolation guardrail).
- No non-interactive promotion identifier exists (verified by both
  the acceptance and isolation tests).

## Verdict

**`phase2f_validation_framework_complete + prospective_validation_pending + promotion_disabled`**

Explicitly NOT claimed: `phase2f_validated`, `challenger_superior`,
`strategy_profitable`, `promotion_approved`, `kelly_enabled`,
`ready_for_live_capital`.

## Prerequisites for the Desktop Operator Console

The Desktop Operator Console must:

1. Never attempt to POST an order under any dashboard action.
2. Read `getDecisionChainAggregate.researchObserver.validation` and
   surface the promotion / Kelly / attribution status honestly.
3. Enforce that any promotion action originates from an authenticated
   human operator and writes the actor identity into
   `humanApprovalActor`.
4. Refuse to render a promotion approval UI when
   `prospectiveEvidenceAvailable=false`.
5. Never invert a `blocked` promotion decision without a new
   evidence bundle.
6. Read-only for Kelly activation state; no UI toggle enables Kelly.

## Release-surface report

**active desktop/server release surface: green**
**mobile companion workspace: deferred, non-blocking**
