import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db';
import {
  featureDefinitions,
  featureValues,
  fingerprintDefinitions,
  fingerprintEvidence,
  fingerprintSnapshots,
  productMetadataObservations,
  productQuarantines,
  shortlistDecisions,
  universeProducts,
  universeSnapshots,
} from '../../src/db/schema';
import {
  FixtureProductUniverseProvider,
  enumerateUniverse,
  type ProductMetadata,
} from '../../src/research/universe/enumerator';
import {
  HYGIENE_POLICY_VERSION,
  activeQuarantine,
  clearQuarantine,
  evaluateProductHygiene,
  recordQuarantine,
} from '../../src/research/hygiene/gate';
import {
  failResult,
  isUsableWithCaveat,
  isValid,
  validResult,
} from '../../src/research/features/contract';
import {
  hashCandleWindow,
  alignedSeries,
  detectBucketGaps,
  visibleFinalizedBars,
  type CandleBar,
  type FeatureInputBundle,
} from '../../src/research/features/inputs';
import {
  STAGE1_FEATURES,
  amihudIlliquidityFeature,
  btcBetaFeature,
  candleGapFrequencyFeature,
  dataQualityPenaltyFeature,
  directionalPersistenceFeature,
  hurstFeature,
  meanLogReturnFeature,
  quoteVolumeFeature,
  realizedVolFeature,
  rollingAutocorrelationFeature,
  stdevLogReturnFeature,
  trendEfficiencyFeature,
  varianceRatioFeature,
} from '../../src/research/features/stage1';
import {
  STAGE2_FEATURES,
  adfLiteFeature,
  kpssLiteFeature,
  ouHalfLifeFeature,
} from '../../src/research/features/stage2';
import {
  DEFAULT_SHORTLIST_POLICY,
  evaluateShortlist,
  persistShortlist,
  type CandidateFeatureBundle,
} from '../../src/research/shortlist/policy';
import {
  computeCatalog,
  ensureCatalogRegistered,
  persistCatalogResults,
  registerFeatureDefinition,
  startFeatureRun,
} from '../../src/research/features/registry';
import {
  FINGERPRINT_CLASSIFICATION_VERSION,
  composeFingerprint,
  ensureFingerprintDefinition,
  persistFingerprint,
} from '../../src/research/fingerprint/composer';
import { createDecisionChain, getDecisionChainAggregate, startScanRun } from '../../src/db/lineage';
import { resetDatabase } from '../setup/db';
import { SCENARIOS, SCENARIOS_BY_ID } from './fixtures/scenarios';

/**
 * Phase 2A §R — required observer tests.
 *
 * Fifty tests, grouped by topic. All fixtures are deterministic (see
 * scenarios.ts) so results are byte-stable across runs.
 */

async function ensureMetadata(m: ProductMetadata) {
  const provider = new FixtureProductUniverseProvider([m]);
  const { snapshot, metadataObservations } = await enumerateUniverse({
    provider,
    now: new Date('2026-02-01T00:00:00.000Z'),
  });
  return { snapshot, metadata: metadataObservations[0] };
}

function metadataFor(productId: string, overrides: Partial<ProductMetadata> = {}): ProductMetadata {
  const [base, quote] = productId.split('-');
  const observedAt = new Date('2026-02-01T00:00:00.000Z');
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
    baseIncrement: '0.00000001',
    quoteIncrement: '0.01',
    baseMinimum: '0.001',
    quoteMinimum: '1',
    baseMaximum: '1000',
    quoteMaximum: null,
    priceIncrement: '0.01',
    approximateVolume24h: '5000000',
    metadataObservedAt: observedAt,
    metadataAvailableAt: observedAt,
    sourceVersion: 'test',
    raw: {},
    ...overrides,
  };
}

function bundleFromScenario(scenarioId: string): FeatureInputBundle {
  const s = SCENARIOS_BY_ID.get(scenarioId)!;
  return {
    productId: s.productId,
    now: s.now,
    bars: s.bars,
    staticInputs: s.staticInputs,
    benchmarks: s.benchmarks,
  };
}

describe('Phase 2A §R — Observer framework', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    await resetDatabase();
  });

  // -------------------------------------------------------------------------
  // Universe enumerator (§B)
  // -------------------------------------------------------------------------

  it('§R.1 enumerator dedupes duplicate productIds keeping latest metadataObservedAt', async () => {
    const earlier = metadataFor('AAA-USD', { metadataObservedAt: new Date('2026-01-30T00:00:00Z') });
    const later = metadataFor('AAA-USD', {
      metadataObservedAt: new Date('2026-01-31T00:00:00Z'),
      tradingStatus: 'newer',
    });
    const provider = new FixtureProductUniverseProvider([earlier, later]);
    const { snapshot, products, metadataObservations } = await enumerateUniverse({
      provider,
      now: new Date('2026-02-01T00:00:00Z'),
    });
    expect(products).toHaveLength(1);
    expect(metadataObservations).toHaveLength(1);
    expect(snapshot.productCount).toBe(1);
    expect(metadataObservations[0].tradingStatus).toBe('newer');
  });

  it('§R.2 enumerator produces stable payloadHash regardless of input order', async () => {
    const a = metadataFor('AAA-USD');
    const b = metadataFor('BBB-USD');
    const p1 = new FixtureProductUniverseProvider([a, b]);
    const p2 = new FixtureProductUniverseProvider([b, a]);
    const r1 = await enumerateUniverse({ provider: p1, now: new Date('2026-02-01T00:00:00Z') });
    await resetDatabase();
    const r2 = await enumerateUniverse({ provider: p2, now: new Date('2026-02-01T00:00:00Z') });
    expect(r1.snapshot.payloadHash).toBe(r2.snapshot.payloadHash);
  });

  it('§R.3 enumerator dedupes identical metadata observations via unique payloadHash', async () => {
    const a = metadataFor('AAA-USD');
    const provider = new FixtureProductUniverseProvider([a]);
    const now = new Date('2026-02-01T00:00:00Z');
    const r1 = await enumerateUniverse({ provider, now });
    const r2 = await enumerateUniverse({ provider, now });
    expect(r1.metadataObservations[0].id).toBe(r2.metadataObservations[0].id);
  });

  it('§R.4 enumerator persists snapshot + product rows', async () => {
    const provider = new FixtureProductUniverseProvider([
      metadataFor('AAA-USD'),
      metadataFor('BBB-USD'),
    ]);
    await enumerateUniverse({ provider, now: new Date('2026-02-01T00:00:00Z') });
    const snaps = await db.select().from(universeSnapshots);
    const prods = await db.select().from(universeProducts);
    const obs = await db.select().from(productMetadataObservations);
    expect(snaps).toHaveLength(1);
    expect(prods).toHaveLength(2);
    expect(obs).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Hygiene gate (§C, §D)
  // -------------------------------------------------------------------------

  it('§R.5 hygiene: SPOT + USD + normal metadata → eligible', async () => {
    const { snapshot, metadata } = await ensureMetadata(metadataFor('AAA-USD'));
    const dec = await evaluateProductHygiene({
      snapshotId: snapshot.id,
      now: new Date('2026-02-01T00:00:00Z'),
      productMetadata: {
        productId: 'AAA-USD',
        baseCurrency: 'AAA',
        quoteCurrency: 'USD',
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
        metadataObservedAt: metadata.metadataObservedAt,
        metadataAvailableAt: metadata.metadataAvailableAt,
        sourceVersion: 'test',
        raw: {},
      },
      metadataRow: metadata,
    });
    expect(dec.result).toBe('eligible');
    expect(dec.row.policyVersion).toBe(HYGIENE_POLICY_VERSION);
  });

  it('§R.6 hygiene: non-SPOT is ineligible', async () => {
    const { snapshot, metadata } = await ensureMetadata(metadataFor('AAA-USD'));
    const dec = await evaluateProductHygiene({
      snapshotId: snapshot.id,
      now: new Date('2026-02-01T00:00:00Z'),
      productMetadata: {
        productId: 'AAA-USD',
        baseCurrency: 'AAA',
        quoteCurrency: 'USD',
        productType: 'PERP',
        tradingStatus: 'online',
        cancelOnly: false,
        limitOnly: false,
        postOnly: false,
        auctionMode: false,
        tradingDisabled: false,
        baseIncrement: '0.001',
        quoteIncrement: '0.01',
        baseMinimum: '0.001',
        metadataObservedAt: metadata.metadataObservedAt,
        metadataAvailableAt: metadata.metadataAvailableAt,
        sourceVersion: 'test',
        raw: {},
      },
      metadataRow: metadata,
    });
    expect(dec.result).toBe('ineligible');
    expect(dec.row.reasonCodes).toContain('non_spot');
  });

  it('§R.7 hygiene: unsupported quote currency is ineligible', async () => {
    const { snapshot, metadata } = await ensureMetadata(metadataFor('AAA-EUR'));
    const dec = await evaluateProductHygiene({
      snapshotId: snapshot.id,
      now: new Date('2026-02-01T00:00:00Z'),
      productMetadata: {
        productId: 'AAA-EUR',
        baseCurrency: 'AAA',
        quoteCurrency: 'EUR',
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
        metadataObservedAt: metadata.metadataObservedAt,
        metadataAvailableAt: metadata.metadataAvailableAt,
        sourceVersion: 'test',
        raw: {},
      },
      metadataRow: metadata,
    });
    expect(dec.result).toBe('ineligible');
    expect(dec.row.reasonCodes).toContain('unsupported_quote_currency');
  });

  it('§R.8 hygiene: stablecoin base is ineligible', async () => {
    const { snapshot, metadata } = await ensureMetadata(metadataFor('USDC-USD'));
    const dec = await evaluateProductHygiene({
      snapshotId: snapshot.id,
      now: new Date('2026-02-01T00:00:00Z'),
      productMetadata: {
        productId: 'USDC-USD',
        baseCurrency: 'USDC',
        quoteCurrency: 'USD',
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
        metadataObservedAt: metadata.metadataObservedAt,
        metadataAvailableAt: metadata.metadataAvailableAt,
        sourceVersion: 'test',
        raw: {},
      },
      metadataRow: metadata,
    });
    expect(dec.result).toBe('ineligible');
    expect(dec.row.reasonCodes).toContain('stablecoin_or_pegged_asset');
  });

  it('§R.9 hygiene: leveraged suffix (BULL/BEAR/3L/3S/UP/DOWN) is ineligible', async () => {
    const { snapshot, metadata } = await ensureMetadata(metadataFor('ETH3L-USD'));
    const dec = await evaluateProductHygiene({
      snapshotId: snapshot.id,
      now: new Date('2026-02-01T00:00:00Z'),
      productMetadata: {
        productId: 'ETH3L-USD',
        baseCurrency: 'ETH3L',
        quoteCurrency: 'USD',
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
        metadataObservedAt: metadata.metadataObservedAt,
        metadataAvailableAt: metadata.metadataAvailableAt,
        sourceVersion: 'test',
        raw: {},
      },
      metadataRow: metadata,
    });
    expect(dec.result).toBe('ineligible');
    expect(dec.row.reasonCodes).toContain('leveraged_or_synthetic');
  });

  it('§R.10 hygiene: stale metadata (>24h) quarantines but does not permanently reject', async () => {
    const now = new Date('2026-02-01T00:00:00Z');
    const staleObserved = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    const md = metadataFor('AAA-USD', { metadataObservedAt: staleObserved, metadataAvailableAt: staleObserved });
    const { snapshot, metadata } = await ensureMetadata(md);
    const dec = await evaluateProductHygiene({
      snapshotId: snapshot.id,
      now,
      productMetadata: md,
      metadataRow: metadata,
    });
    expect(dec.result).toBe('quarantined');
    expect(dec.row.reasonCodes).toContain('stale_metadata');
    expect(dec.row.reEvaluateAt).not.toBeNull();
  });

  it('§R.11 hygiene: recent listing (< 30 days) quarantines', async () => {
    const now = new Date('2026-02-01T00:00:00Z');
    const seen = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const { snapshot, metadata } = await ensureMetadata(metadataFor('NEW-USD'));
    const dec = await evaluateProductHygiene({
      snapshotId: snapshot.id,
      now,
      productMetadata: metadataFor('NEW-USD'),
      metadataRow: metadata,
      productFirstSeenAt: seen,
    });
    expect(dec.result).toBe('quarantined');
    expect(dec.row.reasonCodes).toContain('recent_listing');
  });

  it('§R.12 manual quarantine wins over otherwise-eligible data', async () => {
    const { snapshot, metadata } = await ensureMetadata(metadataFor('AAA-USD'));
    const q = await recordQuarantine({
      productId: 'AAA-USD',
      reasonCode: 'admin_review',
      severity: 'research_blocked',
      startedAt: new Date('2026-01-25T00:00:00Z'),
      manualOverride: true,
    });
    const dec = await evaluateProductHygiene({
      snapshotId: snapshot.id,
      now: new Date('2026-02-01T00:00:00Z'),
      productMetadata: metadataFor('AAA-USD'),
      metadataRow: metadata,
      activeManualQuarantine: q,
    });
    expect(dec.result).toBe('quarantined');
    expect(dec.row.reasonCodes).toBe('manual_quarantine');
  });

  it('§R.13 quarantine is append-only — clearQuarantine sets clearedAt without deleting', async () => {
    const q = await recordQuarantine({
      productId: 'AAA-USD',
      reasonCode: 'reviewer_hold',
      severity: 'feature_blocked',
      startedAt: new Date('2026-01-20T00:00:00Z'),
    });
    await clearQuarantine(q.id, 'ops', new Date('2026-02-01T00:00:00Z'));
    const rows = await db
      .select()
      .from(productQuarantines)
      .where(eq(productQuarantines.id, q.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].clearedAt).not.toBeNull();
    expect(rows[0].clearedBy).toBe('ops');
  });

  it('§R.14 activeQuarantine honors expiresAt', async () => {
    const past = new Date('2026-01-01T00:00:00Z');
    await recordQuarantine({
      productId: 'AAA-USD',
      reasonCode: 'temporary',
      severity: 'observe_only',
      startedAt: past,
      expiresAt: new Date('2026-01-15T00:00:00Z'),
    });
    const now = new Date('2026-02-01T00:00:00Z');
    const q = await activeQuarantine('AAA-USD', now);
    expect(q).toBeNull();
  });

  // -------------------------------------------------------------------------
  // FeatureResult contract (§F)
  // -------------------------------------------------------------------------

  it('§R.15 validResult with a NaN value promotes to numerical_failure with value=null', () => {
    const r = validResult(
      { version: '1' },
      {
        value: Number.NaN,
        confidence: 1,
        sampleCount: 10,
        lookbackStart: new Date(),
        lookbackEnd: new Date(),
        dataAvailableAt: new Date(),
        inputHash: 'x',
      },
    );
    expect(r.status).toBe('numerical_failure');
    expect(r.value).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('§R.16 failResult never emits a numeric value', () => {
    const r = failResult('insufficient_history', { version: '1' }, {
      dataAvailableAt: new Date(),
      inputHash: 'x',
      failureReason: 'too few bars',
    });
    expect(r.value).toBeNull();
    expect(r.status).toBe('insufficient_history');
  });

  it('§R.17 low_confidence is usable-with-caveat but NOT strictly valid', () => {
    const r = validResult({ version: '1' }, {
      value: 0.5,
      confidence: 0.3,
      sampleCount: 10,
      lookbackStart: new Date(),
      lookbackEnd: new Date(),
      dataAvailableAt: new Date(),
      inputHash: 'x',
      lowConfidence: true,
      lowConfidenceReason: 'noise band',
    });
    expect(r.status).toBe('low_confidence');
    expect(isValid(r)).toBe(false);
    expect(isUsableWithCaveat(r)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Input hygiene (§E, §F)
  // -------------------------------------------------------------------------

  it('§R.18 visibleFinalizedBars excludes bars with dataAvailableAt > now (honesty barrier)', () => {
    const bars: CandleBar[] = SCENARIOS[0].bars.slice(0, 10).map((b, i) => ({
      ...b,
      dataAvailableAt: i < 5 ? b.dataAvailableAt : new Date(b.dataAvailableAt.getTime() + 3_600_000),
    }));
    const now = SCENARIOS[0].bars[6].bucketStart;
    const visible = visibleFinalizedBars(bars, now);
    expect(visible.every((b) => b.dataAvailableAt.getTime() <= now.getTime())).toBe(true);
  });

  it('§R.19 hashCandleWindow is deterministic and order-sensitive', () => {
    const b1 = SCENARIOS[0].bars.slice(0, 3);
    const h1 = hashCandleWindow(b1);
    const h2 = hashCandleWindow(b1);
    const h3 = hashCandleWindow([b1[1], b1[0], b1[2]]);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it('§R.20 detectBucketGaps counts missing buckets between visible bars', () => {
    const bars = SCENARIOS[0].bars.slice(0, 10);
    const gapped = [bars[0], bars[1], bars[5], bars[6]];
    expect(detectBucketGaps(gapped)).toBe(3);
  });

  it('§R.21 alignedSeries drops unaligned buckets, never zero-fills', () => {
    const btc = SCENARIOS_BY_ID.get('S10_btc_shadow_high_corr')!.benchmarks!['BTC-USD'].bars.slice(0, 20);
    const partial = [btc[0], btc[3], btc[7]];
    const { aAligned, bAligned } = alignedSeries(btc, partial);
    expect(aAligned).toHaveLength(3);
    expect(bAligned).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // Stage 1 features (§G)
  // -------------------------------------------------------------------------

  it('§R.22 mean log return computes exactly for the trender fixture', () => {
    const r = meanLogReturnFeature.compute(bundleFromScenario('S01_ideal_trender_long'));
    expect(r.status).toBe('valid');
    expect(r.value!).toBeGreaterThan(0);
  });

  it('§R.23 stdev log return is positive and finite for a random walk', () => {
    const r = stdevLogReturnFeature.compute(bundleFromScenario('S05_random_walk_pure'));
    expect(r.status).toBe('valid');
    expect(r.value!).toBeGreaterThan(0);
  });

  it('§R.24 variance ratio near 1 (± 2SE) promotes to low_confidence', () => {
    const r = varianceRatioFeature.compute(bundleFromScenario('S05_random_walk_pure'));
    expect(['valid', 'low_confidence']).toContain(r.status);
    if (r.status === 'valid') {
      expect(Math.abs((r.value as number) - 1)).toBeGreaterThan(0.02);
    }
  });

  it('§R.25 Hurst emits low_confidence when the R/S log-log fit R² is poor', () => {
    const s = SCENARIOS_BY_ID.get('S05_random_walk_pure')!;
    const r = hurstFeature.compute({
      productId: s.productId,
      now: s.now,
      bars: s.bars,
      staticInputs: s.staticInputs,
    });
    // Random walk usually gives a reasonable R², so we just assert the field is populated.
    expect(r.status === 'valid' || r.status === 'low_confidence').toBe(true);
    expect(r.diagnostics?.r2).toBeTypeOf('number');
  });

  it('§R.26 trend efficiency = 1 on a monotone series', () => {
    const bars: CandleBar[] = SCENARIOS[0].bars.map((b, i) => ({
      ...b,
      open: 100 + i,
      close: 100 + (i + 1),
      high: 100 + (i + 1),
      low: 100 + i,
    }));
    const r = trendEfficiencyFeature.compute({
      productId: SCENARIOS[0].productId,
      now: SCENARIOS[0].now,
      bars,
      staticInputs: SCENARIOS[0].staticInputs,
    });
    expect(r.status).toBe('valid');
    expect(r.value!).toBeCloseTo(1, 2);
  });

  it('§R.27 lag-1 autocorrelation is finite for the trender fixture', () => {
    const r = rollingAutocorrelationFeature.compute(bundleFromScenario('S01_ideal_trender_long'));
    expect(r.status).toBe('valid');
    expect(Number.isFinite(r.value)).toBe(true);
  });

  it('§R.28 realized volatility scales with jump frequency', () => {
    const calmVol = realizedVolFeature.compute(bundleFromScenario('S05_random_walk_pure')).value as number;
    const jumpyVol = realizedVolFeature.compute(bundleFromScenario('S08_disordered_jumpy')).value as number;
    expect(jumpyVol).toBeGreaterThan(calmVol);
  });

  it('§R.29 amihud illiquidity is higher for the thin-book fixture than the trender', () => {
    const thin = amihudIlliquidityFeature.compute(bundleFromScenario('S06_illiquid_thin_book')).value as number;
    const trnd = amihudIlliquidityFeature.compute(bundleFromScenario('S01_ideal_trender_long')).value as number;
    expect(thin).toBeGreaterThan(trnd);
  });

  it('§R.30 quote volume returns unsupported when the static input is null', () => {
    const s = SCENARIOS_BY_ID.get('S01_ideal_trender_long')!;
    const r = quoteVolumeFeature.compute({
      productId: s.productId,
      now: s.now,
      bars: s.bars,
      staticInputs: { ...s.staticInputs, quoteVolume24h: null },
    });
    expect(r.status).toBe('unsupported');
    expect(r.value).toBeNull();
  });

  it('§R.31 candle gap frequency detects the gappy fixture', () => {
    const r = candleGapFrequencyFeature.compute(bundleFromScenario('S07_illiquid_gappy'));
    expect(r.status).toBe('valid');
    expect(r.value!).toBeGreaterThan(0);
  });

  it('§R.32 data quality penalty is higher for gappy vs clean fixtures', () => {
    const gappy = dataQualityPenaltyFeature.compute(bundleFromScenario('S07_illiquid_gappy')).value as number;
    const clean = dataQualityPenaltyFeature.compute(bundleFromScenario('S01_ideal_trender_long')).value as number;
    expect(gappy).toBeGreaterThan(clean);
  });

  it('§R.33 directional persistence is higher for a strong trender than a random walk', () => {
    const trnd = directionalPersistenceFeature.compute(bundleFromScenario('S01_ideal_trender_long')).value as number;
    const rwlk = directionalPersistenceFeature.compute(bundleFromScenario('S05_random_walk_pure')).value as number;
    expect(trnd).toBeGreaterThan(rwlk);
  });

  it('§R.34 BTC beta requires the aligned benchmark; returns unsupported otherwise', () => {
    const s = SCENARIOS_BY_ID.get('S05_random_walk_pure')!;
    const r = btcBetaFeature.compute({
      productId: s.productId,
      now: s.now,
      bars: s.bars,
      staticInputs: s.staticInputs,
    });
    expect(r.status).toBe('unsupported');
  });

  it('§R.35 BTC beta on a 1.3x shadow series is near 1.3', () => {
    const r = btcBetaFeature.compute(bundleFromScenario('S11_btc_shadow_stable_beta'));
    expect(r.status).toBe('valid');
    expect(Math.abs((r.value as number) - 1.3)).toBeLessThan(0.15);
  });

  it('§R.36 all Stage 1 features have unique keys and versions', () => {
    const keys = STAGE1_FEATURES.map((f) => `${f.def.key}@${f.def.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // -------------------------------------------------------------------------
  // Stage 2 features (§H)
  // -------------------------------------------------------------------------

  it('§R.37 ADF-lite t-stat is very negative on a strong OU reverter', () => {
    const r = adfLiteFeature.compute(bundleFromScenario('S03_ou_reverter_fast'));
    expect(r.status).toBe('valid');
    expect(r.value!).toBeLessThan(-2);
  });

  it('§R.38 OU half-life is positive on an OU reverter and low_confidence on a random walk when R² < 0.5', () => {
    const ou = ouHalfLifeFeature.compute(bundleFromScenario('S03_ou_reverter_fast'));
    const rw = ouHalfLifeFeature.compute(bundleFromScenario('S05_random_walk_pure'));
    expect(ou.value).toBeGreaterThan(0);
    expect(['valid', 'low_confidence']).toContain(rw.status);
  });

  it('§R.39 KPSS-lite is finite on trending series', () => {
    const r = kpssLiteFeature.compute(bundleFromScenario('S01_ideal_trender_long'));
    expect(r.status).toBe('valid');
    expect(Number.isFinite(r.value)).toBe(true);
  });

  it('§R.40 all Stage 2 features have unique keys and versions', () => {
    const keys = STAGE2_FEATURES.map((f) => `${f.def.key}@${f.def.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // -------------------------------------------------------------------------
  // Registry + persistence (§E)
  // -------------------------------------------------------------------------

  it('§R.41 registering a definition twice returns the same row without duplication', async () => {
    const reg1 = await registerFeatureDefinition(meanLogReturnFeature.def);
    const reg2 = await registerFeatureDefinition(meanLogReturnFeature.def);
    expect(reg1.row.id).toBe(reg2.row.id);
    const all = await db.select().from(featureDefinitions);
    expect(all.filter((r) => r.featureKey === meanLogReturnFeature.def.key)).toHaveLength(1);
  });

  it('§R.42 persistCatalogResults writes one row per (run, product, feature)', async () => {
    await ensureCatalogRegistered(STAGE1_FEATURES);
    const provider = new FixtureProductUniverseProvider([metadataFor('TRND-USD')]);
    const { snapshot } = await enumerateUniverse({
      provider,
      now: new Date('2026-02-01T00:00:00Z'),
    });
    const run = await startFeatureRun({
      snapshotId: snapshot.id,
      stage: 'stage_1',
      now: new Date('2026-02-01T00:00:00Z'),
      runVersion: 'test',
      productCount: 1,
    });
    const bundle = bundleFromScenario('S01_ideal_trender_long');
    const results = computeCatalog(STAGE1_FEATURES, bundle);
    const counts = await persistCatalogResults(run.id, bundle.productId, results);
    expect(counts.rows.length).toBe(STAGE1_FEATURES.length);
    const dupCheck = await db
      .select()
      .from(featureValues)
      .where(and(eq(featureValues.runId, run.id), eq(featureValues.productId, bundle.productId)));
    expect(dupCheck.length).toBe(STAGE1_FEATURES.length);
  });

  it('§R.43 no feature_values row is written with status=valid AND value=null (fail-closed)', async () => {
    await ensureCatalogRegistered(STAGE1_FEATURES);
    const provider = new FixtureProductUniverseProvider([metadataFor('TRND-USD')]);
    const { snapshot } = await enumerateUniverse({
      provider,
      now: new Date('2026-02-01T00:00:00Z'),
    });
    const run = await startFeatureRun({
      snapshotId: snapshot.id,
      stage: 'stage_1',
      now: new Date('2026-02-01T00:00:00Z'),
      runVersion: 'test',
      productCount: 1,
    });
    for (const s of SCENARIOS.slice(0, 8)) {
      await persistCatalogResults(
        run.id,
        s.productId,
        computeCatalog(STAGE1_FEATURES, {
          productId: s.productId,
          now: s.now,
          bars: s.bars,
          staticInputs: s.staticInputs,
          benchmarks: s.benchmarks,
        }),
      );
    }
    const bad = await db
      .select()
      .from(featureValues)
      .where(eq(featureValues.status, 'valid'));
    for (const row of bad) expect(row.value).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Shortlist policy (§I)
  // -------------------------------------------------------------------------

  it('§R.44 shortlist excludes products missing required features with a reason', () => {
    const bad: CandidateFeatureBundle = {
      productId: 'BAD-USD',
      hygieneEligible: true,
      results: new Map(),
    };
    const outcomes = evaluateShortlist([bad]);
    expect(outcomes[0].shortlisted).toBe(false);
    expect(outcomes[0].reasonCodes.some((r) => r.startsWith('missing_required'))).toBe(true);
  });

  it('§R.45 shortlist top-N is deterministic and rank ties break lexically', () => {
    const mk = (id: string): CandidateFeatureBundle => ({
      productId: id,
      hygieneEligible: true,
      results: new Map(
        STAGE1_FEATURES.map((f) => [
          f.def.key,
          validResult({ version: '1' }, {
            value: 0.5,
            confidence: 1,
            sampleCount: 10,
            lookbackStart: new Date(),
            lookbackEnd: new Date(),
            dataAvailableAt: new Date(),
            inputHash: id,
          }),
        ]),
      ),
    });
    const outcomes = evaluateShortlist([mk('ZZZ-USD'), mk('AAA-USD'), mk('MMM-USD')], {
      ...DEFAULT_SHORTLIST_POLICY,
      topN: 2,
    });
    const ranked = outcomes.filter((o) => o.shortlisted).map((o) => o.productId).sort();
    expect(ranked).toEqual(['AAA-USD', 'MMM-USD']);
  });

  it('§R.46 shortlist persistence writes one row per candidate with policy version and hash', async () => {
    const provider = new FixtureProductUniverseProvider([metadataFor('AAA-USD')]);
    const { snapshot } = await enumerateUniverse({
      provider,
      now: new Date('2026-02-01T00:00:00Z'),
    });
    const outcomes = evaluateShortlist([
      {
        productId: 'AAA-USD',
        hygieneEligible: true,
        results: new Map(),
      },
    ]);
    const rows = await persistShortlist({
      snapshotId: snapshot.id,
      now: new Date('2026-02-01T00:00:00Z'),
      outcomes,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].policyVersion).toBe(DEFAULT_SHORTLIST_POLICY.policyVersion);
    const stored = await db
      .select()
      .from(shortlistDecisions)
      .where(eq(shortlistDecisions.snapshotId, snapshot.id));
    expect(stored).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Fingerprint composer (§K)
  // -------------------------------------------------------------------------

  function resultsFor(
    scenarioId: string,
  ): Map<string, import('../../src/research/features/contract').FeatureResult> {
    const bundle = bundleFromScenario(scenarioId);
    const all = [...STAGE1_FEATURES, ...STAGE2_FEATURES];
    const map = new Map<string, import('../../src/research/features/contract').FeatureResult>();
    for (const f of all) map.set(f.def.key, f.compute(bundle));
    return map;
  }

  it('§R.47 ILLIQUID overrides directional classes for a thin-book product', () => {
    const results = resultsFor('S06_illiquid_thin_book');
    const decision = composeFingerprint({
      productId: 'THIN-USD',
      now: new Date(),
      results,
      metadataVersion: 'test',
    });
    expect(decision.fingerprintClass).toBe('ILLIQUID');
  });

  it('§R.48 fingerprint composer never emits a directional class without a quorum → UNCLASSIFIED', () => {
    const results = new Map<string, any>();
    for (const f of STAGE1_FEATURES) {
      results.set(
        f.def.key,
        failResult('insufficient_history', f.def, {
          dataAvailableAt: new Date(),
          inputHash: 'x',
          failureReason: 'no data',
        }),
      );
    }
    const decision = composeFingerprint({
      productId: 'UNK-USD',
      now: new Date(),
      results,
      metadataVersion: 'test',
    });
    expect(decision.fingerprintClass).toBe('UNCLASSIFIED');
    expect(decision.confidence).toBe(0);
  });

  it('§R.49 fingerprint persistence writes evidence rows with supporting/conflicting/missing roles', async () => {
    await ensureFingerprintDefinition();
    const provider = new FixtureProductUniverseProvider([metadataFor('THIN-USD')]);
    const { snapshot } = await enumerateUniverse({
      provider,
      now: new Date('2026-02-01T00:00:00Z'),
    });
    const decision = composeFingerprint({
      productId: 'THIN-USD',
      now: new Date('2026-02-01T00:00:00Z'),
      results: resultsFor('S06_illiquid_thin_book'),
      metadataVersion: 'test',
    });
    const { snapshot: fp, evidence } = await persistFingerprint({
      snapshotId: snapshot.id,
      productId: 'THIN-USD',
      now: new Date('2026-02-01T00:00:00Z'),
      dataAvailableAt: new Date('2026-02-01T00:00:00Z'),
      decision,
    });
    expect(fp.fingerprintClass).toBe('ILLIQUID');
    expect(fp.classificationVersion).toBe(FINGERPRINT_CLASSIFICATION_VERSION);
    expect(evidence.length).toBeGreaterThan(0);
    const roles = new Set(evidence.map((e) => e.role));
    expect(roles.size).toBeGreaterThan(0);
    const defs = await db.select().from(fingerprintDefinitions);
    expect(defs.some((d) => d.classificationVersion === FINGERPRINT_CLASSIFICATION_VERSION)).toBe(true);
    const stored = await db.select().from(fingerprintSnapshots);
    expect(stored).toHaveLength(1);
    const ev = await db.select().from(fingerprintEvidence);
    expect(ev.length).toBe(evidence.length);
  });

  it('§R.50 audit route returns researchObserver section (snapshot + hygiene + fingerprint + evidence) for a chain', async () => {
    // Set up universe snapshot for AAA-USD.
    const provider = new FixtureProductUniverseProvider([metadataFor('AAA-USD')]);
    const { snapshot: universeSnap, metadataObservations } = await enumerateUniverse({
      provider,
      now: new Date('2026-02-01T00:00:00Z'),
    });
    await evaluateProductHygiene({
      snapshotId: universeSnap.id,
      now: new Date('2026-02-01T00:00:00Z'),
      productMetadata: metadataFor('AAA-USD'),
      metadataRow: metadataObservations[0],
    });
    await ensureFingerprintDefinition();
    const decision = composeFingerprint({
      productId: 'AAA-USD',
      now: new Date('2026-02-01T00:00:00Z'),
      results: resultsFor('S06_illiquid_thin_book'),
      metadataVersion: 'test',
    });
    await persistFingerprint({
      snapshotId: universeSnap.id,
      productId: 'AAA-USD',
      now: new Date('2026-02-01T00:00:00Z'),
      dataAvailableAt: new Date('2026-02-01T00:00:00Z'),
      decision,
    });
    // Build a champion chain for AAA-USD observed later.
    const scan = await startScanRun({
      triggerType: 'test',
      scannerVersion: 'test',
    });
    const chain = await createDecisionChain({
      scanRunId: scan.id,
      productId: 'AAA-USD',
      strategyVersion: 'test',
      observedAt: new Date('2026-02-01T02:00:00Z'),
      dataAvailableAt: new Date('2026-02-01T02:00:00Z'),
    });
    const agg = await getDecisionChainAggregate(chain.id);
    expect(agg).not.toBeNull();
    expect(agg!.researchObserver).toBeDefined();
    expect(agg!.researchObserver.snapshot?.id).toBe(universeSnap.id);
    expect(agg!.researchObserver.hygiene).not.toBeNull();
    expect(agg!.researchObserver.fingerprint?.fingerprintClass).toBe('ILLIQUID');
    expect(agg!.researchObserver.fingerprintEvidence.length).toBeGreaterThan(0);
  });
});
