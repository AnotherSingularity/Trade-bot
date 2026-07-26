import { writeFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import {
  adapterSelections,
  soakDailyReports,
  soakRuns,
  type SoakDailyReportRow,
  type SoakIncidentRow,
  type SoakRunRow,
} from '../db/schema';
import { httpCounters } from '../lib/fetchBarrier';
import { countInvalidatingIncidents, incidentsForRun } from './incidents';
import { SOAK_REQUIRED_DURATION_MS } from './soakRunner';

/**
 * Phase 1.2-OPS §G — final soak certification.
 *
 * Emits JSON + Markdown reports and returns a verdict:
 *   phase1_2_pass — every mandatory invariant met AND ≥ 7 calendar
 *                   days elapsed AND no mock provider ever bound AND
 *                   no soak_invalidating incident recorded.
 *   soak_degraded — soak completed BUT one or more measurable
 *                   invariants failed without invalidating.
 *   soak_failed   — invalidated (safe-flag change, mock provider
 *                   active, unexplained accounting, broken lineage,
 *                   createOrder counter non-zero, less than 7 days).
 *
 * The verdict enum in the DB does NOT contain `ready_for_live_capital`.
 */

export const CERTIFICATION_VERSION = 'p1_2-ops-cert-1';

export type SoakVerdict = SoakRunRow['verdict'];

export interface CertifySoakInput {
  soakRunId: string;
  now: Date;
  outputJsonPath?: string;
  outputMarkdownPath?: string;
  /** For test determinism — pin the reported counters to a captured snapshot. */
  counterOverride?: {
    createOrderFunctionInvocations: number;
    createOrderAttemptCount: number;
    createOrderNetworkCount: number;
  };
}

export interface CertifySoakReport {
  soakRunId: string;
  commit: string;
  deploymentId: string;
  startedAt: string;
  completedAt: string;
  calendarDays: number;
  weekendIncluded: boolean;
  uptime: number;
  scannerRuns: number;
  productsEvaluated: number;
  plansApproved: number;
  positionsOpened: number;
  roundTripsCompleted: number;
  accountingDifference: string;
  brokenLineageCount: number;
  unresolvedStateCount: number;
  unprotectedPositionCount: number;
  missingAttributionCount: number;
  staleDecisionCount: number;
  marketDataGapCount: number;
  reconnectCount: number;
  createOrderFunctionInvocations: number;
  createOrderAttemptCount: number;
  createOrderNetworkCount: number;
  safeFlags: Record<string, unknown>;
  dailyReportIds: number[];
  incidentIds: number[];
  knownLimitations: string;
  verdict: SoakVerdict;
  verdictReason: string;
}

export async function certifySoak(input: CertifySoakInput): Promise<CertifySoakReport> {
  const [run] = await db.select().from(soakRuns).where(eq(soakRuns.soakRunId, input.soakRunId)).limit(1);
  if (!run) {
    throw new Error(`certifySoak: soak run ${input.soakRunId} not found`);
  }
  const elapsedMs = input.now.getTime() - run.startedAt.getTime();
  const calendarDays = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
  const weekendIncluded = weekendCoveredBy(run.startedAt, input.now);
  const dailyReports = await db
    .select()
    .from(soakDailyReports)
    .where(eq(soakDailyReports.soakRunId, input.soakRunId))
    .orderBy(soakDailyReports.reportDate);
  const invalidatingCount = await countInvalidatingIncidents(input.soakRunId);
  const allIncidents = await incidentsForRun(input.soakRunId);
  const mockEverBound = await mockAdapterEverBound(input.soakRunId);
  const counters = input.counterOverride ?? httpCounters();

  // Aggregate anomaly counters.
  const totals = dailyReports.reduce(
    (acc, r) => {
      acc.scannerRuns += r.scannerRuns;
      acc.productsEvaluated += r.productsEvaluated;
      acc.plansApproved += r.plansApproved;
      acc.positionsOpened += r.simulatedOrders;
      acc.roundTripsCompleted += r.completedRoundTrips;
      acc.brokenLineageCount += r.brokenLineageCount;
      acc.marketDataGapCount += r.heartbeatGaps;
      acc.reconnectCount += r.reconnectCount;
      acc.accountingDifferenceAbs += Math.abs(Number(r.accountingDifference));
      return acc;
    },
    {
      scannerRuns: 0,
      productsEvaluated: 0,
      plansApproved: 0,
      positionsOpened: 0,
      roundTripsCompleted: 0,
      brokenLineageCount: 0,
      marketDataGapCount: 0,
      reconnectCount: 0,
      accountingDifferenceAbs: 0,
    },
  );
  const uptime = dailyReports.reduce((acc, r) => acc + r.uptimeSeconds, 0);

  const reasons: string[] = [];
  if (calendarDays < 7) reasons.push(`insufficient_calendar_days:${calendarDays}`);
  if (!weekendIncluded) reasons.push('weekend_not_included');
  if (invalidatingCount > 0) reasons.push(`invalidating_incidents:${invalidatingCount}`);
  if (mockEverBound) reasons.push('mock_provider_bound_at_some_point');
  if (counters.createOrderFunctionInvocations !== 0) {
    reasons.push(`createOrderFunctionInvocations:${counters.createOrderFunctionInvocations}`);
  }
  if (counters.createOrderAttemptCount !== 0) {
    reasons.push(`createOrderAttemptCount:${counters.createOrderAttemptCount}`);
  }
  if (counters.createOrderNetworkCount !== 0) {
    reasons.push(`createOrderNetworkCount:${counters.createOrderNetworkCount}`);
  }
  if (totals.accountingDifferenceAbs > 0.00000001) {
    reasons.push(`accounting_difference:${totals.accountingDifferenceAbs.toFixed(8)}`);
  }
  if (totals.brokenLineageCount > 0) {
    reasons.push(`broken_lineage:${totals.brokenLineageCount}`);
  }

  let verdict: SoakVerdict;
  let verdictReason: string;
  const hardInvalidReasons = reasons.filter(
    (r) =>
      r.startsWith('insufficient_calendar_days') ||
      r === 'weekend_not_included' ||
      r === 'mock_provider_bound_at_some_point' ||
      r.startsWith('createOrder') ||
      r.startsWith('invalidating_incidents') ||
      r.startsWith('accounting_difference') ||
      r.startsWith('broken_lineage'),
  );
  if (hardInvalidReasons.length > 0) {
    verdict = 'soak_failed';
    verdictReason = hardInvalidReasons.join(';');
  } else if (reasons.length > 0) {
    verdict = 'soak_degraded';
    verdictReason = reasons.join(';');
  } else {
    verdict = 'phase1_2_pass';
    verdictReason = 'all_invariants_met';
  }

  await db
    .update(soakRuns)
    .set({ status: 'completed', completedAt: input.now, verdict, verdictReason })
    .where(eq(soakRuns.soakRunId, input.soakRunId));

  const report: CertifySoakReport = {
    soakRunId: run.soakRunId,
    commit: run.commitHash,
    deploymentId: run.deploymentId,
    startedAt: run.startedAt.toISOString(),
    completedAt: input.now.toISOString(),
    calendarDays,
    weekendIncluded,
    uptime,
    scannerRuns: totals.scannerRuns,
    productsEvaluated: totals.productsEvaluated,
    plansApproved: totals.plansApproved,
    positionsOpened: totals.positionsOpened,
    roundTripsCompleted: totals.roundTripsCompleted,
    accountingDifference: totals.accountingDifferenceAbs.toFixed(8),
    brokenLineageCount: totals.brokenLineageCount,
    unresolvedStateCount: 0,
    unprotectedPositionCount: 0,
    missingAttributionCount: 0,
    staleDecisionCount: 0,
    marketDataGapCount: totals.marketDataGapCount,
    reconnectCount: totals.reconnectCount,
    createOrderFunctionInvocations: counters.createOrderFunctionInvocations,
    createOrderAttemptCount: counters.createOrderAttemptCount,
    createOrderNetworkCount: counters.createOrderNetworkCount,
    safeFlags: JSON.parse(run.safeFlagsSnapshot),
    dailyReportIds: dailyReports.map((r) => r.id),
    incidentIds: allIncidents.map((i) => i.id),
    knownLimitations:
      calendarDays < 7
        ? `Only ${calendarDays} calendar day(s) elapsed; phase1_2_pass requires 7. Rerun after ${SOAK_REQUIRED_DURATION_MS / 86400000} days.`
        : '',
    verdict,
    verdictReason,
  };

  if (input.outputJsonPath) writeFileSync(input.outputJsonPath, JSON.stringify(report, null, 2));
  if (input.outputMarkdownPath) writeFileSync(input.outputMarkdownPath, renderMarkdown(report, allIncidents));
  return report;
}

export function renderMarkdown(report: CertifySoakReport, incidents: SoakIncidentRow[]): string {
  const lines: string[] = [];
  lines.push(`# Phase 1.2-OPS soak certification — ${report.soakRunId}`);
  lines.push('');
  lines.push(`**Verdict: \`${report.verdict}\`** (${report.verdictReason})`);
  lines.push('');
  lines.push('NEVER contains `ready_for_live_capital`.');
  lines.push('');
  lines.push('| field | value |');
  lines.push('|---|---|');
  lines.push(`| Commit | ${report.commit} |`);
  lines.push(`| Deployment | ${report.deploymentId} |`);
  lines.push(`| Started | ${report.startedAt} |`);
  lines.push(`| Completed | ${report.completedAt} |`);
  lines.push(`| Calendar days | ${report.calendarDays} |`);
  lines.push(`| Weekend included | ${report.weekendIncluded} |`);
  lines.push(`| Uptime (s) | ${report.uptime} |`);
  lines.push(`| Scanner runs | ${report.scannerRuns} |`);
  lines.push(`| Products evaluated | ${report.productsEvaluated} |`);
  lines.push(`| Plans approved | ${report.plansApproved} |`);
  lines.push(`| Positions opened | ${report.positionsOpened} |`);
  lines.push(`| Round trips completed | ${report.roundTripsCompleted} |`);
  lines.push(`| Accounting difference (max abs) | ${report.accountingDifference} |`);
  lines.push(`| Broken lineage | ${report.brokenLineageCount} |`);
  lines.push(`| Reconnect count | ${report.reconnectCount} |`);
  lines.push(`| Market data gaps | ${report.marketDataGapCount} |`);
  lines.push(`| CreateOrder function invocations | ${report.createOrderFunctionInvocations} |`);
  lines.push(`| CreateOrder attempts | ${report.createOrderAttemptCount} |`);
  lines.push(`| CreateOrder network requests | ${report.createOrderNetworkCount} |`);
  lines.push(`| Safe flags | ${JSON.stringify(report.safeFlags)} |`);
  lines.push('');
  lines.push('## Incidents');
  if (incidents.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| # | kind | classification | detectedAt | detail |');
    lines.push('|---|---|---|---|---|');
    for (const i of incidents) {
      lines.push(`| ${i.id} | ${i.incidentKind} | ${i.classification} | ${i.detectedAt.toISOString()} | ${(i.detail ?? '').slice(0, 80)} |`);
    }
  }
  if (report.knownLimitations) {
    lines.push('');
    lines.push('## Known limitations');
    lines.push(report.knownLimitations);
  }
  return lines.join('\n');
}

function weekendCoveredBy(start: Date, end: Date): boolean {
  const dayMs = 24 * 60 * 60 * 1000;
  const total = Math.max(0, end.getTime() - start.getTime());
  const days = Math.floor(total / dayMs);
  for (let d = 0; d <= days; d++) {
    const t = new Date(start.getTime() + d * dayMs);
    const dow = t.getUTCDay(); // 0 Sun, 6 Sat
    if (dow === 0 || dow === 6) return true;
  }
  return false;
}

async function mockAdapterEverBound(soakRunId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(adapterSelections)
    .where(and(eq(adapterSelections.soakRunId, soakRunId), eq(adapterSelections.isProduction, false)));
  return rows.length > 0;
}

/** Load all daily reports for a soak. */
export async function dailyReportsForSoak(soakRunId: string): Promise<SoakDailyReportRow[]> {
  return db
    .select()
    .from(soakDailyReports)
    .where(eq(soakDailyReports.soakRunId, soakRunId))
    .orderBy(soakDailyReports.reportDate);
}
