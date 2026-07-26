import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  dailyLossStates,
  portfolioDrawdownStates,
  weeklyLossStates,
  type DailyLossStateRow,
  type PortfolioDrawdownStateRow,
  type WeeklyLossStateRow,
} from '../../db/schema';
import type {
  DailyLossStateInput,
  DrawdownStateInput,
  PortfolioRiskInput,
  WeeklyLossStateInput,
} from './inputs';
import { invalidMeasurement, validMeasurement, type RiskMeasurement } from './contract';

/**
 * Phase 2C §P — Persisted daily/weekly loss + drawdown states.
 *
 * These states are backed by the ledger and completed round trips —
 * NEVER by ticker-derived unrealized gain. Open unrealized gain
 * cannot erase realized loss. Period boundaries are UTC-based and
 * carry the policyVersion that produced them.
 */

export const LOSS_STATE_POLICY_VERSION = 'p2c-loss-1';

export function periodStartUtcDay(now: Date): Date {
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return utc;
}

export function periodEndUtcDay(now: Date): Date {
  const start = periodStartUtcDay(now);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

export function periodStartUtcWeek(now: Date): Date {
  // ISO week: Monday 00:00 UTC as period start.
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (utc.getUTCDay() + 6) % 7; // Monday=0
  utc.setUTCDate(utc.getUTCDate() - dow);
  return utc;
}

export function periodEndUtcWeek(now: Date): Date {
  const start = periodStartUtcWeek(now);
  return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function persistDailyLossState(
  input: DailyLossStateInput,
  status: 'open' | 'warning' | 'hard_breached' | 'closed' | 'invalid',
): Promise<DailyLossStateRow> {
  const existing = await db
    .select()
    .from(dailyLossStates)
    .where(
      and(
        eq(dailyLossStates.policyVersion, LOSS_STATE_POLICY_VERSION),
        eq(dailyLossStates.periodStart, input.periodStart),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(dailyLossStates)
      .set({
        endingEquity: Number(input.currentEquity).toFixed(10),
        realizedNetPnl: Number(input.realizedNetPnl).toFixed(10),
        status,
        dataAvailableAt: input.dataAvailableAt,
      })
      .where(eq(dailyLossStates.id, existing[0].id));
    const [refreshed] = await db.select().from(dailyLossStates).where(eq(dailyLossStates.id, existing[0].id));
    return refreshed;
  }
  await db.insert(dailyLossStates).values({
    policyVersion: LOSS_STATE_POLICY_VERSION,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    startingEquity: Number(input.startingEquity).toFixed(10),
    endingEquity: Number(input.currentEquity).toFixed(10),
    realizedNetPnl: Number(input.realizedNetPnl).toFixed(10),
    fees: '0',
    status,
    dataAvailableAt: input.dataAvailableAt,
  });
  const [row] = await db
    .select()
    .from(dailyLossStates)
    .where(
      and(
        eq(dailyLossStates.policyVersion, LOSS_STATE_POLICY_VERSION),
        eq(dailyLossStates.periodStart, input.periodStart),
      ),
    )
    .limit(1);
  return row;
}

export async function persistWeeklyLossState(
  input: WeeklyLossStateInput,
  status: 'open' | 'warning' | 'hard_breached' | 'closed' | 'invalid',
): Promise<WeeklyLossStateRow> {
  const existing = await db
    .select()
    .from(weeklyLossStates)
    .where(
      and(
        eq(weeklyLossStates.policyVersion, LOSS_STATE_POLICY_VERSION),
        eq(weeklyLossStates.periodStart, input.periodStart),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(weeklyLossStates)
      .set({
        endingEquity: Number(input.currentEquity).toFixed(10),
        realizedNetPnl: Number(input.realizedNetPnl).toFixed(10),
        status,
        dataAvailableAt: input.dataAvailableAt,
      })
      .where(eq(weeklyLossStates.id, existing[0].id));
    const [refreshed] = await db.select().from(weeklyLossStates).where(eq(weeklyLossStates.id, existing[0].id));
    return refreshed;
  }
  await db.insert(weeklyLossStates).values({
    policyVersion: LOSS_STATE_POLICY_VERSION,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    startingEquity: Number(input.startingEquity).toFixed(10),
    endingEquity: Number(input.currentEquity).toFixed(10),
    realizedNetPnl: Number(input.realizedNetPnl).toFixed(10),
    fees: '0',
    status,
    dataAvailableAt: input.dataAvailableAt,
  });
  const [row] = await db
    .select()
    .from(weeklyLossStates)
    .where(
      and(
        eq(weeklyLossStates.policyVersion, LOSS_STATE_POLICY_VERSION),
        eq(weeklyLossStates.periodStart, input.periodStart),
      ),
    )
    .limit(1);
  return row;
}

export async function persistDrawdownState(
  input: DrawdownStateInput,
  status: 'healthy' | 'warning' | 'hard_breached' | 'invalid',
): Promise<PortfolioDrawdownStateRow> {
  await db.insert(portfolioDrawdownStates).values({
    policyVersion: LOSS_STATE_POLICY_VERSION,
    peakEquity: Number(input.peakEquity).toFixed(10),
    currentEquity: Number(input.currentEquity).toFixed(10),
    currentDrawdown: Number(input.currentDrawdown).toFixed(10),
    maximumDrawdown: Number(input.maximumDrawdown).toFixed(10),
    peakEquityAt: input.peakEquityAt,
    status,
    dataAvailableAt: input.dataAvailableAt,
  });
  // Return the row we just inserted (latest by createdAt for this policy).
  const rows = await db
    .select()
    .from(portfolioDrawdownStates)
    .where(eq(portfolioDrawdownStates.policyVersion, LOSS_STATE_POLICY_VERSION));
  return rows[rows.length - 1];
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

export function measureDailyLoss(input: PortfolioRiskInput): RiskMeasurement<number> {
  const meta = {
    measurementKey: 'daily.realized_loss',
    unit: 'quote',
    observedAt: input.observedAt,
    dataAvailableAt: input.dailyLossState.dataAvailableAt,
    policyVersion: 'p2c-risk-1',
    modelVersion: LOSS_STATE_POLICY_VERSION,
    inputHash: `daily:${input.dailyLossState.periodStart.toISOString()}`,
  };
  const start = Number(input.dailyLossState.startingEquity);
  const cur = Number(input.dailyLossState.currentEquity);
  const realized = Number(input.dailyLossState.realizedNetPnl);
  if (!Number.isFinite(start) || !Number.isFinite(cur) || !Number.isFinite(realized)) {
    return invalidMeasurement<number>('invalid_input', {
      ...meta,
      failureReason: 'non-finite equity or realized pnl',
    });
  }
  // Open gain cannot erase realized loss — use realized pnl only.
  const loss = realized < 0 ? -realized : 0;
  return validMeasurement<number>({
    ...meta,
    value: loss,
    confidence: 1,
    sampleCount: 1,
    diagnostics: { startingEquity: start, currentEquity: cur, realizedNetPnl: realized },
  });
}

export function measureWeeklyLoss(input: PortfolioRiskInput): RiskMeasurement<number> {
  const meta = {
    measurementKey: 'weekly.realized_loss',
    unit: 'quote',
    observedAt: input.observedAt,
    dataAvailableAt: input.weeklyLossState.dataAvailableAt,
    policyVersion: 'p2c-risk-1',
    modelVersion: LOSS_STATE_POLICY_VERSION,
    inputHash: `weekly:${input.weeklyLossState.periodStart.toISOString()}`,
  };
  const realized = Number(input.weeklyLossState.realizedNetPnl);
  if (!Number.isFinite(realized)) {
    return invalidMeasurement<number>('invalid_input', {
      ...meta,
      failureReason: 'non-finite realized pnl',
    });
  }
  const loss = realized < 0 ? -realized : 0;
  return validMeasurement<number>({
    ...meta,
    value: loss,
    confidence: 1,
    sampleCount: 1,
    diagnostics: { realizedNetPnl: realized },
  });
}

export function measureDrawdown(input: PortfolioRiskInput): RiskMeasurement<number> {
  const meta = {
    measurementKey: 'drawdown.current',
    unit: 'quote',
    observedAt: input.observedAt,
    dataAvailableAt: input.drawdownState.dataAvailableAt,
    policyVersion: 'p2c-risk-1',
    modelVersion: LOSS_STATE_POLICY_VERSION,
    inputHash: `dd:${input.drawdownState.peakEquityAt.toISOString()}`,
  };
  const peak = Number(input.drawdownState.peakEquity);
  const cur = Number(input.drawdownState.currentEquity);
  if (!Number.isFinite(peak) || !Number.isFinite(cur) || peak <= 0) {
    return invalidMeasurement<number>('invalid_input', {
      ...meta,
      failureReason: 'invalid peak/current equity',
    });
  }
  const drawdown = Math.max(0, peak - cur);
  return validMeasurement<number>({
    ...meta,
    value: drawdown,
    confidence: 1,
    sampleCount: 1,
    diagnostics: {
      peakEquity: peak,
      currentEquity: cur,
      ratio: peak > 0 ? drawdown / peak : 0,
      maximumDrawdown: Number(input.drawdownState.maximumDrawdown),
    },
  });
}
