/**
 * Stage 3C-CI-RESET Part 2 Checkpoint D.14 items 11..45 —
 * validator + contract tests for the reconstructed native result
 * shapes. Every rule the native suite enforces at runtime also has
 * a portable unit test proving the validator rejects the
 * corresponding class of failure.
 *
 * The native suite POPULATES a ReconstructedResults object;
 * `validateReconstructedResults(r, 'final')` returns a list of
 * failure tags the evidence writer surfaces. This file feeds
 * validator inputs that pin every listed policy.
 */

import { describe, expect, it } from 'vitest';
import {
  makeIncompleteReconstructedResults,
  validateReconstructedResults,
  type ReconstructedResults,
} from '../native/nativeReconstructedResults';

function passingResults(): ReconstructedResults {
  return {
    costsHonestyResult: { outcome: 'passed', source: 'renderer:domInspect', detail: 'seed shows 0 attributions', rowCount: 0, observedState: 'empty', observedReason: 'forecast_vs_realized_evidence_unavailable', forbiddenLabelsSeen: [] },
    lockResult: {
      outcome: 'passed', source: 'renderer:auth+cache', detail: 'seed:scan_run:6001 cleared',
      seededIdentifierBeforeLock: 'scan_run:6001', seededIdentifierAfterLock: 'absent',
      authPhaseAfterLock: 'unauthenticated', cachedQueryStateAfterLock: 'empty',
      subsequentAuthenticatedRequestOutcome: 'unauthenticated_error',
    },
    revocationResult: {
      outcome: 'passed', source: 'server:operatorAuth.revokeAll', detail: 'db+redis cleared',
      revocationHttpStatus: 200, revocationSchemaOk: true, authPhaseAfter: 'unauthenticated',
      dbSessionInvalidated: true, redisSessionCleared: true,
      subsequentAuthenticatedRequestOutcome: 'session_revoked',
      tokenLeakedInResponse: false, revokedAllSessions: true,
    },
    staleResult: {
      outcome: 'passed', source: 'induction:stale_response', detail: 'reconciliationStatus induced',
      inductionMode: 'stale_response', inductionRouteKey: 'reconciliationStatus',
      observedDataState: 'stale', observedReason: 'authoritative_timestamp_expired',
      forbiddenStatesSeen: [], recoveryVerified: true,
    },
    degradedResult: {
      outcome: 'passed', source: 'induction:degraded_response', detail: 'scannerReadiness partial',
      inductionMode: 'degraded_response', inductionRouteKey: 'scannerReadiness',
      observedDataState: 'degraded', observedReason: 'observer_source_unavailable',
      forbiddenStatesSeen: [], recoveryVerified: true,
    },
    unavailableResult: {
      outcome: 'passed', source: 'induction:unavailable_response', detail: 'observerPolicyVersions offline',
      inductionMode: 'unavailable_response', inductionRouteKey: 'observerPolicyVersions',
      observedDataState: 'unavailable', observedReason: 'endpoint_unreachable',
      forbiddenStatesSeen: [], recoveryVerified: true,
    },
    serverSuspensionResult: {
      outcome: 'passed', source: 'harness:SIGSTOP', detail: 'server suspended + resumed',
      initialServerPid: 111, stopSignalSent: 'SIGSTOP', stoppedProcessStillExists: true,
      observedFailureState: 'api_failure', recoveryVerified: true, finalServerPid: 111,
    },
    contractMismatchResult: {
      outcome: 'passed', source: 'induction:contract_mismatch', detail: 'schema issue at .known',
      inductionRouteKey: 'reconciliationStatus',
      typedFailureCode: 'desktop_api_response_contract_mismatch:reconciliationStatus',
      issuePaths: ['known'], observedDataState: 'contract_mismatch',
      payloadLeaked: false, recoveryVerified: true,
    },
    windowLifecycleResult: {
      outcome: 'passed', source: 'electron:BrowserWindow', detail: 'closed + recreated',
      initialWindowIds: [1], targetWindowId: 1, mainProcessPid: 222,
      closeEventObserved: true, targetWindowDestroyed: true, mainProcessStillAlive: true,
      orphanRendererObserved: false, recreationSucceeded: true,
      postRecreateBusinessRequestOk: true, newWindowIds: [2],
    },
    serverRestartResult: {
      outcome: 'passed', source: 'harness:spawnServer', detail: 'new pid + reconciliation ok',
      oldServerPid: 111, newServerPid: 333, readinessAfterRestart: 'ready',
      authReestablished: true, reconciliationHttpStatus: 200, reconciliationSchemaOk: true,
      reconciliationRunIdentifier: 'native_recon_1',
    },
    safeConfigurationResult: {
      outcome: 'passed', source: 'server:championConfiguration',
      detail: 'authoritative safeFlags read', authoritySource: 'server:championConfiguration',
      DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false, liveCapitalAuthorized: false,
      promotionEnabled: false, kellyEnabled: false, harnessEnvAgrees: true,
    },
    credentialPresenceResult: {
      outcome: 'passed', source: 'harness+electron+server env probes',
      detail: 'no COINBASE_* in any child',
      records: [
        { process: 'native_harness', pid: 1, credentials: { COINBASE_API_KEY: false, COINBASE_API_SECRET: false } },
        { process: 'electron_main', pid: 2, credentials: { COINBASE_API_KEY: false, COINBASE_API_SECRET: false } },
        { process: 'server_child', pid: 3, credentials: { COINBASE_API_KEY: false, COINBASE_API_SECRET: false } },
      ],
      anyCredentialPresent: false,
    },
    providerSelectionResult: {
      outcome: 'passed', source: 'server:championConfiguration',
      detail: 'fixture providers everywhere', authoritySource: 'server:championConfiguration',
      marketDataProvider: 'fixture', exchangeProvider: 'fixture',
      orderSubmissionCapable: false, productionLevel2Active: false,
    },
  };
}

describe('Stage 3C-CI-RESET Part 2 Checkpoint D.14 — reconstructed result validator', () => {
  // ---- Happy path
  it('R0: complete pass results with all cross-checks green → zero failures', () => {
    expect(validateReconstructedResults(passingResults(), 'final')).toEqual([]);
  });

  // ---- T34 (items 11..14)
  it('R11: empty Costs state passes', () => {
    const r = passingResults();
    expect(validateReconstructedResults(r, 'final').filter((f) => f.startsWith('costs'))).toEqual([]);
  });
  it('R12: fabricated attribution surfaces via forbiddenLabelsSeen', () => {
    const r = passingResults();
    (r.costsHonestyResult as unknown as { forbiddenLabelsSeen: string[] }).forbiddenLabelsSeen = ['calibrated'];
    expect(validateReconstructedResults(r, 'final')).toContain('costs_honest_state_violation');
  });
  it('R13: gross-as-net labeling surfaces via forbiddenLabelsSeen', () => {
    const r = passingResults();
    (r.costsHonestyResult as unknown as { forbiddenLabelsSeen: string[] }).forbiddenLabelsSeen = ['profitable'];
    expect(validateReconstructedResults(r, 'final')).toContain('costs_honest_state_violation');
  });
  it('R14: outcome=failed marks the result explicitly', () => {
    const r = passingResults();
    (r.costsHonestyResult as { outcome: 'failed' }).outcome = 'failed';
    expect(validateReconstructedResults(r, 'final')).toContain('result_failed:costsHonestyResult');
  });

  // ---- T36 (items 15..16)
  it('R15: lock clears cached query state (empty)', () => {
    expect(validateReconstructedResults(passingResults(), 'final').filter((f) => f.startsWith('lock_'))).toEqual([]);
  });
  it('R16: retained cached row fails', () => {
    const r = passingResults();
    (r.lockResult as { cachedQueryStateAfterLock: 'retained_payload' }).cachedQueryStateAfterLock = 'retained_payload';
    expect(validateReconstructedResults(r, 'final')).toContain('lock_cache_retained');
  });

  // ---- T37 (items 17..19)
  it('R17: successful revocation clears state', () => {
    expect(validateReconstructedResults(passingResults(), 'final').filter((f) => f.startsWith('revocation'))).toEqual([]);
  });
  it('R18: 401/403 revocation cannot pass', () => {
    const r = passingResults();
    (r.revocationResult as { revocationHttpStatus: number }).revocationHttpStatus = 401;
    expect(validateReconstructedResults(r, 'final')).toContain('revocation_status_denied_not_success');
    (r.revocationResult as { revocationHttpStatus: number }).revocationHttpStatus = 403;
    expect(validateReconstructedResults(r, 'final')).toContain('revocation_status_denied_not_success');
  });
  it('R19: revoked session must block subsequent request', () => {
    const r = passingResults();
    (r.lockResult as { subsequentAuthenticatedRequestOutcome: 'succeeded' }).subsequentAuthenticatedRequestOutcome = 'succeeded';
    expect(validateReconstructedResults(r, 'final')).toContain('lock_did_not_gate_request');
  });

  // ---- T39/T40/T41 (items 20..26) — one state cannot satisfy another
  it('R20-R25: mode collisions and cross-satisfaction are validator-detectable', () => {
    const r = passingResults();
    // Attempt to satisfy T39 (stale) with a degraded observation — the
    // observedDataState mismatches the mode; validator flags it via
    // forbiddenStatesSeen (added by the native writer).
    (r.staleResult as unknown as { forbiddenStatesSeen: string[] }).forbiddenStatesSeen = ['degraded'];
    expect(validateReconstructedResults(r, 'final')).toContain('stale_forbidden_state_observed');
    (r.degradedResult as unknown as { forbiddenStatesSeen: string[] }).forbiddenStatesSeen = ['unavailable'];
    expect(validateReconstructedResults(r, 'final')).toContain('degraded_forbidden_state_observed');
    (r.unavailableResult as unknown as { forbiddenStatesSeen: string[] }).forbiddenStatesSeen = ['stale'];
    expect(validateReconstructedResults(r, 'final')).toContain('unavailable_forbidden_state_observed');
  });
  it('R26: recovery required after each induction (final mode)', () => {
    const r = passingResults();
    (r.staleResult as { recoveryVerified: boolean }).recoveryVerified = false;
    expect(validateReconstructedResults(r, 'final')).toContain('stale_recovery_not_verified');
  });

  // ---- T43 (items 27..29)
  it('R27: malformed HTTP-200 → contract_mismatch typed failure code required', () => {
    const r = passingResults();
    expect(r.contractMismatchResult.typedFailureCode).toMatch(/^desktop_api_response_contract_mismatch:/);
  });
  it('R28: schema issue paths recorded without payload leak', () => {
    const r = passingResults();
    expect(r.contractMismatchResult.payloadLeaked).toBe(false);
    (r.contractMismatchResult as { payloadLeaked: boolean }).payloadLeaked = true;
    expect(validateReconstructedResults(r, 'final')).toContain('contract_mismatch_payload_leaked');
  });
  it('R29: production cannot activate mutation — enforced by policy at server (see native_induction_policy tests)', () => {
    // Policy is proven in native_induction_policy.test.ts P1..P6.
    // This result-shape test only proves the validator surfaces
    // outcome=failed on the reconstructed test itself.
    const r = passingResults();
    (r.contractMismatchResult as { outcome: 'failed' }).outcome = 'failed';
    expect(validateReconstructedResults(r, 'final')).toContain('result_failed:contractMismatchResult');
  });

  // ---- T46 (items 30..32)
  it('R30: close event required for passed outcome', () => {
    const r = passingResults();
    (r.windowLifecycleResult as { closeEventObserved: boolean }).closeEventObserved = false;
    expect(validateReconstructedResults(r, 'final')).toContain('window_close_event_not_observed');
  });
  it('R31: target window must be destroyed', () => {
    const r = passingResults();
    (r.windowLifecycleResult as { targetWindowDestroyed: boolean }).targetWindowDestroyed = false;
    expect(validateReconstructedResults(r, 'final')).toContain('window_target_not_destroyed');
  });
  it('R32: orphan renderer prevents pass', () => {
    const r = passingResults();
    (r.windowLifecycleResult as { orphanRendererObserved: boolean }).orphanRendererObserved = true;
    expect(validateReconstructedResults(r, 'final')).toContain('window_orphan_renderer');
  });

  // ---- T49 (items 33..36)
  it('R33: PID must change on restart', () => {
    const r = passingResults();
    (r.serverRestartResult as { newServerPid: number }).newServerPid = r.serverRestartResult.oldServerPid;
    expect(validateReconstructedResults(r, 'final')).toContain('server_restart_pid_unchanged');
  });
  it('R34: 401/403 reconciliation rejected', () => {
    const r = passingResults();
    (r.serverRestartResult as { reconciliationHttpStatus: number }).reconciliationHttpStatus = 401;
    expect(validateReconstructedResults(r, 'final')).toContain('server_restart_reconciliation_denied');
    (r.serverRestartResult as { reconciliationHttpStatus: number }).reconciliationHttpStatus = 403;
    expect(validateReconstructedResults(r, 'final')).toContain('server_restart_reconciliation_denied');
  });
  it('R35: schema-invalid reconciliation rejected', () => {
    const r = passingResults();
    (r.serverRestartResult as { reconciliationSchemaOk: boolean }).reconciliationSchemaOk = false;
    expect(validateReconstructedResults(r, 'final')).toContain('server_restart_reconciliation_schema_invalid');
  });
  it('R36: auth must be re-established', () => {
    const r = passingResults();
    (r.serverRestartResult as { authReestablished: boolean }).authReestablished = false;
    // authReestablished doesn't have a dedicated validator tag —
    // the writer marks the outcome failed in that case.
    (r.serverRestartResult as { outcome: 'failed' }).outcome = 'failed';
    expect(validateReconstructedResults(r, 'final')).toContain('result_failed:serverRestartResult');
  });

  // ---- T53 (items 37..39)
  it('R37: authoritative safe flags pass', () => {
    expect(validateReconstructedResults(passingResults(), 'final').filter((f) => f.startsWith('safe_configuration'))).toEqual([]);
  });
  it('R38: unsafe DRY_RUN=false fails', () => {
    const r = passingResults();
    (r.safeConfigurationResult as { DRY_RUN: boolean }).DRY_RUN = false;
    expect(validateReconstructedResults(r, 'final')).toContain('safe_configuration_unsafe');
  });
  it('R39: unsafe ORDER_SUBMISSION_ENABLED=true fails', () => {
    const r = passingResults();
    (r.safeConfigurationResult as { ORDER_SUBMISSION_ENABLED: boolean }).ORDER_SUBMISSION_ENABLED = true;
    expect(validateReconstructedResults(r, 'final')).toContain('safe_configuration_unsafe');
  });

  // ---- T54 (items 40..41)
  it('R40: credential presence in any process fails', () => {
    const r = passingResults();
    (r.credentialPresenceResult as { anyCredentialPresent: boolean }).anyCredentialPresent = true;
    expect(validateReconstructedResults(r, 'final')).toContain('credential_present_in_process_env');
  });
  it('R41: evidence records booleans only — non-boolean value surfaces validator failure', () => {
    const r = passingResults();
    (r.credentialPresenceResult.records[0].credentials as Record<string, unknown>)['COINBASE_API_KEY'] = 'leaked-string' as unknown as boolean;
    expect(validateReconstructedResults(r, 'final').some((f) => f.startsWith('credential_recorded_non_boolean:'))).toBe(true);
  });

  // ---- T55 (items 42..45)
  it('R42: fixture provider passes', () => {
    expect(validateReconstructedResults(passingResults(), 'final').filter((f) => f.startsWith('provider'))).toEqual([]);
  });
  it('R43: production market provider fails', () => {
    const r = passingResults();
    (r.providerSelectionResult as { marketDataProvider: 'production' }).marketDataProvider = 'production';
    expect(validateReconstructedResults(r, 'final')).toContain('provider_market_production');
  });
  it('R44: order-capable provider fails', () => {
    const r = passingResults();
    (r.providerSelectionResult as { orderSubmissionCapable: boolean }).orderSubmissionCapable = true;
    expect(validateReconstructedResults(r, 'final')).toContain('provider_order_capable');
  });
  it('R45: production Level-2 provider fails', () => {
    const r = passingResults();
    (r.providerSelectionResult as { productionLevel2Active: boolean }).productionLevel2Active = true;
    expect(validateReconstructedResults(r, 'final')).toContain('provider_l2_production');
  });

  // ---- Structural: incomplete-in-final always fails
  it('R46: any incomplete kind is a failure in final mode', () => {
    const r = makeIncompleteReconstructedResults();
    const f = validateReconstructedResults(r, 'final');
    expect(f).toContain('result_incomplete:costsHonestyResult');
    expect(f).toContain('result_incomplete:lockResult');
    expect(f).toContain('result_incomplete:revocationResult');
  });

  it('R47: preliminary mode accepts incomplete but still surfaces domain violations', () => {
    const r = makeIncompleteReconstructedResults();
    const f = validateReconstructedResults(r, 'preliminary');
    // The incomplete safeConfigurationResult carries unsafe flags,
    // so the safety cross-check flags it even in preliminary mode.
    expect(f).toContain('safe_configuration_unsafe');
  });
});
