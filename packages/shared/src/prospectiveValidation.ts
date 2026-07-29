/**
 * Stage 12 — Extended prospective shadow validation contract.
 *
 * Schemas for the evidence buckets the standing execution order
 * names. Every field is zod-strict — an insufficient-evidence
 * verdict is a first-class result and MUST NOT be altered merely
 * to advance the roadmap.
 *
 * Observer outputs remain observer-only. Multipliers are bounded
 * to [0,1]. Unknown is a distinct value, never zero.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const MultiplierSchema = z.number().min(0).max(1);
export type Multiplier = z.infer<typeof MultiplierSchema>;

/** Explicitly-unknown value. Callers MUST distinguish from 0. */
export const UnknownSchema = z.literal('unknown');
export type Unknown = z.infer<typeof UnknownSchema>;

export const NumericOrUnknownSchema = z.union([z.number().finite(), UnknownSchema]);
export type NumericOrUnknown = z.infer<typeof NumericOrUnknownSchema>;

// ---------------------------------------------------------------------------
// Sample-size + distribution shape
// ---------------------------------------------------------------------------

export const SampleSizeSchema = z.object({
  totalObservations: z.number().int().nonnegative(),
  distinctProducts: z.number().int().nonnegative(),
  distinctDaysUtc: z.number().int().nonnegative(),
  totalDecisionChains: z.number().int().nonnegative(),
  completedRoundTrips: z.number().int().nonnegative(),
}).strict();
export type SampleSize = z.infer<typeof SampleSizeSchema>;

export const DistributionBucketSchema = z.object({
  key: z.string().min(1),
  count: z.number().int().nonnegative(),
  fraction: MultiplierSchema,
}).strict();
export type DistributionBucket = z.infer<typeof DistributionBucketSchema>;

export const DistributionSchema = z.object({
  dimension: z.enum([
    'strategy_mode',
    'product',
    'utc_hour',
    'utc_weekday',
    'volatility_regime',
    'liquidity_regime',
    'signal_confidence_bucket',
  ]),
  buckets: z.array(DistributionBucketSchema).min(1),
  sufficient: z.boolean(),
  detail: z.string().max(200).optional(),
}).strict();
export type Distribution = z.infer<typeof DistributionSchema>;

// ---------------------------------------------------------------------------
// Cost + attribution
// ---------------------------------------------------------------------------

export const CostForecastAccuracySchema = z.object({
  meanAbsoluteErrorBps: NumericOrUnknownSchema,
  meanSignedErrorBps: NumericOrUnknownSchema,
  correlationForecastVsRealized: z.union([z.number().min(-1).max(1), UnknownSchema]),
  sampleCount: z.number().int().nonnegative(),
}).strict();
export type CostForecastAccuracy = z.infer<typeof CostForecastAccuracySchema>;

export const GrossToNetAttributionSchema = z.object({
  grossReturnBps: NumericOrUnknownSchema,
  feesBps: NumericOrUnknownSchema,
  spreadBps: NumericOrUnknownSchema,
  slippageBps: NumericOrUnknownSchema,
  fundingBps: NumericOrUnknownSchema,
  netReturnBps: NumericOrUnknownSchema,
  sampleCount: z.number().int().nonnegative(),
}).strict();
export type GrossToNetAttribution = z.infer<typeof GrossToNetAttributionSchema>;

// ---------------------------------------------------------------------------
// Execution + risk observations
// ---------------------------------------------------------------------------

export const ExecutionObservationSchema = z.object({
  totalStops: z.number().int().nonnegative(),
  gapEvents: z.number().int().nonnegative(),
  meanSlippageBps: NumericOrUnknownSchema,
  meanFillLatencyMs: NumericOrUnknownSchema,
  passiveFillFraction: MultiplierSchema,
  partialFillFraction: MultiplierSchema,
  meanLiquidityParticipation: MultiplierSchema,
  meanSpreadBps: NumericOrUnknownSchema,
}).strict();
export type ExecutionObservation = z.infer<typeof ExecutionObservationSchema>;

export const ProtectionObservationSchema = z.object({
  totalProtections: z.number().int().nonnegative(),
  degradedProtections: z.number().int().nonnegative(),
  degradedFraction: MultiplierSchema,
  gapRiskViolations: z.number().int().nonnegative(),
}).strict();
export type ProtectionObservation = z.infer<typeof ProtectionObservationSchema>;

export const ReconciliationObservationSchema = z.object({
  unresolvedActions: z.number().int().nonnegative(),
  meanResolutionSeconds: NumericOrUnknownSchema,
  lineageBrokenCount: z.number().int().nonnegative(),
}).strict();
export type ReconciliationObservation = z.infer<typeof ReconciliationObservationSchema>;

export const RiskObservationSchema = z.object({
  riskCapBindingFraction: MultiplierSchema,
  expectedShortfall95Bps: NumericOrUnknownSchema,
  maxDrawdownBps: NumericOrUnknownSchema,
  dailyLossControlBreaches: z.number().int().nonnegative(),
  weeklyLossControlBreaches: z.number().int().nonnegative(),
  liquidityCapBindingFraction: MultiplierSchema,
}).strict();
export type RiskObservation = z.infer<typeof RiskObservationSchema>;

// ---------------------------------------------------------------------------
// Observer/champion disagreement + incidents
// ---------------------------------------------------------------------------

export const ObserverDisagreementSchema = z.object({
  totalDecisions: z.number().int().nonnegative(),
  observerDisagreedWithChampion: z.number().int().nonnegative(),
  disagreementFraction: MultiplierSchema,
  observerPromotionsAttempted: z.literal(0),
  observerPromotionsAllowed: z.literal(0),
}).strict();
export type ObserverDisagreement = z.infer<typeof ObserverDisagreementSchema>;

export const DataQualityIncidentSchema = z.object({
  incidentKind: z.string().min(1),
  count: z.number().int().nonnegative(),
  classification: z.enum(['informational', 'product_degraded', 'system_degraded', 'soak_invalidating']),
}).strict();
export type DataQualityIncident = z.infer<typeof DataQualityIncidentSchema>;

export const ProviderIncidentSchema = z.object({
  incidentKind: z.string().min(1),
  count: z.number().int().nonnegative(),
  classification: z.enum(['informational', 'system_degraded', 'soak_invalidating']),
}).strict();
export type ProviderIncident = z.infer<typeof ProviderIncidentSchema>;

// ---------------------------------------------------------------------------
// Assembled report
// ---------------------------------------------------------------------------

export const ProspectiveValidationReportSchema = z.object({
  reportId: z.string().min(1),
  commitSha: z.string().length(40).regex(/^[0-9a-f]{40}$/),
  soakId: z.string().min(1),
  generatedAt: z.string().datetime(),
  windowStartUtc: z.string().datetime(),
  windowEndUtc: z.string().datetime(),
  sampleSize: SampleSizeSchema,
  distributions: z.array(DistributionSchema).min(1),
  costForecastAccuracy: CostForecastAccuracySchema,
  grossToNetAttribution: GrossToNetAttributionSchema,
  execution: ExecutionObservationSchema,
  protection: ProtectionObservationSchema,
  reconciliation: ReconciliationObservationSchema,
  risk: RiskObservationSchema,
  observerDisagreement: ObserverDisagreementSchema,
  dataQualityIncidents: z.array(DataQualityIncidentSchema),
  providerIncidents: z.array(ProviderIncidentSchema),
  verdict: z.enum([
    'prospective_evidence_sufficient',
    'prospective_evidence_insufficient',
    'prospective_evidence_invalidated_by_incident',
  ]),
  verdictDetail: z.string().max(500),
}).strict();
export type ProspectiveValidationReport = z.infer<typeof ProspectiveValidationReportSchema>;

// ---------------------------------------------------------------------------
// Sufficiency evaluator — pure
// ---------------------------------------------------------------------------

export interface SufficiencyThresholds {
  readonly minTotalObservations: number;
  readonly minDistinctProducts: number;
  readonly minDistinctDaysUtc: number;
  readonly minCompletedRoundTrips: number;
  readonly requiredDimensions: readonly Distribution['dimension'][];
}

export const DEFAULT_SUFFICIENCY_THRESHOLDS: SufficiencyThresholds = Object.freeze({
  minTotalObservations: 5_000,
  minDistinctProducts: 10,
  minDistinctDaysUtc: 7,
  minCompletedRoundTrips: 50,
  requiredDimensions: Object.freeze([
    'strategy_mode',
    'product',
    'utc_hour',
    'volatility_regime',
    'signal_confidence_bucket',
  ]) as readonly Distribution['dimension'][],
});

export type SufficiencyVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

export function evaluateProspectiveSufficiency(
  report: ProspectiveValidationReport,
  thresholds: SufficiencyThresholds = DEFAULT_SUFFICIENCY_THRESHOLDS,
): SufficiencyVerdict {
  const reasons: string[] = [];
  if (report.sampleSize.totalObservations < thresholds.minTotalObservations) reasons.push(`totalObservations ${report.sampleSize.totalObservations} < ${thresholds.minTotalObservations}`);
  if (report.sampleSize.distinctProducts < thresholds.minDistinctProducts) reasons.push(`distinctProducts ${report.sampleSize.distinctProducts} < ${thresholds.minDistinctProducts}`);
  if (report.sampleSize.distinctDaysUtc < thresholds.minDistinctDaysUtc) reasons.push(`distinctDaysUtc ${report.sampleSize.distinctDaysUtc} < ${thresholds.minDistinctDaysUtc}`);
  if (report.sampleSize.completedRoundTrips < thresholds.minCompletedRoundTrips) reasons.push(`completedRoundTrips ${report.sampleSize.completedRoundTrips} < ${thresholds.minCompletedRoundTrips}`);
  for (const dim of thresholds.requiredDimensions) {
    const d = report.distributions.find((x) => x.dimension === dim);
    if (!d) reasons.push(`distribution.${dim} missing`);
    else if (!d.sufficient) reasons.push(`distribution.${dim} sufficient=false`);
  }
  if (report.observerDisagreement.observerPromotionsAttempted !== 0) reasons.push('observerPromotionsAttempted !== 0');
  if (report.observerDisagreement.observerPromotionsAllowed !== 0) reasons.push('observerPromotionsAllowed !== 0');
  const invalidatingIncidents = [
    ...report.dataQualityIncidents.filter((i) => i.classification === 'soak_invalidating'),
    ...report.providerIncidents.filter((i) => i.classification === 'soak_invalidating'),
  ];
  if (invalidatingIncidents.length > 0) reasons.push(`invalidatingIncidents=${invalidatingIncidents.length}`);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
