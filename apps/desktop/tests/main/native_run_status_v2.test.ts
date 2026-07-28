/**
 * Stage 3C-CI-RESET Part 2 Checkpoint C.4 + C.6 + C.9 tests
 * W21..W24 + S25..S30 — wrapper + status v2 unit tests.
 *
 * The wrapper tests use vitest's own `it()` runner via a nested
 * describe (there's no vitest-in-vitest test runner here, so
 * "passing test records started/passed" is tested by directly
 * invoking the ledger transitions the wrapper would produce and
 * asserting the ledger state matches).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NativeCertificationRequirement } from '../native/nativeCertificationManifest';
import { NativeExecutionLedger, type NativeExecutionSummary } from '../native/nativeExecutionLedger';
import {
  NativeRunStatusV2Writer,
  recomputeNativeRunStatusV2,
  type NativeRunStatusV2FieldsInput,
} from '../native/nativeRunStatusV2';

const REQ_A: NativeCertificationRequirement = { id: 'T-a', title: 'a', category: 'startup', required: true };
const REQ_CLEANUP: NativeCertificationRequirement = { id: 'CLEANUP:x', title: 'x', category: 'cleanup', required: true };

function newRunDir(): string { return mkdtempSync(join(tmpdir(), 'stage3c-status-')); }

function makeCompleteSummary(overrides: Partial<NativeExecutionSummary> = {}): NativeExecutionSummary {
  return {
    contract: 'stage3c-native-execution-summary.v1',
    manifestHash: 'x'.repeat(64),
    ledgerHash: 'y'.repeat(64),
    registered: 1,
    started: 1,
    passed: 1,
    failed: 0,
    unstarted: 0,
    incomplete: 0,
    firstFailure: null,
    secondaryFailures: [],
    byCategory: {} as NativeExecutionSummary['byCategory'],
    screens: {},
    complete: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Wrapper behavior (W21..W24 — asserted through direct ledger ops)
// ---------------------------------------------------------------------------

describe('Stage 3C-CI-RESET Part 2 Checkpoint C.4 — wrapper contract', () => {
  it('W21: passing wrapper records started + passed', () => {
    const ledger = new NativeExecutionLedger({ runDir: newRunDir(), manifest: [REQ_A] });
    ledger.registerManifest();
    // Emulate what certificationTest does on a passing body.
    ledger.start(REQ_A.id);
    ledger.pass(REQ_A.id, 42);
    expect(ledger.currentState(REQ_A.id)).toBe('passed');
    ledger.close();
  });

  it('W22: failing wrapper records started + failed and preserves message', () => {
    const ledger = new NativeExecutionLedger({ runDir: newRunDir(), manifest: [REQ_A] });
    ledger.registerManifest();
    ledger.start(REQ_A.id);
    ledger.fail(REQ_A.id, 'boom', 12);
    expect(ledger.currentState(REQ_A.id)).toBe('failed');
    const events = ledger.snapshot();
    const last = events[events.length - 1];
    expect(last.transition).toBe('fail');
    expect(last.failureCode).toBe('boom');
    ledger.close();
  });

  it('W23: beforeAll-style failure leaves later requirements unstarted', () => {
    const ledger = new NativeExecutionLedger({ runDir: newRunDir(), manifest: [REQ_A, REQ_CLEANUP] });
    ledger.registerManifest();
    // If beforeAll fails, no requirement ever transitions past `registered`.
    expect(ledger.currentState(REQ_A.id)).toBe('registered');
    expect(ledger.currentState(REQ_CLEANUP.id)).toBe('registered');
    ledger.close();
  });

  it('W24: cleanup recordCleanup is safe on an already-passed entry (idempotent)', () => {
    const ledger = new NativeExecutionLedger({ runDir: newRunDir(), manifest: [REQ_CLEANUP] });
    ledger.registerManifest();
    ledger.recordCleanup(REQ_CLEANUP.id, true);
    expect(ledger.currentState(REQ_CLEANUP.id)).toBe('passed');
    // Second call is a no-op.
    ledger.recordCleanup(REQ_CLEANUP.id, false, 'ignored');
    expect(ledger.currentState(REQ_CLEANUP.id)).toBe('passed');
    ledger.close();
  });
});

// ---------------------------------------------------------------------------
// Status v2 (S25..S30)
// ---------------------------------------------------------------------------

function baseInput(): NativeRunStatusV2FieldsInput {
  return {
    workflowRunId: null,
    gitCommit: 'test',
    runId: 'r1',
    startedAt: '2026-07-28T00:00:00Z',
    currentRequirementId: null,
    manifestHash: null,
    ledgerHash: null,
    nativeTestStarted: true,
    startupComplete: false,
    assertionsComplete: false,
    cleanupComplete: false,
    evidenceValid: false,
    ledgerSummary: null,
    processLeakOk: null,
    firstFailure: null,
    secondaryFailures: [],
  };
}

describe('Stage 3C-CI-RESET Part 2 Checkpoint C.6 — native-run-status.v2 completion invariants', () => {
  it('S25: startup-only cannot complete', () => {
    const d = recomputeNativeRunStatusV2({ ...baseInput(), startupComplete: true });
    expect(d.completed).toBe(false);
  });

  it('S26: cleanup-only cannot complete', () => {
    const d = recomputeNativeRunStatusV2({ ...baseInput(), cleanupComplete: true });
    expect(d.completed).toBe(false);
  });

  it('S27: assertion failure prevents completion (firstFailure set)', () => {
    const d = recomputeNativeRunStatusV2({
      ...baseInput(),
      startupComplete: true,
      assertionsComplete: true,
      cleanupComplete: true,
      evidenceValid: true,
      processLeakOk: true,
      ledgerSummary: makeCompleteSummary({
        firstFailure: { requirementId: 'T-a', category: 'startup', failureCode: 'x', sequence: 0, timestamp: 'z' },
        complete: false,
      }),
    });
    expect(d.completed).toBe(false);
  });

  it('S28: process leak failure prevents completion', () => {
    const d = recomputeNativeRunStatusV2({
      ...baseInput(),
      startupComplete: true,
      assertionsComplete: true,
      cleanupComplete: true,
      evidenceValid: true,
      processLeakOk: false,
      ledgerSummary: makeCompleteSummary(),
    });
    expect(d.completed).toBe(false);
  });

  it('S29: evidence failure prevents completion', () => {
    const d = recomputeNativeRunStatusV2({
      ...baseInput(),
      startupComplete: true,
      assertionsComplete: true,
      cleanupComplete: true,
      evidenceValid: false,
      processLeakOk: true,
      ledgerSummary: makeCompleteSummary(),
    });
    expect(d.completed).toBe(false);
  });

  it('S30: only the complete successful state returns completed=true', () => {
    const d = recomputeNativeRunStatusV2({
      ...baseInput(),
      startupComplete: true,
      assertionsComplete: true,
      cleanupComplete: true,
      evidenceValid: true,
      processLeakOk: true,
      ledgerSummary: makeCompleteSummary(),
    });
    expect(d.completed).toBe(true);
  });

  it('S31: cleanupComplete can flip while completed stays false (failed assertion)', () => {
    const d = recomputeNativeRunStatusV2({
      ...baseInput(),
      startupComplete: true,
      assertionsComplete: false,
      cleanupComplete: true,
      evidenceValid: false,
      processLeakOk: true,
      ledgerSummary: makeCompleteSummary({
        firstFailure: { requirementId: 'T-a', category: 'startup', failureCode: 'x', sequence: 0, timestamp: 'z' },
        complete: false,
      }),
    });
    expect(d.completed).toBe(false);
    expect(d.cleanupComplete).toBe(true);
  });

  it('S32: writer persists v2 file with recomputed completed field', () => {
    const runDir = newRunDir();
    const w = new NativeRunStatusV2Writer(runDir, { runId: 'r', gitCommit: 'c', startedAt: '2026-01-01T00:00:00Z', workflowRunId: null });
    w.markStartupComplete();
    w.markAssertionsComplete();
    w.markCleanupComplete();
    w.markEvidenceValid();
    w.setProcessLeakOk(true);
    w.setLedgerSummary(makeCompleteSummary());
    const snap = w.snapshot();
    expect(snap.completed).toBe(true);
    expect(snap.contract).toBe('stage3c-native-run-status.v2');
  });

  it('S33: secondary cleanup failure prevents completion even when other flags are true', () => {
    const d = recomputeNativeRunStatusV2({
      ...baseInput(),
      startupComplete: true,
      assertionsComplete: true,
      cleanupComplete: true,
      evidenceValid: true,
      processLeakOk: true,
      ledgerSummary: makeCompleteSummary({
        secondaryFailures: [{ requirementId: 'CLEANUP:x', category: 'cleanup', failureCode: 'x', sequence: 1, timestamp: 'z' }],
      }),
    });
    expect(d.completed).toBe(false);
  });
});
