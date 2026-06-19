import { z } from 'zod';
import {
  type BotStatus,
  type PortfolioSummary,
  type Position,
  type ActivityLogEntry,
} from '@horizon/shared';
import {
  getBotConfig,
  getOpenPositions,
  getRecentActivity,
  logActivity,
  serializeActivity,
  serializePosition,
  updateBotConfig,
} from '../db/queries';
import { getCashBalance, getProduct } from '../trading/coinbase';
import { closePositionAtPrice } from '../trading/executor';
import { scheduleRecurringScan, triggerImmediateScan } from '../jobs/queue';
import { getBotStatusDTO } from '../lib/services';
import { ENV } from '../env';
import { protectedProcedure, router } from '../lib/trpc';

/** Builds the live BotStatus DTO (shared with the REST layer). */
const buildBotStatus = (): Promise<BotStatus> => getBotStatusDTO();

/** Enriches open positions with live price + unrealized P&L. */
async function buildOpenPositions(): Promise<Position[]> {
  const rows = await getOpenPositions();
  const result: Position[] = [];
  for (const row of rows) {
    const pos = serializePosition(row);
    try {
      const product = await getProduct(row.token);
      const currentPrice = Number(product.price);
      pos.currentPrice = currentPrice;
      pos.unrealizedPnlDollars = (currentPrice - pos.entryPrice) * pos.quantity;
      pos.unrealizedPnlPct =
        pos.entryPrice === 0 ? 0 : ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    } catch {
      // Leave derived fields undefined if price lookup fails.
    }
    result.push(pos);
  }
  return result;
}

export const tradingRouter = router({
  status: protectedProcedure.query(async (): Promise<BotStatus> => buildBotStatus()),

  start: protectedProcedure.mutation(async (): Promise<BotStatus> => {
    await updateBotConfig({ isRunning: true, isPaused: false });
    await scheduleRecurringScan();
    await logActivity({ type: 'system', action: 'BOT_START', detail: 'Bot started' });
    await triggerImmediateScan();
    return buildBotStatus();
  }),

  stop: protectedProcedure.mutation(async (): Promise<BotStatus> => {
    await updateBotConfig({ isRunning: false, isPaused: false });
    await logActivity({ type: 'system', action: 'BOT_STOP', detail: 'Bot stopped' });
    return buildBotStatus();
  }),

  pause: protectedProcedure.mutation(async (): Promise<BotStatus> => {
    const cfg = await getBotConfig();
    const isPaused = !cfg.isPaused;
    await updateBotConfig({ isPaused });
    await logActivity({
      type: 'system',
      action: isPaused ? 'BOT_PAUSE' : 'BOT_RESUME',
      detail: isPaused ? 'Bot paused' : 'Bot resumed',
    });
    return buildBotStatus();
  }),

  scanNow: protectedProcedure.mutation(async (): Promise<{ queued: boolean }> => {
    await triggerImmediateScan();
    await logActivity({ type: 'system', action: 'SCAN_TRIGGERED', detail: 'Manual scan queued' });
    return { queued: true };
  }),

  portfolio: protectedProcedure.query(async (): Promise<PortfolioSummary> => {
    const openPositions = await buildOpenPositions();
    const positionsValue = openPositions.reduce(
      (sum, p) => sum + (p.currentPrice ?? p.entryPrice) * p.quantity,
      0,
    );
    const unrealizedPnlDollars = openPositions.reduce(
      (sum, p) => sum + (p.unrealizedPnlDollars ?? 0),
      0,
    );

    let cashBalance = 10_000; // demo bankroll fallback
    if (!ENV.dryRun && ENV.coinbaseConfigured) {
      try {
        cashBalance = await getCashBalance();
      } catch {
        // keep fallback
      }
    }

    const totalValue = cashBalance + positionsValue;
    const costBasis = positionsValue - unrealizedPnlDollars;
    return {
      totalValue,
      cashBalance,
      positionsValue,
      unrealizedPnlDollars,
      unrealizedPnlPct: costBasis === 0 ? 0 : (unrealizedPnlDollars / costBasis) * 100,
      openPositions,
    };
  }),

  positions: protectedProcedure.query(async (): Promise<Position[]> => buildOpenPositions()),

  activity: protectedProcedure
    .input(
      z
        .object({ limit: z.number().min(1).max(100).default(30), cursor: z.number().nullish() })
        .optional(),
    )
    .query(async ({ input }): Promise<{ items: ActivityLogEntry[]; nextCursor: number | null }> => {
      const { rows, nextCursor } = await getRecentActivity(
        input?.limit ?? 30,
        input?.cursor ?? null,
      );
      return { items: rows.map(serializeActivity), nextCursor };
    }),

  closePosition: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }): Promise<{ closed: boolean }> => {
      const rows = await getOpenPositions();
      const position = rows.find((p) => p.id === input.id);
      if (!position) return { closed: false };
      const product = await getProduct(position.token);
      await closePositionAtPrice(position, Number(product.price), 'manual');
      return { closed: true };
    }),
});
