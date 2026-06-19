import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type {
  ActivityLogEntry,
  Position,
  Trade,
  TokenStat,
  TradeOutcome,
  TradeSide,
  TradingMode,
  ActivityType,
} from '@horizon/shared';
import { db } from './index';
import {
  activityLog,
  botConfig,
  positions,
  tokenStats,
  trades,
  type ActivityLogRow,
  type BotConfigRow,
  type PositionRow,
  type TokenStatRow,
  type TradeRow,
} from './schema';

// ---------------------------------------------------------------------------
// Serializers: Drizzle rows (decimals as strings) -> shared API types (numbers)
// ---------------------------------------------------------------------------

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function serializePosition(row: PositionRow): Position {
  return {
    id: row.id,
    token: row.token,
    mode: row.mode,
    entryPrice: Number(row.entryPrice),
    quantity: Number(row.quantity),
    allocationPct: Number(row.allocationPct),
    takeProfitPrice: Number(row.takeProfitPrice),
    stopLossPrice: Number(row.stopLossPrice),
    takeProfitPct: Number(row.takeProfitPct),
    stopLossPct: Number(row.stopLossPct),
    claudeReason: row.claudeReason,
    coinbaseOrderId: row.coinbaseOrderId,
    status: row.status,
    openedAt: row.openedAt.toISOString(),
    closedAt: iso(row.closedAt),
  };
}

export function serializeTrade(row: TradeRow): Trade {
  return {
    id: row.id,
    token: row.token,
    mode: row.mode,
    side: row.side,
    entryPrice: num(row.entryPrice),
    exitPrice: num(row.exitPrice),
    quantity: Number(row.quantity),
    pnlDollars: num(row.pnlDollars),
    pnlPct: num(row.pnlPct),
    outcome: row.outcome,
    claudeReason: row.claudeReason,
    coinbaseOrderId: row.coinbaseOrderId,
    executedAt: row.executedAt.toISOString(),
  };
}

export function serializeActivity(row: ActivityLogRow): ActivityLogEntry {
  return {
    id: row.id,
    type: row.type,
    token: row.token,
    action: row.action,
    detail: row.detail,
    tokensScanned: row.tokensScanned,
    passedVolumeFilter: row.passedVolumeFilter,
    passedSignalThreshold: row.passedSignalThreshold,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeTokenStat(row: TokenStatRow): TokenStat {
  return {
    id: row.id,
    token: row.token,
    totalTrades: row.totalTrades,
    wins: row.wins,
    losses: row.losses,
    winRate: Number(row.winRate),
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Bot config (singleton row, id = 1)
// ---------------------------------------------------------------------------

export async function getBotConfig(): Promise<BotConfigRow> {
  const rows = await db.select().from(botConfig).where(eq(botConfig.id, 1)).limit(1);
  if (rows.length > 0) return rows[0];
  await db.insert(botConfig).values({ id: 1 });
  const created = await db.select().from(botConfig).where(eq(botConfig.id, 1)).limit(1);
  return created[0];
}

export async function updateBotConfig(
  patch: Partial<Pick<BotConfigRow, 'isRunning' | 'isPaused' | 'consecutiveLosses' | 'circuitBreakerUntil'>>,
): Promise<BotConfigRow> {
  await getBotConfig(); // ensure row exists
  await db.update(botConfig).set(patch).where(eq(botConfig.id, 1));
  return getBotConfig();
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export async function getOpenPositions(): Promise<PositionRow[]> {
  return db.select().from(positions).where(eq(positions.status, 'open')).orderBy(desc(positions.openedAt));
}

export async function countOpenPositions(): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(positions)
    .where(eq(positions.status, 'open'));
  return Number(rows[0]?.count ?? 0);
}

export async function getPositionById(id: number): Promise<PositionRow | undefined> {
  const rows = await db.select().from(positions).where(eq(positions.id, id)).limit(1);
  return rows[0];
}

export interface NewPosition {
  token: string;
  mode: TradingMode;
  entryPrice: number;
  quantity: number;
  allocationPct: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  takeProfitPct: number;
  stopLossPct: number;
  claudeReason: string | null;
  coinbaseOrderId: string | null;
}

export async function insertPosition(p: NewPosition): Promise<number> {
  const result = await db.insert(positions).values({
    token: p.token,
    mode: p.mode,
    entryPrice: String(p.entryPrice),
    quantity: String(p.quantity),
    allocationPct: String(p.allocationPct),
    takeProfitPrice: String(p.takeProfitPrice),
    stopLossPrice: String(p.stopLossPrice),
    takeProfitPct: String(p.takeProfitPct),
    stopLossPct: String(p.stopLossPct),
    claudeReason: p.claudeReason,
    coinbaseOrderId: p.coinbaseOrderId,
  });
  return (result as unknown as { insertId: number }[])[0]?.insertId ?? 0;
}

export async function closePosition(id: number): Promise<void> {
  await db
    .update(positions)
    .set({ status: 'closed', closedAt: new Date() })
    .where(eq(positions.id, id));
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export interface NewTrade {
  token: string;
  mode: TradingMode;
  side: TradeSide;
  entryPrice: number | null;
  exitPrice: number | null;
  quantity: number;
  pnlDollars: number | null;
  pnlPct: number | null;
  outcome: TradeOutcome;
  claudeReason: string | null;
  coinbaseOrderId: string | null;
}

export async function insertTrade(t: NewTrade): Promise<number> {
  const result = await db.insert(trades).values({
    token: t.token,
    mode: t.mode,
    side: t.side,
    entryPrice: t.entryPrice === null ? null : String(t.entryPrice),
    exitPrice: t.exitPrice === null ? null : String(t.exitPrice),
    quantity: String(t.quantity),
    pnlDollars: t.pnlDollars === null ? null : String(t.pnlDollars),
    pnlPct: t.pnlPct === null ? null : String(t.pnlPct),
    outcome: t.outcome,
    claudeReason: t.claudeReason,
    coinbaseOrderId: t.coinbaseOrderId,
  });
  return (result as unknown as { insertId: number }[])[0]?.insertId ?? 0;
}

export interface TradePage {
  rows: TradeRow[];
  nextCursor: number | null;
}

export async function getTrades(opts: {
  filter: 'all' | 'wins' | 'losses';
  cursor: number | null;
  limit: number;
}): Promise<TradePage> {
  const conditions = [];
  if (opts.filter === 'wins') conditions.push(eq(trades.outcome, 'win'));
  if (opts.filter === 'losses') conditions.push(eq(trades.outcome, 'loss'));
  if (opts.cursor !== null) conditions.push(lt(trades.id, opts.cursor));

  const where = conditions.length ? and(...conditions) : undefined;
  const rows = await db
    .select()
    .from(trades)
    .where(where)
    .orderBy(desc(trades.id))
    .limit(opts.limit + 1);

  let nextCursor: number | null = null;
  if (rows.length > opts.limit) {
    const last = rows.pop()!;
    nextCursor = last.id;
  }
  return { rows, nextCursor };
}

export async function getTradeSummary(): Promise<{
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnlDollars: number;
}> {
  const rows = await db
    .select({
      totalTrades: sql<number>`count(*)`,
      wins: sql<number>`sum(case when ${trades.outcome} = 'win' then 1 else 0 end)`,
      losses: sql<number>`sum(case when ${trades.outcome} = 'loss' then 1 else 0 end)`,
      totalPnlDollars: sql<number>`coalesce(sum(${trades.pnlDollars}), 0)`,
    })
    .from(trades);
  const r = rows[0];
  return {
    totalTrades: Number(r?.totalTrades ?? 0),
    wins: Number(r?.wins ?? 0),
    losses: Number(r?.losses ?? 0),
    totalPnlDollars: Number(r?.totalPnlDollars ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

export interface NewActivity {
  type: ActivityType;
  token?: string | null;
  action: string;
  detail: string;
  tokensScanned?: number | null;
  passedVolumeFilter?: number | null;
  passedSignalThreshold?: number | null;
}

export async function logActivity(a: NewActivity): Promise<void> {
  await db.insert(activityLog).values({
    type: a.type,
    token: a.token ?? null,
    action: a.action,
    detail: a.detail,
    tokensScanned: a.tokensScanned ?? null,
    passedVolumeFilter: a.passedVolumeFilter ?? null,
    passedSignalThreshold: a.passedSignalThreshold ?? null,
  });
}

export async function getRecentActivity(limit = 30, cursor: number | null = null): Promise<{
  rows: ActivityLogRow[];
  nextCursor: number | null;
}> {
  const where = cursor !== null ? lt(activityLog.id, cursor) : undefined;
  const rows = await db
    .select()
    .from(activityLog)
    .where(where)
    .orderBy(desc(activityLog.id))
    .limit(limit + 1);
  let nextCursor: number | null = null;
  if (rows.length > limit) {
    const last = rows.pop()!;
    nextCursor = last.id;
  }
  return { rows, nextCursor };
}

// ---------------------------------------------------------------------------
// Token stats
// ---------------------------------------------------------------------------

export async function getAllTokenStats(): Promise<TokenStatRow[]> {
  return db.select().from(tokenStats);
}

export async function getTokenStat(token: string): Promise<TokenStatRow | undefined> {
  const rows = await db.select().from(tokenStats).where(eq(tokenStats.token, token)).limit(1);
  return rows[0];
}

export async function setTokenActive(token: string, isActive: boolean): Promise<void> {
  const existing = await getTokenStat(token);
  if (existing) {
    await db.update(tokenStats).set({ isActive }).where(eq(tokenStats.token, token));
  } else {
    await db.insert(tokenStats).values({ token, isActive });
  }
}

/** Records a trade outcome against a token's running stats, recomputing winRate. */
export async function recordTokenOutcome(token: string, outcome: 'win' | 'loss'): Promise<void> {
  const existing = await getTokenStat(token);
  const wins = (existing?.wins ?? 0) + (outcome === 'win' ? 1 : 0);
  const losses = (existing?.losses ?? 0) + (outcome === 'loss' ? 1 : 0);
  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

  if (existing) {
    await db
      .update(tokenStats)
      .set({ wins, losses, totalTrades, winRate: winRate.toFixed(2) })
      .where(eq(tokenStats.token, token));
  } else {
    await db
      .insert(tokenStats)
      .values({ token, wins, losses, totalTrades, winRate: winRate.toFixed(2) });
  }
}

export { gt }; // re-export for convenience in other modules if needed
