/**
 * Stage 5 §operational-validation-preflight — end-to-end preflight
 * for the OperationalValidationHarness + validateSoakManifest
 * contracts.
 *
 * Distinct from `preflight.ts` (Phase 1.2-OPS Coinbase preflight):
 * this module proves the SOAK CONTRACT is ready before day 1 of the
 * seven-day operational soak begins. It never touches Coinbase, an
 * economic writer, a real credential, or a real provider.
 *
 * The preflight proves — before the seven-day soak begins — that:
 *
 *  1. The harness observes every one of the 30 event kinds without
 *     rejection.
 *  2. Deterministic content-addressed eventIds hold across
 *     process boundaries (two harness instances given the same
 *     inputs produce byte-identical ids).
 *  3. The sanitizer strips every credential-shaped substring
 *     before it reaches the incident record.
 *  4. `buildDailyResult` produces a `SoakDailyResult` whose safety
 *     flags + counters satisfy the z.literal locking in
 *     `SoakSafetyFlagsSchema` + `SoakCreateOrderCountersSchema` —
 *     a drifted flag or nonzero counter is rejected at the schema
 *     level, not at business logic.
 *  5. `validateSoakManifest` accepts an in-progress manifest built
 *     from one preflight day.
 *  6. Each of the HARD_FAIL event kinds (`secret_scan_failure`,
 *     `path_rejected`, `process_leak`, `container_leak`)
 *     invalidates the day when observed.
 *  7. The preflight emits a machine-readable evidence file (the
 *     `PreflightResult` object) with the tool + version + commit +
 *     observed counts + schema-parse roundtrip proof + verdict.
 *
 * Nothing here calls an economic writer, submits an order, activates
 * a real provider, or loads a credential.
 */

import { createHash } from 'node:crypto';
import {
  DEFAULT_SOAK_DAY_COUNT,
  MANDATORY_SOAK_INVALIDATORS,
  SoakCreateOrderCountersSchema,
  SoakDailyResultSchema,
  SoakManifestSchema,
  SoakSafetyFlagsSchema,
  validateSoakManifest,
  type SoakCredentialState,
  type SoakDailyResult,
  type SoakManifest,
  type SoakProviderState,
} from '@horizon/shared';
import {
  HARD_FAIL_EVENT_KINDS,
  OPERATIONAL_EVENT_KINDS,
  OperationalValidationHarness,
  sanitizeDetail,
  type OperationalEvent,
  type OperationalEventKind,
} from './operationalValidation';

export type PreflightVerdict =
  | 'preflight_passed'
  | 'preflight_failed_event_enumeration'
  | 'preflight_failed_determinism'
  | 'preflight_failed_sanitization'
  | 'preflight_failed_schema_parse'
  | 'preflight_failed_manifest_validation'
  | 'preflight_failed_hard_fail_propagation';

export interface PreflightCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface OperationalPreflightResult {
  readonly tool: 'operational-validation-preflight';
  readonly version: '1.0';
  readonly generatedAt: string;
  readonly commitSha: string;
  readonly installationIdHash: string;
  readonly soakId: string;
  readonly verdict: PreflightVerdict;
  readonly detail: string;
  readonly checks: readonly PreflightCheck[];
  readonly counts: {
    readonly eventKindsRecognized: number;
    readonly mandatoryInvalidators: number;
    readonly hardFailKinds: number;
    readonly observedEvents: number;
  };
  readonly dailyResultPassed: SoakDailyResult | null;
  readonly manifestValidationOk: boolean;
}

export interface OperationalPreflightInput {
  readonly commitSha: string;
  readonly installationIdHash: string;
  readonly nowIso: string;
  readonly evidenceRunId: string;
}

const SAFE_FLAGS = Object.freeze({
  DRY_RUN: true as const,
  ORDER_SUBMISSION_ENABLED: false as const,
  liveCapitalAuthorized: false as const,
  promotionEnabled: false as const,
  kellyEnabled: false as const,
});
const ZERO_COUNTERS = Object.freeze({
  functionInvocations: 0 as const,
  attemptCount: 0 as const,
  networkCount: 0 as const,
});
const FIXTURE_PROVIDERS: SoakProviderState = Object.freeze({
  marketDataProvider: 'fixture',
  exchangeProvider: 'fixture',
  productionLevel2Active: false,
  orderCapableProviderActive: false,
});
const NO_CREDENTIALS: SoakCredentialState = Object.freeze({
  coinbaseCredentialsLoaded: false,
  anthropicCredentialsLoaded: false,
  productionCredentialsDetected: false,
});

/** Deterministic clock — advances 1000ms per observe(). */
function makeDeterministicClock(startIso: string): () => Date {
  let t = new Date(startIso).getTime();
  return (): Date => {
    const d = new Date(t);
    t += 1_000;
    return d;
  };
}

/**
 * Exercise every event kind in a healthy pattern: lifecycle,
 * observations, report bursts, some transient degradation.
 * Zero HARD_FAIL events so the day validates as `passed`.
 */
function runHealthyDay(input: OperationalPreflightInput, startIso: string): OperationalValidationHarness {
  const h = new OperationalValidationHarness({
    soakId: `preflight-${input.evidenceRunId}`,
    commitSha: input.commitSha,
    installationIdHash: input.installationIdHash,
    clock: makeDeterministicClock(startIso),
  });
  h.observe('runtime_start', 'preflight lifecycle');
  h.observe('runtime_ready', 'services up');
  h.observe('readiness_transition', 'degraded->healthy');
  h.observe('safety_observation', 'DRY_RUN=true confirmed');
  h.observe('provider_observation', 'market=fixture exchange=fixture');
  h.observe('credential_observation', 'no credentials loaded');
  h.observe('create_order_counter_observation', 'counters 0/0/0');
  for (let i = 0; i < 4; i++) {
    h.observe('report_job_queued', `safety_status queued #${i}`);
    h.observe('report_job_running', `safety_status running #${i}`);
    h.observe('report_job_completed', `safety_status completed #${i}`);
    h.observe('artifact_verification_passed', `safety_status verify #${i}`);
    h.observe('redaction_performed', `safety_status redact #${i}`);
  }
  h.observe('idempotency_hit', 'duplicate enqueue collapsed');
  h.observe('duplicate_prevented', 'ER_DUP_ENTRY caught');
  h.observe('report_job_failed', 'generator failure sanitized');
  h.observe('artifact_verification_failed', 'checksum_mismatch noted');
  h.observe('redaction_failure', 'unknown-key value scrubbed');
  h.observe('server_restart', 'planned restart');
  h.observe('container_restart', 'planned restart');
  h.observe('mariadb_disconnect', 'transient');
  h.observe('mariadb_reconnect', 'recovered');
  h.observe('redis_disconnect', 'transient');
  h.observe('redis_reconnect', 'recovered');
  h.observe('temporary_file_cleanup_failure', 'best-effort scheduled');
  h.observe('orphan_reconciliation', 'artifact reconciled');
  h.observe('runtime_stop', 'shutdown clean');
  return h;
}

/**
 * Exercise every HARD_FAIL kind in a separate fresh harness.
 * Each MUST propagate to invalidatesSoak on the event AND to
 * dayVerdict='invalidated' on the derived daily result.
 */
function checkHardFailPropagation(input: OperationalPreflightInput): PreflightCheck {
  const failures: string[] = [];
  for (const kind of HARD_FAIL_EVENT_KINDS) {
    const h = new OperationalValidationHarness({
      soakId: `preflight-hf-${kind}`,
      commitSha: input.commitSha,
      installationIdHash: input.installationIdHash,
      clock: makeDeterministicClock('2026-07-29T00:00:00Z'),
    });
    h.observe('runtime_start', 'lifecycle');
    const evt = h.observe(kind, `planted ${kind}`);
    if (evt.invalidatesSoak !== true) failures.push(`${kind}: event.invalidatesSoak=${String(evt.invalidatesSoak)}`);
    if (evt.severity !== 'critical') failures.push(`${kind}: severity=${evt.severity}`);
    const dayResult = h.buildDailyResult({
      dateUtc: '2026-07-29',
      safetyFlags: SAFE_FLAGS,
      createOrderCounters: ZERO_COUNTERS,
      providerState: FIXTURE_PROVIDERS,
      credentialState: NO_CREDENTIALS,
    });
    if (dayResult.dayVerdict !== 'invalidated') {
      failures.push(`${kind}: dayVerdict=${dayResult.dayVerdict}`);
    }
  }
  return {
    id: 'hard_fail_propagation',
    ok: failures.length === 0,
    detail: failures.length === 0
      ? `all ${HARD_FAIL_EVENT_KINDS.size} HARD_FAIL kinds propagated to invalidated`
      : failures.join('; '),
  };
}

function checkEventEnumeration(): PreflightCheck {
  const uniqueCount = new Set(OPERATIONAL_EVENT_KINDS).size;
  if (uniqueCount !== 30) {
    return { id: 'event_enumeration', ok: false, detail: `expected 30 unique kinds, saw ${uniqueCount}` };
  }
  return { id: 'event_enumeration', ok: true, detail: '30 unique event kinds recognized' };
}

function checkMandatoryInvalidators(): PreflightCheck {
  if (MANDATORY_SOAK_INVALIDATORS.size !== 13) {
    return { id: 'mandatory_invalidators', ok: false, detail: `expected 13, saw ${MANDATORY_SOAK_INVALIDATORS.size}` };
  }
  return { id: 'mandatory_invalidators', ok: true, detail: '13 mandatory invalidators locked' };
}

function checkDeterminism(input: OperationalPreflightInput): PreflightCheck {
  const h1 = new OperationalValidationHarness({
    soakId: 'preflight-det',
    commitSha: input.commitSha,
    installationIdHash: input.installationIdHash,
    clock: makeDeterministicClock('2026-07-29T00:00:00Z'),
  });
  const h2 = new OperationalValidationHarness({
    soakId: 'preflight-det',
    commitSha: input.commitSha,
    installationIdHash: input.installationIdHash,
    clock: makeDeterministicClock('2026-07-29T00:00:00Z'),
  });
  for (const kind of ['runtime_start', 'safety_observation', 'report_job_queued'] as OperationalEventKind[]) {
    h1.observe(kind, 'det');
    h2.observe(kind, 'det');
  }
  const ids1 = h1.events().map((e) => e.eventId);
  const ids2 = h2.events().map((e) => e.eventId);
  if (JSON.stringify(ids1) !== JSON.stringify(ids2)) {
    return { id: 'determinism', ok: false, detail: `id sequences diverged` };
  }
  return { id: 'determinism', ok: true, detail: `${ids1.length} events reproduced byte-identically across harness instances` };
}

function checkSanitization(): PreflightCheck {
  const cases: Array<{ input: string; mustContain: string; mustNotContain: string }> = [
    { input: 'Authorization: Bearer abcd1234567890xyz', mustContain: '<REDACTED>', mustNotContain: 'abcd1234567890xyz' },
    { input: 'password=hunter2 host=x', mustContain: 'password=<REDACTED>', mustNotContain: 'hunter2' },
    { input: 'token=abc12345 status=200', mustContain: 'token=<REDACTED>', mustNotContain: 'abc12345' },
    { input: 'Bearer ThisIsA20CharToken1234', mustContain: 'Bearer <REDACTED>', mustNotContain: 'ThisIsA20CharToken1234' },
  ];
  for (const c of cases) {
    const out = sanitizeDetail(c.input);
    if (!out.includes(c.mustContain) || out.includes(c.mustNotContain)) {
      return { id: 'sanitization', ok: false, detail: `input=${c.input.slice(0, 40)}` };
    }
  }
  return { id: 'sanitization', ok: true, detail: `${cases.length} secret-shape substrings scrubbed` };
}

function checkSchemaParse(): PreflightCheck {
  const flagsDrift = SoakSafetyFlagsSchema.safeParse({ ...SAFE_FLAGS, DRY_RUN: false });
  if (flagsDrift.success) return { id: 'schema_parse', ok: false, detail: 'SafetyFlagsSchema accepted DRY_RUN=false' };
  const countersDrift = SoakCreateOrderCountersSchema.safeParse({ functionInvocations: 1, attemptCount: 0, networkCount: 0 });
  if (countersDrift.success) return { id: 'schema_parse', ok: false, detail: 'CreateOrderCountersSchema accepted functionInvocations=1' };
  return { id: 'schema_parse', ok: true, detail: 'z.literal drift rejected at schema level' };
}

/**
 * Entry point. Runs six negative-space checks + one full-day
 * roundtrip. Returns a self-describing PreflightResult suitable for
 * writing to disk as CI evidence.
 */
export function runOperationalValidationPreflight(
  input: OperationalPreflightInput,
): OperationalPreflightResult {
  const checks: PreflightCheck[] = [];
  checks.push(checkEventEnumeration());
  checks.push(checkMandatoryInvalidators());
  checks.push(checkDeterminism(input));
  checks.push(checkSanitization());
  checks.push(checkSchemaParse());
  checks.push(checkHardFailPropagation(input));

  const startIso = '2026-07-29T00:00:00Z';
  const harness = runHealthyDay(input, startIso);
  const observedEvents = harness.events().length;

  let dailyResult: SoakDailyResult | null = null;
  let manifestValidationOk = false;
  let manifestCheck: PreflightCheck;
  try {
    dailyResult = harness.buildDailyResult({
      dateUtc: startIso.slice(0, 10),
      safetyFlags: SAFE_FLAGS,
      createOrderCounters: ZERO_COUNTERS,
      providerState: FIXTURE_PROVIDERS,
      credentialState: NO_CREDENTIALS,
    });
    const parsed = SoakDailyResultSchema.safeParse(dailyResult);
    if (!parsed.success) {
      manifestCheck = {
        id: 'manifest_validation',
        ok: false,
        detail: `daily result schema_invalid: ${parsed.error.issues[0]?.message ?? '?'}`,
      };
    } else {
      const manifest: SoakManifest = {
        soakId: `preflight-${input.evidenceRunId}`,
        commitSha: input.commitSha,
        startedAt: startIso,
        expectedEndAt: new Date(new Date(startIso).getTime() + DEFAULT_SOAK_DAY_COUNT * 86_400_000).toISOString(),
        actualEndAt: null,
        simulationMode: 'STANDARD_DRY_RUN',
        migrationHead: '0022',
        migrationChainDigest: 'a'.repeat(64),
        reportSpecVersions: { safety_status: 'safety_status.v1' },
        runtimeMode: 'managed_docker',
        installationIdHash: input.installationIdHash,
        dayResults: [dailyResult],
        incidents: [...harness.incidents()],
        safetyViolations: 0,
        codeChangesDetected: false,
        finalVerdict: 'in_progress',
      };
      const manifestParse = SoakManifestSchema.safeParse(manifest);
      if (!manifestParse.success) {
        manifestCheck = {
          id: 'manifest_validation',
          ok: false,
          detail: `manifest schema_invalid: ${manifestParse.error.issues[0]?.message ?? '?'}`,
        };
      } else {
        const v = validateSoakManifest(manifest);
        manifestValidationOk = v.ok;
        manifestCheck = {
          id: 'manifest_validation',
          ok: v.ok,
          detail: v.ok ? '1-day in_progress manifest validates' : `${v.code}: ${v.detail}`,
        };
      }
    }
  } catch (e) {
    manifestCheck = { id: 'manifest_validation', ok: false, detail: `buildDailyResult threw: ${(e as Error).message}` };
  }
  checks.push(manifestCheck);

  const firstFail = checks.find((c) => !c.ok);
  const verdictMap: Record<string, PreflightVerdict> = {
    event_enumeration: 'preflight_failed_event_enumeration',
    mandatory_invalidators: 'preflight_failed_event_enumeration',
    determinism: 'preflight_failed_determinism',
    sanitization: 'preflight_failed_sanitization',
    schema_parse: 'preflight_failed_schema_parse',
    manifest_validation: 'preflight_failed_manifest_validation',
    hard_fail_propagation: 'preflight_failed_hard_fail_propagation',
  };
  const verdict: PreflightVerdict = firstFail
    ? (verdictMap[firstFail.id] ?? 'preflight_failed_manifest_validation')
    : 'preflight_passed';

  return {
    tool: 'operational-validation-preflight',
    version: '1.0',
    generatedAt: input.nowIso,
    commitSha: input.commitSha,
    installationIdHash: input.installationIdHash,
    soakId: `preflight-${input.evidenceRunId}`,
    verdict,
    detail: firstFail ? `${firstFail.id}: ${firstFail.detail}` : 'all preflight checks passed',
    checks,
    counts: {
      eventKindsRecognized: OPERATIONAL_EVENT_KINDS.length,
      mandatoryInvalidators: MANDATORY_SOAK_INVALIDATORS.size,
      hardFailKinds: HARD_FAIL_EVENT_KINDS.size,
      observedEvents,
    },
    dailyResultPassed: dailyResult,
    manifestValidationOk,
  };
}

/** Convenience for CI: derive a stable evidenceRunId from environment. */
export function deriveEvidenceRunId(commitSha: string, ciRunId: string | undefined): string {
  const seed = `${commitSha}|${ciRunId ?? 'local'}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/** Convenience for tests: pass through iteration. */
export function preflightAllEventsSample(harness: OperationalValidationHarness): readonly OperationalEvent[] {
  return harness.events();
}
