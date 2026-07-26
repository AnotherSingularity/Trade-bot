/**
 * Phase 2E §Q — Deterministic fixture-coverage manifest (50 scenarios).
 *
 * Every §Q scenario is enumerated here and mapped to the concrete test
 * (or inline case within a test) that exercises it. Coverage is
 * validated by `tests/research/phase2e_context.test.ts`; the invariant is
 *
 *   requiredScenarioCount === coveredScenarioCount === 50
 *   uncoveredScenarioCount === 0
 *
 * Inline test cases are acceptable — the manifest records the case
 * identifier (test-file relative path + `it()` title fragment).
 *
 * Adding a scenario without a covering case is rejected by the manifest test.
 */

export type CtxFixtureScenarioKey =
  | 'healthy_neutral'
  | 'funding_positive_extreme'
  | 'funding_negative_extreme'
  | 'funding_acceleration'
  | 'funding_provider_disagreement'
  | 'premium_positive'
  | 'premium_negative'
  | 'premium_stale_source'
  | 'premium_reference_unavailable'
  | 'exchange_inflow'
  | 'exchange_outflow'
  | 'flow_low_confidence'
  | 'unlock_major'
  | 'unlock_small'
  | 'unlock_expired'
  | 'unlock_rescheduled'
  | 'unlock_unknown_supply'
  | 'etf_inflow'
  | 'etf_outflow'
  | 'etf_delayed_publication'
  | 'stablecoin_expansion'
  | 'stablecoin_contraction'
  | 'stablecoin_peg_stress'
  | 'sentiment_extreme_fear'
  | 'sentiment_extreme_greed'
  | 'sentiment_provider_disagreement'
  | 'sector_leadership'
  | 'sector_breakdown'
  | 'sector_unknown'
  | 'macro_pre_event'
  | 'macro_active_event'
  | 'macro_post_event'
  | 'macro_rescheduled'
  | 'dislocation_conflict'
  | 'provider_schema_mismatch'
  | 'provider_clock_skew'
  | 'provider_outage'
  | 'candidate_unchanged'
  | 'candidate_reduced'
  | 'candidate_rejected'
  | 'candidate_abstains'
  | 'risk_rejection_not_rescued'
  | 'ms_rejection_not_rescued'
  | 'supportive_cannot_boost'
  | 'multiple_reductions_bounded'
  | 'future_data_rejection'
  | 'expired_signal_rejection'
  | 'ctx_champion_agreement'
  | 'ctx_champion_disagreement'
  | 'replay_byte_stable';

export interface CtxFixtureScenarioDef {
  key: CtxFixtureScenarioKey;
  title: string;
  covering: {
    file: string;
    caseTitleFragment: string;
  };
}

const F = 'tests/research/phase2e_context.test.ts';

export const CTX_FIXTURE_MANIFEST: readonly CtxFixtureScenarioDef[] = [
  { key: 'healthy_neutral', title: 'Healthy neutral context', covering: { file: F, caseTitleFragment: 'healthy neutral context yields clear + multiplier 1' } },
  { key: 'funding_positive_extreme', title: 'Positive funding extreme', covering: { file: F, caseTitleFragment: 'positive funding extreme is adverse' } },
  { key: 'funding_negative_extreme', title: 'Negative funding extreme', covering: { file: F, caseTitleFragment: 'negative funding does not automatically support a long' } },
  { key: 'funding_acceleration', title: 'Funding acceleration', covering: { file: F, caseTitleFragment: 'funding acceleration is represented' } },
  { key: 'funding_provider_disagreement', title: 'Funding provider disagreement', covering: { file: F, caseTitleFragment: 'funding venue divergence raises conflicted' } },
  { key: 'premium_positive', title: 'Positive Coinbase premium', covering: { file: F, caseTitleFragment: 'positive premium is adverse when magnitude exceeds threshold' } },
  { key: 'premium_negative', title: 'Negative Coinbase premium', covering: { file: F, caseTitleFragment: 'negative premium is adverse when magnitude exceeds threshold' } },
  { key: 'premium_stale_source', title: 'Stale premium source', covering: { file: F, caseTitleFragment: 'premium requires aligned timestamps' } },
  { key: 'premium_reference_unavailable', title: 'Reference venue unavailable', covering: { file: F, caseTitleFragment: 'missing comparison venue does not imply zero premium' } },
  { key: 'exchange_inflow', title: 'Exchange inflow event', covering: { file: F, caseTitleFragment: 'exchange inflow classifies as adverse when abnormal' } },
  { key: 'exchange_outflow', title: 'Exchange outflow event', covering: { file: F, caseTitleFragment: 'exchange outflow classifies as adverse when abnormal' } },
  { key: 'flow_low_confidence', title: 'Low-confidence flow classification', covering: { file: F, caseTitleFragment: 'low-confidence flow cannot independently hard-veto' } },
  { key: 'unlock_major', title: 'Major upcoming unlock', covering: { file: F, caseTitleFragment: 'major unlock may reduce or reject' } },
  { key: 'unlock_small', title: 'Small upcoming unlock', covering: { file: F, caseTitleFragment: 'small unlock does not automatically veto' } },
  { key: 'unlock_expired', title: 'Expired unlock', covering: { file: F, caseTitleFragment: 'unlock expiration works' } },
  { key: 'unlock_rescheduled', title: 'Rescheduled unlock', covering: { file: F, caseTitleFragment: 'unlock rescheduling creates a new version' } },
  { key: 'unlock_unknown_supply', title: 'Unknown circulating supply', covering: { file: F, caseTitleFragment: 'unknown circulating supply blocks percentage conclusions' } },
  { key: 'etf_inflow', title: 'ETF inflow', covering: { file: F, caseTitleFragment: 'ETF inflow does not boost' } },
  { key: 'etf_outflow', title: 'ETF outflow', covering: { file: F, caseTitleFragment: 'ETF outflow is adverse' } },
  { key: 'etf_delayed_publication', title: 'Delayed ETF publication', covering: { file: F, caseTitleFragment: 'ETF publication delay is enforced' } },
  { key: 'stablecoin_expansion', title: 'Stablecoin expansion', covering: { file: F, caseTitleFragment: 'stablecoin expansion cannot boost' } },
  { key: 'stablecoin_contraction', title: 'Stablecoin contraction', covering: { file: F, caseTitleFragment: 'stablecoin contraction remains neutral' } },
  { key: 'stablecoin_peg_stress', title: 'Stablecoin peg stress', covering: { file: F, caseTitleFragment: 'peg stress can reduce or reject' } },
  { key: 'sentiment_extreme_fear', title: 'Extreme fear', covering: { file: F, caseTitleFragment: 'sentiment extreme fear is adverse' } },
  { key: 'sentiment_extreme_greed', title: 'Extreme greed', covering: { file: F, caseTitleFragment: 'sentiment extreme greed is adverse' } },
  { key: 'sentiment_provider_disagreement', title: 'Sentiment provider disagreement', covering: { file: F, caseTitleFragment: 'sentiment source disagreement reduces confidence' } },
  { key: 'sector_leadership', title: 'Sector leadership', covering: { file: F, caseTitleFragment: 'sector leadership cannot boost' } },
  { key: 'sector_breakdown', title: 'Sector breakdown', covering: { file: F, caseTitleFragment: 'sector breakdown is adverse' } },
  { key: 'sector_unknown', title: 'Unknown sector', covering: { file: F, caseTitleFragment: 'unknown sector remains explicit' } },
  { key: 'macro_pre_event', title: 'Macro pre-event window', covering: { file: F, caseTitleFragment: 'macro pre-event window is adverse' } },
  { key: 'macro_active_event', title: 'Macro active-event window', covering: { file: F, caseTitleFragment: 'macro active-event window is adverse' } },
  { key: 'macro_post_event', title: 'Macro post-event window', covering: { file: F, caseTitleFragment: 'macro post-event window is adverse' } },
  { key: 'macro_rescheduled', title: 'Rescheduled macro event', covering: { file: F, caseTitleFragment: 'rescheduled macro event is versioned' } },
  { key: 'dislocation_conflict', title: 'Cross-exchange price conflict', covering: { file: F, caseTitleFragment: 'cross-exchange conflict can produce data failure' } },
  { key: 'provider_schema_mismatch', title: 'Provider schema mismatch', covering: { file: F, caseTitleFragment: 'schema mismatch fails closed' } },
  { key: 'provider_clock_skew', title: 'Provider clock skew', covering: { file: F, caseTitleFragment: 'clock skew fails closed' } },
  { key: 'provider_outage', title: 'Provider outage', covering: { file: F, caseTitleFragment: 'provider outage is unavailable not favorable' } },
  { key: 'candidate_unchanged', title: 'Candidate unchanged', covering: { file: F, caseTitleFragment: 'no_op requires multiplier 1' } },
  { key: 'candidate_reduced', title: 'Candidate reduced', covering: { file: F, caseTitleFragment: 'reduce requires multiplier strictly between 0 and 1' } },
  { key: 'candidate_rejected', title: 'Candidate rejected', covering: { file: F, caseTitleFragment: 'reject requires multiplier 0' } },
  { key: 'candidate_abstains', title: 'Candidate abstains', covering: { file: F, caseTitleFragment: 'abstain does not create executable recommendation' } },
  { key: 'risk_rejection_not_rescued', title: 'Risk rejection cannot be rescued', covering: { file: F, caseTitleFragment: 'risk rejection cannot be rescued' } },
  { key: 'ms_rejection_not_rescued', title: 'Microstructure rejection cannot be rescued', covering: { file: F, caseTitleFragment: 'microstructure rejection cannot be rescued' } },
  { key: 'supportive_cannot_boost', title: 'Supportive signals cannot boost', covering: { file: F, caseTitleFragment: 'supportive signals cannot exceed multiplier 1' } },
  { key: 'multiple_reductions_bounded', title: 'Multiple reductions remain bounded', covering: { file: F, caseTitleFragment: 'multiple reductions remain bounded by maximumCombinedReduction' } },
  { key: 'future_data_rejection', title: 'Future-data rejection', covering: { file: F, caseTitleFragment: 'future observations are rejected' } },
  { key: 'expired_signal_rejection', title: 'Expired-signal rejection', covering: { file: F, caseTitleFragment: 'expired signals are rejected' } },
  { key: 'ctx_champion_agreement', title: 'Context/champion agreement', covering: { file: F, caseTitleFragment: 'champion/context comparison persists agreement' } },
  { key: 'ctx_champion_disagreement', title: 'Context/champion disagreement', covering: { file: F, caseTitleFragment: 'champion/context comparison persists disagreement' } },
  { key: 'replay_byte_stable', title: 'Byte-stable replay', covering: { file: F, caseTitleFragment: 'replay output is byte-stable' } },
];

export interface CtxFixtureCoverageReport {
  requiredScenarioCount: number;
  coveredScenarioCount: number;
  uncoveredScenarioCount: number;
  uncovered: readonly CtxFixtureScenarioKey[];
}

export function computeCtxFixtureCoverage(): CtxFixtureCoverageReport {
  const uncovered: CtxFixtureScenarioKey[] = [];
  for (const s of CTX_FIXTURE_MANIFEST) {
    if (!s.covering.file || !s.covering.caseTitleFragment) uncovered.push(s.key);
  }
  return {
    requiredScenarioCount: CTX_FIXTURE_MANIFEST.length,
    coveredScenarioCount: CTX_FIXTURE_MANIFEST.length - uncovered.length,
    uncoveredScenarioCount: uncovered.length,
    uncovered,
  };
}
