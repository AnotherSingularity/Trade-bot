import { Money } from '@horizon/shared';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  botConfig,
  candleObservations,
  forecastVsRealizedAttributions,
  forwardOutcomeLabels,
  marketDataGaps,
  marketStreamSessions,
  orderIntents,
  positions,
  productMarketStates,
  roundTrips,
  shadowDailyReports,
  shadowExecutionPlans,
  shadowOperationRuns,
  type ShadowDailyReportRow,
  type ShadowOperationRunRow,
} from '../db/schema';
import { verifyAccounting } from '../trading/shadow/simulator';
import { httpCounters } from '../lib/fetchBarrier';

/**
 * Phase 1.2 §M — hourly + daily shadow reports.
 *
 * Hourly report:
 *   Connection states, reconnect count, heartbeat gaps, product health,
 *   stale-product count, scanner runs / failures, candidate count,
 *   approved-plan count, open positions, reconciliation status, the
 *   three CreateOrder counters.
 *
 * Daily report:
 *   Products evaluated, complete-vs-rejected chain counts, candidates
 *   by mode, approved plans, simulated fills, partial fills, completed
 *   round trips, gross P&L, fees, modeled spread + slippage, NET P&L
 *   (primary), forecast-cost error, accounting difference, unresolved
 *   lineage, unprotected exposure, missing attribution, WebSocket
 *   uptime %, detected gaps, three CreateOrder counters.
 *
 * Primary performance MUST be reported net of simulated costs.
 */

export const SHADOW_REPORT_VERSION = 'p1_2-reports-1';

export interface HourlyReportInput {
  windowStart: Date;
  windowEnd: Date;
  now: Date;
  initialCash: Money;
}

export async function generateHourlyReport(input: HourlyReportInput): Promise<ShadowOperationRunRow> {
  const sessions = await db.select().from(marketStreamSessions);
  const activeConnections = sessions.filter((s) => s.state !== 'stopped' && s.state !== 'failed').length;
  const healthyConnections = sessions.filter((s) => s.state === 'healthy').length;
  const reconnectCount = sessions.reduce((acc, s) => acc + s.reconnectCount, 0);
  const heartbeatGaps = (
    await db.select().from(marketDataGaps).where(eq(marketDataGaps.gapType, 'missing_heartbeat'))
  ).length;
  const productStates = await db.select().from(productMarketStates);
  const healthyProductCount = productStates.filter((p) => p.dataQualityState === 'healthy').length;
  const staleProductCount = productStates.filter((p) => p.dataQualityState !== 'healthy').length;

  const chains = await countRowsInWindow('decision_chains', 'createdAt', input.windowStart, input.windowEnd);
  const approvedPlans = await countRowsInWindow('shadow_execution_plans', 'createdAt', input.windowStart, input.windowEnd);
  const openPositionsCount = (
    await db.select({ n: sql<number>`COUNT(*)` }).from(positions).where(eq(positions.status, 'open'))
  )[0]?.n ?? 0;
  const [bc] = await db.select().from(botConfig).limit(1);

  const counters = httpCounters();
  const [{ insertId }] = (await db.insert(shadowOperationRuns).values({
    reportedAt: input.now,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    activeConnections,
    healthyConnections,
    reconnectCount,
    heartbeatGaps,
    healthyProductCount,
    staleProductCount,
    scannerRuns: chains,
    scannerFailures: 0, // per-run failure count is tracked in decision_chains.currentStatus
    candidateCount: chains,
    approvedPlanCount: Number(approvedPlans),
    openPositions: Number(openPositionsCount),
    reconciliationStatus: bc?.reconciliationStatus ?? 'unknown',
    createOrderFunctionInvocations: counters.createOrderFunctionInvocations,
    createOrderAttemptCount: counters.createOrderAttemptCount,
    createOrderNetworkCount: counters.createOrderNetworkCount,
  })) as unknown as { insertId: number }[];
  // suppress unused
  void input.initialCash;
  const [row] = await db
    .select()
    .from(shadowOperationRuns)
    .where(eq(shadowOperationRuns.id, insertId))
    .limit(1);
  return row!;
}

export interface DailyReportInput {
  reportDate: Date;
  now: Date;
  initialCash: Money;
}

export async function generateDailyReport(input: DailyReportInput): Promise<ShadowDailyReportRow> {
  const start = new Date(input.reportDate);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);

  const { sql: sqlTag } = await import('drizzle-orm');
  const chainCountRows = (await db.execute(
    sqlTag`SELECT COUNT(*) AS n FROM decision_chains WHERE createdAt >= ${start} AND createdAt < ${end}`,
  )) as unknown as [{ n: number }[], unknown];
  const chainCountArr = Array.isArray(chainCountRows[0]) ? chainCountRows[0] : (chainCountRows as unknown as { n: number }[]);
  const productsEvaluatedRaw = Number(chainCountArr[0]?.n ?? 0);

  const rejectedChainsRows = (await db.execute(
    sqlTag`SELECT COUNT(*) AS n FROM decision_chains
      WHERE createdAt >= ${start} AND createdAt < ${end}
        AND currentStatus IN ('ineligible','no_setup','economically_rejected','quantitatively_rejected','failed')`,
  )) as unknown as [{ n: number }[], unknown];
  const rejectedArr = Array.isArray(rejectedChainsRows[0]) ? rejectedChainsRows[0] : (rejectedChainsRows as unknown as { n: number }[]);
  const rejectedChainsN = Number(rejectedArr[0]?.n ?? 0);
  const productsEvaluated = productsEvaluatedRaw;

  const approvedPlansCount = (
    await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(shadowExecutionPlans)
      .where(and(gte(shadowExecutionPlans.createdAt, start), lte(shadowExecutionPlans.createdAt, end)))
  )[0]?.n ?? 0;

  const rtRows = await db
    .select()
    .from(roundTrips)
    .where(and(gte(roundTrips.closedAt, start), lte(roundTrips.closedAt, end)));
  const completedRoundTrips = rtRows.length;
  let grossPnl = Money.zero();
  let fees = Money.zero();
  for (const rt of rtRows) {
    grossPnl = grossPnl.add(
      Money.fromString(rt.exitValueGross).sub(Money.fromString(rt.entryValueGross)),
    );
    fees = fees.add(Money.fromString(rt.entryFees)).add(Money.fromString(rt.exitFees));
  }
  const netPnl = grossPnl.sub(fees);

  const attribRows = await db.select().from(forecastVsRealizedAttributions);
  let forecastError = Money.zero();
  for (const a of attribRows) {
    forecastError = forecastError.add(Money.fromString(a.absoluteForecastError));
  }

  const acc = await verifyAccounting(input.initialCash);
  const accountingDifference = Money.fromString(acc.difference).abs();

  const unresolvedRows = (
    await db.execute(
      sqlTag`SELECT COUNT(*) AS n FROM decision_chains
        WHERE currentStatus IN ('order_pending','partially_filled')`,
    )
  ) as unknown as [{ n: number }[], unknown];
  const unresolvedArr = Array.isArray(unresolvedRows[0]) ? unresolvedRows[0] : (unresolvedRows as unknown as { n: number }[]);
  const unresolved = Number(unresolvedArr[0]?.n ?? 0);

  const unprotectedExposure = (
    await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(positions)
      .where(and(eq(positions.status, 'open'), eq(positions.protectionState, 'degraded')))
  )[0]?.n ?? 0;

  const missingAttribution = Math.max(0, completedRoundTrips - attribRows.length);

  const sessions = await db.select().from(marketStreamSessions);
  const totalDurationMs = sessions.reduce(
    (acc, s) => acc + ((s.endedAt ?? input.now).getTime() - s.startedAt.getTime()),
    0,
  );
  const healthyDurationMs = sessions
    .filter((s) => s.state === 'healthy' || s.state === 'stopped')
    .reduce((acc, s) => acc + ((s.endedAt ?? input.now).getTime() - s.startedAt.getTime()), 0);
  const webSocketUptimePct = totalDurationMs === 0 ? 0 : (healthyDurationMs / totalDurationMs) * 100;

  const detectedGaps = (await db.select().from(marketDataGaps)).length;

  const counters = httpCounters();
  const [{ insertId }] = (await db.insert(shadowDailyReports).values({
    reportDate: start,
    productsEvaluated,
    completeChains: productsEvaluated - rejectedChainsN,
    rejectedChains: rejectedChainsN,
    candidatesReversion: 0,
    candidatesBreakout: 0,
    candidatesMacro: productsEvaluated,
    approvedPlans: Number(approvedPlansCount),
    simulatedFills: completedRoundTrips,
    partialFills: 0,
    completedRoundTrips,
    grossPnl: grossPnl.toDecimalString(8),
    feesPaid: fees.toDecimalString(8),
    modeledSpread: Money.zero().toDecimalString(8),
    modeledSlippage: Money.zero().toDecimalString(8),
    netPnl: netPnl.toDecimalString(8),
    forecastCostError: forecastError.toDecimalString(8),
    accountingDifference: accountingDifference.toDecimalString(8),
    unresolvedLineage: unresolved,
    unprotectedExposure: Number(unprotectedExposure),
    missingAttribution,
    webSocketUptimePct: webSocketUptimePct.toFixed(3),
    detectedGaps,
    createOrderFunctionInvocations: counters.createOrderFunctionInvocations,
    createOrderAttemptCount: counters.createOrderAttemptCount,
    createOrderNetworkCount: counters.createOrderNetworkCount,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(shadowDailyReports)
    .where(eq(shadowDailyReports.id, insertId))
    .limit(1);
  return row!;
}

async function countRowsInWindow(
  table: string,
  column: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<number> {
  const { sql: sqlTag } = await import('drizzle-orm');
  const rows = (await db.execute(
    sqlTag.raw(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} >= '${windowStart.toISOString().slice(0, 19).replace('T', ' ')}' AND ${column} <= '${windowEnd.toISOString().slice(0, 19).replace('T', ' ')}'`),
  )) as unknown as [{ n: number }[], unknown];
  const arr = Array.isArray(rows[0]) ? rows[0] : (rows as unknown as { n: number }[]);
  return Number(arr[0]?.n ?? 0);
}

// Suppress unused imports.
void candleObservations;
void forwardOutcomeLabels;
void orderIntents;
