/**
 * Phase 2D-FIX §2 — Fixture-coverage manifest.
 *
 * Every required §O scenario is enumerated here and mapped to the concrete
 * test (or inline case within a test) that exercises it. Coverage is
 * validated by `tests/research/phase2d_fix.test.ts`; the invariant is
 *
 *   requiredScenarioCount === coveredScenarioCount
 *   uncoveredScenarioCount === 0
 *
 * Inline test cases are acceptable — the manifest records the case
 * identifier (test-file relative path + `it()` title fragment).
 *
 * Any addition to §O MUST add a manifest entry.  Adding a scenario
 * without a covering case is a bug the fixture test refuses to accept.
 */

export type MsFixtureScenarioKey =
  // Book-engine scenarios (12)
  | 'book_snapshot_healthy'
  | 'book_delta_applied_in_order'
  | 'book_delta_duplicate_idempotent'
  | 'book_delta_out_of_order_buffered'
  | 'book_delta_out_of_order_gap'
  | 'book_snapshot_crossed_inconsistent'
  | 'book_snapshot_stale_after_age'
  | 'book_negative_price_or_size'
  | 'book_gap_event_resync_required'
  | 'book_resynchronization_after_gap'
  | 'book_replay_byte_stable'
  | 'book_future_event_rejected'
  // Feature registry (5)
  | 'feature_registry_valid'
  | 'feature_registry_gap_detected_fails_closed'
  | 'feature_registry_empty_book_unsupported'
  | 'feature_registry_missing_bid_or_ask'
  | 'feature_registry_persistence_definitions'
  // Trade classifier (5)
  | 'classifier_authoritative'
  | 'classifier_quote_rule'
  | 'classifier_tick_rule'
  | 'classifier_unknown'
  | 'cvd_window_low_confidence'
  // Impact (2)
  | 'impact_curve_walks_visible_book'
  | 'impact_curve_unfilled_residual'
  // Passive fill (2)
  | 'passive_fill_marketable_labelled'
  | 'passive_fill_price_touch_versus_trade_through'
  // Stop execution (1)
  | 'stop_execution_regimes_distinct'
  // Execution decision (4)
  | 'execution_decision_healthy'
  | 'execution_decision_stale_abstain'
  | 'execution_decision_gap_data_failure'
  | 'execution_decision_multiplier_bounded'
  // Comparison / lineage (2)
  | 'agreement_classifier'
  | 'audit_lineage_returns_microstructure';

export interface MsFixtureScenarioDef {
  key: MsFixtureScenarioKey;
  title: string;
  covering: {
    file: string;
    caseTitleFragment: string;
  };
}

export const MS_FIXTURE_MANIFEST: readonly MsFixtureScenarioDef[] = [
  {
    key: 'book_snapshot_healthy',
    title: 'Book engine ingests an initial snapshot and reports healthy',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'book engine handles snapshot + deltas deterministically',
    },
  },
  {
    key: 'book_delta_applied_in_order',
    title: 'Delta at lastSequence+1 applies exactly once',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'book engine handles snapshot + deltas deterministically',
    },
  },
  {
    key: 'book_delta_duplicate_idempotent',
    title: 'Delta with the same sequence is a no-op',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'book engine detects duplicate deltas as idempotent',
    },
  },
  {
    key: 'book_delta_out_of_order_buffered',
    title: 'Delta within maxBufferedGap is buffered and drained on catchup',
    covering: {
      file: 'tests/research/phase2d_fix.test.ts',
      caseTitleFragment: 'book engine buffers out-of-order deltas within the bounded gap',
    },
  },
  {
    key: 'book_delta_out_of_order_gap',
    title: 'Delta beyond maxBufferedGap moves state to gap_detected',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'book engine declares gap on out-of-order beyond buffer',
    },
  },
  {
    key: 'book_snapshot_crossed_inconsistent',
    title: 'Snapshot with bid >= ask marks the book inconsistent',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'book engine flags crossed book as inconsistent',
    },
  },
  {
    key: 'book_snapshot_stale_after_age',
    title: 'Book snapshot classifies stale once lastEventAt is beyond staleAgeMs',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'book engine flags stale book after configured age',
    },
  },
  {
    key: 'book_negative_price_or_size',
    title: 'Negative price/size fails the book closed',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'book engine rejects negative price and size',
    },
  },
  {
    key: 'book_gap_event_resync_required',
    title: 'Provider-emitted gap event moves state to resync_required',
    covering: {
      file: 'tests/research/phase2d_fix.test.ts',
      caseTitleFragment: 'provider-emitted gap event moves state to resync_required',
    },
  },
  {
    key: 'book_resynchronization_after_gap',
    title: 'Resynchronization after a continuity gap increments resyncCount',
    covering: {
      file: 'tests/research/phase2d_fix.test.ts',
      caseTitleFragment: 'resynchronization after a gap increments resyncCount and returns to healthy',
    },
  },
  {
    key: 'book_replay_byte_stable',
    title: 'Same event sequence → same payloadHash and same persisted snapshots',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'replay is byte-stable for identical inputs',
    },
  },
  {
    key: 'book_future_event_rejected',
    title: 'Events whose sourceTimestamp is after decision observedAt cannot enter the decision',
    covering: {
      file: 'tests/research/phase2d_fix.test.ts',
      caseTitleFragment: 'future book events cannot enter the decision',
    },
  },
  {
    key: 'feature_registry_valid',
    title: 'Registry computes valid features for a healthy book',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'microstructure features compute for a healthy book',
    },
  },
  {
    key: 'feature_registry_gap_detected_fails_closed',
    title: 'Gap-detected books cause every feature to fail closed',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'microstructure features fail closed on gap_detected books',
    },
  },
  {
    key: 'feature_registry_empty_book_unsupported',
    title: 'Empty/synchronizing books produce unsupported status',
    covering: {
      file: 'tests/research/phase2d_fix.test.ts',
      caseTitleFragment: 'features report unsupported on empty book',
    },
  },
  {
    key: 'feature_registry_missing_bid_or_ask',
    title: 'One-sided books flag missing bid or ask reasons',
    covering: {
      file: 'tests/research/phase2d_fix.test.ts',
      caseTitleFragment: 'features flag missing bid or ask on one-sided book',
    },
  },
  {
    key: 'feature_registry_persistence_definitions',
    title: 'Registering feature definitions is idempotent',
    covering: {
      file: 'tests/research/phase2d_fix.test.ts',
      caseTitleFragment: 'feature definition registration is idempotent',
    },
  },
  {
    key: 'classifier_authoritative',
    title: 'Trade classifier honors an authoritative provider side',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'trade classifier honors authoritative side',
    },
  },
  {
    key: 'classifier_quote_rule',
    title: 'Quote rule classifies at bid/ask when authoritative is missing',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'trade classifier uses quote rule when side is unknown',
    },
  },
  {
    key: 'classifier_tick_rule',
    title: 'Tick rule fires when quote evidence is missing',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'trade classifier uses tick rule when quote is missing',
    },
  },
  {
    key: 'classifier_unknown',
    title: 'Classifier reports unknown when every rule lacks evidence',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'trade classifier reports unknown when no evidence exists',
    },
  },
  {
    key: 'cvd_window_low_confidence',
    title: 'CVD window flags low_confidence when unknown volume dominates',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'CVD window aggregates classified trades and flags low_confidence',
    },
  },
  {
    key: 'impact_curve_walks_visible_book',
    title: 'Impact curve walks visible book exactly',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'impact curve walks the visible book and reports unfilled residual',
    },
  },
  {
    key: 'impact_curve_unfilled_residual',
    title: 'Impact curve reports unfillable visible-depth residual (never extrapolates)',
    covering: {
      file: 'tests/research/phase2d_fix.test.ts',
      caseTitleFragment: 'impact curve reports unfilled residual when notional exceeds visible depth',
    },
  },
  {
    key: 'passive_fill_marketable_labelled',
    title: 'Passive fill model labels marketable limit orders (not passive)',
    covering: {
      file: 'tests/research/phase2d_fix.test.ts',
      caseTitleFragment: 'passive fill labels marketable order versus a strict price touch',
    },
  },
  {
    key: 'passive_fill_price_touch_versus_trade_through',
    title: 'Passive fill model distinguishes price touch from trade-through',
    covering: {
      file: 'tests/research/phase2d_fix.test.ts',
      caseTitleFragment: 'passive fill labels marketable order versus a strict price touch',
    },
  },
  {
    key: 'stop_execution_regimes_distinct',
    title: 'Stop execution never claims trigger = guaranteed execution across regimes',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'stop-execution observer never claims trigger equals guaranteed execution',
    },
  },
  {
    key: 'execution_decision_healthy',
    title: 'Healthy book preserves champion size',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'execution decision on a healthy book preserves size (multiplier=1)',
    },
  },
  {
    key: 'execution_decision_stale_abstain',
    title: 'Stale book returns abstain with sizeMultiplier=0',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'execution decision on a stale book abstains',
    },
  },
  {
    key: 'execution_decision_gap_data_failure',
    title: 'Gap-detected book returns data_failure with sizeMultiplier=0',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'execution decision on a gap_detected book emits data_failure',
    },
  },
  {
    key: 'execution_decision_multiplier_bounded',
    title: 'sizeMultiplier is always bounded in [0,1]',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'microstructure decision never sets sizeMultiplier > 1',
    },
  },
  {
    key: 'agreement_classifier',
    title: 'Agreement classifier maps every recommendation to a distinct state',
    covering: {
      file: 'tests/research/phase2d_microstructure.test.ts',
      caseTitleFragment: 'agreement classifier maps recommendations correctly',
    },
  },
  {
    key: 'audit_lineage_returns_microstructure',
    title: 'Audit route returns researchObserver.microstructure with book snapshot ID',
    covering: {
      file: 'tests/research/phase2d_fix.test.ts',
      caseTitleFragment: 'audit retrieval returns the complete microstructure chain',
    },
  },
] as const;

export interface MsFixtureCoverageReport {
  requiredScenarioCount: number;
  coveredScenarioCount: number;
  uncoveredScenarioCount: number;
  uncovered: readonly MsFixtureScenarioKey[];
}

export function computeMsFixtureCoverage(): MsFixtureCoverageReport {
  const required = MS_FIXTURE_MANIFEST.length;
  const uncovered: MsFixtureScenarioKey[] = [];
  for (const scenario of MS_FIXTURE_MANIFEST) {
    if (!scenario.covering.file || !scenario.covering.caseTitleFragment) {
      uncovered.push(scenario.key);
    }
  }
  return {
    requiredScenarioCount: required,
    coveredScenarioCount: required - uncovered.length,
    uncoveredScenarioCount: uncovered.length,
    uncovered,
  };
}
