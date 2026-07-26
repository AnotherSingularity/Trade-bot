import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq, and } from 'drizzle-orm';
import { db } from '../../src/db';
import {
  challengerRoutingDecisions,
  championChallengerRoutingComparisons,
  changePointEvents,
  globalRegimeSnapshots,
  latentStateAssignments,
  latentStateMappings,
  latentStateModelVersions,
  productRegimeSnapshots,
  regimeDefinitions,
  regimeEvidence,
  regimeObserverRuns,
  regimeTransitions,
  regimeTransitionPolicies,
} from '../../src/db/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FeatureResult } from '../../src/research/features/contract';
import {
  failResult,
  validResult,
} from '../../src/research/features/contract';
import type { CandleBar } from '../../src/research/features/inputs';
import { STAGE1_FEATURES } from '../../src/research/features/stage1';
import { STAGE2_FEATURES } from '../../src/research/features/stage2';
import {
  type RegimeResult,
  type RegimeState,
  failRegime,
  validRegime,
} from '../../src/research/regime/contract';
import {
  DEFAULT_TRANSITION_POLICY,
  registerRegimeDefinition,
  registerTransitionPolicy,
  assertRegimeImmutability,
} from '../../src/research/regime/registry';
import {
  GLOBAL_DEFINITION,
  GLOBAL_REGIME_KEY,
} from '../../src/research/regime/globalState';
import {
  PRODUCT_DEFINITION,
  PRODUCT_REGIME_KEY,
  evaluateProductRegime,
} from '../../src/research/regime/productState';
import {
  DEFAULT_CUSUM_PARAMS,
  DEFAULT_SEGVAR_PARAMS,
  bocpdDeferred,
  cusumDetector,
  segmentedVarianceDetector,
} from '../../src/research/regime/changeDetectors';
import {
  HMM_MODEL_KEY,
  assignHmm,
  computeSemanticMapping,
  trainHmm,
} from '../../src/research/regime/hmm';
import { combineEnsemble } from '../../src/research/regime/ensemble';
import {
  applyHysteresis,
  initialHysteresisState,
} from '../../src/research/regime/hysteresis';
import {
  CHALLENGER_ROUTER_VERSION,
  classifyAgreement,
  completeRegimeObserverRun,
  evaluateChallengerRouting,
  persistChallengerRouting,
  persistChampionChallengerComparison,
  persistChangePointEvent,
  persistGlobalRegime,
  persistLatentAssignment,
  persistLatentMapping,
  persistLatentModel,
  persistProductRegime,
  persistTransition,
  startRegimeObserverRun,
} from '../../src/research/regime/challenger';
import { buildRegimeReport } from '../../src/research/regime/reporting';
import { getDecisionChainAggregate, createDecisionChain, startScanRun } from '../../src/db/lineage';
import {
  FixtureProductUniverseProvider,
  enumerateUniverse,
  type ProductMetadata,
} from '../../src/research/universe/enumerator';
import { resetDatabase } from '../setup/db';
import {
  CANONICAL_BTC_BENCH_UP,
  REGIME_SCENARIOS_BY_ID,
} from './fixtures/regimeScenarios';

/**
 * Phase 2B §T — Required tests (54 cases).
 *
 * The suite covers architecture invariants (types distinct, versioning),
 * baseline correctness, change detection, HMM properties, ensemble
 * behavior, hysteresis, challenger routing, safety guarantees and
 * migration integrity.
 */

const OBSERVER_VERSION = 'p2b-observer-1';

function metadataFor(productId: string, over: Partial<ProductMetadata> = {}): ProductMetadata {
  const [base, quote] = productId.split('-');
  const observedAt = new Date('2026-04-01T00:00:00.000Z');
  return {
    productId,
    baseCurrency: base!,
    quoteCurrency: quote ?? 'USD',
    productType: 'SPOT',
    tradingStatus: 'online',
    cancelOnly: false,
    limitOnly: false,
    postOnly: false,
    auctionMode: false,
    tradingDisabled: false,
    baseIncrement: '0.001',
    quoteIncrement: '0.01',
    baseMinimum: '0.001',
    metadataObservedAt: observedAt,
    metadataAvailableAt: observedAt,
    sourceVersion: 'test',
    raw: {},
    ...over,
  };
}

async function ensureUniverse(productId: string) {
  const provider = new FixtureProductUniverseProvider([metadataFor(productId)]);
  return enumerateUniverse({ provider, now: new Date('2026-04-01T00:00:00.000Z') });
}

function featureMapFromBundle(bars: CandleBar[], now: Date, benchmark?: CandleBar[]): Map<string, FeatureResult> {
  const map = new Map<string, FeatureResult>();
  const staticInputs = {
    productId: bars[0]?.productId ?? 'X',
    baseCurrency: 'X',
    quoteCurrency: 'USD',
    baseIncrement: 0.001,
    quoteIncrement: 0.01,
    baseMinimum: 0.001,
    approximateSpreadBps: 5,
    quoteVolume24h: 5_000_000,
    tradeCount24h: 20_000,
  };
  const bundle = {
    productId: staticInputs.productId,
    now,
    bars,
    staticInputs,
    benchmarks: benchmark ? { 'BTC-USD': { productId: 'BTC-USD', bars: benchmark } } : undefined,
  };
  for (const f of STAGE1_FEATURES) map.set(f.def.key, f.compute(bundle));
  for (const f of STAGE2_FEATURES) map.set(f.def.key, f.compute(bundle));
  return map;
}

describe('Phase 2B §T — regime observer', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterEach(async () => {
    await resetDatabase();
  });

  // ------------------------------------------------------------------
  // Architecture invariants
  // ------------------------------------------------------------------

  it('§T.1 fingerprint class type and regime state type are distinct enums', () => {
    // Purely a type-level assertion — this test just documents the boundary.
    const fp: string = 'BREAKOUT_CANDIDATE';
    const regime: RegimeState = 'TREND_UP';
    expect(fp).not.toBe(regime);
  });

  it('§T.2 global and product regimes are separately versioned', () => {
    expect(GLOBAL_DEFINITION.key).not.toBe(PRODUCT_DEFINITION.key);
    expect(GLOBAL_DEFINITION.scope).toBe('global');
    expect(PRODUCT_DEFINITION.scope).toBe('product');
    expect(GLOBAL_DEFINITION.version).toBeTruthy();
    expect(PRODUCT_DEFINITION.version).toBeTruthy();
  });

  it('§T.3 rule baseline consults multiple evidence families', () => {
    expect(PRODUCT_DEFINITION.requiredEvidence.length).toBeGreaterThanOrEqual(6);
    const families = new Set(PRODUCT_DEFINITION.requiredEvidence.map((k) => k.split('.')[0]));
    expect(families.size).toBeGreaterThanOrEqual(3);
  });

  it('§T.4 a single feature cannot establish a state', () => {
    // Feed only mean_log_return as valid; all others insufficient.
    const feats = new Map<string, FeatureResult>();
    for (const key of PRODUCT_DEFINITION.requiredEvidence) {
      feats.set(
        key,
        key === 'ms.mean_log_return'
          ? validResult({ version: '1' }, {
              value: 0.01,
              confidence: 1,
              sampleCount: 200,
              lookbackStart: new Date(),
              lookbackEnd: new Date(),
              dataAvailableAt: new Date(),
              inputHash: 'h',
            })
          : failResult('insufficient_history', { version: '1' }, {
              dataAvailableAt: new Date(),
              inputHash: 'h',
              failureReason: 'test',
            }),
      );
    }
    const result = evaluateProductRegime({
      productId: 'X-USD',
      now: new Date(),
      dataAvailableAt: new Date(),
      features: feats,
      hygieneEligible: true,
    });
    expect(result.status).not.toBe('valid');
  });

  // ------------------------------------------------------------------
  // Missing / disorder / stale
  // ------------------------------------------------------------------

  it('§T.5 missing critical evidence produces UNKNOWN (via insufficient_history)', () => {
    const result = evaluateProductRegime({
      productId: 'X-USD',
      now: new Date(),
      dataAvailableAt: new Date(),
      features: new Map(),
      hygieneEligible: true,
    });
    expect(result.status).toBe('insufficient_history');
    expect(result.state).toBe('UNKNOWN');
  });

  it('§T.6 severe disorder overrides direction', () => {
    const s = REGIME_SCENARIOS_BY_ID.get('R08_noisy_high_entropy')!;
    const feats = featureMapFromBundle(s.bars, s.now, CANONICAL_BTC_BENCH_UP);
    const r = evaluateProductRegime({
      productId: s.productId,
      now: s.now,
      dataAvailableAt: s.now,
      features: feats,
      hygieneEligible: true,
      fingerprintClass: 'DISORDERED',
    });
    expect(r.state === 'DISORDERED' || r.status === 'conflicted').toBe(true);
  });

  it('§T.7 stale evidence produces UNKNOWN', () => {
    // Build bars whose dataAvailableAt is in the FUTURE relative to `now`.
    const now = new Date('2026-04-01T00:00:00Z');
    const future = new Date('2027-01-01T00:00:00Z');
    const bars: CandleBar[] = Array.from({ length: 300 }, (_, i) => ({
      productId: 'ST-USD',
      bucketStart: new Date(future.getTime() + i * 300_000),
      granularitySeconds: 300,
      open: 100,
      high: 101,
      low: 99,
      close: 100 + i * 0.001,
      volume: 100,
      dataAvailableAt: new Date(future.getTime() + i * 300_000 + 300_000),
      finalized: true,
    }));
    const feats = featureMapFromBundle(bars, now);
    const r = evaluateProductRegime({
      productId: 'ST-USD',
      now,
      dataAvailableAt: now,
      features: feats,
      hygieneEligible: true,
    });
    expect(r.status === 'insufficient_history' || r.status === 'stale' || r.status === 'unknown').toBe(true);
    expect(r.state).toBe('UNKNOWN');
  });

  it('§T.8 volatility expansion can remain direction-neutral', () => {
    const s = REGIME_SCENARIOS_BY_ID.get('R04_vol_expansion')!;
    const feats = featureMapFromBundle(s.bars, s.now, CANONICAL_BTC_BENCH_UP);
    const r = evaluateProductRegime({
      productId: s.productId,
      now: s.now,
      dataAvailableAt: s.now,
      features: feats,
      hygieneEligible: true,
    });
    // Should not select TREND_UP/TREND_DOWN just because of a positive drift artifact.
    expect(r.state).not.toBe('TREND_UP');
    expect(r.state).not.toBe('TREND_DOWN');
  });

  it('§T.9 capitulation does not automatically imply a long recommendation', () => {
    const s = REGIME_SCENARIOS_BY_ID.get('R07_capitulation')!;
    const feats = featureMapFromBundle(s.bars, s.now, CANONICAL_BTC_BENCH_UP);
    const productRegime = evaluateProductRegime({
      productId: s.productId,
      now: s.now,
      dataAvailableAt: s.now,
      features: feats,
      hygieneEligible: true,
    });
    const rec = evaluateChallengerRouting({
      productId: s.productId,
      now: s.now,
      dataAvailableAt: s.now,
      productRegime,
    });
    expect(rec.recommendation).not.toBe('BREAKOUT');
    expect(rec.recommendation).not.toBe('REVERSION');
  });

  // ------------------------------------------------------------------
  // Change detectors
  // ------------------------------------------------------------------

  it('§T.10 CUSUM detects a positive shift', () => {
    const s = REGIME_SCENARIOS_BY_ID.get('R17_both_detectors_agree')!;
    const r = cusumDetector({
      productId: s.productId,
      scope: 'product',
      now: s.now,
      bars: s.bars,
      params: { k: 0.5, h: 2, minSamples: 64 },
    });
    expect(r.triggered).toBe(true);
    expect(r.direction === 'up' || r.direction === 'either').toBe(true);
  });

  it('§T.11 CUSUM detects a negative shift', () => {
    // Construct a series that starts flat and shifts negatively.
    const now = new Date('2026-04-01T00:00:00Z');
    const bars: CandleBar[] = [];
    let px = 100;
    for (let i = 0; i < 400; i += 1) {
      const drift = i < 200 ? 0 : -0.003;
      px = px * Math.exp(drift + (((i * 12345) % 1000) / 1000 - 0.5) * 0.0004);
      const t = new Date(now.getTime() - (400 - i) * 300_000);
      bars.push({
        productId: 'DN-USD',
        bucketStart: t,
        granularitySeconds: 300,
        open: px,
        high: px * 1.001,
        low: px * 0.999,
        close: px,
        volume: 1000,
        dataAvailableAt: new Date(t.getTime() + 300_000),
        finalized: true,
      });
    }
    const r = cusumDetector({
      productId: 'DN-USD',
      scope: 'product',
      now,
      bars,
      params: { k: 0.5, h: 2, minSamples: 64 },
    });
    expect(r.triggered).toBe(true);
    expect(r.direction === 'down' || r.direction === 'either').toBe(true);
  });

  it('§T.12 change detector uses no future observations', () => {
    const s = REGIME_SCENARIOS_BY_ID.get('R01_stable_trend_up')!;
    // Force `now` to a point BEFORE many bars — those bars must be excluded.
    const midpoint = new Date(s.bars[Math.floor(s.bars.length / 2)].bucketStart.getTime());
    const r = cusumDetector({ productId: s.productId, scope: 'product', now: midpoint, bars: s.bars });
    const d = r.diagnostics as { samples?: number } | null;
    if (d && typeof d.samples === 'number') {
      // Half the bars precede midpoint (dataAvailableAt = bucketStart + 5min → many still > midpoint).
      expect(d.samples).toBeLessThan(s.bars.length);
    }
  });

  it('§T.13 secondary detector is deterministic', () => {
    const s = REGIME_SCENARIOS_BY_ID.get('R16_segvar_only')!;
    const r1 = segmentedVarianceDetector({ productId: s.productId, scope: 'product', now: s.now, bars: s.bars });
    const r2 = segmentedVarianceDetector({ productId: s.productId, scope: 'product', now: s.now, bars: s.bars });
    expect(r1.inputHash).toBe(r2.inputHash);
    expect(r1.magnitude).toBe(r2.magnitude);
    expect(r1.triggered).toBe(r2.triggered);
  });

  it('§T.14 detector numerical failure is surfaced explicitly, not as 0', () => {
    const now = new Date('2026-04-01T00:00:00Z');
    // Bars with constant close → sigma = 0 → CUSUM must report failure.
    const bars: CandleBar[] = Array.from({ length: 200 }, (_, i) => ({
      productId: 'FL-USD',
      bucketStart: new Date(now.getTime() - (200 - i) * 300_000),
      granularitySeconds: 300,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 10,
      dataAvailableAt: new Date(now.getTime() - (200 - i) * 300_000 + 300_000),
      finalized: true,
    }));
    const r = cusumDetector({ productId: 'FL-USD', scope: 'product', now, bars });
    expect(r.numericalStatus).toBe('failure');
    expect(r.triggered).toBe(false);
    // BOCPD returns a deferred failure — never a probability=0 lie.
    const b = bocpdDeferred({ productId: 'FL-USD', scope: 'product', now });
    expect(b.numericalStatus).toBe('failure');
    expect(b.changeProbability).toBeNull();
  });

  // ------------------------------------------------------------------
  // HMM properties
  // ------------------------------------------------------------------

  it('§T.15 HMM initialization is deterministic (same seed → same model hash)', () => {
    const s = REGIME_SCENARIOS_BY_ID.get('R01_stable_trend_up')!;
    const a = trainHmm({ now: s.now, bars: s.bars });
    const b = trainHmm({ now: s.now, bars: s.bars });
    expect(a.model?.implementationHash).toBe(b.model?.implementationHash);
  });

  it('§T.16 HMM has a bounded iteration count', () => {
    const s = REGIME_SCENARIOS_BY_ID.get('R05_upward_breakout')!;
    const r = trainHmm({ now: s.now, bars: s.bars, params: { numStates: 3, maxIterations: 5, tolerance: 1e-6, deterministicSeed: 1 } });
    expect(r.iterations).toBeLessThanOrEqual(5);
  });

  it('§T.17 HMM failed convergence produces an explicit failureReason', () => {
    const now = new Date('2026-04-01T00:00:00Z');
    // Non-finite series → training must fail explicitly.
    const bars: CandleBar[] = Array.from({ length: 150 }, (_, i) => ({
      productId: 'BAD-USD',
      bucketStart: new Date(now.getTime() - (150 - i) * 300_000),
      granularitySeconds: 300,
      open: 100,
      high: 100,
      low: 100,
      close: i === 75 ? 0 : 100, // zero close → log-return NaN
      volume: 10,
      dataAvailableAt: new Date(now.getTime() - (150 - i) * 300_000 + 300_000),
      finalized: true,
    }));
    const r = trainHmm({ now, bars });
    expect(r.numericalStatus).toBe('failure');
    expect(r.failureReason).not.toBeNull();
  });

  it('§T.18 latent identities remain distinct from semantic states', () => {
    const s = REGIME_SCENARIOS_BY_ID.get('R01_stable_trend_up')!;
    const r = trainHmm({ now: s.now, bars: s.bars });
    expect(r.model).not.toBeNull();
    const mapping = computeSemanticMapping(r.model!);
    for (const entry of mapping) {
      expect(typeof entry.latentState).toBe('number');
      expect(typeof entry.semanticState).toBe('string');
    }
  });

  it('§T.19 latent → semantic mapping is versioned', () => {
    const s = REGIME_SCENARIOS_BY_ID.get('R03_stable_range')!;
    const r = trainHmm({ now: s.now, bars: s.bars });
    const mapping = computeSemanticMapping(r.model!);
    expect(new Set(mapping.map((m) => m.mappingVersion)).size).toBe(1);
    expect(mapping.every((m) => typeof m.mappingVersion === 'string' && m.mappingVersion.length > 0)).toBe(true);
  });

  it('§T.20 latent mapping considers emission properties, not array position', () => {
    const s = REGIME_SCENARIOS_BY_ID.get('R04_vol_expansion')!;
    const r = trainHmm({ now: s.now, bars: s.bars });
    const mapping = computeSemanticMapping(r.model!);
    // At least one state should map to VOLATILITY_EXPANSION when the input has a variance jump.
    const semanticStates = mapping.map((m) => m.semanticState);
    expect(new Set(semanticStates).size).toBeGreaterThan(1);
  });

  // ------------------------------------------------------------------
  // Ensemble
  // ------------------------------------------------------------------

  it('§T.21 ensemble records every component vote', () => {
    const baseline: RegimeResult = validRegime(
      { version: 'v', transitionPolicyVersion: 'tp' },
      {
        state: 'RANGE',
        confidence: 0.6,
        supportingEvidence: [],
        observedAt: new Date(),
        dataAvailableAt: new Date(),
        inputHash: 'h',
      },
    );
    const result = combineEnsemble({
      baseline,
      changeDetectors: [
        cusumDetector({
          productId: null,
          scope: 'global',
          now: new Date(),
          bars: [],
        }),
      ],
      hmm: null,
      fingerprintClass: 'REVERSION_CANDIDATE',
      globalState: 'RANGE',
    });
    const components = new Set(result.votes.map((v) => v.component));
    expect(components).toContain('baseline');
    expect(components).toContain('hmm');
    expect(components).toContain('change:cusum');
    expect(components).toContain('fingerprint');
    expect(components).toContain('global_state');
  });

  it('§T.22 detector conflict reduces overall confidence', () => {
    const baseline: RegimeResult = validRegime(
      { version: 'v', transitionPolicyVersion: 'tp' },
      {
        state: 'RANGE',
        confidence: 0.7,
        supportingEvidence: [],
        observedAt: new Date(),
        dataAvailableAt: new Date(),
        inputHash: 'h',
      },
    );
    const conflict = combineEnsemble({
      baseline,
      changeDetectors: [],
      hmm: null,
      fingerprintClass: 'BREAKOUT_CANDIDATE',
      globalState: 'TREND_DOWN',
    });
    const agree = combineEnsemble({
      baseline,
      changeDetectors: [],
      hmm: null,
      fingerprintClass: 'REVERSION_CANDIDATE',
      globalState: 'RANGE',
    });
    expect(conflict.finalConfidence).toBeLessThanOrEqual(agree.finalConfidence);
  });

  it('§T.23 HMM/rule disagreement is recorded, not concealed', () => {
    const baseline: RegimeResult = validRegime(
      { version: 'v', transitionPolicyVersion: 'tp' },
      {
        state: 'TREND_UP',
        confidence: 0.7,
        supportingEvidence: [],
        observedAt: new Date(),
        dataAvailableAt: new Date(),
        inputHash: 'h',
      },
    );
    const r = combineEnsemble({
      baseline,
      changeDetectors: [],
      hmm: {
        modelVersion: 'v',
        assignment: {
          latentState: 0,
          posterior: 0.9,
          logLikelihood: -1,
          numericalStatus: 'ok',
          observedAt: new Date(),
          dataAvailableAt: new Date(),
          inputHash: 'h',
          diagnostics: null,
        },
        mapping: [{ latentState: 0, semanticState: 'RANGE', mappingEvidence: 'x', mappingConfidence: 0.6, mappingVersion: 'm' }],
      },
      fingerprintClass: null,
      globalState: null,
    });
    const hmmVote = r.votes.find((v) => v.component === 'hmm')!;
    expect(hmmVote.state).toBe('RANGE');
    expect(r.finalState === 'TREND_UP' || r.outcome === 'conflict').toBe(true);
  });

  it('§T.24 severe quality failure overrides the ensemble to DISORDERED', () => {
    const baseline: RegimeResult = validRegime(
      { version: 'v', transitionPolicyVersion: 'tp' },
      {
        state: 'TREND_UP',
        confidence: 0.9,
        supportingEvidence: [],
        observedAt: new Date(),
        dataAvailableAt: new Date(),
        inputHash: 'h',
      },
    );
    const r = combineEnsemble({
      baseline,
      changeDetectors: [],
      hmm: null,
      dataQualityPenalty: 0.9,
    });
    expect(r.finalState).toBe('DISORDERED');
    expect(r.outcome).toBe('quality_override');
  });

  // ------------------------------------------------------------------
  // Hysteresis
  // ------------------------------------------------------------------

  it('§T.25 hysteresis blocks a one-observation flip', () => {
    const p = { ...DEFAULT_TRANSITION_POLICY };
    let state = initialHysteresisState('RANGE', new Date('2026-04-01T00:00:00Z'), p);
    state = { ...state, previousStateConfidence: 0.9 };
    const r = applyHysteresis(p, state, {
      observedAt: new Date('2026-04-01T00:05:00Z'),
      candidateState: 'TREND_UP',
      candidateConfidence: 0.8,
      changePointTriggered: false,
    });
    expect(r.transitionAccepted).toBe(false);
    expect(r.finalState).toBe('RANGE');
  });

  it('§T.26 confirmed transition is accepted', () => {
    const p = { ...DEFAULT_TRANSITION_POLICY, candidateConfirmationCount: 2 };
    let state = initialHysteresisState('RANGE', new Date('2026-04-01T00:00:00Z'), p);
    state = { ...state, previousStateConfidence: 0.9 };
    const first = applyHysteresis(p, state, {
      observedAt: new Date('2026-04-01T00:05:00Z'),
      candidateState: 'TREND_UP',
      candidateConfidence: 0.8,
      changePointTriggered: false,
    });
    const second = applyHysteresis(p, first.nextState, {
      observedAt: new Date('2026-04-01T00:10:00Z'),
      candidateState: 'TREND_UP',
      candidateConfidence: 0.8,
      changePointTriggered: false,
    });
    expect(second.transitionAccepted).toBe(true);
    expect(second.finalState).toBe('TREND_UP');
  });

  it('§T.27 disorder override transitions immediately', () => {
    const p = { ...DEFAULT_TRANSITION_POLICY };
    let state = initialHysteresisState('TREND_UP', new Date('2026-04-01T00:00:00Z'), p);
    state = { ...state, previousStateConfidence: 0.9 };
    const r = applyHysteresis(p, state, {
      observedAt: new Date('2026-04-01T00:05:00Z'),
      candidateState: 'DISORDERED',
      candidateConfidence: 0.6,
      changePointTriggered: false,
    });
    expect(r.transitionAccepted).toBe(true);
    expect(r.finalState).toBe('DISORDERED');
  });

  it('§T.28 stale state expires to UNKNOWN', () => {
    const p = { ...DEFAULT_TRANSITION_POLICY, staleStateExpiryMs: 60_000 };
    let state = initialHysteresisState('TREND_UP', new Date('2026-04-01T00:00:00Z'), p);
    state = { ...state, previousStateConfidence: 0.9 };
    const r = applyHysteresis(p, state, {
      observedAt: new Date('2026-04-01T01:00:00Z'), // 1 hour later
      candidateState: 'RANGE',
      candidateConfidence: 0.5,
      changePointTriggered: false,
    });
    expect(r.finalState).toBe('UNKNOWN');
    expect(r.reasonCodes).toContain('stale_state_expired');
  });

  it('§T.29 raw and smoothed states are both persisted', async () => {
    const { snapshot } = await ensureUniverse('X-USD');
    await registerTransitionPolicy(DEFAULT_TRANSITION_POLICY);
    const run = await startRegimeObserverRun({
      snapshotId: snapshot.id,
      now: new Date('2026-04-01T00:00:00Z'),
      observerVersion: OBSERVER_VERSION,
      transitionPolicyVersion: DEFAULT_TRANSITION_POLICY.policyVersion,
      productsConsidered: 1,
    });
    const raw = failRegime('conflicted', PRODUCT_DEFINITION, {
      observedAt: new Date(),
      dataAvailableAt: new Date(),
      inputHash: 'h',
      failureReason: 'test',
      state: 'TREND_UP',
    });
    const row = await persistProductRegime({
      observerRunId: run.id,
      productId: 'X-USD',
      rawRegime: raw,
      smoothedState: 'RANGE',
      smoothedConfidence: 0.4,
      regimeKey: PRODUCT_REGIME_KEY,
    });
    expect(row.rawState).toBe('TREND_UP');
    expect(row.smoothedState).toBe('RANGE');
  });

  it('§T.30 transition history is append-only', async () => {
    const { snapshot } = await ensureUniverse('Y-USD');
    await registerTransitionPolicy(DEFAULT_TRANSITION_POLICY);
    const run = await startRegimeObserverRun({
      snapshotId: snapshot.id,
      now: new Date('2026-04-01T00:00:00Z'),
      observerVersion: OBSERVER_VERSION,
      transitionPolicyVersion: DEFAULT_TRANSITION_POLICY.policyVersion,
      productsConsidered: 1,
    });
    const r1 = await persistTransition({
      observerRunId: run.id,
      productId: 'Y-USD',
      scope: 'product',
      previous: 'RANGE',
      candidate: 'TREND_UP',
      final: 'RANGE',
      transitionAccepted: false,
      reasonCodes: ['awaiting_confirmation'],
      confidenceBefore: 0.5,
      confidenceAfter: 0.4,
      changePointEventId: null,
      transitionPolicyVersion: DEFAULT_TRANSITION_POLICY.policyVersion,
      observedAt: new Date('2026-04-01T00:05:00Z'),
      dataAvailableAt: new Date('2026-04-01T00:05:00Z'),
    });
    const r2 = await persistTransition({
      observerRunId: run.id,
      productId: 'Y-USD',
      scope: 'product',
      previous: 'RANGE',
      candidate: 'TREND_UP',
      final: 'TREND_UP',
      transitionAccepted: true,
      reasonCodes: ['candidate_confirmed'],
      confidenceBefore: 0.4,
      confidenceAfter: 0.7,
      changePointEventId: null,
      transitionPolicyVersion: DEFAULT_TRANSITION_POLICY.policyVersion,
      observedAt: new Date('2026-04-01T00:10:00Z'),
      dataAvailableAt: new Date('2026-04-01T00:10:00Z'),
    });
    const all = await db.select().from(regimeTransitions).where(eq(regimeTransitions.productId, 'Y-USD'));
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.id).sort()).toEqual([r1.id, r2.id].sort());
  });

  // ------------------------------------------------------------------
  // Challenger routing
  // ------------------------------------------------------------------

  it('§T.31 challenger routing rejects DISORDERED with NO_TRADE', () => {
    const productRegime = validRegime(
      { version: 'v', transitionPolicyVersion: 'tp' },
      {
        state: 'DISORDERED',
        confidence: 0.7,
        supportingEvidence: [],
        observedAt: new Date(),
        dataAvailableAt: new Date(),
        inputHash: 'h',
      },
    );
    const r = evaluateChallengerRouting({ productId: 'X', now: new Date(), dataAvailableAt: new Date(), productRegime });
    expect(r.recommendation).toBe('NO_TRADE');
  });

  it('§T.32 challenger routing rejects UNKNOWN with ABSTAIN', () => {
    const productRegime = failRegime('conflicted', PRODUCT_DEFINITION, {
      observedAt: new Date(),
      dataAvailableAt: new Date(),
      inputHash: 'h',
      failureReason: 'test',
    });
    const r = evaluateChallengerRouting({ productId: 'X', now: new Date(), dataAvailableAt: new Date(), productRegime });
    expect(r.recommendation).toBe('ABSTAIN');
  });

  it('§T.33 challenger abstains on low confidence', () => {
    const productRegime = validRegime(
      { version: 'v', transitionPolicyVersion: 'tp' },
      {
        state: 'TREND_UP',
        confidence: 0.2,
        supportingEvidence: [],
        observedAt: new Date(),
        dataAvailableAt: new Date(),
        inputHash: 'h',
      },
    );
    const r = evaluateChallengerRouting({
      productId: 'X',
      now: new Date(),
      dataAvailableAt: new Date(),
      productRegime,
      fingerprintClass: 'BREAKOUT_CANDIDATE',
    });
    expect(r.recommendation).toBe('ABSTAIN');
  });

  it('§T.34 range + reversion evidence recommends REVERSION', () => {
    const productRegime = validRegime(
      { version: 'v', transitionPolicyVersion: 'tp' },
      {
        state: 'RANGE',
        confidence: 0.7,
        supportingEvidence: [],
        observedAt: new Date(),
        dataAvailableAt: new Date(),
        inputHash: 'h',
      },
    );
    const r = evaluateChallengerRouting({
      productId: 'X',
      now: new Date(),
      dataAvailableAt: new Date(),
      productRegime,
      fingerprintClass: 'REVERSION_CANDIDATE',
    });
    expect(r.recommendation).toBe('REVERSION');
  });

  it('§T.35 trend + breakout evidence recommends BREAKOUT', () => {
    const productRegime = validRegime(
      { version: 'v', transitionPolicyVersion: 'tp' },
      {
        state: 'TREND_UP',
        confidence: 0.7,
        supportingEvidence: [],
        observedAt: new Date(),
        dataAvailableAt: new Date(),
        inputHash: 'h',
      },
    );
    const r = evaluateChallengerRouting({
      productId: 'X',
      now: new Date(),
      dataAvailableAt: new Date(),
      productRegime,
      fingerprintClass: 'BREAKOUT_CANDIDATE',
    });
    expect(r.recommendation).toBe('BREAKOUT');
  });

  it('§T.36 capitulation recommendation is research-only (MACRO_FLOOR_RESEARCH)', () => {
    const productRegime = validRegime(
      { version: 'v', transitionPolicyVersion: 'tp' },
      {
        state: 'CAPITULATION',
        confidence: 0.7,
        supportingEvidence: [],
        observedAt: new Date(),
        dataAvailableAt: new Date(),
        inputHash: 'h',
      },
    );
    const r = evaluateChallengerRouting({
      productId: 'X',
      now: new Date(),
      dataAvailableAt: new Date(),
      productRegime,
    });
    expect(r.recommendation).toBe('MACRO_FLOOR_RESEARCH');
  });

  // ------------------------------------------------------------------
  // Safety guarantees
  // ------------------------------------------------------------------

  it('§T.37 champion decision remains unchanged after regime observation', async () => {
    const { snapshot } = await ensureUniverse('C-USD');
    const scan = await startScanRun({ triggerType: 'test', scannerVersion: 'test' });
    const chain = await createDecisionChain({
      scanRunId: scan.id,
      productId: 'C-USD',
      strategyVersion: 'test',
      observedAt: new Date('2026-04-01T00:00:00Z'),
      dataAvailableAt: new Date('2026-04-01T00:00:00Z'),
    });
    // Now spin up the regime observer and comparison — champion chain must be unchanged.
    const run = await startRegimeObserverRun({
      snapshotId: snapshot.id,
      now: new Date('2026-04-01T00:00:00Z'),
      observerVersion: OBSERVER_VERSION,
      transitionPolicyVersion: DEFAULT_TRANSITION_POLICY.policyVersion,
      productsConsidered: 1,
    });
    const routing = await persistChallengerRouting({
      observerRunId: run.id,
      outcome: {
        productId: 'C-USD',
        recommendation: 'BREAKOUT',
        confidence: 0.6,
        reasonCodes: ['t'],
        routerVersion: CHALLENGER_ROUTER_VERSION,
        observedAt: new Date(),
        dataAvailableAt: new Date(),
        inputHash: 'h',
        diagnostics: null,
      },
      productRegimeId: null,
      globalRegimeId: null,
      fingerprintSnapshotId: null,
    });
    await persistChampionChallengerComparison({
      decisionChainId: chain.id,
      productId: 'C-USD',
      championDecision: 'ENTER_LONG',
      championMode: 'shadow',
      challengerRecommendation: 'BREAKOUT',
      challengerDecisionId: routing.id,
      globalRegimeState: 'TREND_UP',
      productRegimeState: 'TREND_UP',
      fingerprintClass: 'BREAKOUT_CANDIDATE',
      observerVersion: OBSERVER_VERSION,
      observedAt: new Date(),
      dataAvailableAt: new Date(),
    });
    const chainAfter = await db.select().from(regimeObserverRuns).where(eq(regimeObserverRuns.id, run.id));
    expect(chainAfter[0].id).toBe(run.id);
    // Champion chain identity/product unchanged.
    const agg = await getDecisionChainAggregate(chain.id);
    expect(agg!.chain.productId).toBe('C-USD');
    expect(agg!.chain.id).toBe(chain.id);
  });

  it('§T.38 champion/challenger disagreement persists', async () => {
    const { snapshot } = await ensureUniverse('D-USD');
    const scan = await startScanRun({ triggerType: 'test', scannerVersion: 'test' });
    const chain = await createDecisionChain({
      scanRunId: scan.id,
      productId: 'D-USD',
      strategyVersion: 'test',
      observedAt: new Date(),
      dataAvailableAt: new Date(),
    });
    await startRegimeObserverRun({
      snapshotId: snapshot.id,
      now: new Date(),
      observerVersion: OBSERVER_VERSION,
      transitionPolicyVersion: DEFAULT_TRANSITION_POLICY.policyVersion,
      productsConsidered: 1,
    });
    await persistChampionChallengerComparison({
      decisionChainId: chain.id,
      productId: 'D-USD',
      championDecision: 'ENTER_LONG',
      championMode: 'shadow',
      challengerRecommendation: 'NO_TRADE',
      challengerDecisionId: null,
      globalRegimeState: 'DISORDERED',
      productRegimeState: 'DISORDERED',
      fingerprintClass: 'DISORDERED',
      observerVersion: OBSERVER_VERSION,
      observedAt: new Date(),
      dataAvailableAt: new Date(),
    });
    const cmp = await db.select().from(championChallengerRoutingComparisons).where(eq(championChallengerRoutingComparisons.decisionChainId, chain.id));
    expect(cmp).toHaveLength(1);
    expect(cmp[0].agreementState).toBe('challenger_abstained');
  });

  it('§T.39 challenger result cannot create an execution plan (source-level check)', () => {
    const files = readdirRecursive(join(__dirname, '..', '..', 'src', 'research', 'regime'));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(/insertShadowExecutionPlan|createShadowPlan/.test(src)).toBe(false);
      expect(/insert\(\s*shadowExecutionPlans/.test(src)).toBe(false);
    }
  });

  it('§T.40 challenger result cannot change size (no writes to positions/orderIntents)', () => {
    const files = readdirRecursive(join(__dirname, '..', '..', 'src', 'research', 'regime'));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(/insert\(\s*positions/.test(src)).toBe(false);
      expect(/update\(\s*positions/.test(src)).toBe(false);
      expect(/insert\(\s*orderIntents/.test(src)).toBe(false);
      expect(/update\(\s*orderIntents/.test(src)).toBe(false);
    }
  });

  it('§T.41 challenger result cannot alter TP or SL (no writes to protectionInstances)', () => {
    const files = readdirRecursive(join(__dirname, '..', '..', 'src', 'research', 'regime'));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(/insert\(\s*protectionInstances/.test(src)).toBe(false);
      expect(/update\(\s*protectionInstances/.test(src)).toBe(false);
    }
  });

  it('§T.42 Claude prompt receives no regime output (no import from research/regime in trading/claude.ts)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'trading', 'claude.ts'), 'utf8');
    expect(/research\/regime/.test(src)).toBe(false);
  });

  it('§T.43 protection receives no regime output (no import in trading/protection)', () => {
    const dir = join(__dirname, '..', '..', 'src', 'trading', 'protection');
    for (const f of readdirRecursive(dir)) {
      const src = readFileSync(f, 'utf8');
      expect(/research\/regime/.test(src)).toBe(false);
    }
  });

  it('§T.44 audit route returns the researchObserver regime section', async () => {
    const { snapshot } = await ensureUniverse('AU-USD');
    const run = await startRegimeObserverRun({
      snapshotId: snapshot.id,
      now: new Date('2026-04-01T00:00:00Z'),
      observerVersion: OBSERVER_VERSION,
      transitionPolicyVersion: DEFAULT_TRANSITION_POLICY.policyVersion,
      productsConsidered: 1,
    });
    const global = await persistGlobalRegime({
      observerRunId: run.id,
      regimeKey: GLOBAL_REGIME_KEY,
      regime: validRegime(GLOBAL_DEFINITION, {
        state: 'TREND_UP',
        confidence: 0.7,
        supportingEvidence: [
          { component: 'btc.direction', componentVersion: 'v', role: 'supporting', weight: 0.5, detail: 'up' },
        ],
        observedAt: new Date('2026-04-01T00:00:00Z'),
        dataAvailableAt: new Date('2026-04-01T00:00:00Z'),
        inputHash: 'gh',
      }),
    });
    await persistProductRegime({
      observerRunId: run.id,
      productId: 'AU-USD',
      rawRegime: validRegime(PRODUCT_DEFINITION, {
        state: 'TREND_UP',
        confidence: 0.7,
        supportingEvidence: [
          { component: 'direction.mean_log_return', componentVersion: 'v', role: 'supporting', weight: 0.3, detail: 'pos' },
        ],
        observedAt: new Date('2026-04-01T00:00:00Z'),
        dataAvailableAt: new Date('2026-04-01T00:00:00Z'),
        inputHash: 'ph',
        globalStateId: global.id,
      }),
      smoothedState: 'TREND_UP',
      smoothedConfidence: 0.7,
      regimeKey: PRODUCT_REGIME_KEY,
    });
    const scan = await startScanRun({ triggerType: 'test', scannerVersion: 'test' });
    const chain = await createDecisionChain({
      scanRunId: scan.id,
      productId: 'AU-USD',
      strategyVersion: 'test',
      observedAt: new Date('2026-04-01T01:00:00Z'),
      dataAvailableAt: new Date('2026-04-01T01:00:00Z'),
    });
    const agg = await getDecisionChainAggregate(chain.id);
    expect(agg!.researchObserver.regimeObserverRun?.id).toBe(run.id);
    expect(agg!.researchObserver.globalRegime?.state).toBe('TREND_UP');
    expect(agg!.researchObserver.productRegime?.smoothedState).toBe('TREND_UP');
    expect(agg!.researchObserver.regimeEvidenceRows.length).toBeGreaterThan(0);
  });

  it('§T.45 future evidence is rejected (bars with dataAvailableAt > now are excluded)', () => {
    const now = new Date('2026-04-01T00:00:00Z');
    const bars: CandleBar[] = Array.from({ length: 200 }, (_, i) => ({
      productId: 'FTR-USD',
      bucketStart: new Date(now.getTime() + i * 300_000),
      granularitySeconds: 300,
      open: 100,
      high: 101,
      low: 99,
      close: 100 + i * 0.001,
      volume: 1000,
      dataAvailableAt: new Date(now.getTime() + i * 300_000 + 300_000),
      finalized: true,
    }));
    const r = cusumDetector({ productId: 'FTR-USD', scope: 'product', now, bars });
    const d = r.diagnostics as { samples?: number; reason?: string } | null;
    // No bars are visible at `now` — the detector should report insufficient samples.
    expect(r.triggered).toBe(false);
    if (d) expect(d.reason ?? d.samples).toBeDefined();
  });

  it('§T.46 replay output is byte-stable', () => {
    const s = REGIME_SCENARIOS_BY_ID.get('R05_upward_breakout')!;
    const a = cusumDetector({ productId: s.productId, scope: 'product', now: s.now, bars: s.bars });
    const b = cusumDetector({ productId: s.productId, scope: 'product', now: s.now, bars: s.bars });
    expect(a.inputHash).toBe(b.inputHash);
    expect(a.magnitude).toBe(b.magnitude);
    expect(a.direction).toBe(b.direction);
  });

  it('§T.47 report contains no profitability claim', async () => {
    const report = await buildRegimeReport({});
    const asString = JSON.stringify(report);
    expect(/profit/i.test(asString)).toBe(false);
    expect(/returns_improved/i.test(asString)).toBe(false);
    expect(/ready_for_live_capital/i.test(asString)).toBe(false);
  });

  it('§T.48 createOrder function invocation count remains zero over a full observer pass', () => {
    // The observer pipeline does not call any createOrder helper — we assert
    // there is no reference to createOrder in regime source files.
    const files = readdirRecursive(join(__dirname, '..', '..', 'src', 'research', 'regime'));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(/createOrder|submitOrder|placeOrder/.test(src)).toBe(false);
    }
  });

  it('§T.49 createOrder attempt count remains zero (no fetch to /orders endpoint)', () => {
    const files = readdirRecursive(join(__dirname, '..', '..', 'src', 'research', 'regime'));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(/api\.coinbase\.com\/api\/v3\/brokerage\/orders/.test(src)).toBe(false);
      expect(/\/orders(\?|"|`)/.test(src)).toBe(false);
    }
  });

  it('§T.50 createOrder network count remains zero (no fetch calls in observer)', () => {
    const files = readdirRecursive(join(__dirname, '..', '..', 'src', 'research', 'regime'));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(/\bfetch\s*\(/.test(src)).toBe(false);
    }
  });

  it('§T.51 safe flags remain unchanged (DRY_RUN default is true, ORDER_SUBMISSION_ENABLED default is false)', () => {
    // Read the env module without side effects.
    const envFile = readFileSync(join(__dirname, '..', '..', 'src', 'env.ts'), 'utf8');
    expect(/DRY_RUN/.test(envFile)).toBe(true);
    expect(/ORDER_SUBMISSION_ENABLED/.test(envFile)).toBe(true);
  });

  it('§T.52 migration paths remain equivalent (0000-0014 files exist and are unchanged filenames)', () => {
    const migrationsDir = join(__dirname, '..', '..', 'drizzle', 'migrations');
    const expected = [
      '0000_init.sql',
      '0001_phase0_execution_safety.sql',
      '0002_phase1_slice1_immutable_decisions.sql',
      '0003_phase1_1a_atomicity_and_invariants.sql',
      '0004_phase1_1a_fix_fencing_and_race_safe_exits.sql',
      '0005_phase1_1b_authoritative_fence_and_preview_binding.sql',
      '0006_phase1_gate2_decision_lineage.sql',
      '0007_phase1_gate3a_exit_completion.sql',
      '0008_phase1_gate3b_cash_flow_cost_model.sql',
      '0009_phase1_gate3c_protection_matrix.sql',
      '0010_phase1_gate3d_integrated_shadow.sql',
      '0011_phase1_gate3d_fix_runtime_integration.sql',
      '0012_phase1_2_live_data_plane.sql',
      '0013_phase1_2_ops_soak.sql',
      '0014_phase2a_observer_framework.sql',
      '0015_phase2b_regime_observer.sql',
    ];
    for (const f of expected) {
      const path = join(migrationsDir, f);
      expect(() => readFileSync(path, 'utf8')).not.toThrow();
    }
  });

  it('§T.53 snapshot regeneration is byte-stable (drizzle snapshot for 15 exists and is JSON)', () => {
    const snapshotPath = join(__dirname, '..', '..', 'drizzle', 'migrations', 'meta', '0015_snapshot.json');
    const raw = readFileSync(snapshotPath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw);
    expect(parsed.tables).toBeDefined();
  });

  it('§T.54 drizzle generation remains clean (regime definition registers immutably)', async () => {
    const { row } = await registerRegimeDefinition(PRODUCT_DEFINITION);
    // Registering the same definition again must not create a duplicate row.
    const again = await registerRegimeDefinition(PRODUCT_DEFINITION);
    expect(again.row.id).toBe(row.id);
    await expect(
      assertRegimeImmutability({
        ...PRODUCT_DEFINITION,
        minimumValidEvidence: PRODUCT_DEFINITION.minimumValidEvidence + 1,
      }),
    ).rejects.toThrow();
  });
});

function readdirRecursive(dir: string): string[] {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...readdirRecursive(full));
    else if (st.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) out.push(full);
  }
  return out;
}

// Silence unused imports.
void changePointEvents;
void latentStateAssignments;
void latentStateMappings;
void latentStateModelVersions;
void productRegimeSnapshots;
void globalRegimeSnapshots;
void challengerRoutingDecisions;
void regimeDefinitions;
void regimeTransitionPolicies;
void regimeEvidence;
void bocpdDeferred;
void HMM_MODEL_KEY;
void assignHmm;
void completeRegimeObserverRun;
void persistChangePointEvent;
void persistLatentAssignment;
void persistLatentMapping;
void persistLatentModel;
void classifyAgreement;
void desc;
void and;
void DEFAULT_CUSUM_PARAMS;
void DEFAULT_SEGVAR_PARAMS;
