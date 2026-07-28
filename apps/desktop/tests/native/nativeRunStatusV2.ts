/**
 * Stage 3C-CI-RESET Part 2 Checkpoint C.6 — native-run-status.v2 with
 * a pure recompute() reducer.
 *
 * The v1 writer (`NativeRunStatus` in nativeDiagnostics.ts) let the
 * `completed` flag flip true whenever three loosely-coupled setters
 * had been called. v2 replaces that with a single pure recompute()
 * that derives `completed` from the WHOLE state at once, so no code
 * path can force `completed:true` without every required condition
 * being present:
 *
 *   startupComplete
 *   assertionsComplete
 *   cleanupComplete
 *   evidenceValid
 *   ledger summary complete (no primary failure, no secondary
 *     mandatory-cleanup failure)
 *   processLeakResult.ok
 *
 * The status file is written atomically (temp + rename) so a
 * reader never observes a torn state. Both v1 and v2 exist during
 * the reset — v2 is authoritative; v1 remains for callers not yet
 * migrated.
 */

import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeExecutionSummary } from './nativeExecutionLedger';

export interface NativeRunStatusV2FieldsInput {
  readonly workflowRunId: string | null;
  readonly gitCommit: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly currentRequirementId: string | null;
  readonly manifestHash: string | null;
  readonly ledgerHash: string | null;
  readonly nativeTestStarted: boolean;
  readonly startupComplete: boolean;
  readonly assertionsComplete: boolean;
  readonly cleanupComplete: boolean;
  readonly evidenceValid: boolean;
  readonly ledgerSummary: NativeExecutionSummary | null;
  readonly processLeakOk: boolean | null;
  readonly firstFailure: NativeExecutionSummary['firstFailure'];
  readonly secondaryFailures: NativeExecutionSummary['secondaryFailures'];
}

export interface NativeRunStatusV2 extends NativeRunStatusV2FieldsInput {
  readonly contract: 'stage3c-native-run-status.v2';
  readonly completed: boolean;
}

/**
 * Pure recompute. Given a state snapshot, return the fully-derived
 * v2 status. The `completed` field is NEVER settable directly.
 */
export function recomputeNativeRunStatusV2(input: NativeRunStatusV2FieldsInput): NativeRunStatusV2 {
  const ledgerComplete = input.ledgerSummary?.complete === true;
  const noPrimaryFailure = input.ledgerSummary?.firstFailure == null;
  const noSecondaryCleanupFailure = (input.ledgerSummary?.secondaryFailures ?? [])
    .every((f) => f.category !== 'cleanup');
  const completed =
    input.startupComplete
    && input.assertionsComplete
    && input.cleanupComplete
    && input.evidenceValid
    && ledgerComplete
    && noPrimaryFailure
    && noSecondaryCleanupFailure
    && input.processLeakOk === true;
  return {
    contract: 'stage3c-native-run-status.v2',
    ...input,
    completed,
  };
}

// ---------------------------------------------------------------------------
// Mutable writer — accumulates fields, calls recompute() on each flush,
// persists atomically. Setters return void; `completed` is READ-ONLY.
// ---------------------------------------------------------------------------

export class NativeRunStatusV2Writer {
  private readonly statusPath: string;
  private readonly tmpPath: string;
  private state: NativeRunStatusV2FieldsInput;

  constructor(runDir: string, opts: { runId: string; gitCommit: string; startedAt: string; workflowRunId: string | null }) {
    this.statusPath = join(runDir, 'native-run-status.v2.json');
    this.tmpPath = join(runDir, 'native-run-status.v2.tmp.json');
    this.state = {
      workflowRunId: opts.workflowRunId,
      gitCommit: opts.gitCommit,
      runId: opts.runId,
      startedAt: opts.startedAt,
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
    this.flush();
  }

  path(): string { return this.statusPath; }

  setCurrentRequirement(id: string | null): void { this.update({ currentRequirementId: id }); }
  setManifestHash(hash: string): void { this.update({ manifestHash: hash }); }
  setLedgerHash(hash: string): void { this.update({ ledgerHash: hash }); }
  markStartupComplete(): void { this.update({ startupComplete: true }); }
  markAssertionsComplete(): void { this.update({ assertionsComplete: true }); }
  markCleanupComplete(): void { this.update({ cleanupComplete: true }); }
  markEvidenceValid(): void { this.update({ evidenceValid: true }); }
  setLedgerSummary(summary: NativeExecutionSummary): void {
    this.update({
      ledgerSummary: summary,
      manifestHash: summary.manifestHash,
      ledgerHash: summary.ledgerHash,
      firstFailure: summary.firstFailure,
      secondaryFailures: summary.secondaryFailures,
    });
  }
  setProcessLeakOk(ok: boolean): void { this.update({ processLeakOk: ok }); }

  snapshot(): NativeRunStatusV2 { return recomputeNativeRunStatusV2(this.state); }

  private update(patch: Partial<NativeRunStatusV2FieldsInput>): void {
    this.state = { ...this.state, ...patch };
    this.flush();
  }

  private flush(): void {
    try {
      const derived = recomputeNativeRunStatusV2(this.state);
      writeFileSync(this.tmpPath, JSON.stringify(derived, null, 2));
      renameSync(this.tmpPath, this.statusPath);
    } catch { /* best-effort */ }
  }
}
