/**
 * Stage 12 — Prospective validation schema + sufficiency tests.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUFFICIENCY_THRESHOLDS,
  evaluateProspectiveSufficiency,
  ProspectiveValidationReportSchema,
  type ProspectiveValidationReport,
} from '@horizon/shared';

const SHA = '0'.repeat(40);

function makeReport(overrides: Partial<ProspectiveValidationReport> = {}): ProspectiveValidationReport {
  return {
    reportId: 'p-abc',
    commitSha: SHA,
    soakId: 'soak-abc',
    generatedAt: '2026-08-05T12:00:00Z',
    windowStartUtc: '2026-07-29T00:00:00Z',
    windowEndUtc: '2026-08-05T00:00:00Z',
    sampleSize: {
      totalObservations: 6_000,
      distinctProducts: 20,
      distinctDaysUtc: 7,
      totalDecisionChains: 300,
      completedRoundTrips: 60,
    },
    distributions: [
      { dimension: 'strategy_mode', buckets: [{ key: 'reversion', count: 300, fraction: 0.5 }, { key: 'breakout', count: 300, fraction: 0.5 }], sufficient: true },
      { dimension: 'product', buckets: [{ key: 'BTC-USD', count: 100, fraction: 0.166 }, { key: 'ETH-USD', count: 500, fraction: 0.834 }], sufficient: true },
      { dimension: 'utc_hour', buckets: [{ key: '00', count: 25, fraction: 0.05 }, { key: '12', count: 30, fraction: 0.06 }], sufficient: true },
      { dimension: 'volatility_regime', buckets: [{ key: 'calm', count: 400, fraction: 0.67 }, { key: 'volatile', count: 200, fraction: 0.33 }], sufficient: true },
      { dimension: 'signal_confidence_bucket', buckets: [{ key: 'low', count: 100, fraction: 0.2 }, { key: 'mid', count: 300, fraction: 0.5 }, { key: 'high', count: 200, fraction: 0.3 }], sufficient: true },
    ],
    costForecastAccuracy: { meanAbsoluteErrorBps: 2.3, meanSignedErrorBps: 0.1, correlationForecastVsRealized: 0.72, sampleCount: 300 },
    grossToNetAttribution: { grossReturnBps: 12, feesBps: 2, spreadBps: 3, slippageBps: 1, fundingBps: 0, netReturnBps: 6, sampleCount: 300 },
    execution: { totalStops: 12, gapEvents: 1, meanSlippageBps: 1.2, meanFillLatencyMs: 50, passiveFillFraction: 0.6, partialFillFraction: 0.2, meanLiquidityParticipation: 0.05, meanSpreadBps: 3 },
    protection: { totalProtections: 60, degradedProtections: 2, degradedFraction: 0.03, gapRiskViolations: 0 },
    reconciliation: { unresolvedActions: 0, meanResolutionSeconds: 10, lineageBrokenCount: 0 },
    risk: { riskCapBindingFraction: 0.1, expectedShortfall95Bps: 45, maxDrawdownBps: 30, dailyLossControlBreaches: 0, weeklyLossControlBreaches: 0, liquidityCapBindingFraction: 0.05 },
    observerDisagreement: { totalDecisions: 300, observerDisagreedWithChampion: 45, disagreementFraction: 0.15, observerPromotionsAttempted: 0, observerPromotionsAllowed: 0 },
    dataQualityIncidents: [],
    providerIncidents: [],
    verdict: 'prospective_evidence_sufficient',
    verdictDetail: 'all buckets met minimums',
    ...overrides,
  };
}

describe('ProspectiveValidationReportSchema', () => {
  it('parses a well-formed report', () => {
    const r = ProspectiveValidationReportSchema.safeParse(makeReport());
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues[0])).toBe(true);
  });

  it('rejects multiplier > 1', () => {
    const r = ProspectiveValidationReportSchema.safeParse(makeReport({
      protection: { totalProtections: 1, degradedProtections: 0, degradedFraction: 1.5, gapRiskViolations: 0 },
    }));
    expect(r.success).toBe(false);
  });

  it('rejects observerPromotionsAttempted != 0', () => {
    const r = ProspectiveValidationReportSchema.safeParse(makeReport({
      observerDisagreement: { totalDecisions: 1, observerDisagreedWithChampion: 0, disagreementFraction: 0, observerPromotionsAttempted: 1 as never, observerPromotionsAllowed: 0 },
    }));
    expect(r.success).toBe(false);
  });

  it("accepts explicit 'unknown' values", () => {
    const r = ProspectiveValidationReportSchema.safeParse(makeReport({
      costForecastAccuracy: { meanAbsoluteErrorBps: 'unknown', meanSignedErrorBps: 'unknown', correlationForecastVsRealized: 'unknown', sampleCount: 0 },
    }));
    expect(r.success).toBe(true);
  });
});

describe('evaluateProspectiveSufficiency', () => {
  it('returns ok on happy path', () => {
    const v = evaluateProspectiveSufficiency(makeReport());
    expect(v.ok).toBe(true);
  });

  it('returns reasons when sample size too small', () => {
    const v = evaluateProspectiveSufficiency(makeReport({
      sampleSize: { totalObservations: 100, distinctProducts: 3, distinctDaysUtc: 2, totalDecisionChains: 5, completedRoundTrips: 1 },
    }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it('returns reasons when a required distribution is missing', () => {
    const v = evaluateProspectiveSufficiency(makeReport({
      distributions: makeReport().distributions.filter((d) => d.dimension !== 'product'),
    }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons.some((r) => r.includes('distribution.product'))).toBe(true);
  });

  it('returns reason when a soak_invalidating incident is present', () => {
    const v = evaluateProspectiveSufficiency(makeReport({
      dataQualityIncidents: [{ incidentKind: 'stale_data_rejection', count: 1, classification: 'soak_invalidating' }],
    }));
    expect(v.ok).toBe(false);
  });

  it('respects custom thresholds', () => {
    const v = evaluateProspectiveSufficiency(makeReport(), {
      ...DEFAULT_SUFFICIENCY_THRESHOLDS,
      minTotalObservations: 100_000,
    });
    expect(v.ok).toBe(false);
  });
});
