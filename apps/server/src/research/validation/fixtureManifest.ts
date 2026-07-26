/**
 * Phase 2F §U — Deterministic fixture-coverage manifest (52 scenarios).
 *
 * Every §U scenario is enumerated here and mapped to the concrete test
 * (or inline case within a test) that exercises it. Coverage is
 * validated by `tests/research/phase2f_validation.test.ts`; the invariant is
 *
 *   requiredScenarioCount === coveredScenarioCount === 52
 *   uncoveredScenarioCount === 0
 *
 * Inline test cases are acceptable — the manifest records the case
 * identifier (test-file relative path + `it()` title fragment).
 */

export type ValidationFixtureScenarioKey =
  | 'clean_expanding_walk_forward'
  | 'clean_rolling_walk_forward'
  | 'anchored_walk_forward'
  | 'label_overlap_requires_purge'
  | 'embargo_enforcement'
  | 'future_observation_leak'
  | 'future_label_leak'
  | 'revised_data_availability_violation'
  | 'train_test_overlap'
  | 'final_holdout_contamination'
  | 'product_survivorship_bias'
  | 'outcome_informed_exclusion'
  | 'empty_fold'
  | 'failed_fold'
  | 'deterministic_fold_generation'
  | 'deterministic_cpcv_paths'
  | 'pbo_insufficient_candidates'
  | 'high_pbo_candidate_family'
  | 'low_pbo_candidate_family'
  | 'dsr_one_trial'
  | 'dsr_many_trials'
  | 'skewed_returns'
  | 'heavy_tailed_returns'
  | 'invalid_zero_variance'
  | 'gross_positive_net_negative'
  | 'strong_aggregate_catastrophic_subgroup'
  | 'regime_instability'
  | 'product_instability'
  | 'liquidity_instability'
  | 'excessive_drawdown'
  | 'excessive_es'
  | 'forecast_cost_failure'
  | 'unified_challenger_agreement'
  | 'unified_challenger_reduction'
  | 'unified_challenger_rejection'
  | 'unified_challenger_conflict'
  | 'missing_observer_evidence'
  | 'risk_rejection_preserved'
  | 'microstructure_rejection_preserved'
  | 'context_veto_preserved'
  | 'promotion_without_registered_experiment'
  | 'promotion_without_prospective_evidence'
  | 'promotion_with_leakage_violation'
  | 'promotion_with_high_pbo'
  | 'promotion_with_failed_dsr'
  | 'promotion_with_subgroup_catastrophe'
  | 'promotion_without_human_approval'
  | 'structurally_eligible_promotion'
  | 'rollback_target_preserved'
  | 'kelly_activation_rejected'
  | 'claude_attribution_pending'
  | 'byte_stable_replay';

export interface ValidationFixtureScenarioDef {
  key: ValidationFixtureScenarioKey;
  title: string;
  covering: {
    file: string;
    caseTitleFragment: string;
  };
}

const F = 'tests/research/phase2f_validation.test.ts';

export const VALIDATION_FIXTURE_MANIFEST: readonly ValidationFixtureScenarioDef[] = [
  { key: 'clean_expanding_walk_forward', title: 'Clean expanding walk-forward', covering: { file: F, caseTitleFragment: 'clean expanding walk-forward generates monotone folds' } },
  { key: 'clean_rolling_walk_forward', title: 'Clean rolling walk-forward', covering: { file: F, caseTitleFragment: 'clean rolling walk-forward generates fixed-window folds' } },
  { key: 'anchored_walk_forward', title: 'Anchored walk-forward', covering: { file: F, caseTitleFragment: 'anchored walk-forward pins the training start' } },
  { key: 'label_overlap_requires_purge', title: 'Label overlap requires purge', covering: { file: F, caseTitleFragment: 'label overlap requires purge' } },
  { key: 'embargo_enforcement', title: 'Embargo enforcement', covering: { file: F, caseTitleFragment: 'embargo is enforced' } },
  { key: 'future_observation_leak', title: 'Future observation leak', covering: { file: F, caseTitleFragment: 'future observations are rejected' } },
  { key: 'future_label_leak', title: 'Future label leak', covering: { file: F, caseTitleFragment: 'future labels are rejected' } },
  { key: 'revised_data_availability_violation', title: 'Revised data availability violation', covering: { file: F, caseTitleFragment: 'revised-data publication time is respected' } },
  { key: 'train_test_overlap', title: 'Train/test overlap', covering: { file: F, caseTitleFragment: 'training/validation overlap is rejected' } },
  { key: 'final_holdout_contamination', title: 'Final holdout contamination', covering: { file: F, caseTitleFragment: 'final holdout contamination is rejected' } },
  { key: 'product_survivorship_bias', title: 'Product survivorship bias', covering: { file: F, caseTitleFragment: 'product survivorship bias is detected' } },
  { key: 'outcome_informed_exclusion', title: 'Outcome-informed exclusion', covering: { file: F, caseTitleFragment: 'outcome-informed exclusions are rejected' } },
  { key: 'empty_fold', title: 'Empty fold', covering: { file: F, caseTitleFragment: 'empty folds remain explicit' } },
  { key: 'failed_fold', title: 'Failed fold', covering: { file: F, caseTitleFragment: 'failed folds remain explicit' } },
  { key: 'deterministic_fold_generation', title: 'Deterministic fold generation', covering: { file: F, caseTitleFragment: 'fold generation is deterministic' } },
  { key: 'deterministic_cpcv_paths', title: 'Deterministic CPCV paths', covering: { file: F, caseTitleFragment: 'CPCV path generation is deterministic' } },
  { key: 'pbo_insufficient_candidates', title: 'PBO insufficient candidates', covering: { file: F, caseTitleFragment: 'PBO requires multiple candidates' } },
  { key: 'high_pbo_candidate_family', title: 'High PBO candidate family', covering: { file: F, caseTitleFragment: 'high-PBO fixture is identified' } },
  { key: 'low_pbo_candidate_family', title: 'Low PBO candidate family', covering: { file: F, caseTitleFragment: 'low-PBO fixture remains distinct' } },
  { key: 'dsr_one_trial', title: 'DSR one trial', covering: { file: F, caseTitleFragment: 'DSR one trial computes without multiple-testing penalty' } },
  { key: 'dsr_many_trials', title: 'DSR many trials', covering: { file: F, caseTitleFragment: 'DSR many trials penalizes observed Sharpe' } },
  { key: 'skewed_returns', title: 'Skewed returns', covering: { file: F, caseTitleFragment: 'DSR accounts for skewness' } },
  { key: 'heavy_tailed_returns', title: 'Heavy-tailed returns', covering: { file: F, caseTitleFragment: 'DSR accounts for kurtosis' } },
  { key: 'invalid_zero_variance', title: 'Invalid zero variance', covering: { file: F, caseTitleFragment: 'DSR invalid variance fails explicitly' } },
  { key: 'gross_positive_net_negative', title: 'Gross positive but net negative', covering: { file: F, caseTitleFragment: 'gross-positive net-negative fails net evaluation' } },
  { key: 'strong_aggregate_catastrophic_subgroup', title: 'Strong aggregate with catastrophic subgroup', covering: { file: F, caseTitleFragment: 'strong aggregate cannot hide catastrophic slice' } },
  { key: 'regime_instability', title: 'Regime instability', covering: { file: F, caseTitleFragment: 'regime instability marks subgroup catastrophic' } },
  { key: 'product_instability', title: 'Product instability', covering: { file: F, caseTitleFragment: 'product instability marks subgroup catastrophic' } },
  { key: 'liquidity_instability', title: 'Liquidity instability', covering: { file: F, caseTitleFragment: 'liquidity instability marks subgroup catastrophic' } },
  { key: 'excessive_drawdown', title: 'Excessive drawdown', covering: { file: F, caseTitleFragment: 'excessive drawdown metric persists' } },
  { key: 'excessive_es', title: 'Excessive ES', covering: { file: F, caseTitleFragment: 'excessive expected shortfall persists' } },
  { key: 'forecast_cost_failure', title: 'Forecast cost failure', covering: { file: F, caseTitleFragment: 'forecast cost error metric persists' } },
  { key: 'unified_challenger_agreement', title: 'Unified challenger agreement', covering: { file: F, caseTitleFragment: 'unified challenger agrees when every observer is neutral' } },
  { key: 'unified_challenger_reduction', title: 'Unified challenger reduction', covering: { file: F, caseTitleFragment: 'unified challenger reduces on adverse observer signal' } },
  { key: 'unified_challenger_rejection', title: 'Unified challenger rejection', covering: { file: F, caseTitleFragment: 'unified challenger rejects on hard rejection' } },
  { key: 'unified_challenger_conflict', title: 'Unified challenger conflict', covering: { file: F, caseTitleFragment: 'unified challenger produces conflict on conflicts' } },
  { key: 'missing_observer_evidence', title: 'Missing observer evidence', covering: { file: F, caseTitleFragment: 'missing observer evidence produces abstain or data failure' } },
  { key: 'risk_rejection_preserved', title: 'Risk rejection preserved', covering: { file: F, caseTitleFragment: 'unified challenger preserves risk rejection' } },
  { key: 'microstructure_rejection_preserved', title: 'Microstructure rejection preserved', covering: { file: F, caseTitleFragment: 'unified challenger preserves microstructure rejection' } },
  { key: 'context_veto_preserved', title: 'Context veto preserved', covering: { file: F, caseTitleFragment: 'unified challenger preserves context veto' } },
  { key: 'promotion_without_registered_experiment', title: 'Promotion without registered experiment', covering: { file: F, caseTitleFragment: 'promotion requires a registered experiment' } },
  { key: 'promotion_without_prospective_evidence', title: 'Promotion without prospective evidence', covering: { file: F, caseTitleFragment: 'promotion requires prospective evidence' } },
  { key: 'promotion_with_leakage_violation', title: 'Promotion with leakage violation', covering: { file: F, caseTitleFragment: 'promotion with leakage violation is blocked' } },
  { key: 'promotion_with_high_pbo', title: 'Promotion with high PBO', covering: { file: F, caseTitleFragment: 'promotion with high PBO is blocked' } },
  { key: 'promotion_with_failed_dsr', title: 'Promotion with failed DSR', covering: { file: F, caseTitleFragment: 'promotion with failed DSR is blocked' } },
  { key: 'promotion_with_subgroup_catastrophe', title: 'Promotion with subgroup catastrophe', covering: { file: F, caseTitleFragment: 'promotion with subgroup catastrophe is blocked' } },
  { key: 'promotion_without_human_approval', title: 'Promotion without human approval', covering: { file: F, caseTitleFragment: 'promotion requires human approval' } },
  { key: 'structurally_eligible_promotion', title: 'Structurally eligible promotion', covering: { file: F, caseTitleFragment: 'structurally eligible promotion fixture demonstrates engine can represent eligibility' } },
  { key: 'rollback_target_preserved', title: 'Rollback target preserved', covering: { file: F, caseTitleFragment: 'rollback target is persisted' } },
  { key: 'kelly_activation_rejected', title: 'Kelly activation rejected', covering: { file: F, caseTitleFragment: 'Kelly remains disabled' } },
  { key: 'claude_attribution_pending', title: 'Claude attribution pending', covering: { file: F, caseTitleFragment: 'Claude attribution remains pending' } },
  { key: 'byte_stable_replay', title: 'Byte-stable replay', covering: { file: F, caseTitleFragment: 'replay output is byte-stable' } },
];

export interface ValidationFixtureCoverageReport {
  requiredScenarioCount: number;
  coveredScenarioCount: number;
  uncoveredScenarioCount: number;
  uncovered: readonly ValidationFixtureScenarioKey[];
}

export function computeValidationFixtureCoverage(): ValidationFixtureCoverageReport {
  const uncovered: ValidationFixtureScenarioKey[] = [];
  for (const s of VALIDATION_FIXTURE_MANIFEST) {
    if (!s.covering.file || !s.covering.caseTitleFragment) uncovered.push(s.key);
  }
  return {
    requiredScenarioCount: VALIDATION_FIXTURE_MANIFEST.length,
    coveredScenarioCount: VALIDATION_FIXTURE_MANIFEST.length - uncovered.length,
    uncoveredScenarioCount: uncovered.length,
    uncovered,
  };
}
