/**
 * Stage 3 §2 — versioned desktop read contracts.
 *
 * One shared schema surface for server, Electron main, preload, renderer,
 * and tests. Every response uses `DesktopDataEnvelope<T>`. Every list is
 * cursor-paginated with deterministic ordering.
 *
 * Money and quantities are decimal strings, never numbers — the renderer
 * must not perform floating-point arithmetic on financial values.
 * Unknown values are `null` with a reason; never zero-filled.
 * Times are UTC ISO-8601 strings.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Contract version — every response identifies which surface it belongs to.
// ---------------------------------------------------------------------------
export const DESKTOP_CONTRACT_VERSION = '3.0.0' as const;

// ---------------------------------------------------------------------------
// Primitive schemas.
// ---------------------------------------------------------------------------

/** Signed decimal string. Empty and whitespace rejected. */
export const DecimalStringSchema = z.string().regex(/^-?(?:\d+\.?\d*|\d*\.\d+)$/, 'decimal_string_required');
export type DecimalString = z.infer<typeof DecimalStringSchema>;

/** RFC 3339 / ISO-8601 UTC timestamp. Requires trailing `Z` — no local time. */
export const IsoTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/,
  'iso8601_utc_required',
);
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

/** Opaque cursor for pagination. Server-signed; renderer treats as opaque. */
export const CursorSchema = z.string().min(1).max(1024);
export type Cursor = z.infer<typeof CursorSchema>;

/** Opaque id string. Never a raw autoincrement leak. */
export const OpaqueIdSchema = z.string().min(1).max(256);

// ---------------------------------------------------------------------------
// Envelope — every response wraps its payload in this.
// ---------------------------------------------------------------------------

export const ENVELOPE_STATUSES = ['healthy', 'degraded', 'stale', 'empty', 'unavailable'] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

export function desktopDataEnvelope<T extends z.ZodTypeAny>(payload: T) {
  return z.object({
    contractVersion: z.literal(DESKTOP_CONTRACT_VERSION),
    status: z.enum(ENVELOPE_STATUSES),
    data: payload.nullable(),
    generatedAt: IsoTimestampSchema,
    observedAt: IsoTimestampSchema.optional(),
    dataAvailableAt: IsoTimestampSchema.optional(),
    staleAt: IsoTimestampSchema.optional(),
    sourceVersion: z.string().max(128).optional(),
    policyVersions: z.record(z.string()).optional(),
    reasonCode: z.string().max(128).optional(),
    diagnostics: z.record(z.unknown()).optional(),
  }).strict();
}

export interface DesktopDataEnvelope<T> {
  contractVersion: typeof DESKTOP_CONTRACT_VERSION;
  status: EnvelopeStatus;
  data: T | null;
  generatedAt: IsoTimestamp;
  observedAt?: IsoTimestamp;
  dataAvailableAt?: IsoTimestamp;
  staleAt?: IsoTimestamp;
  sourceVersion?: string;
  policyVersions?: Record<string, string>;
  reasonCode?: string;
  diagnostics?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Pagination helpers.
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const PaginationInputSchema = z.object({
  cursor: CursorSchema.nullable().optional(),
  limit: z.number().int().positive().max(MAX_PAGE_SIZE).optional(),
}).strict();
export type PaginationInput = z.infer<typeof PaginationInputSchema>;

export function paginatedList<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: CursorSchema.nullable(),
  }).strict();
}

// ---------------------------------------------------------------------------
// Overview — Stage 3 §6.
// ---------------------------------------------------------------------------

export const SchemaFingerprintStateSchema = z.object({
  expectedVersion: z.string(),
  observedVersion: z.string().nullable(),
  fingerprintMatch: z.enum(['match', 'mismatch', 'unknown']),
  reason: z.string().nullable(),
}).strict();

export const CreateOrderCounterEnvelopeSchema = z.object({
  known: z.boolean(),
  source: z.string(),
  functionInvocations: z.number().int().nonnegative().nullable(),
  attemptCount: z.number().int().nonnegative().nullable(),
  networkCount: z.number().int().nonnegative().nullable(),
  reasonCode: z.string().nullable(),
}).strict();

export const ScannerReadinessSchema = z.object({
  state: z.enum(['ready', 'blocked', 'unknown']),
  blockingReasons: z.array(z.string()),
  observedAt: IsoTimestampSchema.nullable(),
}).strict();

export const ReconciliationHealthSchema = z.object({
  state: z.enum(['ok', 'degraded', 'failed', 'unknown']),
  lastRunAt: IsoTimestampSchema.nullable(),
  unresolvedCount: z.number().int().nonnegative().nullable(),
  reasonCode: z.string().nullable(),
}).strict();

export const ServiceHealthKindSchema = z.enum([
  'server', 'mariadb', 'redis', 'scanner_worker', 'reconciliation_worker',
]);

export const OverviewServiceHealthSchema = z.object({
  kind: ServiceHealthKindSchema,
  state: z.enum(['healthy', 'degraded', 'failed', 'unknown', 'stopped']),
  detail: z.string().nullable(),
  lastCheckedAt: IsoTimestampSchema.nullable(),
}).strict();

export const OverviewSafeFlagsSchema = z.object({
  DRY_RUN: z.literal(true),
  ORDER_SUBMISSION_ENABLED: z.literal(false),
  SIMULATION_MODE: z.string(),
  liveOrderSubmissionDisabled: z.literal(true),
}).strict();

export const AccountingIntegritySchema = z.object({
  accountingDifference: DecimalStringSchema.nullable(),
  brokenAcceptedLineageCount: z.number().int().nonnegative().nullable(),
  missingMandatoryAttributionCount: z.number().int().nonnegative().nullable(),
  reasonCode: z.string().nullable(),
}).strict();

export const OverviewPayloadSchema = z.object({
  desktopVersion: z.string(),
  serverVersion: z.string().nullable(),
  buildCommit: z.string().nullable(),
  providerMode: z.enum(['fixture', 'deferred_production', 'external']),
  safeFlags: OverviewSafeFlagsSchema,
  schemaFingerprint: SchemaFingerprintStateSchema,
  services: z.array(OverviewServiceHealthSchema),
  scannerReadiness: ScannerReadinessSchema,
  reconciliationHealth: ReconciliationHealthSchema,
  accountingIntegrity: AccountingIntegritySchema,
  openPositionCount: z.number().int().nonnegative().nullable(),
  unprotectedExposure: DecimalStringSchema.nullable(),
  championVersion: z.string().nullable(),
  observerPolicyVersions: z.record(z.string()),
  createOrderCounters: CreateOrderCounterEnvelopeSchema,
}).strict();
export type OverviewPayload = z.infer<typeof OverviewPayloadSchema>;
export const OverviewEnvelopeSchema = desktopDataEnvelope(OverviewPayloadSchema);
export type OverviewEnvelope = z.infer<typeof OverviewEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Portfolio — Stage 3 §7.
// ---------------------------------------------------------------------------

export const MEASUREMENT_STATUSES = ['known', 'estimated', 'unknown', 'unavailable'] as const;
export type MeasurementStatus = (typeof MEASUREMENT_STATUSES)[number];

/**
 * Every portfolio measurement carries its own state envelope. `value` is
 * `null` for `unknown`/`unavailable` — never zero-filled.
 */
export const PortfolioMeasurementSchema = z.object({
  status: z.enum(MEASUREMENT_STATUSES),
  value: DecimalStringSchema.nullable(),
  unit: z.enum(['usd', 'ratio', 'count', 'percent']),
  observedAt: IsoTimestampSchema.nullable(),
  dataAvailableAt: IsoTimestampSchema.nullable(),
  policyVersion: z.string().nullable(),
  confidence: DecimalStringSchema.nullable(),
  reasonCode: z.string().nullable(),
}).strict();
export type PortfolioMeasurement = z.infer<typeof PortfolioMeasurementSchema>;

export const ExposureBreakdownEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  measurement: PortfolioMeasurementSchema,
}).strict();

export const StressResultSchema = z.object({
  scenarioId: z.string(),
  scenarioName: z.string(),
  measurement: PortfolioMeasurementSchema,
  runAt: IsoTimestampSchema.nullable(),
}).strict();

export const PortfolioPayloadSchema = z.object({
  snapshotId: z.string().nullable(),
  snapshotAt: IsoTimestampSchema.nullable(),
  policyVersion: z.string().nullable(),
  cash: PortfolioMeasurementSchema,
  reservedCash: PortfolioMeasurementSchema,
  availableCash: PortfolioMeasurementSchema,
  grossExposure: PortfolioMeasurementSchema,
  netExposure: PortfolioMeasurementSchema,
  openStopRisk: PortfolioMeasurementSchema,
  pendingEntryExposure: PortfolioMeasurementSchema,
  pendingExitResidualExposure: PortfolioMeasurementSchema,
  unprotectedExposure: PortfolioMeasurementSchema,
  illiquidExposure: PortfolioMeasurementSchema,
  productExposures: z.array(ExposureBreakdownEntrySchema),
  strategyModeExposures: z.array(ExposureBreakdownEntrySchema),
  clusterExposures: z.array(ExposureBreakdownEntrySchema),
  btcBetaExposure: PortfolioMeasurementSchema,
  ethBetaExposure: PortfolioMeasurementSchema,
  dailyRealizedResult: PortfolioMeasurementSchema,
  weeklyRealizedResult: PortfolioMeasurementSchema,
  drawdown: PortfolioMeasurementSchema,
  historicalVar: PortfolioMeasurementSchema,
  historicalExpectedShortfall: PortfolioMeasurementSchema,
  stressResults: z.array(StressResultSchema),
}).strict();
export type PortfolioPayload = z.infer<typeof PortfolioPayloadSchema>;
export const PortfolioEnvelopeSchema = desktopDataEnvelope(PortfolioPayloadSchema);
export type PortfolioEnvelope = z.infer<typeof PortfolioEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Positions — Stage 3 §8.
// ---------------------------------------------------------------------------

export const POSITION_STATES = [
  'open', 'partially_exited', 'closed', 'reconciling', 'orphaned', 'unknown',
] as const;
export type PositionState = (typeof POSITION_STATES)[number];

export const PROTECTION_STATES = [
  'confirmed', 'pending', 'degraded', 'unprotected', 'unknown',
] as const;
export type ProtectionState = (typeof PROTECTION_STATES)[number];

export const RECONCILIATION_STATES = [
  'in_sync', 'pending', 'divergent', 'unknown',
] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

export const DATA_QUALITY_STATES = [
  'complete', 'degraded', 'missing_fills', 'stale', 'unknown',
] as const;
export type DataQualityState = (typeof DATA_QUALITY_STATES)[number];

export const PositionListInputSchema = PaginationInputSchema.extend({
  filter: z.object({
    stateIn: z.array(z.enum(POSITION_STATES)).max(POSITION_STATES.length).optional(),
    productPrefix: z.string().max(32).optional(),
  }).strict().optional(),
}).strict();
export type PositionListInput = z.infer<typeof PositionListInputSchema>;

export const PositionListRowSchema = z.object({
  id: OpaqueIdSchema,
  product: z.string(),
  state: z.enum(POSITION_STATES),
  remainingBaseQuantity: DecimalStringSchema.nullable(),
  weightedEntryPrice: DecimalStringSchema.nullable(),
  protectionState: z.enum(PROTECTION_STATES),
  reconciliationState: z.enum(RECONCILIATION_STATES),
  openedAt: IsoTimestampSchema.nullable(),
  lastUpdateAt: IsoTimestampSchema.nullable(),
  dataQualityState: z.enum(DATA_QUALITY_STATES),
}).strict();
export type PositionListRow = z.infer<typeof PositionListRowSchema>;

export const PositionListPayloadSchema = paginatedList(PositionListRowSchema);
export const PositionListEnvelopeSchema = desktopDataEnvelope(PositionListPayloadSchema);
export type PositionListEnvelope = z.infer<typeof PositionListEnvelopeSchema>;

export const PositionDetailInputSchema = z.object({ id: OpaqueIdSchema }).strict();
export type PositionDetailInput = z.infer<typeof PositionDetailInputSchema>;

export const EntryFillSchema = z.object({
  fillId: OpaqueIdSchema,
  quantity: DecimalStringSchema,
  price: DecimalStringSchema,
  fee: DecimalStringSchema.nullable(),
  filledAt: IsoTimestampSchema,
}).strict();

export const PartialExitSchema = z.object({
  exitAttemptId: OpaqueIdSchema,
  quantity: DecimalStringSchema,
  proceeds: DecimalStringSchema.nullable(),
  fee: DecimalStringSchema.nullable(),
  completedAt: IsoTimestampSchema.nullable(),
  state: z.enum(['pending', 'partial', 'complete', 'failed', 'unknown']),
}).strict();

export const BracketLegSchema = z.object({
  legId: OpaqueIdSchema,
  role: z.enum(['take_profit', 'stop_loss', 'trailing', 'other']),
  state: z.enum(['pending', 'active', 'triggered', 'cancelled', 'failed', 'unknown']),
  triggerPrice: DecimalStringSchema.nullable(),
  quantity: DecimalStringSchema.nullable(),
  lastUpdateAt: IsoTimestampSchema.nullable(),
}).strict();

export const ExitAttemptSchema = z.object({
  attemptId: OpaqueIdSchema,
  method: z.enum(['bracket', 'manual', 'reconciliation_recovery', 'unknown']),
  requestedAt: IsoTimestampSchema.nullable(),
  state: z.enum(['pending', 'partial', 'complete', 'failed', 'unknown']),
  quantity: DecimalStringSchema.nullable(),
  reasonCode: z.string().nullable(),
}).strict();

export const ReconciliationHistoryEntrySchema = z.object({
  runId: OpaqueIdSchema,
  runAt: IsoTimestampSchema,
  action: z.string(),
  outcome: z.enum(['no_op', 'applied', 'failed', 'skipped', 'unknown']),
  detail: z.string().nullable(),
}).strict();

export const LedgerEffectSchema = z.object({
  ledgerId: OpaqueIdSchema,
  causeCategory: z.string(),
  delta: DecimalStringSchema,
  balanceAfter: DecimalStringSchema.nullable(),
  recordedAt: IsoTimestampSchema,
}).strict();

export const CostAttributionSchema = z.object({
  forecastVersion: z.string().nullable(),
  forecastFees: DecimalStringSchema.nullable(),
  realizedFees: DecimalStringSchema.nullable(),
  forecastSpread: DecimalStringSchema.nullable(),
  realizedSpread: DecimalStringSchema.nullable(),
  forecastImpact: DecimalStringSchema.nullable(),
  realizedImpact: DecimalStringSchema.nullable(),
  totalForecastError: DecimalStringSchema.nullable(),
  netOutcome: DecimalStringSchema.nullable(),
}).strict();

export const RoundTripOutcomeSchema = z.object({
  roundTripId: OpaqueIdSchema,
  outcomeLabel: z.enum(['win', 'loss', 'scratch', 'incomplete', 'unknown']),
  netPnl: DecimalStringSchema.nullable(),
  netPnlPct: DecimalStringSchema.nullable(),
  closedAt: IsoTimestampSchema.nullable(),
}).strict();

export const PositionDetailPayloadSchema = z.object({
  id: OpaqueIdSchema,
  product: z.string(),
  state: z.enum(POSITION_STATES),
  entryFills: z.array(EntryFillSchema),
  entryFees: DecimalStringSchema.nullable(),
  partialExits: z.array(PartialExitSchema),
  residualQuantity: DecimalStringSchema.nullable(),
  dustQuantity: DecimalStringSchema.nullable(),
  dustClassification: z.enum(['none', 'below_min_size', 'below_min_notional', 'unknown']).nullable(),
  targetPrice: DecimalStringSchema.nullable(),
  stopPrice: DecimalStringSchema.nullable(),
  protectedQuantity: DecimalStringSchema.nullable(),
  bracketLegs: z.array(BracketLegSchema),
  exitAttempts: z.array(ExitAttemptSchema),
  reconciliationHistory: z.array(ReconciliationHistoryEntrySchema),
  ledgerEffects: z.array(LedgerEffectSchema),
  costAttribution: CostAttributionSchema,
  roundTrip: RoundTripOutcomeSchema.nullable(),
  dataQualityState: z.enum(DATA_QUALITY_STATES),
  brokenLineageMarkers: z.array(z.string()),
}).strict();
export type PositionDetailPayload = z.infer<typeof PositionDetailPayloadSchema>;
export const PositionDetailEnvelopeSchema = desktopDataEnvelope(PositionDetailPayloadSchema);
export type PositionDetailEnvelope = z.infer<typeof PositionDetailEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Decisions — Stage 3 §9.
// ---------------------------------------------------------------------------

export const DecisionListInputSchema = PaginationInputSchema.extend({
  filter: z.object({
    outcomeIn: z.array(z.enum(['win', 'loss', 'scratch', 'incomplete', 'unknown'])).max(5).optional(),
    productPrefix: z.string().max(32).optional(),
  }).strict().optional(),
}).strict();
export type DecisionListInput = z.infer<typeof DecisionListInputSchema>;

export const DecisionListRowSchema = z.object({
  chainId: OpaqueIdSchema,
  createdAt: IsoTimestampSchema,
  product: z.string().nullable(),
  championVersion: z.string().nullable(),
  authorizationOutcome: z.enum(['approved', 'rejected', 'skipped', 'error', 'unknown']),
  positionState: z.enum(POSITION_STATES).nullable(),
  outcomeLabel: z.enum(['win', 'loss', 'scratch', 'incomplete', 'unknown']).nullable(),
  brokenLineage: z.boolean(),
}).strict();
export type DecisionListRow = z.infer<typeof DecisionListRowSchema>;

export const DecisionListPayloadSchema = paginatedList(DecisionListRowSchema);
export const DecisionListEnvelopeSchema = desktopDataEnvelope(DecisionListPayloadSchema);
export type DecisionListEnvelope = z.infer<typeof DecisionListEnvelopeSchema>;

export const DecisionDetailInputSchema = z.object({ chainId: OpaqueIdSchema }).strict();
export type DecisionDetailInput = z.infer<typeof DecisionDetailInputSchema>;

/**
 * Each record in the decision chain declares WHERE it fits in the trust
 * hierarchy. `champion_influence` means the record affected the champion's
 * decision. `observer_only` means it was recorded but not acted on.
 */
export const DecisionRecordProvenanceSchema = z.object({
  championInfluence: z.boolean(),
  observerOnly: z.boolean(),
  knownAtDecisionTime: z.boolean(),
  knownAfterDecision: z.boolean(),
  knownAfterOutcome: z.boolean(),
}).strict();

export const DecisionRecordSchema = z.object({
  stage: z.string(),
  recordId: OpaqueIdSchema.nullable(),
  recordedAt: IsoTimestampSchema.nullable(),
  provenance: DecisionRecordProvenanceSchema,
  summary: z.string().nullable(),
  detail: z.record(z.unknown()).nullable(),
  brokenReason: z.string().nullable(),
}).strict();
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const DecisionDetailPayloadSchema = z.object({
  chainId: OpaqueIdSchema,
  createdAt: IsoTimestampSchema,
  product: z.string().nullable(),
  championVersion: z.string().nullable(),
  chain: z.object({
    scanRun: DecisionRecordSchema.nullable(),
    marketObservation: DecisionRecordSchema.nullable(),
    productEligibility: DecisionRecordSchema.nullable(),
    setupEvaluation: DecisionRecordSchema.nullable(),
    championRouting: DecisionRecordSchema.nullable(),
    costForecast: DecisionRecordSchema.nullable(),
    quantitativeAuthorization: DecisionRecordSchema.nullable(),
    claudeDecision: DecisionRecordSchema.nullable(),
    approvedPreview: DecisionRecordSchema.nullable(),
    executionPlan: DecisionRecordSchema.nullable(),
    orderIntents: z.array(DecisionRecordSchema),
    fills: z.array(DecisionRecordSchema),
    position: DecisionRecordSchema.nullable(),
    protection: DecisionRecordSchema.nullable(),
    exitActivity: z.array(DecisionRecordSchema),
    cashLedger: z.array(DecisionRecordSchema),
    roundTrip: DecisionRecordSchema.nullable(),
    outcomeLabel: DecisionRecordSchema.nullable(),
  }).strict(),
  observers: z.object({
    phase2AFingerprint: DecisionRecordSchema.nullable(),
    phase2BRegime: DecisionRecordSchema.nullable(),
    phase2CRisk: DecisionRecordSchema.nullable(),
    phase2DMicrostructure: DecisionRecordSchema.nullable(),
    phase2EContext: DecisionRecordSchema.nullable(),
    phase2FUnifiedChallenger: DecisionRecordSchema.nullable(),
    validationAttribution: DecisionRecordSchema.nullable(),
  }).strict(),
  brokenLineageMarkers: z.array(z.string()),
}).strict();
export type DecisionDetailPayload = z.infer<typeof DecisionDetailPayloadSchema>;
export const DecisionDetailEnvelopeSchema = desktopDataEnvelope(DecisionDetailPayloadSchema);
export type DecisionDetailEnvelope = z.infer<typeof DecisionDetailEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Universe — Stage 3 §10.
// ---------------------------------------------------------------------------

export const UniverseListInputSchema = PaginationInputSchema.extend({
  filter: z.object({
    membership: z.enum(['champion', 'observer', 'quarantined', 'any']).optional(),
    productPrefix: z.string().max(32).optional(),
  }).strict().optional(),
}).strict();
export type UniverseListInput = z.infer<typeof UniverseListInputSchema>;

export const UniverseRowSchema = z.object({
  product: z.string(),
  membership: z.array(z.enum(['champion', 'observer'])),
  eligibility: z.enum(['eligible', 'ineligible', 'unknown']),
  hygieneState: z.enum(['clean', 'warning', 'quarantined', 'unknown']),
  quarantineReason: z.string().nullable(),
  metadataFreshness: z.enum(['fresh', 'stale', 'missing', 'unknown']),
  liquidityState: z.enum(['sufficient', 'thin', 'insufficient', 'unknown']),
  historySufficiency: z.enum(['sufficient', 'partial', 'insufficient', 'unknown']),
  featureCompletionRate: DecimalStringSchema.nullable(),
  fingerprintState: z.enum(['available', 'stale', 'missing', 'unknown']),
  regimeState: z.string().nullable(),
  confidence: DecimalStringSchema.nullable(),
  missingEvidence: z.array(z.string()),
  failureReason: z.string().nullable(),
}).strict();
export type UniverseRow = z.infer<typeof UniverseRowSchema>;

export const UniverseListPayloadSchema = paginatedList(UniverseRowSchema);
export const UniverseListEnvelopeSchema = desktopDataEnvelope(UniverseListPayloadSchema);
export type UniverseListEnvelope = z.infer<typeof UniverseListEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Fingerprints — Stage 3 §10.
// ---------------------------------------------------------------------------

export const FingerprintListInputSchema = PaginationInputSchema.extend({
  filter: z.object({ productPrefix: z.string().max(32).optional() }).strict().optional(),
}).strict();
export type FingerprintListInput = z.infer<typeof FingerprintListInputSchema>;

export const FingerprintRowSchema = z.object({
  fingerprintId: OpaqueIdSchema,
  product: z.string(),
  fingerprintClass: z.string(),
  featureEvidence: z.array(z.string()),
  supportingEvidence: z.array(z.string()),
  conflictingEvidence: z.array(z.string()),
  missingFeatures: z.array(z.string()),
  qualityPenalty: DecimalStringSchema.nullable(),
  liquidityPenalty: DecimalStringSchema.nullable(),
  confidence: DecimalStringSchema.nullable(),
  featureVersions: z.record(z.string()),
  inputHash: z.string().nullable(),
  observedAt: IsoTimestampSchema.nullable(),
  availableAt: IsoTimestampSchema.nullable(),
}).strict();

export const FingerprintListPayloadSchema = paginatedList(FingerprintRowSchema);
export const FingerprintListEnvelopeSchema = desktopDataEnvelope(FingerprintListPayloadSchema);
export type FingerprintListEnvelope = z.infer<typeof FingerprintListEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Regimes — Stage 3 §11.
// ---------------------------------------------------------------------------

export const RegimePayloadSchema = z.object({
  globalRegime: z.object({
    raw: z.string().nullable(),
    smoothed: z.string().nullable(),
    latentState: z.string().nullable(),
    semanticMapping: z.string().nullable(),
    confidence: DecimalStringSchema.nullable(),
    baselineVote: z.string().nullable(),
    changeDetectorVotes: z.record(z.string()),
    stateDuration: z.string().nullable(),
    observedAt: IsoTimestampSchema.nullable(),
  }).strict(),
  productRegimes: z.array(z.object({
    product: z.string(),
    raw: z.string().nullable(),
    smoothed: z.string().nullable(),
    latentState: z.string().nullable(),
    semanticMapping: z.string().nullable(),
    confidence: DecimalStringSchema.nullable(),
    transitionState: z.string().nullable(),
    rejectedTransitions: z.array(z.string()),
    stateDuration: z.string().nullable(),
    observedAt: IsoTimestampSchema.nullable(),
  }).strict()),
  challengerRoute: z.string().nullable(),
  championComparison: z.record(z.string()).nullable(),
  policyVersion: z.string().nullable(),
}).strict();
export const RegimeEnvelopeSchema = desktopDataEnvelope(RegimePayloadSchema);
export type RegimeEnvelope = z.infer<typeof RegimeEnvelopeSchema>;
export type RegimePayload = z.infer<typeof RegimePayloadSchema>;

// ---------------------------------------------------------------------------
// Risk (Portfolio Risk) — Stage 3 §12.
// ---------------------------------------------------------------------------

export const RiskCapEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  limit: DecimalStringSchema.nullable(),
  observed: DecimalStringSchema.nullable(),
  binding: z.boolean(),
  breach: z.boolean(),
  action: z.enum(['none', 'block', 'shrink', 'alert', 'unknown']),
  reasonCode: z.string().nullable(),
}).strict();

export const RiskPayloadSchema = z.object({
  policyVersion: z.string().nullable(),
  observedAt: IsoTimestampSchema.nullable(),
  observerEnforcementActive: z.literal(false),
  kellyEnabled: z.literal(false),
  candidateStopRisk: PortfolioMeasurementSchema,
  volatilityMultiplier: PortfolioMeasurementSchema,
  caps: z.array(RiskCapEntrySchema),
  breaches: z.array(z.object({
    breachId: OpaqueIdSchema,
    limitKey: z.string(),
    observedAt: IsoTimestampSchema.nullable(),
    magnitude: DecimalStringSchema.nullable(),
    detail: z.string().nullable(),
  }).strict()),
  systemIntegrityVetoes: z.array(z.string()),
  expectedShortfall: PortfolioMeasurementSchema,
  stressRuns: z.array(StressResultSchema),
  bindingCap: z.string().nullable(),
  candidateDecision: z.object({
    outcome: z.enum(['approved', 'blocked', 'shrunk', 'unknown']),
    finalSize: DecimalStringSchema.nullable(),
    reasonCode: z.string().nullable(),
  }).strict(),
  championComparison: z.record(z.string()).nullable(),
}).strict();
export const RiskEnvelopeSchema = desktopDataEnvelope(RiskPayloadSchema);
export type RiskEnvelope = z.infer<typeof RiskEnvelopeSchema>;
export type RiskPayload = z.infer<typeof RiskPayloadSchema>;

// ---------------------------------------------------------------------------
// Microstructure — Stage 3 §13.
// ---------------------------------------------------------------------------

export const MicrostructureRowSchema = z.object({
  product: z.string(),
  bookSessionId: z.string().nullable(),
  bookHealth: z.enum(['healthy', 'degraded', 'stale', 'invalid', 'unknown']),
  continuityState: z.enum(['continuous', 'gap', 'reset', 'unknown']),
  bestBid: DecimalStringSchema.nullable(),
  bestAsk: DecimalStringSchema.nullable(),
  spread: DecimalStringSchema.nullable(),
  midprice: DecimalStringSchema.nullable(),
  microprice: DecimalStringSchema.nullable(),
  depthBands: z.array(z.object({
    band: z.string(),
    bidQuantity: DecimalStringSchema.nullable(),
    askQuantity: DecimalStringSchema.nullable(),
  }).strict()),
  depthImbalance: DecimalStringSchema.nullable(),
  impactCurves: z.array(z.object({
    side: z.enum(['buy', 'sell']),
    notional: DecimalStringSchema,
    impactBps: DecimalStringSchema.nullable(),
  }).strict()),
  visibleExecutableQuantity: DecimalStringSchema.nullable(),
  unfillableResidual: DecimalStringSchema.nullable(),
  buyerFlow: DecimalStringSchema.nullable(),
  sellerFlow: DecimalStringSchema.nullable(),
  unknownFlow: DecimalStringSchema.nullable(),
  cvd: DecimalStringSchema.nullable(),
  passiveFillEstimate: DecimalStringSchema.nullable(),
  queueUncertainty: z.enum(['known', 'unknown']),
  stopExecutionEstimate: DecimalStringSchema.nullable(),
  executionCostEstimate: DecimalStringSchema.nullable(),
  observedAt: IsoTimestampSchema.nullable(),
}).strict();

export const MicrostructurePayloadSchema = z.object({
  productionLevel2Active: z.literal(false),
  queuePositionKnown: z.literal(false),
  policyVersion: z.string().nullable(),
  shortlist: z.array(MicrostructureRowSchema),
  observerRecommendation: z.string().nullable(),
  championComparison: z.record(z.string()).nullable(),
}).strict();
export const MicrostructureEnvelopeSchema = desktopDataEnvelope(MicrostructurePayloadSchema);
export type MicrostructureEnvelope = z.infer<typeof MicrostructureEnvelopeSchema>;
export type MicrostructurePayload = z.infer<typeof MicrostructurePayloadSchema>;

// ---------------------------------------------------------------------------
// Context — Stage 3 §14.
// ---------------------------------------------------------------------------

export const ContextProviderSchema = z.object({
  providerId: z.string(),
  label: z.string(),
  health: z.enum(['healthy', 'degraded', 'stale', 'unavailable', 'unknown']),
  staleness: DecimalStringSchema.nullable(),
  lastObservedAt: IsoTimestampSchema.nullable(),
}).strict();

export const ContextSignalSchema = z.object({
  signalId: z.string(),
  family: z.string(),
  status: z.enum(['available', 'missing', 'stale', 'unknown']),
  value: DecimalStringSchema.nullable(),
  observedAt: IsoTimestampSchema.nullable(),
  reasonCode: z.string().nullable(),
}).strict();

export const ContextPayloadSchema = z.object({
  policyVersion: z.string().nullable(),
  providers: z.array(ContextProviderSchema),
  signals: z.array(ContextSignalSchema),
  globalSnapshot: z.record(z.string()).nullable(),
  productSnapshots: z.array(z.object({
    product: z.string(),
    snapshot: z.record(z.string()),
  }).strict()),
  ensembleMultiplier: PortfolioMeasurementSchema,
  warnings: z.array(z.string()),
  vetoes: z.array(z.string()),
  missingSignals: z.array(z.string()),
  conflicts: z.array(z.string()),
  incidents: z.array(z.string()),
  championComparison: z.record(z.string()).nullable(),
}).strict();
export const ContextEnvelopeSchema = desktopDataEnvelope(ContextPayloadSchema);
export type ContextEnvelope = z.infer<typeof ContextEnvelopeSchema>;
export type ContextPayload = z.infer<typeof ContextPayloadSchema>;

// ---------------------------------------------------------------------------
// Validation Lab — Stage 3 §15.
// ---------------------------------------------------------------------------

export const ValidationExperimentListInputSchema = PaginationInputSchema.extend({}).strict();
export type ValidationExperimentListInput = z.infer<typeof ValidationExperimentListInputSchema>;

export const ValidationExperimentRowSchema = z.object({
  experimentId: OpaqueIdSchema,
  name: z.string(),
  datasetId: OpaqueIdSchema.nullable(),
  createdAt: IsoTimestampSchema,
  splitPolicy: z.string().nullable(),
  status: z.enum(['registered', 'running', 'completed', 'failed', 'unknown']),
  metrics: z.object({
    pbo: DecimalStringSchema.nullable(),
    sharpe: DecimalStringSchema.nullable(),
    dsr: DecimalStringSchema.nullable(),
    sortino: DecimalStringSchema.nullable(),
    calmar: DecimalStringSchema.nullable(),
    drawdown: DecimalStringSchema.nullable(),
    expectedShortfall: DecimalStringSchema.nullable(),
  }).strict(),
  promotionEligible: z.literal(false),
}).strict();

export const ValidationPayloadSchema = z.object({
  promotionEnabled: z.literal(false),
  kellyEnabled: z.literal(false),
  claudeAttributionStatus: z.enum(['deferred', 'partial', 'complete', 'unknown']),
  experiments: paginatedList(ValidationExperimentRowSchema),
  datasetRegistrySummary: z.record(z.string()).nullable(),
  policyVersion: z.string().nullable(),
}).strict();
export const ValidationEnvelopeSchema = desktopDataEnvelope(ValidationPayloadSchema);
export type ValidationEnvelope = z.infer<typeof ValidationEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Costs & Attribution — Stage 3 §16 (costs).
// ---------------------------------------------------------------------------

export const CostAttributionRowSchema = z.object({
  attributionId: OpaqueIdSchema,
  positionId: OpaqueIdSchema.nullable(),
  attributionVersion: z.string().nullable(),
  entryForecast: DecimalStringSchema.nullable(),
  exitForecast: DecimalStringSchema.nullable(),
  forecastFees: DecimalStringSchema.nullable(),
  realizedFees: DecimalStringSchema.nullable(),
  forecastSpread: DecimalStringSchema.nullable(),
  effectiveSpread: DecimalStringSchema.nullable(),
  forecastImpact: DecimalStringSchema.nullable(),
  simulatedImpact: DecimalStringSchema.nullable(),
  forecastLatencyCost: DecimalStringSchema.nullable(),
  realizedLatencyEvidence: z.string().nullable(),
  stopExecutionAssumptions: z.string().nullable(),
  exitPath: z.string().nullable(),
  totalForecastError: DecimalStringSchema.nullable(),
  netOutcome: DecimalStringSchema.nullable(),
  recordedAt: IsoTimestampSchema.nullable(),
}).strict();

export const CostsPayloadSchema = z.object({
  attributionVersion: z.string().nullable(),
  entries: z.array(CostAttributionRowSchema),
}).strict();
export const CostsEnvelopeSchema = desktopDataEnvelope(CostsPayloadSchema);
export type CostsEnvelope = z.infer<typeof CostsEnvelopeSchema>;
export type CostsPayload = z.infer<typeof CostsPayloadSchema>;

// ---------------------------------------------------------------------------
// Protection — Stage 3 §16 (protection).
// ---------------------------------------------------------------------------

export const ProtectionInstanceSchema = z.object({
  instanceId: OpaqueIdSchema,
  positionId: OpaqueIdSchema.nullable(),
  policyVersion: z.string().nullable(),
  capability: z.enum(['exchange_bracket', 'polling_fallback', 'unprotected', 'unknown']),
  validation: z.enum(['validated', 'pending', 'failed', 'unknown']),
  requiredQuantity: DecimalStringSchema.nullable(),
  confirmedQuantity: DecimalStringSchema.nullable(),
  degradation: z.enum(['none', 'partial', 'complete', 'unknown']),
  recoveryAttempts: z.number().int().nonnegative().nullable(),
  gapRiskAssumptions: z.string().nullable(),
  bracketLegs: z.array(BracketLegSchema),
  lastEventAt: IsoTimestampSchema.nullable(),
}).strict();

export const ProtectionPayloadSchema = z.object({
  policyVersion: z.string().nullable(),
  instances: z.array(ProtectionInstanceSchema),
}).strict();
export const ProtectionEnvelopeSchema = desktopDataEnvelope(ProtectionPayloadSchema);
export type ProtectionEnvelope = z.infer<typeof ProtectionEnvelopeSchema>;
export type ProtectionPayload = z.infer<typeof ProtectionPayloadSchema>;

// ---------------------------------------------------------------------------
// Reconciliation — Stage 3 §16 (reconciliation).
// ---------------------------------------------------------------------------

export const ReconciliationListInputSchema = PaginationInputSchema.extend({
  filter: z.object({ statusIn: z.array(z.enum(['ok', 'degraded', 'failed', 'unknown'])).max(4).optional() }).strict().optional(),
}).strict();
export type ReconciliationListInput = z.infer<typeof ReconciliationListInputSchema>;

export const ReconciliationRunRowSchema = z.object({
  runId: OpaqueIdSchema,
  startedAt: IsoTimestampSchema,
  finishedAt: IsoTimestampSchema.nullable(),
  status: z.enum(['ok', 'degraded', 'failed', 'unknown']),
  nonterminalIntentCount: z.number().int().nonnegative().nullable(),
  unknownIntentCount: z.number().int().nonnegative().nullable(),
  discoveredFillCount: z.number().int().nonnegative().nullable(),
  entryBlockActive: z.boolean(),
  failureReasons: z.array(z.string()),
}).strict();

export const ReconciliationListPayloadSchema = paginatedList(ReconciliationRunRowSchema);
export const ReconciliationListEnvelopeSchema = desktopDataEnvelope(ReconciliationListPayloadSchema);
export type ReconciliationListEnvelope = z.infer<typeof ReconciliationListEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Incidents — Stage 3 §17.
// ---------------------------------------------------------------------------

export const INCIDENT_SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;
export const INCIDENT_STATES = ['open', 'acknowledged', 'resolved', 'unknown'] as const;

export const IncidentListInputSchema = PaginationInputSchema.extend({
  filter: z.object({
    severityIn: z.array(z.enum(INCIDENT_SEVERITIES)).max(4).optional(),
    subsystemIn: z.array(z.string().max(64)).max(16).optional(),
    stateIn: z.array(z.enum(INCIDENT_STATES)).max(4).optional(),
    acknowledged: z.boolean().optional(),
    since: IsoTimestampSchema.optional(),
    until: IsoTimestampSchema.optional(),
  }).strict().optional(),
}).strict();
export type IncidentListInput = z.infer<typeof IncidentListInputSchema>;

export const IncidentRowSchema = z.object({
  incidentId: OpaqueIdSchema,
  severity: z.enum(INCIDENT_SEVERITIES),
  subsystem: z.string(),
  title: z.string(),
  state: z.enum(INCIDENT_STATES),
  acknowledged: z.boolean(),
  openedAt: IsoTimestampSchema,
  lastUpdateAt: IsoTimestampSchema.nullable(),
  underlyingResolved: z.boolean(),
}).strict();

export const IncidentListPayloadSchema = paginatedList(IncidentRowSchema);
export const IncidentListEnvelopeSchema = desktopDataEnvelope(IncidentListPayloadSchema);
export type IncidentListEnvelope = z.infer<typeof IncidentListEnvelopeSchema>;
export type IncidentRow = z.infer<typeof IncidentRowSchema>;

export const IncidentAcknowledgeInputSchema = z.object({
  incidentId: OpaqueIdSchema,
  operatorNote: z.string().max(500).optional(),
}).strict();
export type IncidentAcknowledgeInput = z.infer<typeof IncidentAcknowledgeInputSchema>;

export const IncidentAcknowledgeResultSchema = z.object({
  ok: z.boolean(),
  acknowledged: z.boolean(),
  underlyingResolved: z.literal(false),
  reasonCode: z.string().nullable(),
}).strict();
export const IncidentAcknowledgeEnvelopeSchema = desktopDataEnvelope(IncidentAcknowledgeResultSchema);
export type IncidentAcknowledgeEnvelope = z.infer<typeof IncidentAcknowledgeEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Reports — Stage 3 §17. Stage 3 exposes catalog + history only.
// ---------------------------------------------------------------------------

export const ReportCatalogEntrySchema = z.object({
  kind: z.string(),
  label: z.string(),
  description: z.string(),
  supportedFormats: z.array(z.enum(['json', 'csv', 'html'])),
  generationAvailable: z.literal(false),
  reasonCode: z.string(),
}).strict();

export const ReportHistoryEntrySchema = z.object({
  jobId: OpaqueIdSchema,
  kind: z.string(),
  status: z.enum(['requested', 'succeeded', 'failed', 'unknown']),
  requestedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema.nullable(),
  artifactChecksum: z.string().nullable(),
  reasonCode: z.string().nullable(),
}).strict();

export const ReportsPayloadSchema = z.object({
  catalog: z.array(ReportCatalogEntrySchema),
  history: paginatedList(ReportHistoryEntrySchema),
  generationImplemented: z.literal(false),
  reasonCode: z.string(),
}).strict();
export const ReportsEnvelopeSchema = desktopDataEnvelope(ReportsPayloadSchema);
export type ReportsEnvelope = z.infer<typeof ReportsEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Configuration — Stage 3 §17.
// ---------------------------------------------------------------------------

export const ConfigurationPayloadSchema = z.object({
  serviceMode: z.enum(['managed_docker', 'external_services']),
  databaseMode: z.enum(['managed_docker', 'external_services']),
  redisMode: z.enum(['managed_docker', 'external_services']),
  providerMode: z.enum(['fixture', 'deferred_production', 'external']),
  safeFlags: OverviewSafeFlagsSchema,
  observerPolicyVersions: z.record(z.string()),
  championConfigurationView: z.record(z.unknown()),
  credentialStatus: z.record(z.enum(['absent', 'present_encrypted', 'expired', 'unknown'])),
  retention: z.object({
    logRetentionDays: z.number().int().nonnegative(),
    rawEventRetentionDays: z.number().int().nonnegative(),
  }).strict(),
  desktopStartupBehavior: z.enum(['manual', 'auto_check', 'auto_start']),
  reportLocation: z.string(),
  reportSchedule: z.enum(['off', 'daily', 'weekly']),
  timeZoneDisplay: z.string(),
  safetyCriticalReadOnly: z.literal(true),
}).strict();
export const ConfigurationEnvelopeSchema = desktopDataEnvelope(ConfigurationPayloadSchema);
export type ConfigurationEnvelope = z.infer<typeof ConfigurationEnvelopeSchema>;

// ---------------------------------------------------------------------------
// System — Stage 3 §17.
// ---------------------------------------------------------------------------

export const SystemPayloadSchema = z.object({
  desktopVersion: z.string(),
  serverVersion: z.string().nullable(),
  buildCommit: z.string().nullable(),
  buildTimestamp: IsoTimestampSchema.nullable(),
  electronVersion: z.string().nullable(),
  nodeVersion: z.string().nullable(),
  platform: z.enum(['win32', 'darwin', 'linux', 'unknown']),
  runtimeAssets: z.array(z.object({ name: z.string(), version: z.string().nullable() }).strict()),
  serviceOwnership: z.array(z.object({ service: z.string(), owner: z.string() }).strict()),
  processes: z.array(z.object({
    kind: z.string(),
    pid: z.number().int().nonnegative().nullable(),
    state: z.string(),
    startedAt: IsoTimestampSchema.nullable(),
  }).strict()),
  uptimeSeconds: z.number().int().nonnegative().nullable(),
  migrationState: z.object({
    appliedCount: z.number().int().nonnegative().nullable(),
    latestApplied: z.string().nullable(),
    schemaVersion: z.string().nullable(),
  }).strict(),
  schemaState: SchemaFingerprintStateSchema,
  runtimeMode: z.enum(['fixture', 'deferred_production', 'external']),
  logHealth: z.enum(['healthy', 'degraded', 'unavailable', 'unknown']),
}).strict();
export const SystemEnvelopeSchema = desktopDataEnvelope(SystemPayloadSchema);
export type SystemEnvelope = z.infer<typeof SystemEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Safety — Stage 3 §17.
// ---------------------------------------------------------------------------

export const SafetyPayloadSchema = z.object({
  safeFlags: OverviewSafeFlagsSchema,
  createOrderBarrierActive: z.literal(true),
  createOrderCounters: CreateOrderCounterEnvelopeSchema,
  scannerGate: ScannerReadinessSchema,
  reconciliationGate: ReconciliationHealthSchema,
  accountingIntegrity: AccountingIntegritySchema,
  protectionIntegrity: z.object({
    unprotectedExposure: DecimalStringSchema.nullable(),
    degradedInstances: z.number().int().nonnegative().nullable(),
    reasonCode: z.string().nullable(),
  }).strict(),
  observerEnforcementActive: z.literal(false),
  promotionEnabled: z.literal(false),
  kellyEnabled: z.literal(false),
  liveCapitalAuthorized: z.literal(false),
  simulationMode: z.string(),
  providerMode: z.enum(['fixture', 'deferred_production', 'external']),
}).strict();
export const SafetyEnvelopeSchema = desktopDataEnvelope(SafetyPayloadSchema);
export type SafetyEnvelope = z.infer<typeof SafetyEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Stage 4D — report export procedures wrapped in DesktopDataEnvelope so
// they flow through the same DesktopDataClient/IPC surface as read
// procedures. `enqueue` is the ONLY mutation; the others are queries.
// Input + output types live in packages/shared/src/reports.ts.
// ---------------------------------------------------------------------------

import {
  ExportEnqueueInputSchema,
  ExportEnqueueOutputSchema,
  ExportListInputSchema,
  ExportListOutputSchema,
  ExportStatusInputSchema,
  ExportStatusOutputSchema,
  ExportVerifyInputSchema,
  ExportVerifyOutputSchema,
} from './reports';

export const ExportEnqueueEnvelopeSchema = desktopDataEnvelope(ExportEnqueueOutputSchema);
export type ExportEnqueueEnvelope = z.infer<typeof ExportEnqueueEnvelopeSchema>;
export const ExportStatusEnvelopeSchema = desktopDataEnvelope(ExportStatusOutputSchema);
export type ExportStatusEnvelope = z.infer<typeof ExportStatusEnvelopeSchema>;
export const ExportListEnvelopeSchema = desktopDataEnvelope(ExportListOutputSchema);
export type ExportListEnvelope = z.infer<typeof ExportListEnvelopeSchema>;
export const ExportVerifyEnvelopeSchema = desktopDataEnvelope(ExportVerifyOutputSchema);
export type ExportVerifyEnvelope = z.infer<typeof ExportVerifyEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Discriminated union of every desktop-data request key.
//
// Preload + IPC accept ONLY these keys. Unknown keys fail closed.
// ---------------------------------------------------------------------------

const EmptyInputSchema = z.object({}).strict();

export const DesktopDataRequestSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('overview.get'), input: EmptyInputSchema.optional() }).strict(),
  z.object({ key: z.literal('portfolio.get'), input: EmptyInputSchema.optional() }).strict(),
  z.object({ key: z.literal('positions.list'), input: PositionListInputSchema.optional() }).strict(),
  z.object({ key: z.literal('positions.get'), input: PositionDetailInputSchema }).strict(),
  z.object({ key: z.literal('decisions.list'), input: DecisionListInputSchema.optional() }).strict(),
  z.object({ key: z.literal('decisions.get'), input: DecisionDetailInputSchema }).strict(),
  z.object({ key: z.literal('universe.list'), input: UniverseListInputSchema.optional() }).strict(),
  z.object({ key: z.literal('fingerprints.list'), input: FingerprintListInputSchema.optional() }).strict(),
  z.object({ key: z.literal('regimes.get'), input: EmptyInputSchema.optional() }).strict(),
  z.object({ key: z.literal('risk.get'), input: EmptyInputSchema.optional() }).strict(),
  z.object({ key: z.literal('microstructure.get'), input: EmptyInputSchema.optional() }).strict(),
  z.object({ key: z.literal('context.get'), input: EmptyInputSchema.optional() }).strict(),
  z.object({ key: z.literal('validation.get'), input: ValidationExperimentListInputSchema.optional() }).strict(),
  z.object({ key: z.literal('costs.get'), input: EmptyInputSchema.optional() }).strict(),
  z.object({ key: z.literal('protection.get'), input: EmptyInputSchema.optional() }).strict(),
  z.object({ key: z.literal('reconciliation.list'), input: ReconciliationListInputSchema.optional() }).strict(),
  z.object({ key: z.literal('incidents.list'), input: IncidentListInputSchema.optional() }).strict(),
  z.object({ key: z.literal('incidents.acknowledge'), input: IncidentAcknowledgeInputSchema }).strict(),
  z.object({ key: z.literal('reports.get'), input: PaginationInputSchema.optional() }).strict(),
  z.object({ key: z.literal('reports.enqueue'), input: ExportEnqueueInputSchema }).strict(),
  z.object({ key: z.literal('reports.status'), input: ExportStatusInputSchema }).strict(),
  z.object({ key: z.literal('reports.list'), input: ExportListInputSchema.optional() }).strict(),
  z.object({ key: z.literal('reports.verify'), input: ExportVerifyInputSchema }).strict(),
  z.object({ key: z.literal('configuration.get'), input: EmptyInputSchema.optional() }).strict(),
  z.object({ key: z.literal('system.get'), input: EmptyInputSchema.optional() }).strict(),
  z.object({ key: z.literal('safety.get'), input: EmptyInputSchema.optional() }).strict(),
]);
export type DesktopDataRequest = z.infer<typeof DesktopDataRequestSchema>;
export type DesktopDataRequestKey = DesktopDataRequest['key'];

/**
 * Central map — for a given key, which envelope schema is the authoritative
 * response contract? Used by the IPC boundary to validate outbound payloads
 * and by the renderer hook to give strong typing.
 */
export const DESKTOP_DATA_RESPONSE_SCHEMAS = {
  'overview.get': OverviewEnvelopeSchema,
  'portfolio.get': PortfolioEnvelopeSchema,
  'positions.list': PositionListEnvelopeSchema,
  'positions.get': PositionDetailEnvelopeSchema,
  'decisions.list': DecisionListEnvelopeSchema,
  'decisions.get': DecisionDetailEnvelopeSchema,
  'universe.list': UniverseListEnvelopeSchema,
  'fingerprints.list': FingerprintListEnvelopeSchema,
  'regimes.get': RegimeEnvelopeSchema,
  'risk.get': RiskEnvelopeSchema,
  'microstructure.get': MicrostructureEnvelopeSchema,
  'context.get': ContextEnvelopeSchema,
  'validation.get': ValidationEnvelopeSchema,
  'costs.get': CostsEnvelopeSchema,
  'protection.get': ProtectionEnvelopeSchema,
  'reconciliation.list': ReconciliationListEnvelopeSchema,
  'incidents.list': IncidentListEnvelopeSchema,
  'incidents.acknowledge': IncidentAcknowledgeEnvelopeSchema,
  'reports.get': ReportsEnvelopeSchema,
  'reports.enqueue': ExportEnqueueEnvelopeSchema,
  'reports.status': ExportStatusEnvelopeSchema,
  'reports.list': ExportListEnvelopeSchema,
  'reports.verify': ExportVerifyEnvelopeSchema,
  'configuration.get': ConfigurationEnvelopeSchema,
  'system.get': SystemEnvelopeSchema,
  'safety.get': SafetyEnvelopeSchema,
} as const satisfies Record<DesktopDataRequestKey, z.ZodTypeAny>;

export type DesktopDataResponse<K extends DesktopDataRequestKey> =
  z.infer<(typeof DESKTOP_DATA_RESPONSE_SCHEMAS)[K]>;

/**
 * The exhaustive list of desktop-data keys. Any procedure not on this list
 * MUST be rejected by the IPC boundary. Also drives Stage 3 test coverage —
 * every key here must have an authenticated tRPC procedure, a query service,
 * a main-client method, a preload binding, and a screen state matrix.
 */
export const DESKTOP_DATA_KEYS: readonly DesktopDataRequestKey[] = [
  'overview.get', 'portfolio.get',
  'positions.list', 'positions.get',
  'decisions.list', 'decisions.get',
  'universe.list', 'fingerprints.list',
  'regimes.get', 'risk.get',
  'microstructure.get', 'context.get',
  'validation.get', 'costs.get',
  'protection.get', 'reconciliation.list',
  'incidents.list', 'incidents.acknowledge',
  'reports.get',
  'reports.enqueue', 'reports.status', 'reports.list', 'reports.verify',
  'configuration.get',
  'system.get', 'safety.get',
] as const;

// ---------------------------------------------------------------------------
// Envelope helper factories — used by both the server and unit tests.
// ---------------------------------------------------------------------------

export function unavailableEnvelope<T>(reasonCode: string, generatedAt: string): DesktopDataEnvelope<T> {
  return {
    contractVersion: DESKTOP_CONTRACT_VERSION,
    status: 'unavailable',
    data: null,
    generatedAt: generatedAt as IsoTimestamp,
    reasonCode,
  };
}

export function emptyEnvelope<T>(data: T, generatedAt: string, reasonCode?: string): DesktopDataEnvelope<T> {
  return {
    contractVersion: DESKTOP_CONTRACT_VERSION,
    status: 'empty',
    data,
    generatedAt: generatedAt as IsoTimestamp,
    reasonCode,
  };
}

export function healthyEnvelope<T>(data: T, generatedAt: string, extra?: Partial<DesktopDataEnvelope<T>>): DesktopDataEnvelope<T> {
  return {
    contractVersion: DESKTOP_CONTRACT_VERSION,
    status: 'healthy',
    data,
    generatedAt: generatedAt as IsoTimestamp,
    ...extra,
  };
}

export function degradedEnvelope<T>(data: T | null, reasonCode: string, generatedAt: string, extra?: Partial<DesktopDataEnvelope<T>>): DesktopDataEnvelope<T> {
  return {
    contractVersion: DESKTOP_CONTRACT_VERSION,
    status: 'degraded',
    data,
    generatedAt: generatedAt as IsoTimestamp,
    reasonCode,
    ...extra,
  };
}

export function unknownMeasurement(reasonCode: string, unit: 'usd' | 'ratio' | 'count' | 'percent' = 'usd'): PortfolioMeasurement {
  return {
    status: 'unknown',
    value: null,
    unit,
    observedAt: null,
    dataAvailableAt: null,
    policyVersion: null,
    confidence: null,
    reasonCode,
  };
}
