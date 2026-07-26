# Phase 3B §G — Statistical audit summary

## Approximation labels

Every statistical primitive in the observer stack retains a HONEST
name in code + docs:

| Primitive | Location | Honest label preserved? |
|---|---|---|
| Hurst exponent (R/S) | apps/server/src/observers/context/hurst.ts | yes — labeled `hurstApprox` in output shape |
| Variance ratio (Lo–MacKinlay) | apps/server/src/observers/context/varianceRatio.ts | yes — `varianceRatioApprox` |
| ADF-lite | apps/server/src/observers/context/adf.ts | yes — `adfLite` + comment: "approximation, not the full ADF" |
| KPSS-lite | apps/server/src/observers/context/kpss.ts | yes — `kpssLite` + comment |
| OU fit + half-life | apps/server/src/observers/context/ou.ts | yes — `ouLinearFit` documented as biased estimator |
| CUSUM change point | apps/server/src/observers/regime/cusum.ts | yes |
| Segmented variance | apps/server/src/observers/regime/segmentedVariance.ts | yes — `secondaryDetector` |
| Semantic HMM | apps/server/src/observers/regime/hmm.ts | yes — `semanticHmmDeterministic` |
| Correlation matrix | apps/server/src/observers/risk/correlation.ts | yes |
| Covariance shrinkage (Ledoit–Wolf) | apps/server/src/observers/risk/covariance.ts | yes — `shrinkageApprox` |
| Cluster detection | apps/server/src/observers/risk/clusters.ts | yes — `clustersHeuristic` |
| Beta exposure | apps/server/src/observers/risk/beta.ts | yes |
| Historical VaR / ES | apps/server/src/observers/risk/var.ts | yes |
| Stress tests | apps/server/src/observers/risk/stress.ts | yes — deterministic scenarios named |
| Market-impact curves | apps/server/src/observers/microstructure/impact.ts | yes — `linearImpactApprox` |
| PBO (Bailey & López de Prado) | apps/server/src/validation/pbo.ts | yes |
| Deflated Sharpe | apps/server/src/validation/dsr.ts | yes |
| Unified multiplier | apps/server/src/validation/multiplier.ts | yes — `min(...)` composition with 1.0 ceiling |

## Composition rules

- No multiplier above 1 (enforced by Zod schema `z.number().max(1)`
  on ObserverMultiplier).
- No favorable fallback on numerical failure (every observer returns
  `{ok:false, reason}` and the ensemble treats missing evidence as
  neutral, not favorable).
- Failed audits block promotion use (`promotion_gates` requires all
  audits ok=true).
- Statistical results remain observer-only (no champion writer imports
  observer output — see isolation report).
- Historical replay remains labeled historical (`isHistoricalReplay`
  flag propagates through the lineage tables).

## Numerical audit reference

See `phase3b_audit/reports/numerical_audit.json` for the static grep
of every `Number()`, `parseFloat`, `Infinity`, `NaN` and `+ str`
call site. Every non-comment hit is either:

- Inside `Money`/decimal helpers with a `Number.isFinite` guard,
- An explicit test literal, or
- A documented sentinel (e.g. `Infinity` used as a comparison
  ceiling in a validated context).

## Result

Statistical approximation labels honest. No silent NaN / Infinity /
coercion. Composition ceiling enforced.
