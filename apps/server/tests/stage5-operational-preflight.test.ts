/**
 * Stage 5 §preflight — operational-validation preflight tests.
 *
 * Pure — no DB, no filesystem. Every branch of the preflight
 * harness has an accepting AND a negative-space test so future
 * refactors that quietly weaken any check trip the suite.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveEvidenceRunId,
  runOperationalValidationPreflight,
} from '../src/soak/operationalPreflight';

const BASE = {
  commitSha: '0'.repeat(40),
  installationIdHash: 'test-preflight',
  nowIso: '2026-07-29T12:00:00Z',
  evidenceRunId: 'abcdef0123456789',
};

describe('runOperationalValidationPreflight — happy path', () => {
  it('accepts a healthy day and returns preflight_passed', () => {
    const r = runOperationalValidationPreflight(BASE);
    expect(r.verdict, `${r.verdict}: ${r.detail}`).toBe('preflight_passed');
    expect(r.tool).toBe('operational-validation-preflight');
    expect(r.version).toBe('1.0');
    expect(r.commitSha).toBe(BASE.commitSha);
    expect(r.installationIdHash).toBe(BASE.installationIdHash);
    expect(r.manifestValidationOk).toBe(true);
    expect(r.dailyResultPassed).not.toBeNull();
  });

  it('records the 6 negative-space checks + 1 manifest check, all ok', () => {
    const r = runOperationalValidationPreflight(BASE);
    expect(r.checks).toHaveLength(7);
    for (const c of r.checks) {
      expect(c.ok, `check[${c.id}] failed: ${c.detail}`).toBe(true);
    }
    const ids = r.checks.map((c) => c.id).sort();
    expect(ids).toEqual([
      'determinism',
      'event_enumeration',
      'hard_fail_propagation',
      'mandatory_invalidators',
      'manifest_validation',
      'sanitization',
      'schema_parse',
    ]);
  });

  it('records observed event count > 0 and correct kind/invalidator counts', () => {
    const r = runOperationalValidationPreflight(BASE);
    expect(r.counts.eventKindsRecognized).toBe(30);
    expect(r.counts.mandatoryInvalidators).toBe(13);
    expect(r.counts.hardFailKinds).toBeGreaterThanOrEqual(4);
    expect(r.counts.observedEvents).toBeGreaterThan(20);
  });
});

describe('runOperationalValidationPreflight — dailyResultPassed shape', () => {
  it('produces a dayVerdict=passed daily result with safety flags locked', () => {
    const r = runOperationalValidationPreflight(BASE);
    const d = r.dailyResultPassed;
    expect(d).not.toBeNull();
    if (!d) return;
    expect(d.dayVerdict).toBe('passed');
    expect(d.safetyFlags.DRY_RUN).toBe(true);
    expect(d.safetyFlags.ORDER_SUBMISSION_ENABLED).toBe(false);
    expect(d.safetyFlags.liveCapitalAuthorized).toBe(false);
    expect(d.safetyFlags.promotionEnabled).toBe(false);
    expect(d.safetyFlags.kellyEnabled).toBe(false);
    expect(d.createOrderCounters.functionInvocations).toBe(0);
    expect(d.createOrderCounters.attemptCount).toBe(0);
    expect(d.createOrderCounters.networkCount).toBe(0);
  });

  it('rolls up runtime + report + observability counters from the observed events', () => {
    const r = runOperationalValidationPreflight(BASE);
    const d = r.dailyResultPassed;
    if (!d) throw new Error('daily result was null');
    expect(d.runtimeStarts).toBe(1);
    expect(d.runtimeStops).toBe(1);
    expect(d.serverRestarts).toBe(1);
    expect(d.containerRestarts).toBe(1);
    expect(d.databaseDisconnects).toBe(1);
    expect(d.databaseReconnects).toBe(1);
    expect(d.redisDisconnects).toBe(1);
    expect(d.redisReconnects).toBe(1);
    expect(d.reportJobsQueued).toBe(4);
    expect(d.reportJobsCompleted).toBe(4);
    expect(d.reportJobsFailed).toBe(1);
    expect(d.idempotencyHits).toBe(1);
    expect(d.duplicatePreventions).toBe(1);
    expect(d.artifactVerificationPasses).toBe(4);
    expect(d.artifactVerificationFailures).toBe(1);
    expect(d.redactionsApplied).toBe(4);
    expect(d.redactionFailures).toBe(1);
    expect(d.secretScanFailures).toBe(0);
    expect(d.pathRejections).toBe(0);
    expect(d.processLeaks).toBe(0);
    expect(d.containerLeaks).toBe(0);
  });
});

describe('deriveEvidenceRunId', () => {
  it('is deterministic for the same (commit, ciRunId) pair', () => {
    const a = deriveEvidenceRunId('c1', 'r1');
    const b = deriveEvidenceRunId('c1', 'r1');
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it('differs for different commit or run', () => {
    const a = deriveEvidenceRunId('c1', 'r1');
    const b = deriveEvidenceRunId('c2', 'r1');
    const c = deriveEvidenceRunId('c1', 'r2');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('falls back to `local` when ciRunId is undefined', () => {
    const a = deriveEvidenceRunId('c1', undefined);
    const b = deriveEvidenceRunId('c1', 'local');
    expect(a).toBe(b);
  });
});
