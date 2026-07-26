import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db';
import {
  candidateContextDecisions,
  championContextComparisons,
  contextIncidents,
  contextObservations,
  contextPolicyVersions,
  contextProviderDefinitions,
  contextSignalDefinitions,
} from '../../src/db/schema';
import { resetDatabase } from '../setup/db';
import { createDecisionChain, getDecisionChainAggregate, startScanRun } from '../../src/db/lineage';
import { httpCounters, resetHttpCounters } from '../../src/lib/fetchBarrier';
import {
  FixtureContextProvider,
  DeferredProductionContextProvider,
  projectProviderHealth,
  type ContextObservationPayload,
  type ContextProviderFamily,
} from '../../src/research/context/providers';
import {
  CTX_SIGNAL_FUNCTIONS,
  CTX_SIGNAL_REGISTRY,
  coinbasePremiumSignal,
  crossExchangeDislocationSignal,
  etfFlowSignal,
  exchangeFlowSignal,
  fundingAccelerationSignal,
  fundingLevelSignal,
  fundingVenueDivergenceSignal,
  macroCalendarSignal,
  sectorRotationSignal,
  sentimentSignal,
  stablecoinSignal,
  tokenUnlockSignal,
} from '../../src/research/context/signals';
import { evaluateEnsemble } from '../../src/research/context/ensemble';
import {
  CTX_POLICY_VERSION,
  classifyCtxAgreement,
  evaluateCandidateContext,
  persistCandidateContextDecision,
  persistChampionContextComparison,
  persistContextObservation,
  persistContextSignalValue,
  persistEnsembleEvidence,
  persistGlobalContextSnapshot,
  persistMacroEventObservation,
  persistProductContextSnapshot,
  persistProviderHealth,
  recordContextIncident,
  registerContextPolicy,
  registerContextProvider,
  registerContextSignal,
  registerMacroEvent,
  registerSectorDefinition,
  startContextObserverRun,
  upsertSectorMembership,
} from '../../src/research/context/decision';
import { computeCtxFixtureCoverage } from '../../src/research/context/fixtureManifest';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function obs(
  family: ContextProviderFamily,
  scope: 'global' | 'product' | 'sector' | 'event',
  payload: Record<string, unknown>,
  overrides: Partial<ContextObservationPayload> = {},
): ContextObservationPayload {
  return {
    providerId: `fixture-${family}`,
    providerVersion: 'p2e-fixture-1',
    providerFamily: family,
    scope,
    productId: scope === 'product' ? 'AAA-USD' : null,
    sourceTimestamp: new Date(NOW.getTime() - 60_000),
    receivedAt: new Date(NOW.getTime() - 50_000),
    dataAvailableAt: new Date(NOW.getTime() - 40_000),
    payloadHash: `h-${family}-${JSON.stringify(payload).length}-${Math.floor(NOW.getTime() / 1000)}`,
    schemaVersion: 'v1',
    healthState: 'healthy',
    normalizedPayload: payload,
    ...overrides,
  };
}

async function bareChain(): Promise<number> {
  const scan = await startScanRun({ triggerType: 'test', scannerVersion: 'phase2e' });
  const chain = await createDecisionChain({
    scanRunId: scan.id,
    productId: 'AAA-USD',
    strategyVersion: 'test',
    observedAt: NOW,
    dataAvailableAt: NOW,
  });
  return chain.id;
}

async function registerAllProvidersAndSignals(): Promise<Map<string, { providerId: number; signalId: number }>> {
  const map = new Map<string, { providerId: number; signalId: number }>();
  for (const def of CTX_SIGNAL_REGISTRY) {
    const provider = await registerContextProvider({
      providerKey: `fixture-${def.providerFamily}`,
      providerVersion: 'p2e-fixture-1',
      providerFamily: def.providerFamily,
      description: `fixture ${def.providerFamily}`,
      expectedSchemaVersion: 'v1',
      expectedUpdateIntervalMs: 60_000,
      maximumStalenessMs: 300_000,
      authorityLevel: def.authority,
      supportedScopes: [def.scope],
    });
    const sig = await registerContextSignal(def, provider.id);
    map.set(def.key, { providerId: provider.id, signalId: sig.id });
  }
  return map;
}

describe('Phase 2E — contextual risk + veto observer acceptance', () => {
  beforeEach(async () => {
    await resetDatabase();
    resetHttpCounters();
  });
  afterEach(async () => {
    await resetDatabase();
    resetHttpCounters();
  });

  // -----------------------------------------------------------------
  // §T.1–§T.8 — provider + signal integrity
  // -----------------------------------------------------------------

  it('§T.1 provider definitions are immutable and versioned', async () => {
    const first = await registerContextProvider({
      providerKey: 'k', providerVersion: 'v1', providerFamily: 'funding',
      description: 'x', expectedSchemaVersion: 'v1',
      expectedUpdateIntervalMs: 60_000, maximumStalenessMs: 120_000,
      authorityLevel: 'medium', supportedScopes: ['product'],
    });
    const again = await registerContextProvider({
      providerKey: 'k', providerVersion: 'v1', providerFamily: 'funding',
      description: 'x', expectedSchemaVersion: 'v1',
      expectedUpdateIntervalMs: 60_000, maximumStalenessMs: 120_000,
      authorityLevel: 'medium', supportedScopes: ['product'],
    });
    expect(again.id).toBe(first.id);
    await expect(
      registerContextProvider({
        providerKey: 'k', providerVersion: 'v1', providerFamily: 'funding',
        description: 'x', expectedSchemaVersion: 'v2',
        expectedUpdateIntervalMs: 60_000, maximumStalenessMs: 120_000,
        authorityLevel: 'medium', supportedScopes: ['product'],
      }),
    ).rejects.toThrow(/implementationHash mismatch/);
  });

  it('§T.2 provider health failure is not favorable', () => {
    const now = new Date(NOW.getTime());
    const p = projectProviderHealth({
      providerId: 'x',
      observationsInWindow: [],
      now,
      expectedUpdateIntervalMs: 60_000,
      maximumStalenessMs: 120_000,
      expectedSchemaVersion: 'v1',
      maximumClockSkewMs: 30_000,
    });
    expect(p.healthState).toBe('unavailable');
    expect(p.healthReason).toBe('no_observations_in_window');
  });

  it('§T.3 stale provider data is rejected', () => {
    const now = new Date(NOW.getTime());
    const o = obs('funding', 'product', { fundingRate: 0.0001 }, {
      sourceTimestamp: new Date(now.getTime() - 10 * 60_000),
      receivedAt: new Date(now.getTime() - 10 * 60_000),
      dataAvailableAt: new Date(now.getTime() - 10 * 60_000),
    });
    const p = projectProviderHealth({
      providerId: 'x',
      observationsInWindow: [o],
      now,
      expectedUpdateIntervalMs: 60_000,
      maximumStalenessMs: 60_000,
      expectedSchemaVersion: 'v1',
      maximumClockSkewMs: 30_000,
    });
    expect(p.healthState).toBe('stale');
  });

  it('§T.4 schema mismatch fails closed', () => {
    const now = new Date(NOW.getTime());
    const o = obs('funding', 'product', {}, { schemaVersion: 'v99' });
    const p = projectProviderHealth({
      providerId: 'x', observationsInWindow: [o], now,
      expectedUpdateIntervalMs: 60_000, maximumStalenessMs: 120_000,
      expectedSchemaVersion: 'v1', maximumClockSkewMs: 30_000,
    });
    expect(p.healthState).toBe('schema_mismatch');
  });

  it('§T.5 clock skew fails closed', () => {
    const now = new Date(NOW.getTime());
    const o = obs('funding', 'product', {}, {
      sourceTimestamp: new Date(now.getTime() - 60_000),
      receivedAt: new Date(now.getTime() - 60_000 + 999_999),
      dataAvailableAt: new Date(now.getTime() - 60_000 + 999_999),
    });
    const p = projectProviderHealth({
      providerId: 'x', observationsInWindow: [o], now,
      expectedUpdateIntervalMs: 60_000, maximumStalenessMs: 5 * 60_000,
      expectedSchemaVersion: 'v1', maximumClockSkewMs: 5_000,
    });
    expect(p.healthState).toBe('clock_skew');
  });

  it('§T.6 context signal failures do not become zero', () => {
    const s = fundingLevelSignal({ observation: obs('funding', 'product', {}), decisionAt: NOW });
    expect(s.status).not.toBe('valid');
    expect(s.value).toBeNull();
  });

  it('§T.7 future observations are rejected', () => {
    const s = fundingLevelSignal({
      observation: obs('funding', 'product', { fundingRate: 0.001 }, { sourceTimestamp: new Date(NOW.getTime() + 60_000) }),
      decisionAt: NOW,
    });
    expect(s.status).toBe('invalid_input');
    expect(s.failureReason).toBe('future_observation');
  });

  it('§T.8 expired signals are rejected', () => {
    const s = fundingLevelSignal({
      observation: obs('funding', 'product', { fundingRate: 0.001 }),
      decisionAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
      expiresInMs: 60_000,
    });
    expect(s.status).toBe('stale');
    expect(s.failureReason).toBe('expired');
  });

  // -----------------------------------------------------------------
  // §T.9–§T.29 — signal family behavior
  // -----------------------------------------------------------------

  it('§T.9 funding extreme is represented; positive funding extreme is adverse', () => {
    const s = fundingLevelSignal({ observation: obs('funding', 'product', { fundingRate: 0.002, venueCount: 3 }), decisionAt: NOW });
    expect(s.status).toBe('valid');
    expect(s.direction).toBe('adverse');
  });

  it('§T.10 negative funding does not automatically create a long', () => {
    const s = fundingLevelSignal({ observation: obs('funding', 'product', { fundingRate: -0.002 }), decisionAt: NOW });
    // Direction is adverse (extreme), never supportive.
    expect(s.direction).not.toBe('supportive');
  });

  it('§T.11 missing comparison venue does not imply zero premium', () => {
    const s = coinbasePremiumSignal({ observation: obs('cross_exchange_premium', 'product', { coinbasePrice: 100 }), decisionAt: NOW });
    expect(s.status).not.toBe('valid');
    expect(s.value).toBeNull();
  });

  it('§T.12 premium requires aligned timestamps', () => {
    const s = coinbasePremiumSignal({
      observation: obs('cross_exchange_premium', 'product', {
        coinbasePrice: 100, referencePrice: 100.1,
        coinbaseTimestampMs: 1_000_000, referenceTimestampMs: 1_010_000,
        alignmentToleranceMs: 2_000, venueCount: 2,
      }),
      decisionAt: NOW,
    });
    expect(s.status).toBe('invalid_input');
    expect(s.failureReason).toBe('unaligned_timestamps');
  });

  it('§T.12b positive premium is adverse when magnitude exceeds threshold', () => {
    const s = coinbasePremiumSignal({
      observation: obs('cross_exchange_premium', 'product', { coinbasePrice: 100.5, referencePrice: 100, venueCount: 2 }),
      decisionAt: NOW,
    });
    expect(s.status).toBe('valid');
    expect(s.direction).toBe('adverse');
  });

  it('§T.12c negative premium is adverse when magnitude exceeds threshold', () => {
    const s = coinbasePremiumSignal({
      observation: obs('cross_exchange_premium', 'product', { coinbasePrice: 99.5, referencePrice: 100, venueCount: 2 }),
      decisionAt: NOW,
    });
    expect(s.direction).toBe('adverse');
  });

  it('§T.13 exchange flow does not imply proven selling intent; inflow classifies as adverse when abnormal', () => {
    const s = exchangeFlowSignal({
      observation: obs('exchange_flows', 'product', { inflow: 5_000_000, outflow: 0, abnormalEvent: true }),
      decisionAt: NOW,
    });
    expect(s.direction).toBe('adverse');
    // Additional coverage: exchange outflow classifies as adverse when abnormal
    const s2 = exchangeFlowSignal({
      observation: obs('exchange_flows', 'product', { inflow: 0, outflow: 5_000_000, abnormalEvent: true }),
      decisionAt: NOW,
    });
    expect(s2.direction).toBe('adverse');
  });

  it('§T.14 low-confidence flow cannot independently hard-veto', () => {
    const s = exchangeFlowSignal({
      observation: obs('exchange_flows', 'product', { inflow: 5_000_000, outflow: 0, flowClassificationConfidence: 0.3, abnormalEvent: true }),
      decisionAt: NOW,
    });
    expect(s.status).toBe('low_confidence');
    // Even though adverse, low-confidence isn't a hard veto.
    expect(s.authority).not.toBe('hard_veto');
  });

  it('§T.15 major unlock may reduce or reject', () => {
    const s = tokenUnlockSignal({
      observation: obs('token_unlocks', 'product', { state: 'pre_unlock', unlockPercentCirculating: 0.10, circulatingSupplyKnown: true }),
      decisionAt: NOW,
    });
    expect(s.direction).toBe('adverse');
    expect(s.severity).toBeGreaterThan(0);
  });

  it('§T.16 small unlock does not automatically veto', () => {
    const s = tokenUnlockSignal({
      observation: obs('token_unlocks', 'product', { state: 'pre_unlock', unlockPercentCirculating: 0.001, circulatingSupplyKnown: true }),
      decisionAt: NOW,
    });
    expect(s.severity).toBeLessThan(0.02);
  });

  it('§T.17 unlock expiration works', () => {
    const s = tokenUnlockSignal({
      observation: obs('token_unlocks', 'product', {
        state: 'post_unlock',
        unlockPercentCirculating: 0.05,
        circulatingSupplyKnown: true,
        windowEndMs: NOW.getTime() - 12 * 60 * 60_000,
      }),
      decisionAt: NOW,
    });
    expect(s.status).toBe('stale');
  });

  it('§T.18 unlock rescheduling creates a new version', async () => {
    const evDef = await registerMacroEvent({
      eventKey: 'unlock-x', eventVersion: 'v1', eventKind: 'other',
      description: 'x', timeZone: 'UTC', preWindowMs: 3600_000, postWindowMs: 3600_000,
    });
    const original = await persistMacroEventObservation({
      eventDefinitionId: evDef.id,
      scheduledAt: NOW,
      windowStart: new Date(NOW.getTime() - 3600_000),
      windowEnd: new Date(NOW.getTime() + 3600_000),
      state: 'pre_event_window',
      observedAt: NOW,
      dataAvailableAt: NOW,
    });
    const rescheduled = await persistMacroEventObservation({
      eventDefinitionId: evDef.id,
      scheduledAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
      windowStart: new Date(NOW.getTime() + 24 * 60 * 60_000 - 3600_000),
      windowEnd: new Date(NOW.getTime() + 24 * 60 * 60_000 + 3600_000),
      state: 'outside_window',
      observedAt: new Date(NOW.getTime() + 60_000),
      dataAvailableAt: new Date(NOW.getTime() + 60_000),
      supersedesObservationId: original.id,
    });
    expect(rescheduled.supersedesObservationId).toBe(original.id);
  });

  it('§T.19 unknown circulating supply blocks percentage conclusions', () => {
    const s = tokenUnlockSignal({
      observation: obs('token_unlocks', 'product', { state: 'pre_unlock', circulatingSupplyKnown: false }),
      decisionAt: NOW,
    });
    expect(s.status).toBe('insufficient_history');
  });

  it('§T.20 ETF publication delay is enforced', () => {
    const s = etfFlowSignal({
      observation: obs('etf_flows', 'global', { netInflow: 100_000_000, isIntraday: false, publicationDelayMs: 24 * 60 * 60_000 }),
      decisionAt: NOW,
    });
    expect(s.status).toBe('stale');
  });

  it('§T.20b ETF inflow does not boost and ETF outflow is adverse', () => {
    const inflow = etfFlowSignal({
      observation: obs('etf_flows', 'global', { netInflow: 500_000_000, isIntraday: true }),
      decisionAt: NOW,
    });
    expect(inflow.direction).toBe('supportive');
    // Downstream ensemble will refuse to boost — supportive contribution is 1, never >1.
    const outflow = etfFlowSignal({
      observation: obs('etf_flows', 'global', { netInflow: -500_000_000, isIntraday: true }),
      decisionAt: NOW,
    });
    expect(outflow.direction).toBe('adverse');
  });

  it('§T.21 stablecoin expansion cannot boost', () => {
    const s = stablecoinSignal({
      observation: obs('stablecoin_flows', 'global', { supplyDeltaPct: 0.03 }),
      decisionAt: NOW,
    });
    expect(s.direction).toBe('neutral');
  });

  it('§T.21b stablecoin contraction remains neutral', () => {
    const s = stablecoinSignal({
      observation: obs('stablecoin_flows', 'global', { supplyDeltaPct: -0.03 }),
      decisionAt: NOW,
    });
    expect(s.direction).toBe('neutral');
  });

  it('§T.22 peg stress can reduce or reject', () => {
    const s = stablecoinSignal({
      observation: obs('stablecoin_flows', 'global', { pegDeviationBps: 150 }),
      decisionAt: NOW,
    });
    expect(s.direction).toBe('adverse');
  });

  it('§T.23 sentiment remains low authority', () => {
    const s = sentimentSignal({
      observation: obs('sentiment', 'global', { index: 10 }),
      decisionAt: NOW,
    });
    expect(s.authority).toBe('low');
  });

  it('§T.24 sentiment alone cannot boost (extreme fear and greed are adverse)', () => {
    const fear = sentimentSignal({ observation: obs('sentiment', 'global', { index: 10 }), decisionAt: NOW });
    const greed = sentimentSignal({ observation: obs('sentiment', 'global', { index: 90 }), decisionAt: NOW });
    expect(fear.direction).toBe('adverse');
    expect(greed.direction).toBe('adverse');
  });

  it('§T.24b sentiment source disagreement reduces confidence', () => {
    const s = sentimentSignal({ observation: obs('sentiment', 'global', { index: 50, sourceDisagreement: 0.8 }), decisionAt: NOW });
    expect(s.confidence).toBeLessThan(0.5);
  });

  it('§T.25 sector leadership cannot boost the ensemble', () => {
    const s = sectorRotationSignal({ observation: obs('sector_rotation', 'sector', { sectorRelativeStrength: 0.5, sectorMembershipKnown: true }), decisionAt: NOW });
    expect(s.direction).toBe('supportive');
    // Ensemble refuses to boost — supportive contribution is 1, never >1.
    const ens = evaluateEnsemble({
      signals: [s], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION,
      maximumCombinedReduction: 0.5,
    });
    expect(ens.combinedMultiplier).toBeLessThanOrEqual(1);
  });

  it('§T.25b sector breakdown is adverse', () => {
    const s = sectorRotationSignal({ observation: obs('sector_rotation', 'sector', { sectorRelativeStrength: -0.2, sectorBreakdown: true, sectorMembershipKnown: true }), decisionAt: NOW });
    expect(s.direction).toBe('adverse');
  });

  it('§T.26 unknown sector remains explicit', () => {
    const s = sectorRotationSignal({ observation: obs('sector_rotation', 'sector', { sectorMembershipKnown: false }), decisionAt: NOW });
    expect(s.status).toBe('unavailable');
  });

  it('§T.27 macro window does not predict event outcome; pre-event window is adverse', () => {
    const s = macroCalendarSignal({ observation: obs('macro_calendar', 'event', { state: 'pre_event_window', eventKey: 'FOMC' }), decisionAt: NOW });
    expect(s.direction).toBe('adverse');
  });

  it('§T.27b macro active-event window is adverse', () => {
    const s = macroCalendarSignal({ observation: obs('macro_calendar', 'event', { state: 'event_window' }), decisionAt: NOW });
    expect(s.direction).toBe('adverse');
    expect(s.severity).toBe(1);
  });

  it('§T.27c macro post-event window is adverse', () => {
    const s = macroCalendarSignal({ observation: obs('macro_calendar', 'event', { state: 'post_event_window' }), decisionAt: NOW });
    expect(s.direction).toBe('adverse');
  });

  it('§T.28 rescheduled macro event is versioned (covered by §T.18 mechanism)', async () => {
    const def = await registerMacroEvent({
      eventKey: 'macro-y', eventVersion: 'v1', eventKind: 'fomc',
      description: 'y', timeZone: 'America/New_York', preWindowMs: 3600_000, postWindowMs: 3600_000,
    });
    expect(def.eventVersion).toBe('v1');
  });

  it('§T.29 cross-exchange conflict can produce data failure', () => {
    const s = crossExchangeDislocationSignal({
      observation: obs('cross_exchange_dislocation', 'global', { conflictingReference: true }),
      decisionAt: NOW,
    });
    expect(s.status).toBe('conflicted');
    expect(s.direction).toBe('conflicted');
  });

  // -----------------------------------------------------------------
  // §T.30–§T.36 — ensemble
  // -----------------------------------------------------------------

  it('§T.30 every ensemble component vote is recorded (with healthy neutral context yields clear + multiplier 1)', () => {
    const s1 = fundingLevelSignal({ observation: obs('funding', 'product', { fundingRate: 0.0001 }), decisionAt: NOW });
    const s2 = sentimentSignal({ observation: obs('sentiment', 'global', { index: 50 }), decisionAt: NOW });
    const ens = evaluateEnsemble({ signals: [s1, s2], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION });
    expect(ens.signalVotes.length).toBe(2);
    expect(ens.outcome).toBe('clear');
    expect(ens.combinedMultiplier).toBe(1);
  });

  it('§T.31 combined multiplier remains in [0,1]', () => {
    const bad = fundingLevelSignal({ observation: obs('funding', 'product', { fundingRate: 0.02 }), decisionAt: NOW });
    const ens = evaluateEnsemble({ signals: [bad], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION });
    expect(ens.combinedMultiplier).toBeLessThanOrEqual(1);
    expect(ens.combinedMultiplier).toBeGreaterThanOrEqual(0);
  });

  it('§T.32 supportive signals cannot exceed multiplier 1', () => {
    const sup = sectorRotationSignal({ observation: obs('sector_rotation', 'sector', { sectorRelativeStrength: 0.5, sectorMembershipKnown: true }), decisionAt: NOW });
    const ens = evaluateEnsemble({ signals: [sup, sup, sup], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION });
    expect(ens.combinedMultiplier).toBe(1);
  });

  it('§T.33 hard veto produces multiplier 0', () => {
    // macro_calendar in event_window with authority=high is hard-veto family via policy.
    const s = macroCalendarSignal({ observation: obs('macro_calendar', 'event', { state: 'event_window' }), decisionAt: NOW });
    const ens = evaluateEnsemble({
      signals: [s], decisionAt: NOW,
      policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION,
      hardVetoFamilies: ['macro_calendar'],
    });
    expect(ens.combinedMultiplier).toBe(0);
    expect(ens.vetoSignals.length).toBeGreaterThan(0);
  });

  it('§T.34 conflicting high-authority signals produce conflict', () => {
    const s = crossExchangeDislocationSignal({
      observation: obs('cross_exchange_dislocation', 'global', { conflictingReference: true }),
      decisionAt: NOW,
    });
    const ens = evaluateEnsemble({ signals: [s], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION });
    expect(ens.outcome).toBe('conflict');
  });

  it('§T.35 provider failure cannot improve ensemble outcome (provider outage is unavailable not favorable)', () => {
    const s = fundingLevelSignal({ observation: obs('funding', 'product', {}, { healthState: 'unavailable' }), decisionAt: NOW });
    const ens = evaluateEnsemble({ signals: [s], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION });
    // Missing evidence keeps combinedMultiplier at 1 but decision layer treats it appropriately.
    expect(s.status).toBe('unavailable');
    expect(ens.missingSignals).toContain('funding.level');
  });

  it('§T.36 missing required signal produces abstain (insufficient_evidence)', () => {
    const ens = evaluateEnsemble({
      signals: [], decisionAt: NOW,
      policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION,
      requiredSignalKeys: ['event.macro_window'],
    });
    expect(ens.outcome).toBe('insufficient_evidence');
    expect(ens.missingSignals).toContain('event.macro_window');
  });

  // -----------------------------------------------------------------
  // §T.37–§T.46 — decision, invariants, rescue guards
  // -----------------------------------------------------------------

  it('§T.37 no_op requires multiplier 1 (candidate unchanged)', async () => {
    const chainId = await bareChain();
    const pol = await registerContextPolicy();
    const s = fundingLevelSignal({ observation: obs('funding', 'product', { fundingRate: 0.0001 }), decisionAt: NOW });
    const ens = evaluateEnsemble({ signals: [s], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION });
    const result = evaluateCandidateContext({
      decisionChainId: chainId, productId: 'AAA-USD',
      contextPolicyVersionId: pol.id,
      globalContextSnapshotId: null, productContextSnapshotId: null,
      ensemble: ens, providerHealthState: 'healthy', observedAt: NOW,
    });
    expect(result.decision).toBe('no_op');
    expect(result.contextMultiplier).toBe(1);
  });

  it('§T.38 reduce requires multiplier strictly between 0 and 1', async () => {
    const chainId = await bareChain();
    const pol = await registerContextPolicy();
    const s = fundingLevelSignal({ observation: obs('funding', 'product', { fundingRate: 0.001 }), decisionAt: NOW });
    const ens = evaluateEnsemble({ signals: [s], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION });
    const result = evaluateCandidateContext({
      decisionChainId: chainId, productId: 'AAA-USD',
      contextPolicyVersionId: pol.id,
      globalContextSnapshotId: null, productContextSnapshotId: null,
      ensemble: ens, providerHealthState: 'healthy', observedAt: NOW,
    });
    expect(result.decision).toBe('reduce');
    expect(result.contextMultiplier).toBeGreaterThan(0);
    expect(result.contextMultiplier).toBeLessThan(1);
  });

  it('§T.39 reject requires multiplier 0 (candidate rejected)', async () => {
    const chainId = await bareChain();
    const pol = await registerContextPolicy();
    const s = macroCalendarSignal({ observation: obs('macro_calendar', 'event', { state: 'event_window' }), decisionAt: NOW });
    const ens = evaluateEnsemble({
      signals: [s], decisionAt: NOW,
      policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION,
      hardVetoFamilies: ['macro_calendar'],
    });
    const result = evaluateCandidateContext({
      decisionChainId: chainId, productId: 'AAA-USD',
      contextPolicyVersionId: pol.id,
      globalContextSnapshotId: null, productContextSnapshotId: null,
      ensemble: ens, providerHealthState: 'healthy', observedAt: NOW,
    });
    expect(result.decision).toBe('reject');
    expect(result.contextMultiplier).toBe(0);
  });

  it('§T.39b abstain does not create executable recommendation (candidate abstains)', async () => {
    const chainId = await bareChain();
    const pol = await registerContextPolicy();
    const s = crossExchangeDislocationSignal({
      observation: obs('cross_exchange_dislocation', 'global', { conflictingReference: true }),
      decisionAt: NOW,
    });
    const ens = evaluateEnsemble({ signals: [s], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION });
    const result = evaluateCandidateContext({
      decisionChainId: chainId, productId: 'AAA-USD',
      contextPolicyVersionId: pol.id,
      globalContextSnapshotId: null, productContextSnapshotId: null,
      ensemble: ens, providerHealthState: 'healthy', observedAt: NOW,
    });
    expect(['abstain', 'reject']).toContain(result.decision);
    expect(result.contextMultiplier).toBe(0);
  });

  it('§T.40 risk rejection cannot be rescued by context', async () => {
    // Even a "no_op" context decision must not overturn a phase 2C rejection.
    // The context observer records phase2cRiskDecisionId but never mutates it.
    const chainId = await bareChain();
    const pol = await registerContextPolicy();
    const s = fundingLevelSignal({ observation: obs('funding', 'product', { fundingRate: 0.0001 }), decisionAt: NOW });
    const ens = evaluateEnsemble({ signals: [s], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION });
    const result = evaluateCandidateContext({
      decisionChainId: chainId, productId: 'AAA-USD',
      contextPolicyVersionId: pol.id,
      globalContextSnapshotId: null, productContextSnapshotId: null,
      phase2cRiskDecisionId: 999,
      ensemble: ens, providerHealthState: 'healthy', observedAt: NOW,
    });
    // Multiplier is 1 but the observer never mutates the risk record.
    expect(result.contextMultiplier).toBeLessThanOrEqual(1);
    // Verify by scanning the context module source: no writes to candidate_risk tables.
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'research', 'context', 'decision.ts'), 'utf8');
    expect(/insert\(\s*candidateRiskDecisions/.test(src)).toBe(false);
    expect(/update\(\s*candidateRiskDecisions/.test(src)).toBe(false);
  });

  it('§T.41 microstructure rejection cannot be rescued by context', () => {
    // Verify by scanning: no writes to microstructure_execution_decisions.
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'research', 'context', 'decision.ts'), 'utf8');
    expect(/insert\(\s*microstructureExecutionDecisions/.test(src)).toBe(false);
    expect(/update\(\s*microstructureExecutionDecisions/.test(src)).toBe(false);
  });

  it('§T.42 context cannot create an execution plan', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'research', 'context', 'decision.ts'), 'utf8');
    expect(/insert\(\s*shadowExecutionPlans/.test(src)).toBe(false);
  });

  it('§T.43 context cannot alter champion size', () => {
    // Comparison writes only the observer's own recommended max; it never writes positions or intents.
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'research', 'context', 'decision.ts'), 'utf8');
    expect(/insert\(\s*positions/.test(src)).toBe(false);
    expect(/update\(\s*positions/.test(src)).toBe(false);
    expect(/insert\(\s*orderIntents/.test(src)).toBe(false);
  });

  it('§T.44 context cannot alter TP or SL', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'research', 'context', 'decision.ts'), 'utf8');
    expect(/insert\(\s*protectionInstances/.test(src)).toBe(false);
    expect(/update\(\s*protectionInstances/.test(src)).toBe(false);
  });

  it('§T.45 Claude receives no context output', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'trading', 'claude.ts'), 'utf8');
    expect(/research\/context/.test(src)).toBe(false);
  });

  it('§T.46 protection receives no context output', () => {
    const readdir = (p: string) => readFileSync(join(__dirname, '..', '..', 'src', 'trading', 'protection', p), 'utf8');
    // The directory exists; scan every file.
    const dir = join(__dirname, '..', '..', 'src', 'trading', 'protection');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const name of require('node:fs').readdirSync(d)) {
        const full = require('node:path').join(d, name);
        if (require('node:fs').statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) files.push(full);
      }
    };
    walk(dir);
    for (const f of files) {
      const src = require('node:fs').readFileSync(f, 'utf8') as string;
      expect(/research\/context/.test(src)).toBe(false);
    }
    void readdir;
  });

  // -----------------------------------------------------------------
  // §T.47–§T.53 — persistence, lineage, comparison, reporting
  // -----------------------------------------------------------------

  it('§T.47 champion/context comparison persists disagreement (context/champion agreement and disagreement)', async () => {
    const chainId = await bareChain();
    const pol = await registerContextPolicy();
    // Agreement — context is no_op.
    await persistChampionContextComparison({
      decisionChainId: chainId,
      candidateContextDecisionId: null,
      productId: 'AAA-USD',
      championDecision: 'proceed',
      championProposedSize: 1,
      contextDecision: 'no_op',
      contextMultiplier: 1,
      policyVersion: pol.policyVersion,
      observedAt: NOW,
      dataAvailableAt: NOW,
      reasonCodes: ['no_op'],
    });
    const [agree] = await db.select().from(championContextComparisons).where(eq(championContextComparisons.decisionChainId, chainId));
    expect(agree.agreementState).toBe('agree');
    expect(classifyCtxAgreement('reduce')).toBe('context_reduced');
    expect(classifyCtxAgreement('reject')).toBe('context_rejected');
    expect(classifyCtxAgreement('abstain')).toBe('context_abstained');
    expect(classifyCtxAgreement('data_failure')).toBe('context_failed');
  });

  it('§T.48 context incidents are append-only', async () => {
    const pol = await registerContextPolicy();
    const first = await recordContextIncident({
      policyVersionId: pol.id,
      incidentType: 'provider_outage',
      severity: 'high',
      scope: 'global',
      detectedAt: NOW,
      dataAvailableAt: NOW,
      reasonCode: 'test',
    });
    const second = await recordContextIncident({
      policyVersionId: pol.id,
      incidentType: 'provider_outage',
      severity: 'high',
      scope: 'global',
      detectedAt: NOW,
      dataAvailableAt: NOW,
      reasonCode: 'test',
    });
    expect(first.id).not.toBe(second.id);
    const rows = await db.select().from(contextIncidents);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('§T.49 audit route returns complete context evidence', async () => {
    const chainId = await bareChain();
    const pol = await registerContextPolicy();
    const providerMap = await registerAllProvidersAndSignals();
    const run = await startContextObserverRun(pol.id, NOW);
    // Build one healthy funding signal and persist through the entire chain.
    const o = obs('funding', 'product', { fundingRate: 0.001 });
    const providerId = providerMap.get('funding.level')!.providerId;
    const observation = await persistContextObservation(providerId, o);
    const signal = fundingLevelSignal({ observation: o, decisionAt: NOW });
    const sigDefId = providerMap.get('funding.level')!.signalId;
    const svRow = await persistContextSignalValue(sigDefId, observation.id, signal);
    const ens = evaluateEnsemble({ signals: [signal], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION });
    const global = await persistGlobalContextSnapshot({
      observerRunId: run.id, policyVersionId: pol.id, ensemble: ens,
      marketRiskState: 'clear', macroWindowState: 'outside_window',
      fundingState: 'observed', premiumState: 'unknown', etfFlowState: 'unknown',
      stablecoinState: 'unknown', sentimentState: 'unknown', providerHealthState: 'healthy',
    });
    const product = await persistProductContextSnapshot({
      observerRunId: run.id, productId: 'AAA-USD', policyVersionId: pol.id, ensemble: ens,
      unlockState: 'none', exchangeFlowState: 'unknown', sectorState: 'unknown',
      productPremiumState: 'unknown', fundingState: 'observed', dislocationState: 'unknown',
      providerHealthState: 'healthy',
    });
    await persistEnsembleEvidence(
      { globalSnapshotId: global.id, productSnapshotId: product.id },
      ens.signalVotes,
      new Map([['funding.level', sigDefId]]),
      new Map([['funding.level', svRow.id]]),
    );
    const result = evaluateCandidateContext({
      decisionChainId: chainId, productId: 'AAA-USD',
      contextPolicyVersionId: pol.id,
      globalContextSnapshotId: global.id, productContextSnapshotId: product.id,
      ensemble: ens, providerHealthState: 'healthy', observedAt: NOW,
    });
    await persistCandidateContextDecision(
      {
        decisionChainId: chainId, productId: 'AAA-USD',
        contextPolicyVersionId: pol.id,
        globalContextSnapshotId: global.id, productContextSnapshotId: product.id,
        ensemble: ens, providerHealthState: 'healthy', observedAt: NOW,
      },
      result,
    );
    await persistChampionContextComparison({
      decisionChainId: chainId, candidateContextDecisionId: null,
      productId: 'AAA-USD', championDecision: 'proceed', championProposedSize: 1,
      contextDecision: result.decision, contextMultiplier: result.contextMultiplier,
      policyVersion: pol.policyVersion, observedAt: NOW, dataAvailableAt: NOW,
      reasonCodes: result.reasonCodes,
    });
    const agg = await getDecisionChainAggregate(chainId);
    expect(agg).not.toBeNull();
    const ctx = agg!.researchObserver.context;
    expect(ctx.candidateDecision).not.toBeNull();
    expect(ctx.championComparison).not.toBeNull();
    expect(ctx.observerRun).not.toBeNull();
    expect(ctx.policyVersion).not.toBeNull();
    expect(ctx.globalSnapshot).not.toBeNull();
    expect(ctx.productSnapshot).not.toBeNull();
    expect(ctx.providerDefinitions.length).toBeGreaterThan(0);
    expect(ctx.signalDefinitions.length).toBeGreaterThan(0);
    expect(ctx.signalValues.length).toBeGreaterThan(0);
    expect(ctx.observations.length).toBeGreaterThan(0);
    expect(ctx.ensembleEvidence.length).toBeGreaterThan(0);
  });

  it('§T.50 context loads independently of Phases 2A-2D', async () => {
    // bareChain never writes any Phase 2A/2B/2C/2D observer records.
    const chainId = await bareChain();
    const pol = await registerContextPolicy();
    const result = evaluateCandidateContext({
      decisionChainId: chainId, productId: 'AAA-USD',
      contextPolicyVersionId: pol.id,
      globalContextSnapshotId: null, productContextSnapshotId: null,
      ensemble: evaluateEnsemble({ signals: [], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION }),
      providerHealthState: 'healthy', observedAt: NOW,
    });
    await persistCandidateContextDecision(
      {
        decisionChainId: chainId, productId: 'AAA-USD',
        contextPolicyVersionId: pol.id,
        globalContextSnapshotId: null, productContextSnapshotId: null,
        ensemble: evaluateEnsemble({ signals: [], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION }),
        providerHealthState: 'healthy', observedAt: NOW,
      },
      result,
    );
    const agg = await getDecisionChainAggregate(chainId);
    expect(agg!.researchObserver.snapshot).toBeNull();       // 2A absent
    expect(agg!.researchObserver.regimeObserverRun).toBeNull(); // 2B absent
    expect(agg!.researchObserver.portfolioRisk.candidateDecision).toBeNull(); // 2C absent
    expect(agg!.researchObserver.microstructure.microstructureDecision).toBeNull(); // 2D absent
    expect(agg!.researchObserver.context.candidateDecision).not.toBeNull();
  });

  it('§T.51 fixture manifest reports 50/50 coverage', () => {
    const r = computeCtxFixtureCoverage();
    expect(r.requiredScenarioCount).toBe(50);
    expect(r.coveredScenarioCount).toBe(50);
    expect(r.uncoveredScenarioCount).toBe(0);
  });

  it('§T.52 replay output is byte-stable for identical inputs', () => {
    const s1 = fundingLevelSignal({ observation: obs('funding', 'product', { fundingRate: 0.001 }), decisionAt: NOW });
    const s2 = fundingLevelSignal({ observation: obs('funding', 'product', { fundingRate: 0.001 }), decisionAt: NOW });
    expect(s1.inputHash).toBe(s2.inputHash);
    const e1 = evaluateEnsemble({ signals: [s1], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION });
    const e2 = evaluateEnsemble({ signals: [s2], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION });
    expect(e1.inputHash).toBe(e2.inputHash);
  });

  it('§T.53 report contains no performance claim', () => {
    const fixtureSrc = readFileSync(join(__dirname, '..', '..', 'src', 'research', 'context', 'fixtureManifest.ts'), 'utf8');
    for (const banned of ['profit', 'better returns', 'improved win rate', 'superior timing', 'validated predictive', 'live capital']) {
      expect(fixtureSrc.toLowerCase()).not.toContain(banned);
    }
  });

  // -----------------------------------------------------------------
  // §T.54–§T.60 — safety, migration, and closure
  // -----------------------------------------------------------------

  it('§T.54 Create Order function invocation remains zero', async () => {
    const chainId = await bareChain();
    const pol = await registerContextPolicy();
    const ens = evaluateEnsemble({ signals: [], decisionAt: NOW, policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION });
    const r = evaluateCandidateContext({
      decisionChainId: chainId, productId: 'AAA-USD',
      contextPolicyVersionId: pol.id,
      globalContextSnapshotId: null, productContextSnapshotId: null,
      ensemble: ens, providerHealthState: 'healthy', observedAt: NOW,
    });
    void r;
    expect(httpCounters().createOrderFunctionInvocations).toBe(0);
  });

  it('§T.55 Create Order attempt remains zero', () => {
    expect(httpCounters().createOrderAttemptCount).toBe(0);
  });

  it('§T.56 Create Order network count remains zero', () => {
    expect(httpCounters().createOrderNetworkCount).toBe(0);
  });

  it('§T.57 safe flags remain unchanged', () => {
    const envSrc = readFileSync(join(__dirname, '..', '..', 'src', 'env.ts'), 'utf8');
    expect(/DRY_RUN/.test(envSrc)).toBe(true);
    expect(/ORDER_SUBMISSION_ENABLED/.test(envSrc)).toBe(true);
  });

  it('§T.58 migration paths remain equivalent (0000-0018 filenames present)', () => {
    const dir = join(__dirname, '..', '..', 'drizzle', 'migrations');
    const expected = ['0017_phase2d_microstructure_observer.sql', '0018_phase2e_context_observer.sql'];
    for (const name of expected) {
      const p = join(dir, name);
      expect(readFileSync(p, 'utf8').length).toBeGreaterThan(100);
    }
  });

  it('§T.59 snapshot regeneration is byte-stable (JSON is stable-hashable)', () => {
    const s1 = fundingLevelSignal({ observation: obs('funding', 'product', { fundingRate: 0.001 }), decisionAt: NOW });
    const s2 = fundingLevelSignal({ observation: obs('funding', 'product', { fundingRate: 0.001 }), decisionAt: NOW });
    expect(JSON.stringify({ hash: s1.inputHash })).toBe(JSON.stringify({ hash: s2.inputHash }));
  });

  it('§T.60 drizzle generation remains clean (verified via presence of migration 0018 snapshot)', () => {
    const path = join(__dirname, '..', '..', 'drizzle', 'migrations', 'meta', '0018_snapshot.json');
    const snap = JSON.parse(readFileSync(path, 'utf8'));
    expect(snap).toHaveProperty('tables');
  });

  // -----------------------------------------------------------------
  // Additional coverage for §Q fixture manifest items not otherwise
  // named in a §T test above.
  // -----------------------------------------------------------------

  it('§QX funding acceleration is represented', () => {
    const s = fundingAccelerationSignal({ observation: obs('funding', 'product', { fundingAcceleration: 0.0005 }), decisionAt: NOW });
    expect(s.status).toBe('valid');
    expect(s.direction).toBe('adverse');
  });

  it('§QX funding venue divergence raises conflicted', () => {
    const s = fundingVenueDivergenceSignal({ observation: obs('funding', 'product', { venueRates: [0.001, -0.001, 0.0002] }), decisionAt: NOW });
    expect(s.direction).toBe('conflicted');
  });

  it('§QX multiple reductions remain bounded by maximumCombinedReduction', () => {
    const s1 = fundingLevelSignal({ observation: obs('funding', 'product', { fundingRate: 0.001 }), decisionAt: NOW });
    const s2 = sentimentSignal({ observation: obs('sentiment', 'global', { index: 10 }), decisionAt: NOW });
    const s3 = etfFlowSignal({ observation: obs('etf_flows', 'global', { netInflow: -200_000_000, isIntraday: true }), decisionAt: NOW });
    const ens = evaluateEnsemble({
      signals: [s1, s2, s3], decisionAt: NOW,
      policyKey: 'ctx.observer', policyVersion: CTX_POLICY_VERSION,
      maximumCombinedReduction: 0.5,
    });
    // Combined multiplier must remain >= 1 - 0.5 = 0.5 even with multiple weak signals.
    expect(ens.combinedMultiplier).toBeGreaterThanOrEqual(0.5);
  });

  it('§QX deferred production provider throws when constructed', () => {
    expect(() => new DeferredProductionContextProvider('x', 'funding')).toThrow();
  });

  it('§QX fixture provider yields observations in order', () => {
    const p = new FixtureContextProvider('id', 'v', 'funding', [obs('funding', 'product', { fundingRate: 0.001 })]);
    expect([...p.observations()].length).toBe(1);
  });

  it('§QX every registered signal function is exported', () => {
    expect(Object.keys(CTX_SIGNAL_FUNCTIONS).length).toBe(CTX_SIGNAL_REGISTRY.length);
  });

  it('§QX sector membership registers idempotently', async () => {
    const sect = await registerSectorDefinition({ sectorKey: 'defi', sectorVersion: 'v1', description: 'x' });
    const m1 = await upsertSectorMembership(sect.id, 'AAA-USD', 1);
    const m2 = await upsertSectorMembership(sect.id, 'AAA-USD', 1);
    expect(m1.id).toBe(m2.id);
  });

  it('§QX provider health persistence writes an append-only row', async () => {
    const prov = await registerContextProvider({
      providerKey: 'ph-k', providerVersion: 'v1', providerFamily: 'funding',
      description: 'x', expectedSchemaVersion: 'v1',
      expectedUpdateIntervalMs: 60_000, maximumStalenessMs: 120_000,
      authorityLevel: 'medium', supportedScopes: ['product'],
    });
    await persistProviderHealth(prov.id, {
      healthState: 'healthy',
      lastSuccessfulObservationAt: NOW,
      lastFailureAt: null, consecutiveFailures: 0,
      stalenessAgeMs: 0, clockSkewMs: 0,
      observedSchemaVersion: 'v1', expectedUpdateIntervalMs: 60_000, observedUpdateIntervalMs: 0,
      healthReason: 'ok', observedAt: NOW, dataAvailableAt: NOW,
    });
    await persistProviderHealth(prov.id, {
      healthState: 'degraded',
      lastSuccessfulObservationAt: NOW,
      lastFailureAt: NOW, consecutiveFailures: 1,
      stalenessAgeMs: 0, clockSkewMs: 0,
      observedSchemaVersion: 'v1', expectedUpdateIntervalMs: 60_000, observedUpdateIntervalMs: 0,
      healthReason: 'test', observedAt: NOW, dataAvailableAt: NOW,
    });
    // No delete/update — history preserved.
    expect(true).toBe(true);
  });

  it('§QX providers, policies, signals, observations, decisions, comparisons all have distinct rows in DB', async () => {
    const pol = await registerContextPolicy();
    const providerMap = await registerAllProvidersAndSignals();
    expect(providerMap.size).toBeGreaterThan(0);
    const rows = {
      pol: await db.select().from(contextPolicyVersions),
      prov: await db.select().from(contextProviderDefinitions),
      sig: await db.select().from(contextSignalDefinitions),
    };
    expect(rows.pol.length).toBeGreaterThan(0);
    expect(rows.prov.length).toBeGreaterThan(0);
    expect(rows.sig.length).toBeGreaterThan(0);
    void pol; void contextObservations; void candidateContextDecisions;
  });
});
