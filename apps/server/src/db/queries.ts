import { and, desc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type {
  ActivityLogEntry,
  Position,
  Trade,
  TokenStat,
  ActivityType,
} from '@horizon/shared';
import { db } from './index';
import {
  activityLog,
  botConfig,
  cashLedger,
  fills,
  orderIntents,
  positions,
  roundTrips,
  tokenStats,
  type ActivityLogRow,
  type BotConfigRow,
  type CashLedgerInsert,
  type FillRow,
  type OrderIntentRow,
  type PositionInsert,
  type PositionRow,
  type RoundTripInsert,
  type RoundTripRow,
  type TokenStatRow,
  type TradeRow,
} from './schema';

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** Position row → mobile-shaped Position DTO (uses actual-fill fields). */
export function serializePosition(row: PositionRow): Position {
  return {
    id: row.id,
    token: row.token,
    mode: row.mode,
    entryPrice: Number(row.avgEntryPrice),
    quantity: Number(row.filledQuantity),
    allocationPct: Number(row.allocationPct),
    takeProfitPrice: Number(row.takeProfitPrice),
    stopLossPrice: Number(row.stopLossPrice),
    takeProfitPct: Number(row.takeProfitPct),
    stopLossPct: Number(row.stopLossPct),
    claudeReason: row.claudeReason,
    coinbaseOrderId: null,
    status: row.status,
    openedAt: row.openedAt.toISOString(),
    closedAt: iso(row.closedAt),
  };
}

/** Legacy trades row → DTO. */
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

/** Round-trip → mobile Trade DTO (post-Phase-0 source of truth for history). */
export function roundTripToTradeDTO(row: RoundTripRow): Trade {
  const pnl = Number(row.realizedNetPnl);
  return {
    id: row.id,
    token: row.token,
    mode: row.mode,
    side: 'sell',
    entryPrice: Number(row.entryValueGross),
    exitPrice: Number(row.exitValueGross),
    quantity: 0,
    pnlDollars: pnl,
    pnlPct: Number(row.realizedNetPnlPct),
    outcome: row.outcome === 'flat' ? 'loss' : row.outcome, // flats are non-winning per policy
    claudeReason: row.exitReason,
    coinbaseOrderId: null,
    executedAt: row.closedAt.toISOString(),
  };
}

export function serializeActivity(row: ActivityLogRow): ActivityLogEntry {
  return {
    id: row.id,
    type:
      row.type === 'reconciliation' || row.type === 'security'
        ? 'system'
        : (row.type as ActivityType),
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
// Bot config
// ---------------------------------------------------------------------------

export async function getBotConfig(): Promise<BotConfigRow> {
  const rows = await db.select().from(botConfig).where(eq(botConfig.id, 1)).limit(1);
  if (rows.length > 0) return rows[0];
  await db.insert(botConfig).values({ id: 1 });
  const created = await db.select().from(botConfig).where(eq(botConfig.id, 1)).limit(1);
  return created[0];
}

export async function updateBotConfig(
  patch: Partial<
    Pick<
      BotConfigRow,
      | 'isRunning'
      | 'isPaused'
      | 'consecutiveLosses'
      | 'circuitBreakerUntil'
      | 'reconciliationStatus'
      | 'reconciliationDetail'
      | 'reconciledAt'
    >
  >,
): Promise<BotConfigRow> {
  await getBotConfig();
  await db.update(botConfig).set(patch).where(eq(botConfig.id, 1));
  return getBotConfig();
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export async function getOpenPositions(): Promise<PositionRow[]> {
  return db
    .select()
    .from(positions)
    .where(eq(positions.status, 'open'))
    .orderBy(desc(positions.openedAt));
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

export async function getOpenPositionForToken(token: string): Promise<PositionRow | undefined> {
  const rows = await db
    .select()
    .from(positions)
    .where(and(eq(positions.token, token), eq(positions.status, 'open')))
    .limit(1);
  return rows[0];
}

export async function insertPosition(p: PositionInsert): Promise<number> {
  const result = await db.insert(positions).values(p);
  return (result as unknown as { insertId: number }[])[0]?.insertId ?? 0;
}

/** Optimistic-locking update: only updates when the version matches. */
export async function updatePositionVersioned(
  id: number,
  currentVersion: number,
  patch: Partial<PositionRow>,
): Promise<boolean> {
  const nextVersion = currentVersion + 1;
  const result = await db
    .update(positions)
    .set({ ...patch, version: nextVersion })
    .where(and(eq(positions.id, id), eq(positions.version, currentVersion)));
  const affected = (result as unknown as { affectedRows: number }[])[0]?.affectedRows ?? 0;
  return affected > 0;
}

export async function markPositionClosed(id: number, closedAt: Date): Promise<void> {
  await db
    .update(positions)
    .set({ status: 'closed', lifecycleState: 'closed', closedAt })
    .where(eq(positions.id, id));
}

// ---------------------------------------------------------------------------
// Order intents
// ---------------------------------------------------------------------------

export type NewOrderIntent = typeof orderIntents.$inferInsert;

export async function insertOrderIntent(intent: NewOrderIntent): Promise<number> {
  const result = await db.insert(orderIntents).values(intent);
  return (result as unknown as { insertId: number }[])[0]?.insertId ?? 0;
}

export async function updateOrderIntent(
  id: number,
  patch: Partial<OrderIntentRow>,
): Promise<void> {
  await db.update(orderIntents).set(patch).where(eq(orderIntents.id, id));
}

export async function getOrderIntent(id: number): Promise<OrderIntentRow | undefined> {
  const rows = await db.select().from(orderIntents).where(eq(orderIntents.id, id)).limit(1);
  return rows[0];
}

export async function findOrderIntentByClientOrderId(
  clientOrderId: string,
): Promise<OrderIntentRow | undefined> {
  const rows = await db
    .select()
    .from(orderIntents)
    .where(eq(orderIntents.clientOrderId, clientOrderId))
    .limit(1);
  return rows[0];
}

export async function getNonTerminalOrderIntents(): Promise<OrderIntentRow[]> {
  return db
    .select()
    .from(orderIntents)
    .where(
      and(
        ne(orderIntents.state, 'filled'),
        ne(orderIntents.state, 'rejected'),
        ne(orderIntents.state, 'canceled'),
        ne(orderIntents.state, 'failed'),
      ),
    );
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

export type NewFill = typeof fills.$inferInsert;

export async function insertFill(fill: NewFill): Promise<number> {
  // Idempotent upsert on exchangeFillId.
  await db
    .insert(fills)
    .values(fill)
    .onDuplicateKeyUpdate({ set: { rawResponse: fill.rawResponse ?? null } });
  const rows = await db
    .select()
    .from(fills)
    .where(eq(fills.exchangeFillId, fill.exchangeFillId))
    .limit(1);
  return rows[0]?.id ?? 0;
}

export async function getFillsForOrderIntent(orderIntentId: number): Promise<FillRow[]> {
  return db.select().from(fills).where(eq(fills.orderIntentId, orderIntentId));
}

/** Weighted-average fill price + totals for a set of fills. */
export function aggregateFills(fillRows: FillRow[]): {
  filledSize: number;
  weightedAvgPrice: number;
  totalFees: number;
  quoteValue: number;
} {
  if (fillRows.length === 0) {
    return { filledSize: 0, weightedAvgPrice: 0, totalFees: 0, quoteValue: 0 };
  }
  let filledSize = 0;
  let quoteValue = 0;
  let totalFees = 0;
  for (const f of fillRows) {
    const size = Number(f.filledSize);
    const price = Number(f.fillPrice);
    filledSize += size;
    quoteValue += size * price;
    totalFees += Number(f.fee);
  }
  const weightedAvgPrice = filledSize === 0 ? 0 : quoteValue / filledSize;
  return { filledSize, weightedAvgPrice, totalFees, quoteValue };
}

// ---------------------------------------------------------------------------
// Round-trips
// ---------------------------------------------------------------------------

export async function insertRoundTrip(rt: RoundTripInsert): Promise<number> {
  const result = await db.insert(roundTrips).values(rt);
  return (result as unknown as { insertId: number }[])[0]?.insertId ?? 0;
}

export async function getRoundTripSummary(): Promise<{
  totalTrades: number;
  wins: number;
  losses: number;
  flats: number;
  totalPnlDollars: number;
}> {
  const rows = await db
    .select({
      totalTrades: sql<number>`count(*)`,
      wins: sql<number>`sum(case when ${roundTrips.outcome} = 'win' then 1 else 0 end)`,
      losses: sql<number>`sum(case when ${roundTrips.outcome} = 'loss' then 1 else 0 end)`,
      flats: sql<number>`sum(case when ${roundTrips.outcome} = 'flat' then 1 else 0 end)`,
      totalPnlDollars: sql<number>`coalesce(sum(${roundTrips.realizedNetPnl}), 0)`,
    })
    .from(roundTrips);
  const r = rows[0];
  return {
    totalTrades: Number(r?.totalTrades ?? 0),
    wins: Number(r?.wins ?? 0),
    losses: Number(r?.losses ?? 0),
    flats: Number(r?.flats ?? 0),
    totalPnlDollars: Number(r?.totalPnlDollars ?? 0),
  };
}

export async function getRoundTrips(opts: {
  filter: 'all' | 'wins' | 'losses';
  cursor: number | null;
  limit: number;
}): Promise<{ rows: RoundTripRow[]; nextCursor: number | null }> {
  const conds = [];
  if (opts.filter === 'wins') conds.push(eq(roundTrips.outcome, 'win'));
  if (opts.filter === 'losses') conds.push(eq(roundTrips.outcome, 'loss'));
  if (opts.cursor !== null) conds.push(lt(roundTrips.id, opts.cursor));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db
    .select()
    .from(roundTrips)
    .where(where)
    .orderBy(desc(roundTrips.id))
    .limit(opts.limit + 1);
  let nextCursor: number | null = null;
  if (rows.length > opts.limit) {
    const last = rows.pop()!;
    nextCursor = last.id;
  }
  return { rows, nextCursor };
}

// ---------------------------------------------------------------------------
// Cash ledger
// ---------------------------------------------------------------------------

export async function recordCash(entry: CashLedgerInsert): Promise<void> {
  await db.insert(cashLedger).values(entry);
}

export async function getCashBalance(dryRun: boolean): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${cashLedger.deltaUsd}), 0)` })
    .from(cashLedger)
    .where(eq(cashLedger.dryRun, dryRun));
  return Number(rows[0]?.total ?? 0);
}

export async function ensureInitialFund(dryRun: boolean, amountUsd: number): Promise<void> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(cashLedger)
    .where(and(eq(cashLedger.dryRun, dryRun), eq(cashLedger.reason, 'initial_fund')));
  if (Number(rows[0]?.n ?? 0) > 0) return;
  await recordCash({
    deltaUsd: String(amountUsd),
    reason: 'initial_fund',
    dryRun,
    detail: `Initial funding of $${amountUsd} for ${dryRun ? 'dry-run' : 'live'} account`,
  });
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

export interface NewActivity {
  type: ActivityType | 'reconciliation' | 'security';
  severity?: 'info' | 'warn' | 'high' | 'critical';
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
    severity: a.severity ?? 'info',
    token: a.token ?? null,
    action: a.action,
    detail: a.detail,
    tokensScanned: a.tokensScanned ?? null,
    passedVolumeFilter: a.passedVolumeFilter ?? null,
    passedSignalThreshold: a.passedSignalThreshold ?? null,
  });
}

export async function getRecentActivity(
  limit = 30,
  cursor: number | null = null,
): Promise<{ rows: ActivityLogRow[]; nextCursor: number | null }> {
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
// Token stats + shrinkage
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

/**
 * Bayesian-shrunk win rate for prioritization. A single win no longer looks
 * like 100%: it's shrunk toward the beta(priorAlpha, priorBeta) prior mean.
 */
export function shrunkWinRate(
  wins: number,
  losses: number,
  priorAlpha = 5,
  priorBeta = 5,
): number {
  return ((wins + priorAlpha) / (wins + losses + priorAlpha + priorBeta)) * 100;
}

export { and, eq, isNull, or };
