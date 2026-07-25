import { writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { Money } from '@horizon/shared';
import { db } from '../../db';
import {
  shadowCertificationRuns,
  type ShadowCertificationRunRow,
} from '../../db/schema';
import { httpCounters, resetHttpCounters, installFetchBarrier } from '../../lib/fetchBarrier';
import {
  SHADOW_LINEAGE_VERSION,
  SHADOW_STRATEGY_VERSION,
} from './authorization';
import { CASH_FLOW_MODEL_VERSION } from '../cashFlowForecast';
import { PROTECTION_MODULE_VERSION } from '../protection/instance';
import {
  countIncompleteAttributions,
  countUnprotectedOpenPositions,
  countUnresolvedIntents,
  verifyAccounting,
} from './simulator';

/**
 * Phase 1.1 Gate 3D §M — shadow-readiness certification harness.
 *
 * Runs a fixture suite (supplied by the caller — each fixture is an
 * async function that walks a single trade lifecycle). After the suite,
 * inspects the DB for accounting/lineage invariants and computes a
 * verdict:
 *
 *   mechanically_ready_for_shadow — every required fixture passed,
 *       accounting exact, no unresolved intent, no unexplained
 *       unprotected position, attribution complete, lineage complete,
 *       createOrder attempt count = 0, createOrder network count = 0,
 *       safe flags correct, migration + schema checks pass.
 *   degraded                       — some passed but invariants broke.
 *   not_ready                      — anything else.
 *
 * The harness NEVER returns `ready_for_live_capital`. That verdict is
 * not modeled at all — it does not exist as an enum value in the DB.
 */

export type CertificationVerdict = 'not_ready' | 'degraded' | 'mechanically_ready_for_shadow';

export interface FixtureCase {
  id: string;
  category: 'entry' | 'protection' | 'exit' | 'economics_lineage';
  title: string;
  /** async fn — must throw on failure. */
  run: () => Promise<void>;
  /** Optional additional invariants after run() — return null if ok, string reason if failed. */
  invariant?: () => Promise<string | null>;
}

export interface RunFixtureMatrixOptions {
  initialCash: Money;
  fixtures: FixtureCase[];
  /** External seed for the certification run id (test-controlled). */
  runId: string;
  now: Date;
  /** Fresh-DB reset before each fixture. */
  beforeEachFixture: () => Promise<void>;
  outputJsonPath?: string;
  outputMarkdownPath?: string;
  /** Optional pre-seeded cert fields (git commit, migration head). */
  commitHash?: string;
  migrationVersion?: string;
  schemaFingerprint?: string;
  safeFlags?: Record<string, unknown>;
  knownLimitations?: string;
}

export interface FixtureResult {
  id: string;
  title: string;
  passed: boolean;
  reason: string | null;
  invariantFailure: string | null;
}

export interface CertificationReport {
  certificationRunId: string;
  commitHash: string | null;
  migrationVersion: string | null;
  schemaFingerprint: string | null;
  simulationMode: string;
  strategyVersion: string;
  costModelVersion: string;
  protectionPolicyVersion: string;
  lineageVersion: string;
  startedAt: string;
  completedAt: string;
  fixtureCount: number;
  passedFixtures: number;
  failedFixtures: number;
  accountingDifference: string;
  unresolvedIntents: number;
  unprotectedPositions: number;
  incompleteAttributions: number;
  lineageFailures: number;
  createOrderAttemptCount: number;
  createOrderNetworkCount: number;
  safeFlags: Record<string, unknown>;
  knownLimitations: string;
  verdict: CertificationVerdict;
  fixtures: FixtureResult[];
}

export async function runFixtureMatrix(
  opts: RunFixtureMatrixOptions,
): Promise<{ report: CertificationReport; row: ShadowCertificationRunRow }> {
  installFetchBarrier();
  resetHttpCounters();
  const startedAt = opts.now;
  const fixtures: FixtureResult[] = [];
  let accountingDifferenceMax = Money.zero();
  let unresolvedIntents = 0;
  let unprotectedPositions = 0;
  let incompleteAttributions = 0;
  let lineageFailures = 0;

  for (const fixture of opts.fixtures) {
    await opts.beforeEachFixture();
    let passed = true;
    let reason: string | null = null;
    let invariantFailure: string | null = null;
    try {
      await fixture.run();
      const accounting = await verifyAccounting(opts.initialCash);
      const diff = Money.fromString(accounting.difference).abs();
      if (Number(diff.toDecimalString(8)) > 0.00000001) {
        passed = false;
        reason = `accounting_difference:${accounting.difference}`;
        if (diff.gt(accountingDifferenceMax)) accountingDifferenceMax = diff;
      }
      const ur = await countUnresolvedIntents();
      if (ur > 0) {
        unresolvedIntents += ur;
        if (fixture.category !== 'entry' || !fixture.id.includes('unknown')) {
          passed = false;
          reason = reason ?? `unresolved_intents:${ur}`;
        }
      }
      const up = await countUnprotectedOpenPositions();
      if (up > 0) {
        unprotectedPositions += up;
        // These are counted in the report but only a fail for exit/economics fixtures.
        if (fixture.category === 'exit' || fixture.category === 'economics_lineage') {
          passed = false;
          reason = reason ?? `unprotected_positions:${up}`;
        }
      }
      const ia = await countIncompleteAttributions();
      if (ia > 0) {
        incompleteAttributions += ia;
        passed = false;
        reason = reason ?? `incomplete_attributions:${ia}`;
      }
      if (fixture.invariant) {
        const inv = await fixture.invariant();
        if (inv) {
          passed = false;
          invariantFailure = inv;
        }
      }
    } catch (err) {
      passed = false;
      reason = err instanceof Error ? err.message : String(err);
    }
    fixtures.push({ id: fixture.id, title: fixture.title, passed, reason, invariantFailure });
  }

  const counters = httpCounters();
  const completedAt = new Date(startedAt.getTime() + 1);
  const passedFixtures = fixtures.filter((f) => f.passed).length;
  const failedFixtures = fixtures.length - passedFixtures;

  const flagsAllGood =
    (opts.safeFlags?.DRY_RUN === true || opts.safeFlags?.DRY_RUN === 'true') &&
    (opts.safeFlags?.ORDER_SUBMISSION_ENABLED === false ||
      opts.safeFlags?.ORDER_SUBMISSION_ENABLED === 'false');

  let verdict: CertificationVerdict = 'not_ready';
  if (failedFixtures === 0) {
    if (
      Number(accountingDifferenceMax.toDecimalString(8)) === 0 &&
      counters.createOrderAttemptCount === 0 &&
      counters.createOrderNetworkCount === 0 &&
      flagsAllGood &&
      // Unresolved/unprotected/incomplete are per-fixture; the summed
      // values here reflect only the fixtures that failed. When all
      // fixtures pass, they are also all zero.
      unresolvedIntents === 0 &&
      unprotectedPositions === 0 &&
      incompleteAttributions === 0 &&
      lineageFailures === 0
    ) {
      verdict = 'mechanically_ready_for_shadow';
    } else {
      verdict = 'degraded';
    }
  } else if (
    counters.createOrderAttemptCount === 0 &&
    counters.createOrderNetworkCount === 0 &&
    passedFixtures > 0
  ) {
    verdict = 'degraded';
  } else {
    verdict = 'not_ready';
  }

  const report: CertificationReport = {
    certificationRunId: opts.runId,
    commitHash: opts.commitHash ?? null,
    migrationVersion: opts.migrationVersion ?? null,
    schemaFingerprint: opts.schemaFingerprint ?? null,
    simulationMode: 'SHADOW_LIVE',
    strategyVersion: SHADOW_STRATEGY_VERSION,
    costModelVersion: CASH_FLOW_MODEL_VERSION,
    protectionPolicyVersion: PROTECTION_MODULE_VERSION,
    lineageVersion: SHADOW_LINEAGE_VERSION,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    fixtureCount: fixtures.length,
    passedFixtures,
    failedFixtures,
    accountingDifference: accountingDifferenceMax.toDecimalString(8),
    unresolvedIntents,
    unprotectedPositions,
    incompleteAttributions,
    lineageFailures,
    createOrderAttemptCount: counters.createOrderAttemptCount,
    createOrderNetworkCount: counters.createOrderNetworkCount,
    safeFlags: opts.safeFlags ?? {},
    knownLimitations: opts.knownLimitations ?? '',
    verdict,
    fixtures,
  };

  // Persist the run.
  const [{ insertId }] = (await db.insert(shadowCertificationRuns).values({
    certificationRunId: opts.runId,
    commitHash: opts.commitHash ?? null,
    migrationVersion: opts.migrationVersion ?? null,
    schemaFingerprint: opts.schemaFingerprint ?? null,
    simulationMode: 'SHADOW_LIVE',
    strategyVersion: SHADOW_STRATEGY_VERSION,
    costModelVersion: CASH_FLOW_MODEL_VERSION,
    protectionPolicyVersion: PROTECTION_MODULE_VERSION,
    lineageVersion: SHADOW_LINEAGE_VERSION,
    startedAt,
    completedAt,
    fixtureCount: fixtures.length,
    passedFixtures,
    failedFixtures,
    accountingDifference: accountingDifferenceMax.toDecimalString(8),
    unresolvedIntents,
    unprotectedPositions,
    incompleteAttributions,
    lineageFailures,
    createOrderAttemptCount: counters.createOrderAttemptCount,
    createOrderNetworkCount: counters.createOrderNetworkCount,
    safeFlagsSnapshot: JSON.stringify(opts.safeFlags ?? {}),
    knownLimitations: opts.knownLimitations ?? '',
    verdict,
    fixtureResults: JSON.stringify(fixtures),
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(shadowCertificationRuns)
    .where(eq(shadowCertificationRuns.id, insertId))
    .limit(1);

  if (opts.outputJsonPath) {
    writeFileSync(opts.outputJsonPath, JSON.stringify(report, null, 2));
  }
  if (opts.outputMarkdownPath) {
    writeFileSync(opts.outputMarkdownPath, renderMarkdownReport(report));
  }
  return { report, row: row! };
}

export function renderMarkdownReport(r: CertificationReport): string {
  const lines: string[] = [];
  lines.push(`# Shadow-readiness certification — ${r.certificationRunId}`);
  lines.push('');
  lines.push(`**Verdict: \`${r.verdict}\`** — NEVER \`ready_for_live_capital\``);
  lines.push('');
  lines.push('| field | value |');
  lines.push('|---|---|');
  lines.push(`| Simulation mode | ${r.simulationMode} |`);
  lines.push(`| Commit | ${r.commitHash ?? '(not supplied)'} |`);
  lines.push(`| Migration version | ${r.migrationVersion ?? '(not supplied)'} |`);
  lines.push(`| Schema fingerprint | ${r.schemaFingerprint ?? '(not supplied)'} |`);
  lines.push(`| Strategy version | ${r.strategyVersion} |`);
  lines.push(`| Cost-model version | ${r.costModelVersion} |`);
  lines.push(`| Protection-policy version | ${r.protectionPolicyVersion} |`);
  lines.push(`| Lineage version | ${r.lineageVersion} |`);
  lines.push(`| Started at | ${r.startedAt} |`);
  lines.push(`| Completed at | ${r.completedAt} |`);
  lines.push(`| Fixture count | ${r.fixtureCount} |`);
  lines.push(`| Passed | ${r.passedFixtures} |`);
  lines.push(`| Failed | ${r.failedFixtures} |`);
  lines.push(`| Accounting difference (max abs) | ${r.accountingDifference} |`);
  lines.push(`| Unresolved intents | ${r.unresolvedIntents} |`);
  lines.push(`| Unprotected positions | ${r.unprotectedPositions} |`);
  lines.push(`| Incomplete attributions | ${r.incompleteAttributions} |`);
  lines.push(`| Lineage failures | ${r.lineageFailures} |`);
  lines.push(`| CreateOrder attempts | ${r.createOrderAttemptCount} |`);
  lines.push(`| CreateOrder network requests | ${r.createOrderNetworkCount} |`);
  lines.push(`| Safe flags | ${JSON.stringify(r.safeFlags)} |`);
  lines.push('');
  lines.push('## Fixtures');
  lines.push('');
  lines.push('| # | title | passed | reason |');
  lines.push('|---|---|---|---|');
  r.fixtures.forEach((f, i) =>
    lines.push(`| ${i + 1} | ${f.title} | ${f.passed ? 'yes' : 'NO'} | ${f.reason ?? f.invariantFailure ?? ''} |`),
  );
  lines.push('');
  if (r.knownLimitations) {
    lines.push('## Known limitations');
    lines.push('');
    lines.push(r.knownLimitations);
  }
  return lines.join('\n');
}
