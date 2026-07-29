/**
 * Stage 5F §8 — operational-validation harness tests.
 *
 * Deterministic — injects a clock and a fixed installationIdHash so
 * every eventId + timestamp is reproducible. No real DB, no real
 * Docker, no real runtime.
 */
import { describe, expect, it } from 'vitest';
import { validateSoakManifest } from '@horizon/shared';
import {
  HARD_FAIL_EVENT_KINDS,
  OPERATIONAL_EVENT_KINDS,
  OPERATIONAL_EVENT_KIND_COUNT,
  OperationalValidationHarness,
  sanitizeDetail,
} from '../src/soak/operationalValidation';

function makeClock(startIso: string) {
  let t = new Date(startIso).getTime();
  return () => {
    const d = new Date(t);
    t += 1000; // 1s per event so timestamps stay unique + monotonic
    return d;
  };
}

const BASE_CFG = {
  soakId: 'preflight-abc',
  commitSha: '0'.repeat(40),
  installationIdHash: 'installhash',
};
const SAFE_FLAGS = {
  DRY_RUN: true as const, ORDER_SUBMISSION_ENABLED: false as const,
  liveCapitalAuthorized: false as const, promotionEnabled: false as const, kellyEnabled: false as const,
};
const ZERO_COUNTERS = { functionInvocations: 0 as const, attemptCount: 0 as const, networkCount: 0 as const };
const FIXTURE_PROVIDER = {
  marketDataProvider: 'fixture', exchangeProvider: 'fixture',
  productionLevel2Active: false, orderCapableProviderActive: false,
};
const FIXTURE_CREDS = {
  coinbaseCredentialsLoaded: false, anthropicCredentialsLoaded: false,
  productionCredentialsDetected: false,
};

describe('OperationalValidationHarness — event enumeration', () => {
  it('recognizes all 30 event kinds', () => {
    expect(OPERATIONAL_EVENT_KIND_COUNT).toBe(30);
    expect(new Set(OPERATIONAL_EVENT_KINDS).size).toBe(30);
  });

  it('assigns critical severity to every HARD_FAIL kind', () => {
    const h = new OperationalValidationHarness({ ...BASE_CFG, clock: makeClock('2026-07-27T00:00:00Z') });
    for (const kind of HARD_FAIL_EVENT_KINDS) {
      const e = h.observe(kind, 'test');
      expect(e.severity).toBe('critical');
      expect(e.invalidatesSoak).toBe(true);
    }
  });

  it('assigns warn severity to lifecycle events', () => {
    const h = new OperationalValidationHarness({ ...BASE_CFG, clock: makeClock('2026-07-27T00:00:00Z') });
    for (const kind of ['runtime_stop', 'server_restart', 'container_restart', 'mariadb_disconnect', 'redis_disconnect'] as const) {
      const e = h.observe(kind, 'test');
      expect(e.severity).toBe('warn');
      expect(e.invalidatesSoak).toBe(false);
    }
  });

  it('assigns info severity to normal observations', () => {
    const h = new OperationalValidationHarness({ ...BASE_CFG, clock: makeClock('2026-07-27T00:00:00Z') });
    for (const kind of ['runtime_start', 'runtime_ready', 'report_job_queued', 'safety_observation'] as const) {
      const e = h.observe(kind, 'test');
      expect(e.severity).toBe('info');
      expect(e.invalidatesSoak).toBe(false);
    }
  });
});

describe('OperationalValidationHarness — deterministic event identity', () => {
  it('assigns unique + monotonic timestamps', () => {
    const h = new OperationalValidationHarness({ ...BASE_CFG, clock: makeClock('2026-07-27T00:00:00Z') });
    for (let i = 0; i < 5; i++) h.observe('safety_observation', `obs ${i}`);
    const timestamps = h.events().map((e) => e.timestampUtc);
    expect(new Set(timestamps).size).toBe(5);
    for (let i = 1; i < timestamps.length; i++) {
      expect(new Date(timestamps[i]).getTime()).toBeGreaterThan(new Date(timestamps[i - 1]).getTime());
    }
  });

  it('same inputs produce the same eventId hash (deterministic across processes)', () => {
    const h1 = new OperationalValidationHarness({ ...BASE_CFG, clock: makeClock('2026-07-27T00:00:00Z') });
    const h2 = new OperationalValidationHarness({ ...BASE_CFG, clock: makeClock('2026-07-27T00:00:00Z') });
    h1.observe('safety_observation', 'obs 0');
    h2.observe('safety_observation', 'obs 0');
    expect(h1.events()[0].eventId).toBe(h2.events()[0].eventId);
  });
});

describe('OperationalValidationHarness — sanitizeDetail scrubs credentials', () => {
  it('scrubs Bearer + password + token + authorization', () => {
    expect(sanitizeDetail('Authorization: Bearer abcd1234567890xyz')).toContain('authorization=<REDACTED>');
    expect(sanitizeDetail('password=hunter2 host=x')).toContain('password=<REDACTED>');
    expect(sanitizeDetail('token=abc123 status=200')).toContain('token=<REDACTED>');
    expect(sanitizeDetail('Bearer ThisIsA20CharToken1234')).toContain('Bearer <REDACTED>');
  });

  it('caps at 2000 chars', () => {
    expect(sanitizeDetail('a'.repeat(3000)).length).toBe(2000);
  });
});

describe('OperationalValidationHarness — buildDailyResult', () => {
  it('counts each event kind + produces passed dayVerdict when no invalidator', () => {
    const h = new OperationalValidationHarness({ ...BASE_CFG, clock: makeClock('2026-07-27T00:00:00Z') });
    h.observe('runtime_start', 'start');
    h.observe('runtime_ready', 'ready');
    h.observe('report_job_queued', 'q');
    h.observe('report_job_running', 'r');
    h.observe('report_job_completed', 'c');
    h.observe('idempotency_hit', 'hit');
    h.observe('artifact_verification_passed', 'v');
    h.observe('redaction_performed', 'redact');
    const day = h.buildDailyResult({
      dateUtc: '2026-07-27',
      safetyFlags: SAFE_FLAGS,
      createOrderCounters: ZERO_COUNTERS,
      providerState: FIXTURE_PROVIDER,
      credentialState: FIXTURE_CREDS,
    });
    expect(day.runtimeStarts).toBe(1);
    expect(day.reportJobsCompleted).toBe(1);
    expect(day.idempotencyHits).toBe(1);
    expect(day.artifactVerificationPasses).toBe(1);
    expect(day.redactionsApplied).toBe(1);
    expect(day.dayVerdict).toBe('passed');
    expect(day.uptimeSeconds).toBeGreaterThan(0);
  });

  it('produces invalidated dayVerdict on any HARD_FAIL event', () => {
    const h = new OperationalValidationHarness({ ...BASE_CFG, clock: makeClock('2026-07-27T00:00:00Z') });
    h.observe('runtime_start', 'start');
    h.observe('secret_scan_failure', 'planted secret found');
    const day = h.buildDailyResult({
      dateUtc: '2026-07-27',
      safetyFlags: SAFE_FLAGS,
      createOrderCounters: ZERO_COUNTERS,
      providerState: FIXTURE_PROVIDER,
      credentialState: FIXTURE_CREDS,
    });
    expect(day.dayVerdict).toBe('invalidated');
    expect(day.secretScanFailures).toBe(1);
  });

  it('produces invalidated dayVerdict on nonzero counters', () => {
    const h = new OperationalValidationHarness({ ...BASE_CFG, clock: makeClock('2026-07-27T00:00:00Z') });
    h.observe('runtime_start', 'start');
    // Note: SoakCreateOrderCounters schema enforces literal(0). We
    // cast to bypass the type check here to prove the harness ALSO
    // enforces at the aggregation level.
    const day = h.buildDailyResult({
      dateUtc: '2026-07-27',
      safetyFlags: SAFE_FLAGS,
      createOrderCounters: { functionInvocations: 1, attemptCount: 0, networkCount: 0 } as unknown as typeof ZERO_COUNTERS,
      providerState: FIXTURE_PROVIDER,
      credentialState: FIXTURE_CREDS,
    });
    expect(day.dayVerdict).toBe('invalidated');
  });
});

describe('OperationalValidationHarness — incidents flow into SoakManifest', () => {
  it('mapped incidents are validation-ready + roundtrip through the manifest validator', () => {
    const h = new OperationalValidationHarness({ ...BASE_CFG, clock: makeClock('2026-07-27T00:00:00Z') });
    h.observe('runtime_start', 'start');
    h.observe('mariadb_disconnect', 'lost mariadb');
    h.observe('mariadb_reconnect', 'ok');
    h.observe('secret_scan_failure', 'planted');
    const incidents = h.incidents();
    // mariadb_disconnect + secret_scan_failure produce incidents.
    // runtime_start + mariadb_reconnect do NOT map (observations only).
    expect(incidents.map((i) => i.eventType).sort()).toEqual(['database_unavailable', 'secret_scan_failed']);
    // secret_scan_failed is a mandatory invalidator; database_unavailable is not.
    const secretHit = incidents.find((i) => i.eventType === 'secret_scan_failed');
    expect(secretHit?.invalidatesSoak).toBe(true);

    // Build a full manifest around it (only 1 day so must be in_progress).
    const day = h.buildDailyResult({
      dateUtc: '2026-07-27',
      safetyFlags: SAFE_FLAGS,
      createOrderCounters: ZERO_COUNTERS,
      providerState: FIXTURE_PROVIDER,
      credentialState: FIXTURE_CREDS,
    });
    const manifest = {
      soakId: BASE_CFG.soakId,
      commitSha: BASE_CFG.commitSha,
      startedAt: '2026-07-27T00:00:00Z',
      expectedEndAt: '2026-08-03T00:00:00Z',
      actualEndAt: null,
      simulationMode: 'STANDARD_DRY_RUN' as const,
      migrationHead: '0022',
      migrationChainDigest: 'a'.repeat(64),
      reportSpecVersions: { safety_status: 'safety_status.v1' },
      runtimeMode: 'managed_docker' as const,
      installationIdHash: BASE_CFG.installationIdHash,
      dayResults: [day],
      incidents: [...incidents],
      safetyViolations: 0,
      codeChangesDetected: false,
      finalVerdict: 'invalidated' as const,
    };
    const r = validateSoakManifest(manifest);
    expect(r.ok, r.ok ? '' : `${r.code}: ${r.detail}`).toBe(true);
    if (r.ok) expect(r.invalidatingIncidents.length).toBeGreaterThan(0);
  });
});
