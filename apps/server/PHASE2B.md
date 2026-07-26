# Phase 2B — Regime-State Observer, Change Detection, and Challenger Routing

## Scope and status

Phase 2B builds a versioned regime-state observer that consumes Phase 2A fingerprint evidence, global market conditions, volatility state, directional behavior, and structural-break evidence to produce research-only regime assignments and challenger routing recommendations.

The framework MUST NOT:

- Replace the champion strategy router
- Authorize or reject champion orders
- Change allocations, TP, or SL
- Alter the champion product universe
- Promote itself automatically

All observations are DRY_RUN / `ORDER_SUBMISSION_ENABLED=false` by construction.

**Verdict on completion:** `phase2b_regime_observer_complete + prospective_validation_pending`.

`phase2b_validated`, `routing_improved`, `profitable`, `ready_for_live_capital` are NOT claimed.

## Architecture — three distinct concepts

Per §A, Phase 2B keeps three concepts strictly separate:

| Concept | Values | Where it lives |
|---|---|---|
| **Fingerprint** (Phase 2A) | `REVERSION_CANDIDATE` / `BREAKOUT_CANDIDATE` / `MACRO_FLOOR_RESEARCH_CANDIDATE` / `RANDOM_OR_NOISY` / `ILLIQUID` / `DISORDERED` / `UNCLASSIFIED` | `fingerprint_snapshots` |
| **Regime state** | `TREND_UP` / `TREND_DOWN` / `RANGE` / `VOLATILITY_EXPANSION` / `CAPITULATION` / `DISORDERED` / `UNKNOWN` | `global_regime_snapshots`, `product_regime_snapshots` |
| **Challenger recommendation** | `REVERSION` / `BREAKOUT` / `MACRO_FLOOR_RESEARCH` / `NO_TRADE` / `ABSTAIN` / `CONFLICT` | `challenger_routing_decisions` |

Fingerprint ≠ regime. Regime ≠ execution authorization.

## Global vs. product state (§B)

Two independent observers, each with its own versioned definition:

- **Global market state** — from BTC/ETH direction, cross-sectional median return, cross-sectional realized vol + dispersion, % advancing, % in vol expansion, % illiquid/disordered, and market-wide data-quality health.
- **Product regime state** — from Phase 2A features + fingerprint + direction/persistence/vol/stationarity + the currently-active global state. The product snapshot carries the `globalStateId` it consumed for full lineage.

## Regime definition registry (§C)

`regime_definitions` records every versioned regime: `regimeKey`, `regimeVersion`, `scope`, `description`, `requiredEvidence`, `minimumValidEvidence`, `conflictPolicy`, `missingDataPolicy`, `transitionPolicyVersion`, `implementationHash`, `status`, and optional `supersedesDefinitionId`. Changing thresholds, formulas, state logic, or transition rules REQUIRES a new version — enforced by an `implementationHash` mismatch check.

## RegimeResult contract (§D)

Every regime calculation returns a strict shape:

```
state | status | confidence
supportingEvidence[]
conflictingEvidence[]
missingEvidence[]
globalStateId | fingerprintSnapshotId
observedAt | dataAvailableAt
modelVersion | transitionPolicyVersion
inputHash | diagnostics | failureReason
```

Nine statuses: `valid | low_confidence | insufficient_history | stale | gap_detected | conflicted | numerical_failure | quarantined | unknown`. No failed result is EVER coerced into RANGE, neutral, or zero.

## Deterministic baseline (§E, §F)

The product regime baseline combines FIVE evidence families:

- **Direction** — mean log return, trend efficiency, directional persistence, BTC-relative strength, lag-1 autocorrelation, positive-return fraction.
- **Volatility** — realized vol, expansion ratio, vol-of-vol, Parkinson range vol, ATR-normalized range.
- **Range / mean reversion** — ADF-lite t-statistic, KPSS-lite, OU half-life, range stability CoV, lag-1 autocorrelation, variance ratio.
- **Disorder** — jump frequency (5·MAD), outlier concentration, data-quality penalty, directional entropy, gap frequency, fingerprint DISORDERED class.
- **Contextual** — global market state, Phase 2A fingerprint, hygiene + quarantine flags.

Rules:

- No single feature can establish a state.
- Directional states require a quorum ≥ 3 supporting signals with a margin of ≥ 1 over the runner-up.
- Disorder signals (2+, or a DISORDERED fingerprint alone) override direction.
- Volatility expansion is direction-neutral.
- Capitulation requires 4+ supporting signals across direction, downside vol, jump frequency and either global confirmation or explicit isolated evidence — it does NOT trigger a long recommendation.
- Missing critical evidence → UNKNOWN, never a default direction.

## Change-point detectors (§G)

Two INDEPENDENT deterministic detectors:

1. **CUSUM** (`p2b-cusum-1`) — one-sided in both directions with a versioned `k`/`h` threshold. Persists direction (`up`/`down`/`either`/`none`), magnitude, thresholdVersion, confidence, and numericalStatus.
2. **Segmented-variance** (`p2b-segvar-1`) — searches for the largest log-variance-ratio jump between two sub-windows. Fully deterministic, no future observations, no unbounded memory.

`bocpd_deferred` is a first-class enum value: BOCPD is INTENTIONALLY deferred until a hazard-policy audit. The detector returns `numericalStatus='failure'` and `changeProbability=null` — never a probability-0 pretense.

## Latent-state HMM (§H) + semantic mapping (§I)

`p2b-hmm-baseline @ p2b-hmm-1` — a versioned 3-state Gaussian HMM over log-return and log-range observations with:

- Fixed K = 3
- Deterministic quantile-partition initialization (no wall-clock, seeded)
- Log-space forward/backward for numerical safety
- Bounded iteration cap (default 60)
- Convergence tolerance 1e-4
- Posterior floor 1e-8 to prevent silent underflow
- `numericalStatus` in {ok, underflow_handled, overflow_handled, failure}

Latent identities are stored SEPARATELY from semantics. `computeSemanticMapping()` produces evidence-backed entries stored in `latent_state_mappings` (versioned `p2b-hmm-mapping-1`). A retrain generates a new model version and new mappings — never a silent relabel.

The HMM cannot independently route a strategy; it is one vote inside the ensemble.

## Ensemble (§J)

`combineEnsemble()` combines: baseline, change detectors, HMM (via semantic mapping), Phase 2A fingerprint, global state, and data-quality state. Records every component vote. Outcomes:

```
consensus | weak_consensus | conflict | insufficient_evidence | quality_override
```

Severe quality failure produces `DISORDERED` with `outcome=quality_override`. Detector disagreement reduces confidence. HMM/rule disagreement is recorded, not concealed. Change-point detection is evidence, not a state.

## Hysteresis + transition journal (§K, §L)

Versioned transition policy `p2b-transition-1` controls:

```
minimumDwellObservations = 3
candidateConfirmationCount = 2
minimumTransitionConfidence = 0.55
emergencyOverrideStates = [DISORDERED, UNKNOWN]
confidenceDecay = 0.1
staleStateExpiryMs = 6h
transitionMatrixPolicy = "unrestricted"
```

`applyHysteresis()`:

- A candidate must persist for `candidateConfirmationCount` at ≥ minimum confidence before it replaces the previous state.
- Emergency-override states transition immediately.
- Stale expiry forces UNKNOWN.
- Change points reduce required streak by 1.
- Confidence decays when no fresh supporting evidence arrives.

Both `rawState` and `smoothedState` are persisted on every product snapshot. Every accepted or rejected transition writes an append-only row to `regime_transitions`.

## Challenger routing (§M)

`evaluateChallengerRouting()` is a deterministic function of product regime, global regime, fingerprint, liquidity, data-quality, confidence, and conflict state. Emits one of six labels. Principles:

- `RANGE` + `REVERSION_CANDIDATE` → `REVERSION`
- `TREND_UP` / `VOLATILITY_EXPANSION` + `BREAKOUT_CANDIDATE` → `BREAKOUT`
- `CAPITULATION` → `MACRO_FLOOR_RESEARCH` (observer label only)
- `DISORDERED` or severe illiquidity or high quality-penalty → `NO_TRADE`
- `UNKNOWN`, low confidence, missing fingerprint → `ABSTAIN`
- Ensemble conflict → `CONFLICT`
- `TREND_DOWN` → `ABSTAIN` (no short channel exists in the champion strategy)

This recommendation NEVER enters the champion execution chain.

## Champion / challenger comparison (§N)

`champion_challenger_routing_comparisons` records, per `decisionChainId`:

- Champion decision + mode
- Challenger recommendation
- Global + product regime states
- Fingerprint class
- Agreement state: `agree | partial_agreement | disagree | champion_only | challenger_abstained | unresolved`
- Observer version and timestamps

Populated ONLY AFTER the champion decision chain is persisted. Promotion eligibility is NOT calculated in Phase 2B.

## Migration and schema

**Migration 0015 (`0015_phase2b_regime_observer.sql`)** — 13 additive tables:

- `regime_definitions`
- `regime_transition_policies`
- `regime_observer_runs`
- `global_regime_snapshots`
- `product_regime_snapshots`
- `regime_evidence`
- `change_point_events`
- `latent_state_model_versions`
- `latent_state_assignments`
- `latent_state_mappings`
- `regime_transitions`
- `challenger_routing_decisions`
- `champion_challenger_routing_comparisons`

Direct foreign keys enforce every observed relationship (product regime → run + global + fingerprint; challenger → run + product regime + global + fingerprint; comparison → decision chain + challenger decision). Observer records are immutable.

Migrations 0000–0014 remain **byte-identical**. Snapshot 0015 was regenerated mechanically via `scripts/reconstruct-snapshots.ts`; MariaDB fingerprint 0015 is present. `npx drizzle-kit generate` returns `No schema changes, nothing to migrate`.

## Research lineage extension (§P)

`getDecisionChainAggregate.researchObserver` now includes:

```
universe / hygiene / features / shortlist / fingerprint
regimeObserverRun
globalRegime
productRegime (raw + smoothed)
regimeEvidenceRows
changePoints
latentAssignment + latentMappings
transitions
challengerRouting
championComparison
```

Every field is populated read-only from the most recent regime observer run at or before the chain's `observedAt`.

## Replay fixtures (§Q)

**30 deterministic multi-period scenarios** in `tests/research/fixtures/regimeScenarios.ts`:

```
R01 stable_trend_up            R16 segvar_only
R02 stable_trend_down          R17 both_detectors_agree
R03 stable_range               R18 detector_conflict
R04 vol_expansion              R19 missing_benchmark
R05 upward_breakout            R20 stale_evidence
R06 downward_breakdown         R21 severe_data_gap
R07 capitulation               R22 hysteresis_flip
R08 noisy_high_entropy         R23 immediate_disorder_override
R09 illiquid_product           R24 state_expiry_to_unknown
R10 range_to_trend             R25 challenger_champion_agree
R11 trend_to_range             R26 challenger_champion_disagree
R12 short_lived_break          R27 challenger_abstention
R13 hmm_rule_agree             R28 low_confidence_regime
R14 hmm_rule_disagree          R29 global_selloff
R15 cusum_only_up              R30 isolated_product_selloff
```

All fixtures use a seeded LCG. Same inputs → same bars → same detector outputs.

## Source isolation (§R)

Three isolation tests in `tests/research/phase2b_isolation.test.ts` + expanded `phase2a_isolation.test.ts`:

1. No champion file imports from `src/research/regime/*`.
2. No `src/research/regime/*` file imports champion strategy behavior (executor, scanner authorization, allocator, protection, Claude prompt, runtime shadow, scan job).
3. Regime observer never inserts, updates, or deletes any champion table (`orderIntents`, `fills`, `positions`, `roundTrips`, `cashLedger`, `protectionInstances`, `protectionEvents`, `shadowExecutionPlans`, `postFillRevalidations`, `decisionChains`, `quantitativeDecisions`, `signalCandidates`, `executionCostForecasts`, `setupEvaluations`, `eligibilityDecisions`, `strategyRoutingDecisions`).
4. All 26 observer tables (13 Phase 2A + 13 Phase 2B) are written exclusively from `src/research/*` or the read-only `db/lineage.ts` audit surface.

Phase 2B reads champion `decisionChains.observedAt` and `productId` for comparison ONLY after the chain has persisted. No observer output mutates a champion decision.

## Reporting (§S)

`buildRegimeReport()` returns a health/agreement summary — never profitability. Fields: runs considered, global-state counts, product-state counts, raw-vs-smoothed equality, state duration median/p90, transition counts, change-point counts by detector, unknown rate, disordered rate, low-confidence rate, challenger recommendation counts, champion/challenger agreement rate, observer-failure count, data-quality override count.

The test suite explicitly asserts no `profit`, `returns_improved`, or `ready_for_live_capital` string appears in the serialized report.

## Tests

- **54 required §T tests** — `tests/research/phase2b_regime.test.ts`
- **3 Phase 2B isolation tests** — `tests/research/phase2b_isolation.test.ts`
- **Expanded Phase 2A isolation tests** now also cover Phase 2B tables
- **All Phase 0 – Phase 2A tests continue to pass** (unchanged)

**Full server test count: 600 passing across 34 files.**

## Governance and non-claims

- The observer framework is complete; prospective validation is deferred.
- The seven-day operational soak remains parked until the full development agenda reaches code freeze.
- `DRY_RUN=true` and `ORDER_SUBMISSION_ENABLED=false` continue to be the enforced defaults.
- `createOrder` invocation count remains zero across the observer path (guardrail tests verify).
- No live Coinbase connection is required for any Phase 2B functionality or test.

## Known limitations

- **ADF-lite / KPSS-lite / OU** diagnostics remain labeled as research diagnostics rather than canonical statistical validation until a dedicated quantitative audit covers formulas, lag-selection rules, critical-value policy, and numerical behavior.
- **BOCPD** is intentionally deferred; a hazard-policy audit is required before it can produce a numeric change probability.
- **Semantic mapping** is deterministic but heuristic; a validation-for-research promotion requires cross-checking against labeled datasets.
- **HMM training** uses a fixed quantile-partition initialization; results are deterministic but not necessarily globally optimal.
- **The mobile monorepo lint job** still fails on pre-existing TS1323 dynamic-import errors in `trading/coinbase.ts`, `trading/executor.ts`, and `trading/shadow/runtimeService.ts` — outside Phase 2B scope, unchanged by this branch, tracked as a repository-hygiene item.

## Remaining prerequisites for Phase 2C

- Formal statistical audit of the ADF-lite / KPSS-lite / OU baseline
- BOCPD implementation with a peer-reviewed hazard policy (or explicit written omission)
- Prospective validation of regime → challenger routing over a real observation window
- Champion/challenger agreement report over a full 7-day observer soak
- Repo-hygiene resolution of the pre-existing mobile-lint TS1323 errors

## Verdict

**`phase2b_regime_observer_complete + prospective_validation_pending`**

Forbidden verdicts — explicitly not claimed:

- `phase2b_validated`
- `routing_improved`
- `profitable`
- `ready_for_live_capital`

## Explicit safe-flag and zero-order confirmation

- `DRY_RUN` default: `true` (unchanged)
- `ORDER_SUBMISSION_ENABLED` default: `false` (unchanged)
- `createOrder` function invocation count in observer path: **0** (verified by test §T.48)
- `createOrder` HTTP attempt count: **0** (verified by test §T.49)
- `createOrder` network call count: **0** (no `fetch()` in `src/research/regime/*`; verified by test §T.50)
