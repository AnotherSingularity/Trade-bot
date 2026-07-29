/**
 * Stage 13 — Final shadow certification tests.
 * Cannot force a positive verdict; every failure surface has a
 * negative-space test.
 */
import { describe, expect, it } from 'vitest';
import {
  certifyShadow,
  ShadowCertificationSchema,
  type ProspectiveValidationReport,
  type SoakManifest,
} from '@horizon/shared';

const SHA = 'a'.repeat(40);

function makeSoakManifest(overrides: Partial<SoakManifest> = {}): SoakManifest {
  const day = {
    dateUtc: '2026-07-29',
    firstObservationAt: '2026-07-29T00:00:00Z',
    lastObservationAt: '2026-07-29T23:59:59Z',
    uptimeSeconds: 86_400,
    runtimeStarts: 1,
    runtimeStops: 0,
    serverRestarts: 0,
    containerRestarts: 0,
    databaseDisconnects: 0,
    databaseReconnects: 0,
    redisDisconnects: 0,
    redisReconnects: 0,
    reportJobsQueued: 39,
    reportJobsCompleted: 39,
    reportJobsFailed: 0,
    idempotencyHits: 0,
    duplicatePreventions: 0,
    artifactVerificationPasses: 39,
    artifactVerificationFailures: 0,
    redactionsApplied: 39,
    redactionFailures: 0,
    secretScanFailures: 0,
    pathRejections: 0,
    temporaryCleanupFailures: 0,
    orphanReconciliations: 0,
    processLeaks: 0,
    containerLeaks: 0,
    createOrderCounters: { functionInvocations: 0 as const, attemptCount: 0 as const, networkCount: 0 as const },
    safetyFlags: {
      DRY_RUN: true as const, ORDER_SUBMISSION_ENABLED: false as const,
      liveCapitalAuthorized: false as const, promotionEnabled: false as const, kellyEnabled: false as const,
    },
    providerState: {
      marketDataProvider: 'fixture', exchangeProvider: 'fixture',
      productionLevel2Active: false, orderCapableProviderActive: false,
    },
    credentialState: {
      coinbaseCredentialsLoaded: false, anthropicCredentialsLoaded: false,
      productionCredentialsDetected: false,
    },
    dayVerdict: 'passed' as const,
  };
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.UTC(2026, 6, 29 + i)).toISOString().slice(0, 10);
    days.push({ ...day, dateUtc: d, firstObservationAt: `${d}T00:00:00Z`, lastObservationAt: `${d}T23:59:59Z` });
  }
  return {
    soakId: 'soak-abc',
    commitSha: SHA,
    startedAt: '2026-07-29T00:00:00Z',
    expectedEndAt: '2026-08-05T00:00:00Z',
    actualEndAt: '2026-08-04T23:59:59Z',
    simulationMode: 'STANDARD_DRY_RUN',
    migrationHead: '0022',
    migrationChainDigest: 'a'.repeat(64),
    reportSpecVersions: { safety_status: 'safety_status.v1' },
    runtimeMode: 'managed_docker',
    installationIdHash: 'inst',
    dayResults: days,
    incidents: [],
    safetyViolations: 0,
    codeChangesDetected: false,
    finalVerdict: 'passed',
    ...overrides,
  };
}

function makeProspective(overrides: Partial<ProspectiveValidationReport> = {}): ProspectiveValidationReport {
  return {
    reportId: 'p-abc',
    commitSha: SHA,
    soakId: 'soak-abc',
    generatedAt: '2026-08-05T12:00:00Z',
    windowStartUtc: '2026-07-29T00:00:00Z',
    windowEndUtc: '2026-08-05T00:00:00Z',
    sampleSize: { totalObservations: 6_000, distinctProducts: 20, distinctDaysUtc: 7, totalDecisionChains: 300, completedRoundTrips: 60 },
    distributions: [
      { dimension: 'strategy_mode', buckets: [{ key: 'a', count: 300, fraction: 0.5 }, { key: 'b', count: 300, fraction: 0.5 }], sufficient: true },
      { dimension: 'product', buckets: [{ key: 'BTC-USD', count: 200, fraction: 0.4 }, { key: 'ETH-USD', count: 400, fraction: 0.6 }], sufficient: true },
      { dimension: 'utc_hour', buckets: [{ key: '00', count: 25, fraction: 0.05 }, { key: '12', count: 30, fraction: 0.06 }], sufficient: true },
      { dimension: 'volatility_regime', buckets: [{ key: 'calm', count: 400, fraction: 0.67 }, { key: 'volatile', count: 200, fraction: 0.33 }], sufficient: true },
      { dimension: 'signal_confidence_bucket', buckets: [{ key: 'low', count: 100, fraction: 0.2 }, { key: 'mid', count: 300, fraction: 0.5 }, { key: 'high', count: 200, fraction: 0.3 }], sufficient: true },
    ],
    costForecastAccuracy: { meanAbsoluteErrorBps: 2, meanSignedErrorBps: 0.1, correlationForecastVsRealized: 0.7, sampleCount: 300 },
    grossToNetAttribution: { grossReturnBps: 12, feesBps: 2, spreadBps: 3, slippageBps: 1, fundingBps: 0, netReturnBps: 6, sampleCount: 300 },
    execution: { totalStops: 10, gapEvents: 0, meanSlippageBps: 1, meanFillLatencyMs: 40, passiveFillFraction: 0.6, partialFillFraction: 0.15, meanLiquidityParticipation: 0.05, meanSpreadBps: 3 },
    protection: { totalProtections: 60, degradedProtections: 1, degradedFraction: 0.017, gapRiskViolations: 0 },
    reconciliation: { unresolvedActions: 0, meanResolutionSeconds: 8, lineageBrokenCount: 0 },
    risk: { riskCapBindingFraction: 0.1, expectedShortfall95Bps: 40, maxDrawdownBps: 25, dailyLossControlBreaches: 0, weeklyLossControlBreaches: 0, liquidityCapBindingFraction: 0.04 },
    observerDisagreement: { totalDecisions: 300, observerDisagreedWithChampion: 30, disagreementFraction: 0.1, observerPromotionsAttempted: 0, observerPromotionsAllowed: 0 },
    dataQualityIncidents: [],
    providerIncidents: [],
    verdict: 'prospective_evidence_sufficient',
    verdictDetail: 'ok',
    ...overrides,
  };
}

const OK_INPUT = {
  certificationId: 'cert-1',
  releaseCandidateSha: SHA,
  generatedAt: '2026-08-05T14:00:00Z',
  soakManifest: makeSoakManifest(),
  prospectiveReport: makeProspective(),
  reconciliationUnresolved: 0,
  secretLeakageDetected: false,
  providerPolicyViolations: 0,
  migrationDrift: false,
  reportSpecDrift: false,
  evidenceStaleSeconds: 30,
  evidenceStalenessAllowanceSeconds: 3600,
};

describe('certifyShadow — happy path', () => {
  it('returns shadow_certified_for_live_canary_review when every gate satisfied', () => {
    const c = certifyShadow(OK_INPUT);
    expect(c.conclusion, `${c.conclusion}: ${c.detail}`).toBe('shadow_certified_for_live_canary_review');
    expect(c.gates.every((g) => g.satisfied)).toBe(true);
    expect(c.safetyFlagsRemainLocked).toBe(true);
    expect(c.createOrderCountersRemainZero).toBe(true);
  });

  it('parses through the certification schema', () => {
    const c = certifyShadow(OK_INPUT);
    const r = ShadowCertificationSchema.safeParse(c);
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues[0])).toBe(true);
  });
});

describe('certifyShadow — hard-fail conclusions (shadow_not_certified)', () => {
  it('rejects when reconciliation is unresolved', () => {
    const c = certifyShadow({ ...OK_INPUT, reconciliationUnresolved: 3 });
    expect(c.conclusion).toBe('shadow_not_certified');
  });
  it('rejects on secret leakage', () => {
    const c = certifyShadow({ ...OK_INPUT, secretLeakageDetected: true });
    expect(c.conclusion).toBe('shadow_not_certified');
  });
  it('rejects on provider policy violation', () => {
    const c = certifyShadow({ ...OK_INPUT, providerPolicyViolations: 1 });
    expect(c.conclusion).toBe('shadow_not_certified');
  });
  it('rejects on migration drift', () => {
    const c = certifyShadow({ ...OK_INPUT, migrationDrift: true });
    expect(c.conclusion).toBe('shadow_not_certified');
  });
  it('rejects when soakManifest.commitSha != releaseCandidateSha', () => {
    const c = certifyShadow({
      ...OK_INPUT,
      soakManifest: makeSoakManifest({ commitSha: 'b'.repeat(40) }),
    });
    expect(c.conclusion).toBe('shadow_not_certified');
  });
});

describe('certifyShadow — insufficient-evidence conclusion', () => {
  it('returns additional_shadow_evidence_required when prospective is insufficient', () => {
    const c = certifyShadow({
      ...OK_INPUT,
      prospectiveReport: makeProspective({
        verdict: 'prospective_evidence_insufficient',
        sampleSize: { totalObservations: 100, distinctProducts: 3, distinctDaysUtc: 2, totalDecisionChains: 5, completedRoundTrips: 1 },
      }),
    });
    expect(c.conclusion).toBe('additional_shadow_evidence_required');
  });
  it('returns additional_shadow_evidence_required when evidence is stale', () => {
    const c = certifyShadow({ ...OK_INPUT, evidenceStaleSeconds: 999_999 });
    expect(c.conclusion).toBe('additional_shadow_evidence_required');
  });
});

describe('certifyShadow — safety invariants are gate 5+6 not overridable', () => {
  it('cannot fabricate positive verdict when a day has DRY_RUN=false', () => {
    // Attempt to construct a soak manifest with a drifted day.
    // The schema itself blocks this — but we cast to `never` to
    // simulate a hostile caller reaching directly into the
    // certifier's input.
    const badManifest = makeSoakManifest();
    (badManifest.dayResults[0] as unknown as { safetyFlags: { DRY_RUN: boolean } }).safetyFlags.DRY_RUN = false;
    const c = certifyShadow({ ...OK_INPUT, soakManifest: badManifest });
    expect(c.conclusion).toBe('shadow_not_certified');
    const gate = c.gates.find((g) => g.id === 'safety_flags_held');
    expect(gate?.satisfied).toBe(false);
  });
});
