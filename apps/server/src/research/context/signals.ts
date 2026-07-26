import { createHash } from 'node:crypto';
import type { ContextObservationPayload, ContextProviderFamily, ContextScope } from './providers';

/**
 * Phase 2E §E-§H — Signal contract + 10 signal families.
 *
 * Each family reads an observation payload and returns a versioned
 * ContextSignalResult. Signals interpret; they do not fetch.
 *
 * Common invariants (§F):
 *   - Missing values remain null; they NEVER become zero.
 *   - Missing venues remain unavailable; they NEVER count as neutral favorable.
 *   - Observations with sourceTimestamp > decisionAt are rejected.
 *   - Values past expiresAt are rejected.
 *   - Supportive signals may only support no_op — never boost.
 *   - Low-confidence evidence may not independently veto.
 */

export const CTX_SIGNAL_MODEL_VERSION = 'p2e-signal-1';

export type ContextSignalDirection = 'supportive' | 'neutral' | 'adverse' | 'conflicted' | 'unknown';
export type ContextSignalStatus =
  | 'valid'
  | 'low_confidence'
  | 'insufficient_history'
  | 'stale'
  | 'unavailable'
  | 'invalid_input'
  | 'numerical_failure'
  | 'provider_degraded'
  | 'conflicted'
  | 'unsupported';

export type ContextAuthority = 'informational' | 'low' | 'medium' | 'high' | 'hard_veto';

export interface ContextSignalResult {
  signalKey: string;
  signalVersion: string;
  providerId: string;
  providerVersion: string;
  providerFamily: ContextProviderFamily;
  scope: ContextScope;
  productId?: string | null;
  status: ContextSignalStatus;
  value: number | null;
  unit: string;
  direction: ContextSignalDirection;
  severity: number; // [0,1]
  confidence: number; // [0,1]
  sampleCount: number | null;
  observedAt: Date;
  dataAvailableAt: Date;
  expiresAt: Date | null;
  inputHash: string;
  failureReason: string | null;
  diagnostics: Record<string, unknown> | null;
  authority: ContextAuthority;
}

export function hashSignalInput(seed: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(seed)).digest('hex');
}

interface SignalCommonInput {
  observation: ContextObservationPayload;
  decisionAt: Date;
  expiresInMs?: number;
}

function baseSignal(
  key: string,
  authority: ContextAuthority,
  common: SignalCommonInput,
  unit: string,
): ContextSignalResult {
  const { observation } = common;
  const expiresAt = common.expiresInMs != null
    ? new Date(observation.dataAvailableAt.getTime() + common.expiresInMs)
    : null;
  return {
    signalKey: key,
    signalVersion: CTX_SIGNAL_MODEL_VERSION,
    providerId: observation.providerId,
    providerVersion: observation.providerVersion,
    providerFamily: observation.providerFamily,
    scope: observation.scope,
    productId: observation.productId ?? null,
    status: 'valid',
    value: null,
    unit,
    direction: 'neutral',
    severity: 0,
    confidence: 1,
    sampleCount: null,
    observedAt: observation.sourceTimestamp,
    dataAvailableAt: observation.dataAvailableAt,
    expiresAt,
    inputHash: hashSignalInput({ k: key, seq: observation.payloadHash, v: CTX_SIGNAL_MODEL_VERSION }),
    failureReason: null,
    diagnostics: null,
    authority,
  };
}

function fail(
  result: ContextSignalResult,
  status: Exclude<ContextSignalStatus, 'valid' | 'low_confidence'>,
  reason: string,
): ContextSignalResult {
  return { ...result, status, value: null, direction: 'unknown', severity: 0, confidence: 0, failureReason: reason };
}

function checkCommon(res: ContextSignalResult, common: SignalCommonInput): ContextSignalResult | null {
  const { observation, decisionAt } = common;
  if (observation.sourceTimestamp.getTime() > decisionAt.getTime()) {
    return fail(res, 'invalid_input', 'future_observation');
  }
  if (observation.dataAvailableAt.getTime() > decisionAt.getTime()) {
    return fail(res, 'invalid_input', 'future_dataAvailableAt');
  }
  if (res.expiresAt && res.expiresAt.getTime() < decisionAt.getTime()) {
    return fail(res, 'stale', 'expired');
  }
  if (observation.healthState === 'unavailable' || observation.healthState === 'disabled') {
    return fail(res, 'unavailable', `provider_${observation.healthState}`);
  }
  if (observation.healthState === 'schema_mismatch') {
    return fail(res, 'invalid_input', 'provider_schema_mismatch');
  }
  if (observation.healthState === 'authentication_failure') {
    return fail(res, 'unavailable', 'auth_failure');
  }
  if (observation.healthState === 'rate_limited') {
    return fail(res, 'unavailable', 'rate_limited');
  }
  if (observation.healthState === 'clock_skew') {
    return fail(res, 'invalid_input', 'clock_skew_beyond_policy');
  }
  if (observation.healthState === 'stale') {
    return fail(res, 'stale', 'provider_stale');
  }
  if (observation.healthState === 'conflicted') {
    return { ...res, status: 'conflicted', direction: 'conflicted' };
  }
  if (observation.healthState === 'degraded') {
    return { ...res, status: 'provider_degraded' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// §H.1 Funding + derivatives pressure
// ---------------------------------------------------------------------------

export function fundingLevelSignal(common: SignalCommonInput): ContextSignalResult {
  const res = baseSignal('funding.level', 'medium', common, 'rate');
  const early = checkCommon(res, common);
  if (early) return early;
  const p = common.observation.normalizedPayload as { fundingRate?: number; venueCount?: number };
  if (typeof p.fundingRate !== 'number' || !Number.isFinite(p.fundingRate)) {
    return fail(res, 'unavailable', 'missing_funding_rate');
  }
  const rate = p.fundingRate;
  const abs = Math.abs(rate);
  const severity = Math.min(1, abs / 0.001); // 10bps → severity 1
  const direction: ContextSignalDirection = rate > 0.0005 ? 'adverse' : rate < -0.0005 ? 'adverse' : 'neutral';
  return { ...res, value: rate, severity, direction, sampleCount: p.venueCount ?? null };
}

export function fundingAccelerationSignal(common: SignalCommonInput): ContextSignalResult {
  const res = baseSignal('funding.acceleration', 'medium', common, 'rate_per_hour');
  const early = checkCommon(res, common);
  if (early) return early;
  const p = common.observation.normalizedPayload as { fundingAcceleration?: number };
  if (typeof p.fundingAcceleration !== 'number' || !Number.isFinite(p.fundingAcceleration)) {
    return fail(res, 'unavailable', 'missing_acceleration');
  }
  return {
    ...res,
    value: p.fundingAcceleration,
    severity: Math.min(1, Math.abs(p.fundingAcceleration) / 0.0005),
    direction: Math.abs(p.fundingAcceleration) > 0.0003 ? 'adverse' : 'neutral',
  };
}

export function fundingVenueDivergenceSignal(common: SignalCommonInput): ContextSignalResult {
  const res = baseSignal('funding.venue_divergence', 'medium', common, 'rate');
  const early = checkCommon(res, common);
  if (early) return early;
  const p = common.observation.normalizedPayload as { venueRates?: number[] };
  if (!Array.isArray(p.venueRates) || p.venueRates.length < 2) {
    return fail(res, 'insufficient_history', 'need_two_or_more_venues');
  }
  const values = p.venueRates.filter((v) => Number.isFinite(v));
  if (values.length < 2) return fail(res, 'unavailable', 'missing_venue_rates');
  const max = Math.max(...values);
  const min = Math.min(...values);
  const spread = max - min;
  return {
    ...res,
    value: spread,
    severity: Math.min(1, Math.abs(spread) / 0.0005),
    direction: spread > 0.0003 ? 'conflicted' : 'neutral',
    sampleCount: values.length,
    diagnostics: { min, max },
  };
}

// ---------------------------------------------------------------------------
// §H.2 Cross-exchange premium
// ---------------------------------------------------------------------------

export function coinbasePremiumSignal(common: SignalCommonInput): ContextSignalResult {
  const res = baseSignal('premium.coinbase', 'medium', common, 'ratio');
  const early = checkCommon(res, common);
  if (early) return early;
  const p = common.observation.normalizedPayload as {
    coinbasePrice?: number;
    referencePrice?: number;
    coinbaseTimestampMs?: number;
    referenceTimestampMs?: number;
    alignmentToleranceMs?: number;
    venueCount?: number;
  };
  if (typeof p.coinbasePrice !== 'number' || !Number.isFinite(p.coinbasePrice) || p.coinbasePrice <= 0) {
    return fail(res, 'unavailable', 'missing_coinbase_price');
  }
  if (typeof p.referencePrice !== 'number' || !Number.isFinite(p.referencePrice) || p.referencePrice <= 0) {
    return fail(res, 'unavailable', 'missing_reference_price');
  }
  if (typeof p.venueCount === 'number' && p.venueCount < 2) {
    return fail(res, 'insufficient_history', 'need_at_least_two_venues');
  }
  const tol = p.alignmentToleranceMs ?? 2_000;
  if (
    typeof p.coinbaseTimestampMs === 'number' &&
    typeof p.referenceTimestampMs === 'number' &&
    Math.abs(p.coinbaseTimestampMs - p.referenceTimestampMs) > tol
  ) {
    return fail(res, 'invalid_input', 'unaligned_timestamps');
  }
  const premium = (p.coinbasePrice - p.referencePrice) / p.referencePrice;
  return {
    ...res,
    value: premium,
    severity: Math.min(1, Math.abs(premium) / 0.005),
    direction: Math.abs(premium) > 0.003 ? 'adverse' : 'neutral',
    sampleCount: p.venueCount ?? null,
  };
}

// ---------------------------------------------------------------------------
// §H.3 Exchange flow
// ---------------------------------------------------------------------------

export function exchangeFlowSignal(common: SignalCommonInput): ContextSignalResult {
  const res = baseSignal('flow.exchange', 'medium', common, 'quote_per_hour');
  const early = checkCommon(res, common);
  if (early) return early;
  const p = common.observation.normalizedPayload as {
    inflow?: number;
    outflow?: number;
    net?: number;
    flowClassificationConfidence?: number;
    abnormalEvent?: boolean;
  };
  const net = typeof p.net === 'number'
    ? p.net
    : typeof p.inflow === 'number' && typeof p.outflow === 'number'
      ? p.inflow - p.outflow
      : null;
  if (net == null || !Number.isFinite(net)) return fail(res, 'unavailable', 'missing_net_flow');
  const cf = typeof p.flowClassificationConfidence === 'number' ? p.flowClassificationConfidence : 1;
  // Low-confidence classification cannot independently hard-veto (§H.3 rule).
  const status: ContextSignalStatus = cf < 0.5 ? 'low_confidence' : 'valid';
  const abs = Math.abs(net);
  return {
    ...res,
    status,
    value: net,
    severity: Math.min(1, abs / 1_000_000),
    direction: p.abnormalEvent || abs > 1_000_000 ? 'adverse' : 'neutral',
    confidence: cf,
  };
}

// ---------------------------------------------------------------------------
// §H.4 Token unlocks
// ---------------------------------------------------------------------------

export type UnlockState = 'pre_unlock' | 'unlock_window' | 'post_unlock' | 'none' | 'unknown';

export function tokenUnlockSignal(common: SignalCommonInput): ContextSignalResult {
  const res = baseSignal('event.token_unlock', 'high', common, 'ratio');
  const early = checkCommon(res, common);
  if (early) return early;
  const p = common.observation.normalizedPayload as {
    state?: UnlockState;
    unlockAmount?: number;
    unlockPercentCirculating?: number;
    unlockPercentDailyVolume?: number;
    scheduledAtMs?: number;
    windowStartMs?: number;
    windowEndMs?: number;
    circulatingSupplyKnown?: boolean;
  };
  const state = p.state ?? 'unknown';
  if (state === 'none') {
    return { ...res, direction: 'neutral', severity: 0, diagnostics: { state } };
  }
  if (state === 'unknown') {
    return fail(res, 'unavailable', 'unknown_unlock_state');
  }
  // Post-unlock windows are expired context.
  if (state === 'post_unlock' && p.windowEndMs != null && p.windowEndMs < common.decisionAt.getTime() - 6 * 60 * 60_000) {
    return fail(res, 'stale', 'unlock_window_expired');
  }
  const knownSupply = p.circulatingSupplyKnown !== false && typeof p.unlockPercentCirculating === 'number';
  if (!knownSupply && typeof p.unlockPercentDailyVolume !== 'number') {
    return fail(res, 'insufficient_history', 'unknown_circulating_supply');
  }
  const pct = knownSupply
    ? (p.unlockPercentCirculating as number)
    : Math.min(1, (p.unlockPercentDailyVolume ?? 0) / 100);
  const severity = Math.min(1, Math.max(0, pct));
  const direction: ContextSignalDirection = severity > 0.05 ? 'adverse' : severity > 0.01 ? 'adverse' : 'neutral';
  return {
    ...res,
    value: pct,
    severity,
    direction,
    diagnostics: { state, amount: p.unlockAmount ?? null, knownSupply },
  };
}

// ---------------------------------------------------------------------------
// §H.5 ETF flows
// ---------------------------------------------------------------------------

export function etfFlowSignal(common: SignalCommonInput): ContextSignalResult {
  const res = baseSignal('flow.etf', 'medium', common, 'quote');
  const early = checkCommon(res, common);
  if (early) return early;
  const p = common.observation.normalizedPayload as {
    netInflow?: number;
    consecutiveStreak?: number;
    publicationDelayMs?: number;
    isIntraday?: boolean;
  };
  if (typeof p.netInflow !== 'number' || !Number.isFinite(p.netInflow)) {
    return fail(res, 'unavailable', 'missing_net_inflow');
  }
  // Daily flow data cannot pose as intraday real-time evidence before publication.
  if (p.isIntraday === false && (p.publicationDelayMs == null || p.publicationDelayMs > 30 * 60_000)) {
    return { ...res, status: 'stale', direction: 'unknown', value: p.netInflow, failureReason: 'publication_delay' };
  }
  const abs = Math.abs(p.netInflow);
  return {
    ...res,
    value: p.netInflow,
    severity: Math.min(1, abs / 500_000_000),
    direction: p.netInflow < -100_000_000 ? 'adverse' : p.netInflow > 100_000_000 ? 'supportive' : 'neutral',
    sampleCount: p.consecutiveStreak ?? null,
  };
}

// ---------------------------------------------------------------------------
// §H.6 Stablecoin conditions
// ---------------------------------------------------------------------------

export function stablecoinSignal(common: SignalCommonInput): ContextSignalResult {
  const res = baseSignal('flow.stablecoin', 'medium', common, 'ratio');
  const early = checkCommon(res, common);
  if (early) return early;
  const p = common.observation.normalizedPayload as {
    supplyDeltaPct?: number;
    pegDeviationBps?: number;
  };
  if (typeof p.supplyDeltaPct !== 'number' && typeof p.pegDeviationBps !== 'number') {
    return fail(res, 'unavailable', 'missing_supply_and_peg');
  }
  const peg = typeof p.pegDeviationBps === 'number' ? Math.abs(p.pegDeviationBps) : 0;
  const supply = typeof p.supplyDeltaPct === 'number' ? p.supplyDeltaPct : 0;
  if (peg > 50) {
    return {
      ...res,
      value: peg,
      severity: Math.min(1, peg / 200),
      direction: 'adverse',
      diagnostics: { pegDeviationBps: peg },
    };
  }
  // Supply expansion is never supportive of trading — it may only signal no_op.
  return {
    ...res,
    value: supply,
    severity: Math.min(1, Math.abs(supply) / 0.02),
    direction: 'neutral',
    diagnostics: { supplyDeltaPct: supply },
  };
}

// ---------------------------------------------------------------------------
// §H.7 Sentiment
// ---------------------------------------------------------------------------

export function sentimentSignal(common: SignalCommonInput): ContextSignalResult {
  const res = baseSignal('sentiment.index', 'low', common, 'index');
  const early = checkCommon(res, common);
  if (early) return early;
  const p = common.observation.normalizedPayload as {
    index?: number; // 0-100
    sourceDisagreement?: number; // 0-1
  };
  if (typeof p.index !== 'number' || !Number.isFinite(p.index)) {
    return fail(res, 'unavailable', 'missing_index');
  }
  const idx = p.index;
  const extremeFear = idx <= 20;
  const extremeGreed = idx >= 80;
  return {
    ...res,
    value: idx,
    severity: extremeFear || extremeGreed ? 0.6 : 0.2,
    direction: extremeFear || extremeGreed ? 'adverse' : 'neutral',
    confidence: p.sourceDisagreement != null ? Math.max(0, 1 - p.sourceDisagreement) : 1,
    authority: 'low',
  };
}

// ---------------------------------------------------------------------------
// §H.8 Sector rotation
// ---------------------------------------------------------------------------

export function sectorRotationSignal(common: SignalCommonInput): ContextSignalResult {
  const res = baseSignal('sector.rotation', 'low', common, 'ratio');
  const early = checkCommon(res, common);
  if (early) return early;
  const p = common.observation.normalizedPayload as {
    sectorKey?: string;
    sectorRelativeStrength?: number; // negative=weakness, positive=leadership
    sectorBreakdown?: boolean;
    sectorMembershipKnown?: boolean;
  };
  if (p.sectorMembershipKnown === false) {
    return fail(res, 'unavailable', 'sector_membership_unknown');
  }
  if (typeof p.sectorRelativeStrength !== 'number' || !Number.isFinite(p.sectorRelativeStrength)) {
    return fail(res, 'unavailable', 'missing_relative_strength');
  }
  const rs = p.sectorRelativeStrength;
  return {
    ...res,
    value: rs,
    severity: Math.min(1, Math.abs(rs)),
    direction: p.sectorBreakdown || rs < -0.05 ? 'adverse' : rs > 0.05 ? 'supportive' : 'neutral',
    diagnostics: { sectorKey: p.sectorKey ?? null },
  };
}

// ---------------------------------------------------------------------------
// §H.9 Macro-event calendar
// ---------------------------------------------------------------------------

export type MacroEventState = 'outside_window' | 'pre_event_window' | 'event_window' | 'post_event_window' | 'unknown';

export function macroCalendarSignal(common: SignalCommonInput): ContextSignalResult {
  const res = baseSignal('event.macro_window', 'high', common, 'state');
  const early = checkCommon(res, common);
  if (early) return early;
  const p = common.observation.normalizedPayload as {
    state?: MacroEventState;
    eventKey?: string;
    scheduledAtMs?: number;
    windowStartMs?: number;
    windowEndMs?: number;
    timeZone?: string;
  };
  const state = p.state ?? 'unknown';
  if (state === 'unknown') return fail(res, 'unavailable', 'unknown_event_state');
  const severity = state === 'event_window' ? 1 : state === 'pre_event_window' ? 0.6 : state === 'post_event_window' ? 0.3 : 0;
  return {
    ...res,
    value: severity,
    severity,
    direction: state === 'outside_window' ? 'neutral' : 'adverse',
    diagnostics: { state, eventKey: p.eventKey ?? null, timeZone: p.timeZone ?? null },
  };
}

// ---------------------------------------------------------------------------
// §H.10 Cross-exchange dislocation
// ---------------------------------------------------------------------------

export function crossExchangeDislocationSignal(common: SignalCommonInput): ContextSignalResult {
  const res = baseSignal('dislocation.cross_exchange', 'high', common, 'ratio');
  const early = checkCommon(res, common);
  if (early) return early;
  const p = common.observation.normalizedPayload as {
    priceDivergencePct?: number;
    spreadDivergencePct?: number;
    venueOutage?: boolean;
    conflictingReference?: boolean;
    suspectedBadTick?: boolean;
  };
  if (p.conflictingReference || p.suspectedBadTick) {
    return { ...res, status: 'conflicted', direction: 'conflicted', severity: 1, value: null, failureReason: 'conflicting_reference' };
  }
  const div = typeof p.priceDivergencePct === 'number' ? Math.abs(p.priceDivergencePct) : null;
  if (div == null) return fail(res, 'unavailable', 'missing_divergence');
  const severity = Math.min(1, div / 0.02);
  return {
    ...res,
    value: div,
    severity,
    direction: severity > 0.5 || p.venueOutage ? 'adverse' : 'neutral',
    diagnostics: { spreadDivergencePct: p.spreadDivergencePct ?? null, venueOutage: !!p.venueOutage },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface CtxSignalDef {
  key: string;
  version: string;
  providerFamily: ContextProviderFamily;
  scope: ContextScope;
  authority: ContextAuthority;
  description: string;
  outputType: string;
  unit: string;
  directionPolicy: string;
  severityPolicy: string;
  confidencePolicy: string;
  stalenessPolicy: string;
  conflictPolicy: string;
}

export const CTX_SIGNAL_REGISTRY: readonly CtxSignalDef[] = [
  {
    key: 'funding.level',
    version: CTX_SIGNAL_MODEL_VERSION,
    providerFamily: 'funding',
    scope: 'product',
    authority: 'medium',
    description: 'Funding rate level. Extreme values may support reduction; negative rates never imply long support.',
    outputType: 'decimal', unit: 'rate',
    directionPolicy: 'extremes_adverse', severityPolicy: 'abs_over_10bps',
    confidencePolicy: 'venue_count', stalenessPolicy: 'provider_defined',
    conflictPolicy: 'multi_venue_max',
  },
  {
    key: 'funding.acceleration',
    version: CTX_SIGNAL_MODEL_VERSION, providerFamily: 'funding', scope: 'product', authority: 'medium',
    description: 'Change in funding rate per hour.', outputType: 'decimal', unit: 'rate_per_hour',
    directionPolicy: 'extremes_adverse', severityPolicy: 'abs_over_5bps_per_hour',
    confidencePolicy: 'single_source', stalenessPolicy: 'provider_defined', conflictPolicy: 'none',
  },
  {
    key: 'funding.venue_divergence',
    version: CTX_SIGNAL_MODEL_VERSION, providerFamily: 'funding', scope: 'product', authority: 'medium',
    description: 'Spread between highest and lowest venue funding rates.', outputType: 'decimal', unit: 'rate',
    directionPolicy: 'spread_adverse', severityPolicy: 'spread_over_5bps',
    confidencePolicy: 'venue_count', stalenessPolicy: 'provider_defined', conflictPolicy: 'raises_conflicted',
  },
  {
    key: 'premium.coinbase',
    version: CTX_SIGNAL_MODEL_VERSION, providerFamily: 'cross_exchange_premium', scope: 'product', authority: 'medium',
    description: 'Coinbase price versus reference venue premium; requires aligned timestamps.',
    outputType: 'decimal', unit: 'ratio',
    directionPolicy: 'extremes_adverse', severityPolicy: 'abs_over_50bps',
    confidencePolicy: 'venue_count', stalenessPolicy: 'timestamp_alignment', conflictPolicy: 'reference_conflict',
  },
  {
    key: 'flow.exchange',
    version: CTX_SIGNAL_MODEL_VERSION, providerFamily: 'exchange_flows', scope: 'product', authority: 'medium',
    description: 'Net exchange flow; low-confidence classification cannot hard-veto.',
    outputType: 'decimal', unit: 'quote_per_hour',
    directionPolicy: 'abnormal_adverse', severityPolicy: 'abs_over_1M',
    confidencePolicy: 'classification_confidence', stalenessPolicy: 'provider_delay_explicit',
    conflictPolicy: 'none',
  },
  {
    key: 'event.token_unlock',
    version: CTX_SIGNAL_MODEL_VERSION, providerFamily: 'token_unlocks', scope: 'product', authority: 'high',
    description: 'Token unlock proximity + magnitude. Cannot boost — only reduce/reject/abstain.',
    outputType: 'decimal', unit: 'ratio',
    directionPolicy: 'unlock_adverse', severityPolicy: 'percent_circulating',
    confidencePolicy: 'source_confidence', stalenessPolicy: 'window_expiration_enforced',
    conflictPolicy: 'reschedule_versions',
  },
  {
    key: 'flow.etf',
    version: CTX_SIGNAL_MODEL_VERSION, providerFamily: 'etf_flows', scope: 'global', authority: 'medium',
    description: 'ETF net flow. Publication delay enforced; supportive flow does not boost.',
    outputType: 'decimal', unit: 'quote',
    directionPolicy: 'outflow_adverse_inflow_supportive', severityPolicy: 'abs_over_500M',
    confidencePolicy: 'publication_delay', stalenessPolicy: 'publication_delay',
    conflictPolicy: 'none',
  },
  {
    key: 'flow.stablecoin',
    version: CTX_SIGNAL_MODEL_VERSION, providerFamily: 'stablecoin_flows', scope: 'global', authority: 'medium',
    description: 'Stablecoin supply/peg. Expansion cannot boost; peg deviation may reduce/reject.',
    outputType: 'decimal', unit: 'ratio',
    directionPolicy: 'peg_stress_adverse', severityPolicy: 'peg_deviation_or_supply_delta',
    confidencePolicy: 'source_agreement', stalenessPolicy: 'provider_defined',
    conflictPolicy: 'none',
  },
  {
    key: 'sentiment.index',
    version: CTX_SIGNAL_MODEL_VERSION, providerFamily: 'sentiment', scope: 'global', authority: 'low',
    description: 'Sentiment index (0-100). Low authority: cannot hard-veto in initial policy.',
    outputType: 'decimal', unit: 'index',
    directionPolicy: 'extremes_adverse', severityPolicy: 'distance_from_50',
    confidencePolicy: 'source_disagreement', stalenessPolicy: 'provider_defined',
    conflictPolicy: 'none',
  },
  {
    key: 'sector.rotation',
    version: CTX_SIGNAL_MODEL_VERSION, providerFamily: 'sector_rotation', scope: 'sector', authority: 'low',
    description: 'Sector relative strength. Leadership does not boost; unknown sector is explicit.',
    outputType: 'decimal', unit: 'ratio',
    directionPolicy: 'weakness_adverse_leadership_supportive', severityPolicy: 'abs_relative_strength',
    confidencePolicy: 'membership_known', stalenessPolicy: 'provider_defined',
    conflictPolicy: 'none',
  },
  {
    key: 'event.macro_window',
    version: CTX_SIGNAL_MODEL_VERSION, providerFamily: 'macro_calendar', scope: 'event', authority: 'high',
    description: 'Macro event window state. Event window is adverse; the system does not predict outcome.',
    outputType: 'string', unit: 'state',
    directionPolicy: 'window_adverse', severityPolicy: 'window_state',
    confidencePolicy: 'source_known', stalenessPolicy: 'expiration_enforced',
    conflictPolicy: 'reschedule_versions',
  },
  {
    key: 'dislocation.cross_exchange',
    version: CTX_SIGNAL_MODEL_VERSION, providerFamily: 'cross_exchange_dislocation', scope: 'global', authority: 'high',
    description: 'Cross-exchange price/spread dislocation. Conflicting authoritative prices produce data_failure.',
    outputType: 'decimal', unit: 'ratio',
    directionPolicy: 'divergence_adverse', severityPolicy: 'abs_divergence_over_2pct',
    confidencePolicy: 'venue_count', stalenessPolicy: 'provider_defined',
    conflictPolicy: 'reference_conflict_produces_data_failure',
  },
];

export type ContextSignalFn = (input: SignalCommonInput) => ContextSignalResult;

export const CTX_SIGNAL_FUNCTIONS: Readonly<Record<string, ContextSignalFn>> = {
  'funding.level': fundingLevelSignal,
  'funding.acceleration': fundingAccelerationSignal,
  'funding.venue_divergence': fundingVenueDivergenceSignal,
  'premium.coinbase': coinbasePremiumSignal,
  'flow.exchange': exchangeFlowSignal,
  'event.token_unlock': tokenUnlockSignal,
  'flow.etf': etfFlowSignal,
  'flow.stablecoin': stablecoinSignal,
  'sentiment.index': sentimentSignal,
  'sector.rotation': sectorRotationSignal,
  'event.macro_window': macroCalendarSignal,
  'dislocation.cross_exchange': crossExchangeDislocationSignal,
};
