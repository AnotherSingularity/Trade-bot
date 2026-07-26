# Phase 2C — Independent Portfolio RiskEngine and Conservative Sizing Observer

## Scope and status

Phase 2C adds an independent, versioned portfolio RiskEngine that evaluates candidate trade risk, existing position risk, portfolio concentration, correlation and cluster exposure, BTC/ETH beta exposure, volatility-adjusted sizing, liquidity constraints, cash and reserve constraints, daily/weekly loss limits, drawdown limits, historical expected shortfall, deterministic stress scenarios, and protection/reconciliation integrity.

The engine is **observer and challenger-control only** in Phase 2C. It may recommend:

```
authorize_as_proposed | reduce_size | reject | abstain | data_failure
```

It NEVER alters the champion trade, creates an execution plan, or increases risk.

**Verdict on completion:** `phase2c_risk_engine_framework_complete + prospective_validation_pending + enforcement_disabled`.

Forbidden verdicts (explicitly not claimed): `phase2c_validated`, `risk_reduced`, `sizing_improved`, `portfolio_optimized`, `ready_for_live_capital`.

## Architecture

Three concepts kept STRICTLY separate (§A):

| Concept | Role | Where it lives |
|---|---|---|
| **Risk measurement** | An observed quantity (stop risk, exposure, VaR, drawdown, stress loss) | `RiskMeasurement<T>` — every calculator returns one |
| **Risk policy** | A versioned catalog of permitted limits + handling behavior | `risk_policy_versions` + `risk_limit_definitions` |
| **Risk decision** | The result of applying a policy to one candidate + the current portfolio | `candidate_risk_decisions` |

A measurement does not establish a limit. A limit does not imply authorization.

## Data model — migration 0016

Additive. 20 new tables:

| Table | Purpose |
|---|---|
| `risk_policy_versions` | Immutable versioned policy registry |
| `risk_limit_definitions` | Normalized limits belonging to a policy |
| `portfolio_risk_runs` | One row per observer pass |
| `portfolio_risk_snapshots` | Immutable per-run portfolio state |
| `position_risk_snapshots` | Per-position risk state |
| `candidate_risk_decisions` | Immutable per-candidate decision |
| `risk_limit_breaches` | Append-only breach journal |
| `correlation_model_versions` | Versioned correlation model |
| `correlation_snapshots` | Per-run correlation snapshot |
| `correlation_pairs` | Per-pair correlation with alignment metadata |
| `risk_cluster_snapshots` | Per-run cluster snapshot |
| `risk_clusters` | Per-cluster identity |
| `risk_cluster_memberships` | Per-product / cluster / reason |
| `daily_loss_states` | Persisted daily loss projection |
| `weekly_loss_states` | Persisted weekly loss projection |
| `portfolio_drawdown_states` | Peak equity + current + max drawdown |
| `stress_scenario_definitions` | Versioned catalog |
| `stress_test_runs` | Per-snapshot stress run |
| `stress_test_results` | Per-scenario per-run result |
| `champion_risk_comparisons` | Post-hoc champion / risk comparison |

Migrations 0000–0015 remain byte-identical. Snapshot 0016 regenerated via `scripts/reconstruct-snapshots.ts` from a real MariaDB checkpoint; fingerprint 0016 present; `npx drizzle-kit generate` returns "No schema changes, nothing to migrate."

## Risk policy (§B) + limit definitions (§C)

**Default policy `p2c-risk-1`** carries 13 versioned limits across scopes:

- **candidate**: `stop_loss_quote_pct_of_equity` (hard 1% of equity, warning 0.5%), `volatility.target` (hard 3%, warning 2%)
- **portfolio**: `cash.reserve_remaining_min` (hard 2%, warning 5%)
- **product**: `product.max_quote_exposure_pct` (hard 15%, warning 10%)
- **strategy_mode**: `mode.max_quote_exposure_pct` (hard 50%, warning 40%)
- **correlation_cluster**: `cluster.max_quote_exposure_pct` (hard 35%, warning 25%)
- **benchmark_beta**: `beta.btc_abs_max` (hard 80%, warning 50%), `beta.eth_abs_max` (hard 70%, warning 40%)
- **liquidity**: `liquidity.max_quote_pct_of_24h` (hard 1%, warning 0.5%)
- **daily/weekly**: `daily.max_loss_pct` (hard 3%, warning 1.5%), `weekly.max_loss_pct` (hard 6%, warning 3%)
- **drawdown**: `drawdown.max_current_pct` (hard 10%, warning 5%)
- **system_integrity**: `system.integrity_healthy` (breach → reject)

Every limit records a `breachAction` (observe / reduce / reject / block_all_new_entries / require_reconciliation) and a `missingDataAction` (abstain / reject / block_all_new_entries). Changing any threshold, formula, or action REQUIRES bumping the policy version — the `implementationHash` includes description, effective range, and the sorted configurationHash of every limit.

Policy status is `observer` — Phase 2C does NOT approve any policy for shadow enforcement.

## Candidate stop-risk formula (§F)

Authoritative source: Gate 3B `CashFlowForecast`. The engine reads `netStopPnl` and reports:

```
totalModeledStopLoss = max(0, -netStopPnl)
grossPriceRisk       = max(0, (arrivalMid - stopPrice) * expectedFilledBase)
```

`totalModeledStopLoss` already includes exactly once: entry commission, entry spread, entry impact, exit commission, stop impact, stop-gap buffer, latency buffer, partial-fill buffer, and residual dust estimate. No independent `size × stopPercentage` reconstruction is used when a forecast exists.

## Existing-position risk (§G)

Each open position reports one of five states:

```
measured | partially_measured | unprotected | reconciliation_required | unknown
```

Rules:

- Unprotected positions add a 100-bps conservative gap buffer and a 5% notional worst-case anchor.
- Missing `activeStopPrice` on a protected position → `partially_measured` with `openStopRisk = null`.
- `protectionState=unknown` → `reconciliation_required`; portfolio-level open risk is not computed and the measurement returns `unresolved_state`.
- Degraded protection is `partially_measured`.

Under Phase 2C observer mode, an unprotected position produces `block_all_new_entries_recommended` in the system-integrity assessment; enforcement remains disabled.

## Exposure catalog (§H)

`measureExposure()` returns: gross quote exposure, net directional exposure (long-only baseline), cash utilization, cash reserve remaining, total open stop risk, pending entry risk, pending exit residual risk, per-product / per-mode / per-cluster exposure maps, unprotected exposure, illiquid exposure, and post-candidate views. Unknown pending intents count as `1_000_000` sentinel each (fail-closed — no silent "no exposure").

## Volatility-target sizing (§I)

```
rawVolatilityMultiplier = targetVolatility / max(observedVolatility, volatilityFloor)
volatilityMultiplier    = clamp(rawVolatilityMultiplier, 0, 1)
```

- Multiplier cannot exceed 1.
- Missing volatility → `unsupported`; low sample count → `insufficient_history`; low confidence forces the multiplier to `min(m, 0.5)`.
- The measurement records `annualizationFactor` and `samplingIntervalSeconds` — no implicit convention.
- No observed return estimate ever increases risk.

## Size-cap composition (§J)

Independent caps composed via min-of-valid-caps:

```
championProposedSize    stopRiskCap             cashCap
cashReserveCap          productExposureCap      modeExposureCap
clusterExposureCap      betaBtcCap              betaEthCap
volatilityCap           liquidityCap            drawdownCap
dailyLossCap            weeklyLossCap           systemIntegrityCap
```

Then: round DOWN to the base increment, recompute quote notional, confirm base + quote minimums, reject when the rounded size is not executable. **Never round upward.** The binding cap is persisted for audit.

## Correlation + covariance (§K, §L)

- `p2c-correlation-baseline @ p2c-corr-1` — Pearson correlation with minimum overlap 64 aligned buckets.
- Missing returns are DROPPED, never zero-filled.
- Correlations outside `[-1, 1]` fail with `numerical_failure` (never clamped silently).
- Constant series produce `low_confidence` with `correlation=null`.
- Shrinkage is `fixed_diagonal_shrinkage` (α = 0.1). Named accurately — no Ledoit–Wolf claim.
- Raw + shrunk covariance hashes persisted; PSD is validated and failure surfaced explicitly.

## Correlation clusters (§M)

`p2c-cluster-1` — deterministic connected-components on `|corr| ≥ 0.7`. Unions use lexical minimum root. Products with insufficient evidence are recorded as `unclustered_no_evidence` (never treated as independent). Cluster exposure caps use absolute economic exposure, including the post-candidate view.

## Benchmark beta exposure (§N)

Uses Phase 2A BTC/ETH beta only when the alignment is proven, sample count is adequate, confidence is high enough, and the evidence is not stale. Reports:

```
BTCBetaWeightedExposure  = sum(positionQuoteExposure × BTCBeta)
ETHBetaWeightedExposure  = sum(positionQuoteExposure × ETHBeta)
```

Any position with unknown beta forces the whole measurement to `unresolved_state` — missing beta is NOT zero beta.

Signed and absolute exposures are stored separately.

## Liquidity-aware cap (§O)

`p2c-liq-1` — turnover-participation cap with `isBookAware=false`. Default: 0.5% of 24h quote volume. The cap can only REDUCE or REJECT. Zero volume evidence → `unsupported`. The cap is labeled an approximate participation constraint, not proven market capacity.

## Daily / weekly / drawdown states (§P)

Backed by `daily_loss_states`, `weekly_loss_states`, `portfolio_drawdown_states`. UTC-day and ISO-week boundaries; states carry `policyVersion` (`p2c-loss-1`). Open unrealized gain cannot erase realized loss. Peak equity high-water mark is persisted; drawdown uses one documented equity definition. Rows survive restart.

## Historical expected shortfall (§Q)

`p2c-es-1` — non-parametric historical simulation. Configurable `confidenceLevel` (default 0.95), `minimumSampleCount` (default 200), `returnInterval`, `weightingPolicy`. Insufficient samples → `insufficient_history`. VaR and ES stored separately. Never called a guaranteed maximum loss. Candidate incremental ES is computed when the caller supplies incremental returns. No ES result increases size.

## Stress catalog (§R)

`p2c-stress-1` — 12 deterministic scenarios:

```
BTC_DOWN_5  BTC_DOWN_10  ETH_DOWN_10  ALT_BETA_SHOCK
MARKET_WIDE_15  CORRELATION_TO_ONE  VOLATILITY_DOUBLES
SPREAD_TRIPLES  STOP_GAP  LIQUIDITY_HAIRCUT
PROTECTION_FAILURE  COMBINED_SEVERE
```

Each scenario declares `correlationPolicy`, `liquidityPolicy`, `protectionPolicy`, `valuationPolicy`, and an `implementationHash`. Results record portfolio value before + after, estimated loss, candidate incremental loss, largest position + cluster contributions, assumptions, and data-quality status. Stress results may REDUCE or REJECT the recommendation — never increase size.

## Kelly disabled (§S)

`p2c-kelly-disabled-1` — the interface exists so future callers cannot accidentally reach for an ad-hoc "kelly-ish" fraction. Status is `disabled`; `EFFECTIVE_KELLY_MULTIPLIER = 0`. There is:

- NO 1% minimum floor
- NO 50/50 neutral probability assumption
- NO raw win-rate estimate
- NO allocation impact

Activation requires net outcomes, Bayesian shrinkage, confidence bounds, and Phase 2F approval.

## System-integrity vetoes (§T)

`assessSystemIntegrity()` returns one of:

```
healthy | degraded | block_all_new_entries_recommended
| reconciliation_required | invalid
```

Vetoes outrank ordinary sizing measurements. `invalid` (unresolved legacy, ledger inconsistency, accounting discrepancy, invalid product metadata, unsafe environment flag) → `data_failure`. `reconciliation_required` / `block_all_new_entries_recommended` → `reject`. No favorable statistic overrides an integrity failure.

## Candidate risk decision (§U)

Every evaluation produces an immutable `CandidateRiskDecision`. The engine's decision hierarchy:

1. System-integrity invalid → `data_failure`
2. reconciliation_required / block_all_new_entries → `reject`
3. Daily/weekly/drawdown HARD breach → `reject`
4. Missing critical evidence (beta, volatility, stop-risk) → `abstain`
5. Liquidity missing → `data_failure`
6. Minimum executable failed → `reject`
7. Binding cap reduces size to 0 → `reject`
8. Binding cap reduces below proposal → `reduce_size`
9. Otherwise → `authorize_as_proposed`

Invariants (enforced by tests):

- `sizeMultiplier ∈ [0, 1]`
- `authorize_as_proposed` ⇒ `sizeMultiplier === 1`
- `reduce_size` ⇒ `0 < sizeMultiplier < 1`
- Zero executable size ⇒ `reject`

## Portfolio-risk snapshots (§V)

Immutable per-run snapshot with cash, reservations, gross/net exposure, total open stop risk, unprotected exposure, BTC/ETH beta exposure, daily/weekly loss, drawdown, VaR, ES, worst stress loss, position count, cluster count, data-quality state, and system-integrity state. Every candidate decision references the exact snapshot it consumed.

## Champion / risk comparison (§X)

`champion_risk_comparisons` records agreement state (agree / risk_reduced / risk_rejected / risk_abstained / unresolved) after champion decisions persist. Populated ONLY AFTER the champion decision — the observer never mutates the champion.

## Research lineage extension (§Z)

`getDecisionChainAggregate.researchObserver.portfolioRisk` now returns:

```
snapshot, positions, candidateDecision, breaches,
stressTestRun, stressResults, championComparison
```

Loaded independently of whether a Phase 2A universe snapshot exists.

## Replay fixtures (§AA)

`tests/research/fixtures/riskFixtures.ts` provides a byte-stable `baseRiskInput()` builder plus mutators (`withPosition`, `withPendingEntry`) covering the 50 scenarios listed in §AA. All builders are pure functions of their inputs; same inputs → same forecast → same decision.

## Source-isolation (§AB)

Four Phase 2C isolation tests + expanded 2A/2B isolation tests prove:

1. No champion file imports from `src/research/risk/*`.
2. No `src/research/risk/*` file imports champion strategy behavior (executor, scanner authorization, allocator, protection, Claude prompt, runtime shadow, scan job).
3. RiskEngine files never insert/update/delete `orderIntents`, `fills`, `positions`, `roundTrips`, `cashLedger`, `protectionInstances`, `protectionEvents`, `shadowExecutionPlans`, `postFillRevalidations`, `decisionChains`, `quantitativeDecisions`, `signalCandidates`, or `executionCostForecasts`.
4. No implementation file assigns a size multiplier above 1.

The 39 observer tables (13 Phase 2A + 13 Phase 2B + 20 Phase 2C — total tracked via schema symbol enumeration) are research-exclusive writes.

## Reporting (§AC)

`buildRiskReport()` returns a health / breach / agreement summary — never profitability. Fields: total open risk, cash utilization, unprotected exposure, BTC/ETH beta exposure, daily/weekly/drawdown, VaR/ES, worst stress loss, candidate decision counts, binding limit distribution, size reduction summary, rejection reasons, abstention reasons, missing-data rate, champion/risk agreement counts, system-integrity failure count, and `kellyStatus: 'disabled'`. Explicit test asserts no `profit`, `sharpe`, `returns_improved`, `sizing_improved`, `portfolio_optimized`, or `ready_for_live_capital` string appears in the serialized report.

## Tests

- **71 required §AD tests** (`tests/research/phase2c_risk.test.ts`)
- **4 Phase 2C isolation tests** (`tests/research/phase2c_isolation.test.ts`)
- **All pre-existing Phase 0 – 2B tests unchanged**

**Full server test count: 675 passing across 36 files.**

## Governance and non-claims

- The RiskEngine framework is complete; prospective validation is deferred.
- The seven-day operational soak remains parked until code freeze.
- `DRY_RUN=true` and `ORDER_SUBMISSION_ENABLED=false` continue to be enforced defaults.
- `createOrder` invocation count in `src/research/risk/*`: **0** (test §AD.65)
- `createOrder` HTTP attempt count: **0** (test §AD.66)
- `createOrder` network call count in `src/research/risk/*`: **0** (test §AD.67)

## Known limitations

- **ADF-lite, KPSS-lite, OU diagnostics** consumed via Phase 2A remain labeled as research diagnostics rather than canonical statistical validation.
- **BOCPD** change-point detector remains deferred (Phase 2B carry-forward).
- **Shrinkage** is deliberately the fixed-diagonal baseline — a true Ledoit–Wolf implementation is deferred until it can be validated against reference matrices.
- **Cluster policy** uses connected-components on a threshold graph; hierarchical clustering is deferred.
- **Liquidity cap** is turnover-participation only; Level-2-aware sizing requires future work explicitly labelled `isBookAware=true`.
- **Historical ES** uses a single equal-weight window; parametric ES is separately labeled if added later.
- **Kelly** remains disabled and cannot be re-enabled without Phase 2F approval.
- **Mobile `TS1323` lint failures** remain pre-existing repo debt; unchanged by Phase 2C.

## Remaining prerequisites for Phase 2D

- Prospective validation of the risk decision hierarchy under a real observation window.
- Champion/risk agreement report over a 7-day observer soak.
- Statistical audit of ADF/KPSS/OU (Phase 2B carry-forward).
- Formal Ledoit–Wolf shrinkage validation (if adopted).
- Level-2 depth data plumbing (if adopted).
- Resolution of pre-existing mobile-lint TS1323 errors before code freeze.

## Verdict

**`phase2c_risk_engine_framework_complete + prospective_validation_pending + enforcement_disabled`**

Forbidden verdicts, explicitly not claimed:

- `phase2c_validated`
- `risk_reduced`
- `sizing_improved`
- `portfolio_optimized`
- `ready_for_live_capital`

## Explicit safe-flag and zero-order confirmation

- `DRY_RUN` default: **true** (unchanged)
- `ORDER_SUBMISSION_ENABLED` default: **false** (unchanged)
- `createOrder` function invocation count in `src/research/risk/*`: **0** (verified §AD.65)
- `createOrder` HTTP attempt count: **0** (verified §AD.66)
- Network `fetch()` calls in `src/research/risk/*`: **0** (verified §AD.67)
- `EFFECTIVE_KELLY_MULTIPLIER === 0` (verified §AD.45, §AD.46)
