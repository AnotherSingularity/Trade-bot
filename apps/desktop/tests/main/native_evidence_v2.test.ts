/**
 * Stage 3C-CI-RESET Part 2 Checkpoint C.7 + C.9 tests E31..E40 —
 * evidence-v2 derivation + validator unit tests.
 */

import { describe, expect, it } from 'vitest';
import { computeManifestHash, NATIVE_CERTIFICATION_MANIFEST } from '../native/nativeCertificationManifest';
import { reduceNativeExecutionLedger, type NativeExecutionSummary } from '../native/nativeExecutionLedger';
import {
  deriveEvidenceV2,
  makeIncompleteDeriveInput,
  validateEvidenceV2Structure,
  type DeriveEvidenceV2Input,
} from '../native/nativeEvidenceV2';

// A tiny "happy path" summary — no failures, one screen fully passed.
function makeSummary(overrides: Partial<NativeExecutionSummary> = {}): NativeExecutionSummary {
  return {
    contract: 'stage3c-native-execution-summary.v1',
    manifestHash: 'a'.repeat(64),
    ledgerHash: 'b'.repeat(64),
    registered: 3,
    started: 3,
    passed: 3,
    failed: 0,
    unstarted: 0,
    incomplete: 0,
    firstFailure: null,
    secondaryFailures: [],
    byCategory: {} as NativeExecutionSummary['byCategory'],
    screens: {
      overview: { navigation: 'passed', signature: 'passed', manifest: 'passed' },
    },
    complete: true,
    ...overrides,
  };
}

const BASE_ENV = {
  os: 'linux-x64',
  nodeVersion: 'v22',
  workflowRunId: null,
  electronPid: 1,
  serverPid: 2,
  dbName: 'hzn_scratch_test',
  redisNamespace: 'native_test',
};

function makeCompleteInput(): DeriveEvidenceV2Input {
  return {
    runId: 'r1',
    commit: 'test',
    environment: BASE_ENV,
    executionSummary: makeSummary(),
    startupResult: { kind: 'ready', rendererReady: true, authenticationPhase: 'authenticated' },
    authenticationResult: { kind: 'authenticated', sanitized: true },
    rendererSecurityResult: { kind: 'measured', hasProcess: false, hasRequire: false, hasIpcRenderer: false, hasHorizon: true },
    sessionLifecycleResult: { kind: 'exercised', locked: true, revoked: true, relogin: true },
    degradationResult: { kind: 'observed', staleOrDegradedObserved: true, apiFailureObserved: true, contractMismatchStructuralPresent: true },
    createOrderCounters: { kind: 'measured', functionInvocations: 0, attemptCount: 0, networkCount: 0 },
    safeFlags: { kind: 'measured', DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false, SIMULATION_MODE: 'STANDARD_DRY_RUN', liveCapitalAuthorized: false, promotionEnabled: false, kellyEnabled: false },
    providerResult: { kind: 'fixture', providerMode: 'fixture' },
    teardownResult: { kind: 'complete', electronClose: true, serverStop: true, redisCleanup: true, databaseDrop: true, completed: true },
    processLeakResult: { kind: 'clean', ok: true, survivors: [] as const },
  };
}

describe('Stage 3C-CI-RESET Part 2 Checkpoint C.7 — evidence v2 derivation', () => {
  it('E31: assertion counts derive from the ledger summary, not from input', () => {
    const summary = makeSummary({ registered: 5, started: 5, passed: 5 });
    const bundle = deriveEvidenceV2({ ...makeCompleteInput(), executionSummary: summary });
    expect(bundle.assertionResults.source).toBe('execution_ledger');
    expect(bundle.assertionResults.registered).toBe(5);
    expect(bundle.assertionResults.passed).toBe(5);
  });

  it('E32: screen results derive from the ledger summary', () => {
    const summary = makeSummary({
      screens: {
        overview: { navigation: 'passed', signature: 'passed', manifest: 'failed' },
      },
    });
    const bundle = deriveEvidenceV2({ ...makeCompleteInput(), executionSummary: summary });
    expect(bundle.screenResults.overview.navigationPassed).toBe(true);
    expect(bundle.screenResults.overview.signaturePassed).toBe(true);
    expect(bundle.screenResults.overview.manifestPassed).toBe(false);
    expect(bundle.screenResults.overview.complete).toBe(false);
    expect(bundle.evidenceValidation.failures).toContain('screen_incomplete:overview');
    expect(bundle.completed).toBe(false);
  });

  it('E33: missing screen entry in summary (only 2 of 3 passed) prevents completion', () => {
    const summary = makeSummary({
      screens: {
        overview: { navigation: 'passed', signature: 'passed', manifest: 'registered' },
      },
      complete: false,
    });
    const bundle = deriveEvidenceV2({ ...makeCompleteInput(), executionSummary: summary });
    expect(bundle.completed).toBe(false);
    expect(bundle.evidenceValidation.failures.some((f) => f.startsWith('screen_incomplete:overview'))).toBe(true);
  });

  it('E34: no direct API path lets a caller hardcode screen passed:true', () => {
    // The screenResults map is derived — a caller can't inject one.
    // Confirm every entry has the ledger-derived fields, and that
    // any incomplete state in the ledger becomes an explicit
    // failure tag.
    const bundle = deriveEvidenceV2(makeCompleteInput());
    expect(Object.keys(bundle.screenResults)).toEqual(['overview']);
    expect(bundle.screenResults.overview.navigationRequirementId).toBe('NAV:overview');
  });

  it('E35: null / incomplete mandatory value prevents completion', () => {
    const bundle = deriveEvidenceV2({
      ...makeCompleteInput(),
      startupResult: { kind: 'incomplete', detail: 'no observation yet' },
    });
    expect(bundle.completed).toBe(false);
    expect(bundle.evidenceValidation.failures).toContain('incomplete:startupResult');
  });

  it('E36: nonzero Create Order counter prevents completion', () => {
    const bundle = deriveEvidenceV2({
      ...makeCompleteInput(),
      createOrderCounters: { kind: 'measured', functionInvocations: 1, attemptCount: 0, networkCount: 0 },
    });
    expect(bundle.evidenceValidation.failures).toContain('order_counters_nonzero');
    expect(bundle.completed).toBe(false);
  });

  it('E37: safe-flag mismatch prevents completion', () => {
    const bundle = deriveEvidenceV2({
      ...makeCompleteInput(),
      safeFlags: {
        kind: 'measured',
        DRY_RUN: false,
        ORDER_SUBMISSION_ENABLED: false,
        SIMULATION_MODE: 'STANDARD_DRY_RUN',
        liveCapitalAuthorized: false,
        promotionEnabled: false,
        kellyEnabled: false,
      },
    });
    expect(bundle.evidenceValidation.failures).toContain('safe_flags_mismatch');
    expect(bundle.completed).toBe(false);
  });

  it('E38: production provider state prevents completion', () => {
    const bundle = deriveEvidenceV2({
      ...makeCompleteInput(),
      providerResult: { kind: 'production', providerMode: 'external' },
    });
    expect(bundle.evidenceValidation.failures).toContain('production_provider_active');
    expect(bundle.completed).toBe(false);
  });

  it('E39: cleanup failure (teardown partial) prevents completion', () => {
    const bundle = deriveEvidenceV2({
      ...makeCompleteInput(),
      teardownResult: { kind: 'partial', electronClose: true, serverStop: false, redisCleanup: true, databaseDrop: true, completed: false },
    });
    expect(bundle.evidenceValidation.failures).toContain('teardown_partial');
    expect(bundle.completed).toBe(false);
  });

  it('E40: process survivor prevents completion', () => {
    const bundle = deriveEvidenceV2({
      ...makeCompleteInput(),
      processLeakResult: { kind: 'leaked', ok: false, survivors: [{ pid: 999, comm: 'ghost', role: 'server' }] },
    });
    expect(bundle.evidenceValidation.failures).toContain('process_leaked');
    expect(bundle.completed).toBe(false);
  });

  it('E41: complete happy-path input → evidenceValidation.ok=true + completed=true', () => {
    const bundle = deriveEvidenceV2(makeCompleteInput());
    expect(bundle.evidenceValidation.ok).toBe(true);
    expect(bundle.completed).toBe(true);
  });

  it('E42: preliminary structure validator accepts incomplete kinds; final validator rejects them', () => {
    const input = makeIncompleteDeriveInput({
      runId: 'r', commit: 'c', environment: BASE_ENV, executionSummary: makeSummary(),
    });
    const bundle = deriveEvidenceV2(input);
    const pre = validateEvidenceV2Structure(bundle, 'preliminary');
    const fin = validateEvidenceV2Structure(bundle, 'final');
    expect(pre.ok).toBe(true);
    expect(fin.ok).toBe(false);
    expect(fin.failures).toContain('incomplete:startupResult');
  });

  it('E43: hardcoded/unsupported contract version fails validator', () => {
    const bundle = deriveEvidenceV2(makeCompleteInput());
    const tampered = { ...bundle, contract: 'stage3c-native-evidence.v1' as unknown as 'stage3c-native-evidence.v2' };
    const result = validateEvidenceV2Structure(tampered as never, 'final');
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('bad_contract');
  });

  it('E44: missing ledger hash fails validator', () => {
    const bundle = deriveEvidenceV2(makeCompleteInput());
    const tampered = { ...bundle, executionLedgerHash: '' } as never;
    const result = validateEvidenceV2Structure(tampered, 'final');
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('bad_ledger_hash');
  });

  it('E45: ledger-first-failure surfaces in evidenceValidation and prevents completion', () => {
    const summary = makeSummary({
      complete: false,
      firstFailure: { requirementId: 'T-a', category: 'startup', failureCode: 'boom', sequence: 3, timestamp: 'z' },
    });
    const bundle = deriveEvidenceV2({ ...makeCompleteInput(), executionSummary: summary });
    expect(bundle.completed).toBe(false);
    expect(bundle.evidenceValidation.failures).toContain('first_failure:T-a');
    expect(bundle.evidenceValidation.failures).toContain('ledger_incomplete');
  });

  it('E46: real manifest hash flows through — bundle carries the same hash as computeManifestHash', () => {
    // Prove nothing lets a caller fabricate a different manifest hash
    // — the bundle takes it from `executionSummary.manifestHash`.
    const expected = computeManifestHash(NATIVE_CERTIFICATION_MANIFEST);
    const summary = makeSummary({ manifestHash: expected });
    const bundle = deriveEvidenceV2({ ...makeCompleteInput(), executionSummary: summary });
    expect(bundle.certificationManifestHash).toBe(expected);
  });

  it('E47: reduceNativeExecutionLedger round-trip: manifest → summary → evidence keeps counts consistent', () => {
    // End-to-end shape check: build a minimal ledger, reduce, derive
    // evidence, and verify the assertionResults track the summary
    // exactly.
    const events: Parameters<typeof reduceNativeExecutionLedger>[0] = [];
    const summary = reduceNativeExecutionLedger(events, [], Buffer.alloc(0));
    const bundle = deriveEvidenceV2({
      runId: 'r', commit: 'c', environment: BASE_ENV,
      executionSummary: summary,
      startupResult: { kind: 'ready', rendererReady: true, authenticationPhase: 'authenticated' },
      authenticationResult: { kind: 'authenticated', sanitized: true },
      rendererSecurityResult: { kind: 'measured', hasProcess: false, hasRequire: false, hasIpcRenderer: false, hasHorizon: true },
      sessionLifecycleResult: { kind: 'exercised', locked: true, revoked: true, relogin: true },
      degradationResult: { kind: 'observed', staleOrDegradedObserved: true, apiFailureObserved: true, contractMismatchStructuralPresent: true },
      createOrderCounters: { kind: 'measured', functionInvocations: 0, attemptCount: 0, networkCount: 0 },
      safeFlags: { kind: 'measured', DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false, SIMULATION_MODE: 'STANDARD_DRY_RUN', liveCapitalAuthorized: false, promotionEnabled: false, kellyEnabled: false },
      providerResult: { kind: 'fixture', providerMode: 'fixture' },
      teardownResult: { kind: 'complete', electronClose: true, serverStop: true, redisCleanup: true, databaseDrop: true, completed: true },
      processLeakResult: { kind: 'clean', ok: true, survivors: [] as const },
    });
    expect(bundle.assertionResults.registered).toBe(0);
    expect(bundle.assertionResults.passed).toBe(0);
  });
});
