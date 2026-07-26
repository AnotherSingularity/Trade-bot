/**
 * Phase 2E §B — Abstract context-provider interface.
 *
 * Providers deliver observations. They do NOT interpret them. Interpretation
 * happens in the signal layer (§F). Providers advertise identity, version
 * family, timestamps, and provider-side health so the signal layer can
 * reject or degrade evidence honestly.
 *
 * Production providers MAY be defined here (as interfaces) but MUST NOT
 * be constructed during Phase 2E — the DeferredProductionContextProvider
 * placeholder throws to make that explicit.
 */

export type ContextProviderFamily =
  | 'funding'
  | 'derivatives_positioning'
  | 'cross_exchange_premium'
  | 'exchange_flows'
  | 'token_unlocks'
  | 'etf_flows'
  | 'stablecoin_flows'
  | 'sentiment'
  | 'sector_rotation'
  | 'macro_calendar'
  | 'market_risk_calendar'
  | 'cross_exchange_dislocation';

export type ContextProviderHealthState =
  | 'healthy'
  | 'degraded'
  | 'stale'
  | 'conflicted'
  | 'unavailable'
  | 'disabled'
  | 'schema_mismatch'
  | 'clock_skew'
  | 'authentication_failure'
  | 'rate_limited';

export type ContextScope = 'global' | 'sector' | 'product' | 'event';

export interface ContextObservationPayload {
  providerId: string;
  providerVersion: string;
  providerFamily: ContextProviderFamily;
  scope: ContextScope;
  productId?: string | null;
  sourceTimestamp: Date;
  receivedAt: Date;
  dataAvailableAt: Date;
  payloadHash: string;
  schemaVersion: string;
  healthState: ContextProviderHealthState;
  normalizedPayload: Record<string, unknown>;
  rawPayloadSanitized?: Record<string, unknown> | null;
}

export interface ContextProvider {
  providerId: string;
  providerVersion: string;
  providerFamily: ContextProviderFamily;
  observations(): Iterable<ContextObservationPayload>;
}

/**
 * Test-only fixture provider. All observations are pre-computed and
 * deterministic; the provider never derives timestamps from the wall clock.
 */
export class FixtureContextProvider implements ContextProvider {
  constructor(
    readonly providerId: string,
    readonly providerVersion: string,
    readonly providerFamily: ContextProviderFamily,
    private readonly items: readonly ContextObservationPayload[],
  ) {}
  observations(): Iterable<ContextObservationPayload> {
    return this.items;
  }
}

/**
 * Deferred production provider placeholder. Constructing this class is a
 * hard error — production wiring is intentionally not part of Phase 2E.
 */
export class DeferredProductionContextProvider implements ContextProvider {
  readonly providerVersion = 'deferred-until-operator-approval';
  constructor(readonly providerId: string, readonly providerFamily: ContextProviderFamily) {
    throw new Error(
      'DeferredProductionContextProvider is intentionally not implemented in Phase 2E. Enabling it requires operator approval and the post-freeze operational sequence.',
    );
  }
  observations(): Iterable<ContextObservationPayload> {
    throw new Error('unreachable');
  }
}

// ---------------------------------------------------------------------------
// Health projection helpers (pure)
// ---------------------------------------------------------------------------

export interface ProviderHealthComputationInput {
  providerId: string;
  observationsInWindow: readonly ContextObservationPayload[];
  now: Date;
  expectedUpdateIntervalMs: number;
  maximumStalenessMs: number;
  expectedSchemaVersion: string;
  maximumClockSkewMs: number;
  consecutiveFailuresBefore?: number;
  lastFailureAtBefore?: Date | null;
}

export interface ProviderHealthProjection {
  healthState: ContextProviderHealthState;
  lastSuccessfulObservationAt: Date | null;
  lastFailureAt: Date | null;
  consecutiveFailures: number;
  stalenessAgeMs: number | null;
  clockSkewMs: number | null;
  observedSchemaVersion: string | null;
  observedUpdateIntervalMs: number | null;
  healthReason: string;
}

export function projectProviderHealth(input: ProviderHealthComputationInput): ProviderHealthProjection {
  const window = [...input.observationsInWindow].sort(
    (a, b) => a.sourceTimestamp.getTime() - b.sourceTimestamp.getTime(),
  );
  const last = window[window.length - 1] ?? null;
  const lastSuccessfulObservationAt = last ? last.sourceTimestamp : null;
  const lastFailureAt = input.lastFailureAtBefore ?? null;
  const stalenessAgeMs = last ? Math.max(0, input.now.getTime() - last.sourceTimestamp.getTime()) : null;
  const clockSkewMs = last ? last.receivedAt.getTime() - last.sourceTimestamp.getTime() : null;
  const observedSchemaVersion = last ? last.schemaVersion : null;
  const observedUpdateIntervalMs = window.length >= 2
    ? Math.max(0, window[window.length - 1].sourceTimestamp.getTime() - window[window.length - 2].sourceTimestamp.getTime())
    : null;
  const consecutiveFailuresBefore = input.consecutiveFailuresBefore ?? 0;

  // Explicit health rules — fail closed.
  if (!last) {
    return {
      healthState: 'unavailable',
      lastSuccessfulObservationAt,
      lastFailureAt,
      consecutiveFailures: consecutiveFailuresBefore + 1,
      stalenessAgeMs,
      clockSkewMs,
      observedSchemaVersion,
      observedUpdateIntervalMs,
      healthReason: 'no_observations_in_window',
    };
  }
  if (observedSchemaVersion && observedSchemaVersion !== input.expectedSchemaVersion) {
    return {
      healthState: 'schema_mismatch',
      lastSuccessfulObservationAt,
      lastFailureAt: input.now,
      consecutiveFailures: consecutiveFailuresBefore + 1,
      stalenessAgeMs,
      clockSkewMs,
      observedSchemaVersion,
      observedUpdateIntervalMs,
      healthReason: `schema_${observedSchemaVersion}_expected_${input.expectedSchemaVersion}`,
    };
  }
  if (last.healthState === 'authentication_failure') {
    return {
      healthState: 'authentication_failure',
      lastSuccessfulObservationAt,
      lastFailureAt: input.now,
      consecutiveFailures: consecutiveFailuresBefore + 1,
      stalenessAgeMs,
      clockSkewMs,
      observedSchemaVersion,
      observedUpdateIntervalMs,
      healthReason: 'auth_failure_from_provider',
    };
  }
  if (last.healthState === 'rate_limited') {
    return {
      healthState: 'rate_limited',
      lastSuccessfulObservationAt,
      lastFailureAt: input.now,
      consecutiveFailures: consecutiveFailuresBefore + 1,
      stalenessAgeMs,
      clockSkewMs,
      observedSchemaVersion,
      observedUpdateIntervalMs,
      healthReason: 'rate_limited_from_provider',
    };
  }
  if (last.healthState === 'disabled') {
    return {
      healthState: 'disabled',
      lastSuccessfulObservationAt,
      lastFailureAt,
      consecutiveFailures: consecutiveFailuresBefore,
      stalenessAgeMs,
      clockSkewMs,
      observedSchemaVersion,
      observedUpdateIntervalMs,
      healthReason: 'operator_disabled',
    };
  }
  if (clockSkewMs != null && Math.abs(clockSkewMs) > input.maximumClockSkewMs) {
    return {
      healthState: 'clock_skew',
      lastSuccessfulObservationAt,
      lastFailureAt: input.now,
      consecutiveFailures: consecutiveFailuresBefore + 1,
      stalenessAgeMs,
      clockSkewMs,
      observedSchemaVersion,
      observedUpdateIntervalMs,
      healthReason: `clock_skew_${clockSkewMs}ms_exceeds_${input.maximumClockSkewMs}ms`,
    };
  }
  if (stalenessAgeMs != null && stalenessAgeMs > input.maximumStalenessMs) {
    return {
      healthState: 'stale',
      lastSuccessfulObservationAt,
      lastFailureAt: input.now,
      consecutiveFailures: consecutiveFailuresBefore + 1,
      stalenessAgeMs,
      clockSkewMs,
      observedSchemaVersion,
      observedUpdateIntervalMs,
      healthReason: `stale_${stalenessAgeMs}ms_exceeds_${input.maximumStalenessMs}ms`,
    };
  }
  if (last.healthState === 'degraded' || last.healthState === 'conflicted') {
    return {
      healthState: last.healthState,
      lastSuccessfulObservationAt,
      lastFailureAt: input.now,
      consecutiveFailures: consecutiveFailuresBefore + 1,
      stalenessAgeMs,
      clockSkewMs,
      observedSchemaVersion,
      observedUpdateIntervalMs,
      healthReason: `provider_reported_${last.healthState}`,
    };
  }
  return {
    healthState: 'healthy',
    lastSuccessfulObservationAt,
    lastFailureAt,
    consecutiveFailures: 0,
    stalenessAgeMs,
    clockSkewMs,
    observedSchemaVersion,
    observedUpdateIntervalMs,
    healthReason: 'ok',
  };
}
