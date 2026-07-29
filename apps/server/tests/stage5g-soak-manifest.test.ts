/**
 * Stage 5G §9 — soak-manifest contract + incident-policy tests.
 *
 * Every rule the directive names has a positive AND a negative
 * assertion here — the whole point of an append-only manifest is
 * that a downstream consumer knows any drift is caught before it
 * reaches release audit.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOAK_DAY_COUNT,
  MANDATORY_SOAK_INVALIDATORS,
  SOAK_INCIDENT_TYPES,
  isMandatorySoakInvalidator,
  validateSoakManifest,
  type SoakDailyResult,
  type SoakIncident,
  type SoakManifest,
} from '@horizon/shared';

const COMMIT_SHA = '0'.repeat(40);
const SOAK_ID = 'soak-test-1';
const INSTALL_HASH = 'installhashabc';

function day(dateUtc: string, dayVerdict: 'passed' | 'invalidated' = 'passed'): SoakDailyResult {
  return {
    dateUtc,
    firstObservationAt: `${dateUtc}T00:00:00Z`,
    lastObservationAt: `${dateUtc}T23:59:59Z`,
    uptimeSeconds: 86_400,
    runtimeStarts: 1,
    runtimeStops: 0,
    serverRestarts: 0,
    containerRestarts: 0,
    databaseDisconnects: 0,
    databaseReconnects: 0,
    redisDisconnects: 0,
    redisReconnects: 0,
    reportJobsQueued: 24,
    reportJobsCompleted: 24,
    reportJobsFailed: 0,
    idempotencyHits: 0,
    duplicatePreventions: 0,
    artifactVerificationPasses: 24,
    artifactVerificationFailures: 0,
    redactionsApplied: 24,
    redactionFailures: 0,
    secretScanFailures: 0,
    pathRejections: 0,
    temporaryCleanupFailures: 0,
    orphanReconciliations: 0,
    processLeaks: 0,
    containerLeaks: 0,
    createOrderCounters: { functionInvocations: 0, attemptCount: 0, networkCount: 0 },
    safetyFlags: {
      DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false,
      liveCapitalAuthorized: false, promotionEnabled: false, kellyEnabled: false,
    },
    providerState: {
      marketDataProvider: 'fixture', exchangeProvider: 'fixture',
      productionLevel2Active: false, orderCapableProviderActive: false,
    },
    credentialState: {
      coinbaseCredentialsLoaded: false, anthropicCredentialsLoaded: false,
      productionCredentialsDetected: false,
    },
    dayVerdict,
  };
}

function baseManifest(
  overrides: Partial<SoakManifest> = {},
  dayCount = DEFAULT_SOAK_DAY_COUNT,
): SoakManifest {
  const days: SoakDailyResult[] = [];
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(Date.UTC(2026, 6, 27 + i)).toISOString().slice(0, 10);
    days.push(day(d));
  }
  return {
    soakId: SOAK_ID,
    commitSha: COMMIT_SHA,
    startedAt: '2026-07-27T00:00:00Z',
    expectedEndAt: '2026-08-03T00:00:00Z',
    actualEndAt: null,
    simulationMode: 'STANDARD_DRY_RUN',
    migrationHead: '0022',
    migrationChainDigest: 'a'.repeat(64),
    reportSpecVersions: { safety_status: 'safety_status.v1' },
    runtimeMode: 'managed_docker',
    installationIdHash: INSTALL_HASH,
    dayResults: days,
    incidents: [],
    safetyViolations: 0,
    codeChangesDetected: false,
    finalVerdict: 'passed',
    ...overrides,
  };
}

function inc(eventType: SoakIncident['eventType'], invalidatesSoak = true): SoakIncident {
  return {
    eventId: `${eventType}-1`, soakId: SOAK_ID, timestampUtc: '2026-07-28T12:00:00Z',
    commitSha: COMMIT_SHA, installationIdHash: INSTALL_HASH,
    eventType, severity: 'critical', details: 'test-incident', invalidatesSoak,
  };
}

describe('validateSoakManifest — happy path', () => {
  it('accepts a 7-day passed manifest with no incidents', () => {
    const r = validateSoakManifest(baseManifest());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.invalidatingIncidents).toHaveLength(0);
  });

  it('accepts an in_progress manifest with < 7 days', () => {
    const r = validateSoakManifest(baseManifest({ finalVerdict: 'in_progress' }, 3));
    expect(r.ok).toBe(true);
  });
});

describe('validateSoakManifest — UTC continuity', () => {
  it('rejects duplicate UTC date', () => {
    const m = baseManifest();
    m.dayResults.push(day(m.dayResults[0].dateUtc));
    const r = validateSoakManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('utc_date_duplicate');
  });

  it('rejects out-of-order UTC dates', () => {
    const m = baseManifest();
    // Reverse the order.
    m.dayResults.reverse();
    const r = validateSoakManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('utc_date_out_of_order');
  });

  it('rejects missing intermediate UTC date', () => {
    // Use in_progress verdict so the day-count check doesn't shadow
    // the continuity check — the gap between 07-27 and 08-10 is what
    // we're testing.
    const m = baseManifest({ finalVerdict: 'in_progress' }, 3);
    m.dayResults.splice(1, 1); // drop the middle day, breaking continuity
    m.dayResults.push(day('2026-08-10'));
    m.dayResults.sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
    const r = validateSoakManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('utc_date_missing');
  });

  it('rejects passed verdict with < 7 days', () => {
    const r = validateSoakManifest(baseManifest({ finalVerdict: 'passed' }, 3));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('day_count_wrong');
  });
});

describe('validateSoakManifest — invalidator ↔ verdict consistency', () => {
  it('rejects invalidator present + passed verdict', () => {
    const m = baseManifest({ incidents: [inc('safety_flag_violation')] });
    const r = validateSoakManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalidator_present_but_verdict_not_invalidated');
  });

  it('accepts invalidator + invalidated verdict', () => {
    const m = baseManifest({
      incidents: [inc('secret_scan_failed')],
      finalVerdict: 'invalidated',
      dayResults: baseManifest().dayResults.map((d, i) => (i === 1 ? { ...d, dayVerdict: 'invalidated' as const } : d)),
    });
    const r = validateSoakManifest(m);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.invalidatingIncidents).toHaveLength(1);
  });

  it('rejects invalidated verdict with no invalidator', () => {
    const r = validateSoakManifest(baseManifest({ finalVerdict: 'invalidated' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_invalidator_but_verdict_invalidated');
  });

  it('rejects codeChangesDetected + passed verdict', () => {
    const r = validateSoakManifest(baseManifest({ codeChangesDetected: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('code_change_not_reflected_in_verdict');
  });

  it('rejects invalidated day but passed final verdict', () => {
    const m = baseManifest();
    m.dayResults[3] = { ...m.dayResults[3], dayVerdict: 'invalidated' };
    const r = validateSoakManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('incident_count_and_verdict_inconsistent');
  });
});

describe('MANDATORY_SOAK_INVALIDATORS — coverage against typed list', () => {
  it('covers exactly the 13 hard-fail incident types', () => {
    expect(MANDATORY_SOAK_INVALIDATORS.size).toBe(13);
    for (const t of [
      'migration_mismatch', 'fingerprint_mismatch', 'secret_scan_failed',
      'path_security_failed', 'process_leak', 'container_leak',
      'safety_flag_violation', 'create_order_counter_nonzero',
      'production_provider_detected', 'production_credential_detected',
      'commit_changed', 'report_spec_changed', 'migration_chain_changed',
    ] as const) {
      expect(isMandatorySoakInvalidator(t)).toBe(true);
    }
  });

  it('does NOT flag advisory incident types as mandatory invalidators', () => {
    for (const t of ['runtime_unavailable', 'server_restart', 'container_restart', 'report_generation_failed'] as const) {
      expect(isMandatorySoakInvalidator(t)).toBe(false);
    }
  });

  it('SOAK_INCIDENT_TYPES enumerates 23 distinct entries', () => {
    expect(new Set(SOAK_INCIDENT_TYPES).size).toBe(23);
  });
});

describe('validateSoakManifest — schema-level rejections', () => {
  it('rejects manifest missing required fields', () => {
    const r = validateSoakManifest({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('schema_invalid');
  });

  it('rejects DRY_RUN=false in daily result', () => {
    const m = baseManifest();
    (m.dayResults[0] as unknown as { safetyFlags: { DRY_RUN: boolean } }).safetyFlags.DRY_RUN = false;
    const r = validateSoakManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('schema_invalid');
  });

  it('rejects nonzero createOrder counter in daily result', () => {
    const m = baseManifest();
    (m.dayResults[0].createOrderCounters as unknown as { functionInvocations: number }).functionInvocations = 1;
    const r = validateSoakManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('schema_invalid');
  });
});
