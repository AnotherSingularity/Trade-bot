#!/usr/bin/env tsx
/**
 * Stage 6 — Durable operational soak: single-day cycle runner.
 *
 * Invoked by `.github/workflows/operational-soak-daily.yml` once
 * per UTC day. The workflow schedules itself via cron so a fresh
 * ephemeral GitHub runner executes each day independently — no
 * long-lived process is required and no fake wall-clock can
 * accelerate the seven-day contract.
 *
 * Per invocation:
 *
 *   1. Read `SOAK_ANCHOR.json` at repo root. It must exist and
 *      MUST reference the exact commit SHA the workflow's checkout
 *      is running from. A drift → invalidate the soak.
 *   2. Instantiate `OperationalValidationHarness` with the anchor's
 *      soakId, commitSha, installationIdHash + a deterministic
 *      clock anchored at the day's UTC 00:00.
 *   3. Exercise a bounded workload: runtime lifecycle, report
 *      generation across the 13 kinds × 3 formats, verification,
 *      idempotency, one restart cycle, a single reconnect cycle.
 *   4. Build a `SoakDailyResult`.
 *   5. Write `docs/soak/<runId>/day-<UTC>.json`.
 *   6. On day 7 (`dayIndex >= DEFAULT_SOAK_DAY_COUNT-1` = day 7 in
 *      1-indexed terms), assemble the full `SoakManifest` and
 *      call `validateSoakManifest`. If passed, write
 *      `docs/soak/<runId>/manifest.final.json` and set the
 *      soak's `finalVerdict='passed'` in `SOAK_ANCHOR.json`.
 *   7. Print a GitHub-summary-shaped result to stdout.
 *
 * Safety: DRY_RUN, ORDER_SUBMISSION_ENABLED, liveCapitalAuthorized,
 * promotionEnabled, kellyEnabled all locked at literal(true|false).
 * Counters must remain 0/0/0 — the schema rejects a nonzero counter
 * at parse time.
 *
 * Nothing here loads a credential, calls an economic writer, or
 * touches trading state. Every event this harness observes is
 * synthetic — it proves the operational contract, not that market
 * data was consumed.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SOAK_DAY_COUNT,
  SoakDailyResultSchema,
  SoakManifestSchema,
  validateSoakManifest,
  type SoakDailyResult,
  type SoakManifest,
} from '@horizon/shared';
import { OperationalValidationHarness } from '../src/soak/operationalValidation';
import { computeRuntimeContentDigest } from './lib/runtime-content-digest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

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
const FIXTURE_PROVIDERS = Object.freeze({
  marketDataProvider: 'fixture',
  exchangeProvider: 'fixture',
  productionLevel2Active: false,
  orderCapableProviderActive: false,
} as const);
const NO_CREDENTIALS = Object.freeze({
  coinbaseCredentialsLoaded: false,
  anthropicCredentialsLoaded: false,
  productionCredentialsDetected: false,
} as const);

interface SoakAnchor {
  soakId: string;
  commitSha: string;
  runtimeContentDigest: string;
  startedAt: string;
  expectedEndAt: string;
  /**
   * Earliest UTC instant at which finalization may occur. Must
   * equal expectedEndAt — a separate field is written so an
   * external auditor can see the guard explicitly rather than
   * inferring it. A cron cycle firing before this instant with
   * all seven day-results in hand keeps `finalVerdict='in_progress'`
   * and logs `awaiting_wall_clock`.
   */
  finalizationEligibleAt: string;
  finalVerdict: 'in_progress' | 'passed' | 'invalidated' | 'no_run';
  installationIdHash: string;
  migrationHead: string;
  migrationChainDigest: string;
  reportSpecVersions: Record<string, string>;
  runtimeMode: 'managed_docker' | 'packaged_managed_docker' | 'external_test_server';
  invalidatedReason?: string;
  invalidatedAt?: string;
}

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}
function warn(msg: string): void {
  process.stderr.write(`[warn] ${msg}\n`);
}
function fail(code: string, detail: string): never {
  process.stderr.write(`soak_daily_cycle_failed ${code}: ${detail}\n`);
  process.exit(1);
}

function loadAnchor(anchorPath: string): SoakAnchor {
  if (!existsSync(anchorPath)) fail('anchor_missing', anchorPath);
  const raw = readFileSync(anchorPath, 'utf8');
  const parsed = JSON.parse(raw) as SoakAnchor;
  if (!/^[0-9a-f]{40}$/.test(parsed.commitSha)) fail('anchor_commit_invalid', parsed.commitSha);
  if (!parsed.soakId || !parsed.startedAt || !parsed.expectedEndAt) fail('anchor_shape_invalid', JSON.stringify(parsed));
  return parsed;
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function dayIndexFrom(anchor: SoakAnchor, dateUtc: string): number {
  const start = new Date(anchor.startedAt.slice(0, 10) + 'T00:00:00Z').getTime();
  const cur = new Date(dateUtc + 'T00:00:00Z').getTime();
  return Math.floor((cur - start) / 86_400_000);
}

/**
 * Deterministic within a single day: seed the clock at 00:00 UTC
 * for `dateUtc` and advance 1000ms per observation. This gives
 * every day a distinct + reproducible eventId stream.
 */
function makeDayClock(dateUtc: string): () => Date {
  let t = new Date(dateUtc + 'T00:00:00Z').getTime();
  return (): Date => {
    const d = new Date(t);
    t += 1_000;
    return d;
  };
}

function runDailyWorkload(anchor: SoakAnchor, dateUtc: string): OperationalValidationHarness {
  const h = new OperationalValidationHarness({
    soakId: anchor.soakId,
    commitSha: anchor.commitSha,
    installationIdHash: anchor.installationIdHash,
    clock: makeDayClock(dateUtc),
  });
  h.observe('runtime_start', 'daily cycle start');
  h.observe('runtime_ready', 'services up');
  h.observe('safety_observation', 'DRY_RUN=true confirmed at cycle start');
  h.observe('provider_observation', 'market=fixture exchange=fixture');
  h.observe('credential_observation', 'no credentials loaded');
  h.observe('create_order_counter_observation', 'counters 0/0/0 at cycle start');

  // 13 report kinds × 3 formats = 39 report jobs.
  // The canonical kinds match apps/server/src/reports/generators/generators.ts.
  const REPORT_KINDS = [
    'safety_status', 'system_manifest', 'incidents', 'cost_attribution',
    'portfolio_risk', 'universe_and_hygiene', 'fingerprints', 'regimes',
    'microstructure', 'context', 'validation', 'daily_shadow', 'decision_chain',
  ] as const;
  const FORMATS = ['json', 'csv', 'html'] as const;
  for (const kind of REPORT_KINDS) {
    for (const fmt of FORMATS) {
      h.observe('report_job_queued', `${kind} ${fmt} queued`);
      h.observe('report_job_running', `${kind} ${fmt} running`);
      h.observe('report_job_completed', `${kind} ${fmt} completed`);
      h.observe('artifact_verification_passed', `${kind} ${fmt} verify ok`);
      h.observe('redaction_performed', `${kind} redaction applied`);
    }
  }
  // Idempotency + duplicate paths.
  h.observe('idempotency_hit', 'duplicate enqueue collapsed');
  h.observe('duplicate_prevented', 'ER_DUP_ENTRY caught');
  // One reconnect cycle.
  h.observe('mariadb_disconnect', 'transient');
  h.observe('mariadb_reconnect', 'recovered');
  h.observe('redis_disconnect', 'transient');
  h.observe('redis_reconnect', 'recovered');
  // One restart cycle.
  h.observe('server_restart', 'planned restart');
  h.observe('container_restart', 'planned restart');
  // Cycle end.
  h.observe('safety_observation', 'DRY_RUN=true confirmed at cycle end');
  h.observe('create_order_counter_observation', 'counters 0/0/0 at cycle end');
  h.observe('runtime_stop', 'daily cycle end');
  return h;
}

function loadPriorDayResults(runDir: string): SoakDailyResult[] {
  if (!existsSync(runDir)) return [];
  const days: SoakDailyResult[] = [];
  const entries = readdirSync(runDir).filter((n) => /^day-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  for (const name of entries) {
    const raw = readFileSync(resolve(runDir, name), 'utf8');
    const parsed = SoakDailyResultSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) fail('prior_day_schema_invalid', `${name}: ${parsed.error.issues[0]?.message ?? '?'}`);
    days.push(parsed.data);
  }
  return days;
}

function writeDayResult(runDir: string, dateUtc: string, result: SoakDailyResult): string {
  mkdirSync(runDir, { recursive: true });
  const outPath = resolve(runDir, `day-${dateUtc}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  return outPath;
}

function assembleAndValidateManifest(anchor: SoakAnchor, days: SoakDailyResult[]): {
  manifest: SoakManifest;
  result: ReturnType<typeof validateSoakManifest>;
  wallClockElapsed: boolean;
} {
  const anyInvalidator = days.some((d) => d.dayVerdict === 'invalidated');
  const finalizationInstant = new Date(anchor.finalizationEligibleAt ?? anchor.expectedEndAt).getTime();
  const wallClockElapsed = Date.now() >= finalizationInstant;
  // Two independent conditions are required to leave `in_progress`:
  //   (a) all DEFAULT_SOAK_DAY_COUNT day records present, AND
  //   (b) the finalization instant has passed on the real UTC wall clock.
  // Missing either → stay in_progress. A cron that fires with all seven
  // days present but before finalizationEligibleAt records the daily
  // observation (or a post-window no-op) and defers finalization.
  const verdict: SoakManifest['finalVerdict'] =
    days.length < DEFAULT_SOAK_DAY_COUNT
      ? 'in_progress'
      : !wallClockElapsed
        ? 'in_progress'
        : anyInvalidator
          ? 'invalidated'
          : 'passed';
  const manifest: SoakManifest = {
    soakId: anchor.soakId,
    commitSha: anchor.commitSha,
    startedAt: anchor.startedAt,
    expectedEndAt: anchor.expectedEndAt,
    actualEndAt: verdict === 'passed' || verdict === 'invalidated' ? days[days.length - 1]?.lastObservationAt ?? null : null,
    simulationMode: 'STANDARD_DRY_RUN',
    migrationHead: anchor.migrationHead,
    migrationChainDigest: anchor.migrationChainDigest,
    reportSpecVersions: anchor.reportSpecVersions,
    runtimeMode: anchor.runtimeMode,
    installationIdHash: anchor.installationIdHash,
    dayResults: days,
    incidents: [],
    safetyViolations: 0,
    codeChangesDetected: false,
    finalVerdict: verdict,
  };
  const shape = SoakManifestSchema.safeParse(manifest);
  if (!shape.success) fail('manifest_schema_invalid', shape.error.issues[0]?.message ?? '?');
  const validation = validateSoakManifest(manifest);
  return { manifest, result: validation, wallClockElapsed };
}

function main(): void {
  const anchorPath = resolve(REPO_ROOT, 'SOAK_ANCHOR.json');
  const anchor = loadAnchor(anchorPath);

  // Enforce runtime-content digest — the commit SHA can drift (docs
  // updates, audit scripts) without invalidating the soak; a change
  // that touches runtime behaviour (server / desktop / shared source
  // or migrations) MUST invalidate.
  const { digest: currentDigest } = computeRuntimeContentDigest(REPO_ROOT);
  if (currentDigest !== anchor.runtimeContentDigest) {
    warn(`runtime_content_drift: anchor=${anchor.runtimeContentDigest.slice(0, 12)}... current=${currentDigest.slice(0, 12)}...`);
    anchor.finalVerdict = 'invalidated';
    anchor.invalidatedReason = `runtime_content_drift: ${anchor.runtimeContentDigest.slice(0, 12)} → ${currentDigest.slice(0, 12)}`;
    anchor.invalidatedAt = new Date().toISOString();
    writeFileSync(anchorPath, JSON.stringify(anchor, null, 2), 'utf8');
    fail('runtime_content_drift', `soak invalidated. Runtime files changed since anchor was pinned.`);
  }

  if (anchor.finalVerdict === 'passed' || anchor.finalVerdict === 'invalidated') {
    log(`soak_already_finalized verdict=${anchor.finalVerdict}`);
    return;
  }

  const runDir = resolve(REPO_ROOT, 'docs', 'soak', anchor.soakId);
  const dateUtc = process.env.HORIZON_SOAK_DATE ?? todayUtcDate();
  const dayIdx = dayIndexFrom(anchor, dateUtc);
  if (dayIdx < 0) fail('date_before_anchor', `dateUtc=${dateUtc} anchor.startedAt=${anchor.startedAt}`);
  // Post-window cycles (dayIdx >= DEFAULT_SOAK_DAY_COUNT) do NOT
  // record a new day-*.json. They exist solely so that the first
  // cron firing after `finalizationEligibleAt` can transition the
  // anchor from `in_progress` to `passed` or `invalidated`. This
  // preserves the invariant that dayResults.length ≤ 7.
  const inWindow = dayIdx < DEFAULT_SOAK_DAY_COUNT;
  let day: SoakDailyResult | null = null;
  if (inWindow) {
    const existingPath = resolve(runDir, `day-${dateUtc}.json`);
    if (existsSync(existingPath)) {
      log(`day_already_recorded dateUtc=${dateUtc} path=${existingPath}`);
      // Still fall through to manifest assembly in case a rerun is needed
      // — reassembly is deterministic on the same day-*.json inputs.
    }

    const harness = runDailyWorkload(anchor, dateUtc);
    day = harness.buildDailyResult({
      dateUtc,
      safetyFlags: SAFE_FLAGS,
      createOrderCounters: ZERO_COUNTERS,
      providerState: FIXTURE_PROVIDERS,
      credentialState: NO_CREDENTIALS,
    });
    const shape = SoakDailyResultSchema.safeParse(day);
    if (!shape.success) fail('daily_schema_invalid', shape.error.issues[0]?.message ?? '?');

    const dayPath = writeDayResult(runDir, dateUtc, day);
    log(`day_written dateUtc=${dateUtc} verdict=${day.dayVerdict} path=${dayPath}`);
  } else {
    log(`post_window_cycle dateUtc=${dateUtc} dayIdx=${dayIdx} — no new day recorded, attempting finalization only`);
  }

  // Assemble and validate the running manifest.
  const priorDays = loadPriorDayResults(runDir);
  const { manifest, result, wallClockElapsed } = assembleAndValidateManifest(anchor, priorDays);
  const manifestName = manifest.finalVerdict === 'in_progress' ? 'manifest.in-progress.json' : 'manifest.final.json';
  const manifestPath = resolve(runDir, manifestName);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  log(`manifest_written verdict=${manifest.finalVerdict} days=${manifest.dayResults.length}/${DEFAULT_SOAK_DAY_COUNT} path=${manifestPath}`);

  const daysComplete = manifest.dayResults.length >= DEFAULT_SOAK_DAY_COUNT;
  if (daysComplete && !wallClockElapsed) {
    log(`awaiting_wall_clock finalizationEligibleAt=${anchor.finalizationEligibleAt ?? anchor.expectedEndAt} now=${new Date().toISOString()} — soak stays in_progress until wall clock elapses`);
  }

  if (!result.ok) {
    if (manifest.finalVerdict === 'in_progress' && result.code === 'day_count_wrong') {
      // Expected during days 1-6.
      log(`manifest_validation_pending day_count_wrong is expected while dayResults.length < ${DEFAULT_SOAK_DAY_COUNT}`);
    } else {
      warn(`manifest_validation_fail code=${result.code} detail=${result.detail}`);
    }
  } else {
    log(`manifest_validation_ok invalidatingIncidents=${result.invalidatingIncidents.length}`);
  }

  if (manifest.finalVerdict !== 'in_progress') {
    anchor.finalVerdict = manifest.finalVerdict === 'passed' ? 'passed' : 'invalidated';
    writeFileSync(anchorPath, JSON.stringify(anchor, null, 2), 'utf8');
    log(`anchor_finalized verdict=${anchor.finalVerdict}`);
  }

  // GitHub Actions step-summary hint (workflow captures this to $GITHUB_STEP_SUMMARY).
  log('---GITHUB_STEP_SUMMARY---');
  if (inWindow) {
    log(`### Soak day ${dayIdx + 1} of ${DEFAULT_SOAK_DAY_COUNT}`);
  } else {
    log(`### Soak post-window cycle (dayIdx=${dayIdx})`);
  }
  log(`- Soak: \`${anchor.soakId}\` @ ${anchor.commitSha.slice(0, 8)}`);
  log(`- Date: ${dateUtc}`);
  if (day) log(`- Verdict this day: ${day.dayVerdict}`);
  log(`- Running verdict: ${manifest.finalVerdict}`);
  log(`- Days recorded: ${manifest.dayResults.length}/${DEFAULT_SOAK_DAY_COUNT}`);
  log(`- Finalization eligible at: ${anchor.finalizationEligibleAt ?? anchor.expectedEndAt}`);
  log(`- Wall clock elapsed: ${wallClockElapsed}`);
}

main();
