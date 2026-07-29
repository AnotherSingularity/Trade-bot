/**
 * Stage 4 §S4.1 — canonical stringify + idempotency key stability.
 *
 * Proves the pure shared module's guarantees the DB uniqueness
 * constraint depends on:
 *
 *   - key order does not affect the emitted byte-string;
 *   - equivalent inputs → equal idempotencyKey;
 *   - excluded fields (timestamps, jobId, artifact paths) DO NOT
 *     affect the key even when passed through requestOptions
 *     (they simply aren't part of the IdempotencyKeyInputSchema);
 *   - contentDigest is stable across two runs against equal input;
 *   - non-finite numbers are refused;
 *   - non-plain objects (Date, Map, class instances) are refused.
 *
 * These are the mechanical foundation for the Stage 4 exit criterion
 * that "contentDigest determinism is proven" and "the new
 * idempotency uniqueness constraint is database-enforced."
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalStringify,
  REPORT_KINDS,
  REPORT_SPEC_VERSIONS,
  type CanonicalReportEnvelope,
  type IdempotencyKeyInput,
} from '@horizon/shared';
import { buildIdempotencyKey, computeContentDigest } from '../src/reports/digest';

describe('canonicalStringify — determinism', () => {
  it('emits key-sorted objects', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalStringify({ z: { c: 3, a: 1, b: 2 }, a: null })).toBe(
      '{"a":null,"z":{"a":1,"b":2,"c":3}}',
    );
  });

  it('is byte-identical regardless of caller key order', () => {
    const a = canonicalStringify({ a: 1, b: 2, c: 3 });
    const b = canonicalStringify({ c: 3, b: 2, a: 1 });
    const c = canonicalStringify({ b: 2, c: 3, a: 1 });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('preserves array order (arrays are ordered)', () => {
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalStringify([[1], [2]])).toBe('[[1],[2]]');
  });

  it('drops undefined object values, coerces undefined array items to null', () => {
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalStringify([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('escapes strings deterministically', () => {
    expect(canonicalStringify('"\\')).toBe('"\\"\\\\"');
    expect(canonicalStringify('a\nb\tc')).toBe('"a\\nb\\tc"');
    expect(canonicalStringify('\x00\x01')).toBe('"\\u0000\\u0001"');
  });

  it('refuses non-finite numbers', () => {
    expect(() => canonicalStringify(NaN)).toThrow(/non-finite/);
    expect(() => canonicalStringify(Infinity)).toThrow(/non-finite/);
    expect(() => canonicalStringify(-Infinity)).toThrow(/non-finite/);
  });

  it('refuses non-plain objects', () => {
    expect(() => canonicalStringify(new Date(0))).toThrow(/non-plain/);
    expect(() => canonicalStringify(new Map())).toThrow(/non-plain/);
    class C { public x = 1; }
    expect(() => canonicalStringify(new C())).toThrow(/non-plain/);
  });
});

describe('idempotencyKey — determinism + coverage', () => {
  const baseline: IdempotencyKeyInput = {
    installationId: 42,
    reportKind: 'safety_status',
    reportSpecVersion: REPORT_SPEC_VERSIONS.safety_status,
    referenceId: 'ref-001',
    sourceHighWaterMark: { safety: 100, incidents: 50 },
    requestOptions: {},
  };

  it('is stable across identical inputs', () => {
    const a = buildIdempotencyKey(baseline);
    const b = buildIdempotencyKey(baseline);
    expect(a).toBe(b);
    expect(a).toMatch(/^idem_[a-f0-9]{64}$/);
  });

  it('is stable regardless of key insertion order in nested objects', () => {
    const rev: IdempotencyKeyInput = {
      ...baseline,
      sourceHighWaterMark: { incidents: 50, safety: 100 },
    };
    expect(buildIdempotencyKey(rev)).toBe(buildIdempotencyKey(baseline));
  });

  it('changes when installationId changes', () => {
    expect(buildIdempotencyKey({ ...baseline, installationId: 43 }))
      .not.toBe(buildIdempotencyKey(baseline));
  });

  it('changes when reportKind changes', () => {
    expect(buildIdempotencyKey({ ...baseline, reportKind: 'incidents', reportSpecVersion: REPORT_SPEC_VERSIONS.incidents }))
      .not.toBe(buildIdempotencyKey(baseline));
  });

  it('changes when reportSpecVersion changes (contract bump forces new key)', () => {
    expect(buildIdempotencyKey({ ...baseline, reportSpecVersion: 'safety_status.v2' }))
      .not.toBe(buildIdempotencyKey(baseline));
  });

  it('changes when referenceId changes', () => {
    expect(buildIdempotencyKey({ ...baseline, referenceId: 'ref-002' }))
      .not.toBe(buildIdempotencyKey(baseline));
  });

  it('null referenceId is distinct from non-null', () => {
    expect(buildIdempotencyKey({ ...baseline, referenceId: null }))
      .not.toBe(buildIdempotencyKey(baseline));
  });

  it('changes when sourceHighWaterMark changes', () => {
    expect(buildIdempotencyKey({ ...baseline, sourceHighWaterMark: { safety: 101, incidents: 50 } }))
      .not.toBe(buildIdempotencyKey(baseline));
  });

  it('changes when requestOptions changes', () => {
    expect(buildIdempotencyKey({ ...baseline, requestOptions: { rangeDays: 7 } }))
      .not.toBe(buildIdempotencyKey(baseline));
  });

  it('excluded fields (timestamps, jobId, artifact paths) DO NOT appear in the input surface at all — the schema refuses them', () => {
    // Using `as any` here to prove the schema throws; you cannot even
    // pass timestamps/jobId/etc. into the builder because the strict
    // schema rejects unknown keys.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { ...baseline, generatedAt: '2026-07-29T00:00:00Z' } as any;
    expect(() => buildIdempotencyKey(bad)).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad2 = { ...baseline, jobId: 12345 } as any;
    expect(() => buildIdempotencyKey(bad2)).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad3 = { ...baseline, targetFolder: '/tmp/x' } as any;
    expect(() => buildIdempotencyKey(bad3)).toThrow();
  });

  it('covers every ReportKind (per-kind key stability)', () => {
    // Any two ReportKinds with different spec versions produce
    // different keys — no silent collisions across the kind space.
    const keys = new Set<string>();
    for (const k of REPORT_KINDS) {
      keys.add(buildIdempotencyKey({
        ...baseline,
        reportKind: k,
        reportSpecVersion: REPORT_SPEC_VERSIONS[k],
      }));
    }
    expect(keys.size).toBe(REPORT_KINDS.length);
  });
});

describe('contentDigest — determinism', () => {
  const envelope: CanonicalReportEnvelope<'safety_status'> = {
    reportKind: 'safety_status',
    reportSpecVersion: REPORT_SPEC_VERSIONS.safety_status,
    sourceHighWaterMark: { safety: 100 },
    sourceQueryVersions: ['safety.v1'],
    redactionsApplied: [],
    payload: { DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false },
  };

  it('is stable across two runs with identical envelopes', () => {
    expect(computeContentDigest(envelope)).toBe(computeContentDigest(envelope));
  });

  it('is stable when redactionsApplied is in different order', () => {
    const a = computeContentDigest({ ...envelope, redactionsApplied: ['a', 'b'] });
    const b = computeContentDigest({ ...envelope, redactionsApplied: ['b', 'a'] });
    expect(a).toBe(b);
  });

  it('is stable when sourceQueryVersions is in different order', () => {
    const a = computeContentDigest({ ...envelope, sourceQueryVersions: ['x.v1', 'y.v1'] });
    const b = computeContentDigest({ ...envelope, sourceQueryVersions: ['y.v1', 'x.v1'] });
    expect(a).toBe(b);
  });

  it('changes when payload changes', () => {
    const a = computeContentDigest(envelope);
    const b = computeContentDigest({ ...envelope, payload: { DRY_RUN: false, ORDER_SUBMISSION_ENABLED: false } });
    expect(a).not.toBe(b);
  });

  it('changes when sourceHighWaterMark changes (advancing time-in-DB advances the digest)', () => {
    const a = computeContentDigest(envelope);
    const b = computeContentDigest({ ...envelope, sourceHighWaterMark: { safety: 101 } });
    expect(a).not.toBe(b);
  });

  it('changes when reportSpecVersion changes', () => {
    const a = computeContentDigest(envelope);
    const b = computeContentDigest({ ...envelope, reportSpecVersion: 'safety_status.v2' });
    expect(a).not.toBe(b);
  });

  it('produces a 64-hex string (SHA256)', () => {
    expect(computeContentDigest(envelope)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('REPORT_SPEC_VERSIONS coverage', () => {
  it('has an entry for every REPORT_KIND', () => {
    for (const k of REPORT_KINDS) {
      expect(REPORT_SPEC_VERSIONS[k]).toBeTypeOf('string');
      expect(REPORT_SPEC_VERSIONS[k].length).toBeGreaterThan(0);
    }
    expect(Object.keys(REPORT_SPEC_VERSIONS).length).toBe(REPORT_KINDS.length);
  });
});
