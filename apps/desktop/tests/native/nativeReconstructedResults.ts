/**
 * Stage 3C-CI-RESET Part 2 Checkpoint D.13 — typed result contracts
 * for the reconstructed native tests (T34, T36, T37, T39-41, T42,
 * T43, T46, T49, T53, T54, T55).
 *
 * Every reconstructed test produces one of these result values,
 * which is then embedded into the v2 evidence bundle under the
 * corresponding key (`costsHonestyResult`, `lockResult`, etc). No
 * boolean is passed without a source/detail — the discriminated
 * union forces the writer to specify WHERE the observation came
 * from.
 *
 * Pure module — no side effects. Consumed by the native suite
 * (writer) AND by portable unit tests (validator).
 */

// ---------------------------------------------------------------------------
// Common shape: every result kind is one of pass|fail|incomplete plus
// a specific detail record. `incomplete` is the ONLY shape that omits
// authoritative evidence; `pass` and `fail` MUST both cite a source.
// ---------------------------------------------------------------------------

export type ResultOutcome = 'passed' | 'failed' | 'incomplete';

interface ResultBase {
  readonly outcome: ResultOutcome;
  readonly source: string;      // e.g. 'renderer:domInspect' | 'server:reconciliationStatus'
  readonly detail: string;      // sanitized, ≤240 chars
}

// ---------------------------------------------------------------------------
// T34 — Costs honest empty state
// ---------------------------------------------------------------------------

export interface CostsHonestyResult extends ResultBase {
  readonly rowCount: number;
  readonly observedState: string; // data-state value
  readonly observedReason: string | null;
  readonly forbiddenLabelsSeen: readonly string[];
}

// ---------------------------------------------------------------------------
// T36 — Real lock + cache clear
// ---------------------------------------------------------------------------

export interface LockResult extends ResultBase {
  readonly seededIdentifierBeforeLock: string; // e.g. 'scan_run:6001'
  readonly seededIdentifierAfterLock: 'absent' | 'still_present';
  readonly authPhaseAfterLock: string;
  readonly cachedQueryStateAfterLock: 'empty' | 'retained_payload';
  readonly subsequentAuthenticatedRequestOutcome: 'unauthenticated_error' | 'succeeded';
}

// ---------------------------------------------------------------------------
// T37 — Real session revocation
// ---------------------------------------------------------------------------

export interface RevocationResult extends ResultBase {
  readonly revocationHttpStatus: number;
  readonly revocationSchemaOk: boolean;
  readonly authPhaseAfter: string;
  readonly dbSessionInvalidated: boolean;
  readonly redisSessionCleared: boolean | 'not_applicable';
  readonly subsequentAuthenticatedRequestOutcome: 'session_revoked' | 'succeeded_unexpected';
  readonly tokenLeakedInResponse: boolean;
  /** True if the underlying operation is `revokeAll` — title MUST reflect. */
  readonly revokedAllSessions: boolean;
}

// ---------------------------------------------------------------------------
// T39 / T40 / T41 — Induced state observation
// ---------------------------------------------------------------------------

export interface InducedStateResult extends ResultBase {
  readonly inductionMode: 'stale_response' | 'degraded_response' | 'unavailable_response';
  readonly inductionRouteKey: string;
  readonly observedDataState: string;
  readonly observedReason: string | null;
  readonly forbiddenStatesSeen: readonly string[];
  readonly recoveryVerified: boolean;
}

// ---------------------------------------------------------------------------
// T42 — Server suspension
// ---------------------------------------------------------------------------

export interface ServerSuspensionResult extends ResultBase {
  readonly initialServerPid: number;
  readonly stopSignalSent: 'SIGSTOP' | 'skipped_non_linux';
  readonly stoppedProcessStillExists: boolean;
  readonly observedFailureState: string;
  readonly recoveryVerified: boolean;
  readonly finalServerPid: number;
}

// ---------------------------------------------------------------------------
// T43 — Contract mismatch
// ---------------------------------------------------------------------------

export interface ContractMismatchResult extends ResultBase {
  readonly inductionRouteKey: string;
  readonly typedFailureCode: string; // desktop_api_response_contract_mismatch:<route>
  readonly issuePaths: readonly string[];
  readonly observedDataState: string;
  readonly payloadLeaked: boolean;
  readonly recoveryVerified: boolean;
}

// ---------------------------------------------------------------------------
// T46 — Window close + recreation
// ---------------------------------------------------------------------------

export interface WindowLifecycleResult extends ResultBase {
  readonly initialWindowIds: readonly number[];
  readonly targetWindowId: number;
  readonly mainProcessPid: number;
  readonly closeEventObserved: boolean;
  readonly targetWindowDestroyed: boolean;
  readonly mainProcessStillAlive: boolean;
  readonly orphanRendererObserved: boolean;
  readonly recreationSucceeded: boolean;
  readonly postRecreateBusinessRequestOk: boolean;
  readonly newWindowIds: readonly number[];
}

// ---------------------------------------------------------------------------
// T49 — Server restart + reconciliation
// ---------------------------------------------------------------------------

export interface ServerRestartResult extends ResultBase {
  readonly oldServerPid: number;
  readonly newServerPid: number;
  readonly readinessAfterRestart: 'ready' | 'contract_mismatch' | 'timeout';
  readonly authReestablished: boolean;
  readonly reconciliationHttpStatus: number;
  readonly reconciliationSchemaOk: boolean;
  readonly reconciliationRunIdentifier: string | null;
}

// ---------------------------------------------------------------------------
// T53 — Authoritative safe configuration
// ---------------------------------------------------------------------------

export interface SafeConfigurationResult extends ResultBase {
  readonly authoritySource: 'server:championConfiguration' | 'server:systemReadiness' | 'incomplete';
  readonly DRY_RUN: boolean;
  readonly ORDER_SUBMISSION_ENABLED: boolean;
  readonly liveCapitalAuthorized: boolean;
  readonly promotionEnabled: boolean;
  readonly kellyEnabled: boolean;
  readonly harnessEnvAgrees: boolean;
}

// ---------------------------------------------------------------------------
// T54 — Credential presence (three-process fan-out)
// ---------------------------------------------------------------------------

export interface CredentialPresenceRecord {
  readonly process: 'native_harness' | 'electron_main' | 'server_child';
  readonly pid: number;
  /** Booleans ONLY — env values are never recorded. */
  readonly credentials: Readonly<Record<string, boolean>>;
}

export interface CredentialPresenceResult extends ResultBase {
  readonly records: readonly CredentialPresenceRecord[];
  readonly anyCredentialPresent: boolean;
}

// ---------------------------------------------------------------------------
// T55 — Authoritative provider selection
// ---------------------------------------------------------------------------

export interface ProviderSelectionResult extends ResultBase {
  readonly authoritySource: 'server:championConfiguration' | 'server:providerStatus' | 'incomplete';
  readonly marketDataProvider: 'fixture' | 'test' | 'inactive' | 'production';
  readonly exchangeProvider: 'disabled' | 'fixture' | 'inactive' | 'production';
  readonly orderSubmissionCapable: boolean;
  readonly productionLevel2Active: boolean;
}

// ---------------------------------------------------------------------------
// Registry — used by evidence writer + validator
// ---------------------------------------------------------------------------

export interface ReconstructedResults {
  readonly costsHonestyResult: CostsHonestyResult;
  readonly lockResult: LockResult;
  readonly revocationResult: RevocationResult;
  readonly staleResult: InducedStateResult;
  readonly degradedResult: InducedStateResult;
  readonly unavailableResult: InducedStateResult;
  readonly serverSuspensionResult: ServerSuspensionResult;
  readonly contractMismatchResult: ContractMismatchResult;
  readonly windowLifecycleResult: WindowLifecycleResult;
  readonly serverRestartResult: ServerRestartResult;
  readonly safeConfigurationResult: SafeConfigurationResult;
  readonly credentialPresenceResult: CredentialPresenceResult;
  readonly providerSelectionResult: ProviderSelectionResult;
}

/**
 * Every result MUST be a specific outcome. `incomplete` in the
 * final validator is a failure. Returns the list of failing keys.
 */
export function validateReconstructedResults(r: ReconstructedResults, mode: 'preliminary' | 'final'): readonly string[] {
  const failures: string[] = [];
  const forbidIncomplete = mode === 'final';
  const check = (name: string, o: ResultOutcome): void => {
    if (o === 'failed') failures.push(`result_failed:${name}`);
    if (forbidIncomplete && o === 'incomplete') failures.push(`result_incomplete:${name}`);
  };
  check('costsHonestyResult', r.costsHonestyResult.outcome);
  check('lockResult', r.lockResult.outcome);
  check('revocationResult', r.revocationResult.outcome);
  check('staleResult', r.staleResult.outcome);
  check('degradedResult', r.degradedResult.outcome);
  check('unavailableResult', r.unavailableResult.outcome);
  check('serverSuspensionResult', r.serverSuspensionResult.outcome);
  check('contractMismatchResult', r.contractMismatchResult.outcome);
  check('windowLifecycleResult', r.windowLifecycleResult.outcome);
  check('serverRestartResult', r.serverRestartResult.outcome);
  check('safeConfigurationResult', r.safeConfigurationResult.outcome);
  check('credentialPresenceResult', r.credentialPresenceResult.outcome);
  check('providerSelectionResult', r.providerSelectionResult.outcome);

  // Domain-specific cross-checks — surface authoritative failures
  // even when a caller marks the outcome 'passed' by accident.
  if (r.costsHonestyResult.forbiddenLabelsSeen.length > 0) failures.push('costs_honest_state_violation');
  if (r.lockResult.cachedQueryStateAfterLock === 'retained_payload') failures.push('lock_cache_retained');
  if (r.lockResult.subsequentAuthenticatedRequestOutcome === 'succeeded') failures.push('lock_did_not_gate_request');
  if (r.revocationResult.tokenLeakedInResponse) failures.push('revocation_token_leaked');
  if (r.revocationResult.revocationHttpStatus === 401 || r.revocationResult.revocationHttpStatus === 403) failures.push('revocation_status_denied_not_success');
  for (const [name, res] of [['stale', r.staleResult], ['degraded', r.degradedResult], ['unavailable', r.unavailableResult]] as const) {
    if (res.forbiddenStatesSeen.length > 0) failures.push(`${name}_forbidden_state_observed`);
    if (!res.recoveryVerified && mode === 'final') failures.push(`${name}_recovery_not_verified`);
  }
  if (r.serverSuspensionResult.stopSignalSent !== 'skipped_non_linux' && !r.serverSuspensionResult.recoveryVerified && mode === 'final') failures.push('suspension_recovery_not_verified');
  if (r.contractMismatchResult.payloadLeaked) failures.push('contract_mismatch_payload_leaked');
  if (r.windowLifecycleResult.orphanRendererObserved) failures.push('window_orphan_renderer');
  if (r.windowLifecycleResult.closeEventObserved !== true && r.windowLifecycleResult.outcome === 'passed') failures.push('window_close_event_not_observed');
  if (r.windowLifecycleResult.targetWindowDestroyed !== true && r.windowLifecycleResult.outcome === 'passed') failures.push('window_target_not_destroyed');
  if (r.serverRestartResult.oldServerPid === r.serverRestartResult.newServerPid && r.serverRestartResult.outcome === 'passed') failures.push('server_restart_pid_unchanged');
  if (r.serverRestartResult.reconciliationHttpStatus === 401 || r.serverRestartResult.reconciliationHttpStatus === 403) failures.push('server_restart_reconciliation_denied');
  if (!r.serverRestartResult.reconciliationSchemaOk && r.serverRestartResult.outcome === 'passed') failures.push('server_restart_reconciliation_schema_invalid');
  const flagsUnsafe =
    r.safeConfigurationResult.DRY_RUN !== true
    || r.safeConfigurationResult.ORDER_SUBMISSION_ENABLED !== false
    || r.safeConfigurationResult.liveCapitalAuthorized !== false
    || r.safeConfigurationResult.promotionEnabled !== false
    || r.safeConfigurationResult.kellyEnabled !== false;
  if (flagsUnsafe) failures.push('safe_configuration_unsafe');
  if (r.credentialPresenceResult.anyCredentialPresent) failures.push('credential_present_in_process_env');
  // Any recorded credential-presence entry MUST be booleans only —
  // policy is enforced by the writer, but we defensively confirm
  // there are no string values leaking through.
  for (const rec of r.credentialPresenceResult.records) {
    for (const [k, v] of Object.entries(rec.credentials)) {
      if (typeof v !== 'boolean') failures.push(`credential_recorded_non_boolean:${rec.process}:${k}`);
    }
  }
  if (r.providerSelectionResult.marketDataProvider === 'production') failures.push('provider_market_production');
  if (r.providerSelectionResult.exchangeProvider === 'production') failures.push('provider_exchange_production');
  if (r.providerSelectionResult.orderSubmissionCapable) failures.push('provider_order_capable');
  if (r.providerSelectionResult.productionLevel2Active) failures.push('provider_l2_production');
  return failures;
}

/** Convenience: build an incomplete-shaped result set for pre-run initialization. */
export function makeIncompleteReconstructedResults(): ReconstructedResults {
  const inc = (source: string): ResultBase => ({ outcome: 'incomplete', source, detail: 'not_yet_observed' });
  return {
    costsHonestyResult: { ...inc('T34'), rowCount: -1, observedState: '', observedReason: null, forbiddenLabelsSeen: [] },
    lockResult: {
      ...inc('T36'), seededIdentifierBeforeLock: '', seededIdentifierAfterLock: 'still_present',
      authPhaseAfterLock: '', cachedQueryStateAfterLock: 'retained_payload',
      subsequentAuthenticatedRequestOutcome: 'succeeded',
    },
    revocationResult: {
      ...inc('T37'), revocationHttpStatus: 0, revocationSchemaOk: false, authPhaseAfter: '',
      dbSessionInvalidated: false, redisSessionCleared: 'not_applicable',
      subsequentAuthenticatedRequestOutcome: 'succeeded_unexpected', tokenLeakedInResponse: false,
      revokedAllSessions: false,
    },
    staleResult: {
      ...inc('T39'), inductionMode: 'stale_response', inductionRouteKey: '', observedDataState: '',
      observedReason: null, forbiddenStatesSeen: [], recoveryVerified: false,
    },
    degradedResult: {
      ...inc('T40'), inductionMode: 'degraded_response', inductionRouteKey: '', observedDataState: '',
      observedReason: null, forbiddenStatesSeen: [], recoveryVerified: false,
    },
    unavailableResult: {
      ...inc('T41'), inductionMode: 'unavailable_response', inductionRouteKey: '', observedDataState: '',
      observedReason: null, forbiddenStatesSeen: [], recoveryVerified: false,
    },
    serverSuspensionResult: {
      ...inc('T42'), initialServerPid: -1, stopSignalSent: 'skipped_non_linux',
      stoppedProcessStillExists: false, observedFailureState: '', recoveryVerified: false, finalServerPid: -1,
    },
    contractMismatchResult: {
      ...inc('T43'), inductionRouteKey: '', typedFailureCode: '', issuePaths: [],
      observedDataState: '', payloadLeaked: false, recoveryVerified: false,
    },
    windowLifecycleResult: {
      ...inc('T46'), initialWindowIds: [], targetWindowId: -1, mainProcessPid: -1,
      closeEventObserved: false, targetWindowDestroyed: false, mainProcessStillAlive: false,
      orphanRendererObserved: false, recreationSucceeded: false, postRecreateBusinessRequestOk: false,
      newWindowIds: [],
    },
    serverRestartResult: {
      ...inc('T49'), oldServerPid: -1, newServerPid: -1, readinessAfterRestart: 'timeout',
      authReestablished: false, reconciliationHttpStatus: 0, reconciliationSchemaOk: false,
      reconciliationRunIdentifier: null,
    },
    safeConfigurationResult: {
      ...inc('T53'), authoritySource: 'incomplete', DRY_RUN: false, ORDER_SUBMISSION_ENABLED: true,
      liveCapitalAuthorized: true, promotionEnabled: true, kellyEnabled: true, harnessEnvAgrees: false,
    },
    credentialPresenceResult: {
      ...inc('T54'), records: [], anyCredentialPresent: false,
    },
    providerSelectionResult: {
      ...inc('T55'), authoritySource: 'incomplete', marketDataProvider: 'production',
      exchangeProvider: 'production', orderSubmissionCapable: true, productionLevel2Active: true,
    },
  };
}
