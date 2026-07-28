/**
 * Stage 3C-CI-RESET Part 2 Checkpoint C.7 — stage3c-native-evidence.v2
 * contract + a pure derivation function that builds the bundle from
 * authoritative sources only.
 *
 * The v1 EvidenceBundle in electronHarness.ts accepted hardcoded
 * `screens: 19`, `total: 55`, `processLeakResult: { ok: true, ...
 * pending_afterall_leak_check }`, `assertionResults` marked
 * `pending_reporter_hook_...`. The v2 shape below has NO such escape
 * hatches — every mandatory field is either explicitly present as
 * an authoritative result, or explicitly present as an incomplete
 * result that MUST force `completed:false`.
 *
 * `deriveEvidenceV2(input)` is a pure function: same inputs → same
 * output. It does no I/O. `writeEvidenceV2(runDir, bundle)` writes
 * the JSON to disk. The two are separate so the pre-cleanup call
 * site can derive + validate STRUCTURE without touching the
 * eventual post-cleanup evidence file.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeExecutionSummary } from './nativeExecutionLedger';

// ---------------------------------------------------------------------------
// Result subtypes — every mandatory field is a discriminated union with
// an explicit `incomplete` shape. A run that has not yet produced the
// authoritative result MUST carry the incomplete shape; it cannot omit
// the field or claim a default success.
// ---------------------------------------------------------------------------

export type StartupResultV2 =
  | { readonly kind: 'ready'; readonly rendererReady: true; readonly authenticationPhase: 'authenticated' }
  | { readonly kind: 'incomplete'; readonly detail: string };

export type AuthenticationResultV2 =
  | { readonly kind: 'authenticated'; readonly sanitized: true }
  | { readonly kind: 'incomplete'; readonly detail: string };

export interface ScreenResultV2 {
  readonly navigationRequirementId: string;
  readonly signatureRequirementId: string;
  readonly manifestRequirementId: string;
  readonly navigationPassed: boolean;
  readonly signaturePassed: boolean;
  readonly manifestPassed: boolean;
  readonly complete: boolean;
}

export interface AssertionResultsV2 {
  readonly source: 'execution_ledger';
  readonly registered: number;
  readonly started: number;
  readonly passed: number;
  readonly failed: number;
  readonly unstarted: number;
  readonly incomplete: number;
}

export type RendererSecurityResultV2 =
  | { readonly kind: 'measured'; readonly hasProcess: false; readonly hasRequire: false; readonly hasIpcRenderer: false; readonly hasHorizon: true }
  | { readonly kind: 'measured_insecure'; readonly hasProcess: boolean; readonly hasRequire: boolean; readonly hasIpcRenderer: boolean; readonly hasHorizon: boolean }
  | { readonly kind: 'incomplete'; readonly detail: string };

export type SessionLifecycleResultV2 =
  | { readonly kind: 'exercised'; readonly locked: boolean; readonly revoked: boolean; readonly relogin: boolean }
  | { readonly kind: 'incomplete'; readonly detail: string };

export type DegradationResultV2 =
  | { readonly kind: 'observed'; readonly staleOrDegradedObserved: boolean; readonly apiFailureObserved: boolean; readonly contractMismatchStructuralPresent: boolean }
  | { readonly kind: 'incomplete'; readonly detail: string };

export type CreateOrderCountersV2 =
  | { readonly kind: 'measured'; readonly functionInvocations: number; readonly attemptCount: number; readonly networkCount: number }
  | { readonly kind: 'incomplete'; readonly detail: string };

export type SafeFlagsV2 =
  | {
      readonly kind: 'measured';
      readonly DRY_RUN: boolean;
      readonly ORDER_SUBMISSION_ENABLED: boolean;
      readonly SIMULATION_MODE: string;
      readonly liveCapitalAuthorized: boolean;
      readonly promotionEnabled: boolean;
      readonly kellyEnabled: boolean;
    }
  | { readonly kind: 'incomplete'; readonly detail: string };

export type ProviderResultV2 =
  | { readonly kind: 'fixture'; readonly providerMode: 'unset' | 'fixture' }
  | { readonly kind: 'production'; readonly providerMode: string }
  | { readonly kind: 'incomplete'; readonly detail: string };

export type TeardownResultV2 =
  | {
      readonly kind: 'complete';
      readonly electronClose: boolean;
      readonly serverStop: boolean;
      readonly redisCleanup: boolean;
      readonly databaseDrop: boolean;
      readonly completed: true;
    }
  | {
      readonly kind: 'partial';
      readonly electronClose: boolean;
      readonly serverStop: boolean;
      readonly redisCleanup: boolean;
      readonly databaseDrop: boolean;
      readonly completed: false;
    }
  | { readonly kind: 'incomplete'; readonly detail: string };

export type ProcessLeakResultV2 =
  | { readonly kind: 'clean'; readonly ok: true; readonly survivors: readonly [] }
  | { readonly kind: 'leaked'; readonly ok: false; readonly survivors: ReadonlyArray<{ pid: number; comm: string; role: string }> }
  | { readonly kind: 'incomplete'; readonly detail: string };

export interface EvidenceValidationV2 {
  readonly ok: boolean;
  readonly failures: readonly string[];
}

// ---------------------------------------------------------------------------
// The full v2 bundle.
// ---------------------------------------------------------------------------

export interface NativeEvidenceV2 {
  readonly contract: 'stage3c-native-evidence.v2';
  readonly runId: string;
  readonly commit: string;
  readonly environment: {
    readonly os: string;
    readonly nodeVersion: string;
    readonly workflowRunId: string | null;
    readonly electronPid: number | null;
    readonly serverPid: number | null;
    readonly dbName: string;
    readonly redisNamespace: string;
  };
  readonly certificationManifestHash: string;
  readonly executionLedgerHash: string;
  readonly executionSummary: NativeExecutionSummary;
  readonly startupResult: StartupResultV2;
  readonly authenticationResult: AuthenticationResultV2;
  readonly screenResults: Readonly<Record<string, ScreenResultV2>>;
  readonly assertionResults: AssertionResultsV2;
  readonly rendererSecurityResult: RendererSecurityResultV2;
  readonly sessionLifecycleResult: SessionLifecycleResultV2;
  readonly degradationResult: DegradationResultV2;
  readonly createOrderCounters: CreateOrderCountersV2;
  readonly safeFlags: SafeFlagsV2;
  readonly providerResult: ProviderResultV2;
  readonly teardownResult: TeardownResultV2;
  readonly processLeakResult: ProcessLeakResultV2;
  readonly evidenceValidation: EvidenceValidationV2;
  readonly completed: boolean;
}

// ---------------------------------------------------------------------------
// Derivation input + pure builder + validator.
// ---------------------------------------------------------------------------

export interface DeriveEvidenceV2Input {
  readonly runId: string;
  readonly commit: string;
  readonly environment: NativeEvidenceV2['environment'];
  readonly executionSummary: NativeExecutionSummary;
  readonly startupResult: StartupResultV2;
  readonly authenticationResult: AuthenticationResultV2;
  readonly rendererSecurityResult: RendererSecurityResultV2;
  readonly sessionLifecycleResult: SessionLifecycleResultV2;
  readonly degradationResult: DegradationResultV2;
  readonly createOrderCounters: CreateOrderCountersV2;
  readonly safeFlags: SafeFlagsV2;
  readonly providerResult: ProviderResultV2;
  readonly teardownResult: TeardownResultV2;
  readonly processLeakResult: ProcessLeakResultV2;
}

/**
 * Pure derivation. Screen results are derived from the ledger; the
 * assertion counts are derived from the summary. Every mandatory
 * incomplete result contributes to `evidenceValidation.failures`
 * with a stable tag. Any incomplete result forces `completed:false`.
 */
export function deriveEvidenceV2(input: DeriveEvidenceV2Input): NativeEvidenceV2 {
  const failures: string[] = [];
  const summary = input.executionSummary;

  // Screen results — one entry per screen in the summary's `screens`.
  const screenResults: Record<string, ScreenResultV2> = {};
  for (const [key, s] of Object.entries(summary.screens)) {
    const navigationPassed = s.navigation === 'passed';
    const signaturePassed = s.signature === 'passed';
    const manifestPassed = s.manifest === 'passed';
    const complete = navigationPassed && signaturePassed && manifestPassed;
    if (!complete) failures.push(`screen_incomplete:${key}`);
    screenResults[key] = {
      navigationRequirementId: `NAV:${key}`,
      signatureRequirementId: `SIG:${key}`,
      manifestRequirementId: `MANIFEST:${key}`,
      navigationPassed,
      signaturePassed,
      manifestPassed,
      complete,
    };
  }

  const assertionResults: AssertionResultsV2 = {
    source: 'execution_ledger',
    registered: summary.registered,
    started: summary.started,
    passed: summary.passed,
    failed: summary.failed,
    unstarted: summary.unstarted,
    incomplete: summary.incomplete,
  };

  // Result-shape validation.
  const requireComplete = (name: string, kind: string): void => {
    if (kind === 'incomplete') failures.push(`incomplete:${name}`);
  };
  requireComplete('startupResult', input.startupResult.kind);
  requireComplete('authenticationResult', input.authenticationResult.kind);
  requireComplete('rendererSecurityResult', input.rendererSecurityResult.kind);
  requireComplete('sessionLifecycleResult', input.sessionLifecycleResult.kind);
  requireComplete('degradationResult', input.degradationResult.kind);
  requireComplete('createOrderCounters', input.createOrderCounters.kind);
  requireComplete('safeFlags', input.safeFlags.kind);
  requireComplete('providerResult', input.providerResult.kind);
  requireComplete('teardownResult', input.teardownResult.kind);
  requireComplete('processLeakResult', input.processLeakResult.kind);

  if (input.rendererSecurityResult.kind === 'measured_insecure') failures.push('renderer_insecure');
  if (input.createOrderCounters.kind === 'measured') {
    const c = input.createOrderCounters;
    if (c.functionInvocations !== 0 || c.attemptCount !== 0 || c.networkCount !== 0) failures.push('order_counters_nonzero');
  }
  if (input.safeFlags.kind === 'measured') {
    const f = input.safeFlags;
    if (f.DRY_RUN !== true || f.ORDER_SUBMISSION_ENABLED !== false || f.liveCapitalAuthorized !== false || f.promotionEnabled !== false || f.kellyEnabled !== false) failures.push('safe_flags_mismatch');
  }
  if (input.providerResult.kind === 'production') failures.push('production_provider_active');
  if (input.teardownResult.kind === 'partial') failures.push('teardown_partial');
  if (input.processLeakResult.kind === 'leaked') failures.push('process_leaked');

  // Ledger-level completeness contributes to the completed flag
  // through evidenceValidation, so a manifest gap shows up as a
  // failure tag rather than as a silent absence.
  if (!summary.complete) failures.push('ledger_incomplete');
  if (summary.firstFailure) failures.push(`first_failure:${summary.firstFailure.requirementId}`);

  const evidenceValidation: EvidenceValidationV2 = {
    ok: failures.length === 0,
    failures: [...failures].sort(),
  };
  const completed = evidenceValidation.ok;

  return {
    contract: 'stage3c-native-evidence.v2',
    runId: input.runId,
    commit: input.commit,
    environment: input.environment,
    certificationManifestHash: summary.manifestHash,
    executionLedgerHash: summary.ledgerHash,
    executionSummary: summary,
    startupResult: input.startupResult,
    authenticationResult: input.authenticationResult,
    screenResults,
    assertionResults,
    rendererSecurityResult: input.rendererSecurityResult,
    sessionLifecycleResult: input.sessionLifecycleResult,
    degradationResult: input.degradationResult,
    createOrderCounters: input.createOrderCounters,
    safeFlags: input.safeFlags,
    providerResult: input.providerResult,
    teardownResult: input.teardownResult,
    processLeakResult: input.processLeakResult,
    evidenceValidation,
    completed,
  };
}

/**
 * Independent structural validator — reads a bundle and returns
 * pass/fail with a list of failure tags. Used by the T-evidence
 * pre-cleanup check to confirm the derived shape is correct even
 * when several `incomplete` results are present (pre-cleanup
 * expects those; final evidence rejects them).
 */
export function validateEvidenceV2Structure(bundle: NativeEvidenceV2, mode: 'preliminary' | 'final'): EvidenceValidationV2 {
  const failures: string[] = [];
  if (bundle.contract !== 'stage3c-native-evidence.v2') failures.push('bad_contract');
  if (typeof bundle.certificationManifestHash !== 'string' || bundle.certificationManifestHash.length !== 64) failures.push('bad_manifest_hash');
  if (typeof bundle.executionLedgerHash !== 'string' || bundle.executionLedgerHash.length !== 64) failures.push('bad_ledger_hash');
  if (bundle.executionSummary?.contract !== 'stage3c-native-execution-summary.v1') failures.push('bad_summary_contract');
  if (Object.keys(bundle.screenResults).length === 0) failures.push('no_screen_results');
  if (mode === 'final') {
    // Final evidence forbids incomplete kinds anywhere.
    const forbidIncomplete: Array<[string, string]> = [
      ['startupResult', bundle.startupResult.kind],
      ['authenticationResult', bundle.authenticationResult.kind],
      ['rendererSecurityResult', bundle.rendererSecurityResult.kind],
      ['sessionLifecycleResult', bundle.sessionLifecycleResult.kind],
      ['degradationResult', bundle.degradationResult.kind],
      ['createOrderCounters', bundle.createOrderCounters.kind],
      ['safeFlags', bundle.safeFlags.kind],
      ['providerResult', bundle.providerResult.kind],
      ['teardownResult', bundle.teardownResult.kind],
      ['processLeakResult', bundle.processLeakResult.kind],
    ];
    for (const [name, kind] of forbidIncomplete) if (kind === 'incomplete') failures.push(`incomplete:${name}`);
    if (bundle.completed !== true) failures.push('not_completed');
  }
  return { ok: failures.length === 0, failures: [...failures].sort() };
}

// ---------------------------------------------------------------------------
// I/O — separate from derivation. Writes atomically.
// ---------------------------------------------------------------------------

export function writeEvidenceV2(runDir: string, bundle: NativeEvidenceV2, filename = 'native-evidence.v2.json'): string {
  const dest = join(runDir, filename);
  writeFileSync(dest, JSON.stringify(bundle, null, 2));
  return dest;
}

/** Build an `incomplete`-shaped input for every non-yet-collected field. */
export function makeIncompleteDeriveInput(base: Pick<DeriveEvidenceV2Input, 'runId' | 'commit' | 'environment' | 'executionSummary'>, detail = 'pending_afterall'): DeriveEvidenceV2Input {
  return {
    ...base,
    startupResult: { kind: 'incomplete', detail },
    authenticationResult: { kind: 'incomplete', detail },
    rendererSecurityResult: { kind: 'incomplete', detail },
    sessionLifecycleResult: { kind: 'incomplete', detail },
    degradationResult: { kind: 'incomplete', detail },
    createOrderCounters: { kind: 'incomplete', detail },
    safeFlags: { kind: 'incomplete', detail },
    providerResult: { kind: 'incomplete', detail },
    teardownResult: { kind: 'incomplete', detail },
    processLeakResult: { kind: 'incomplete', detail },
  };
}
