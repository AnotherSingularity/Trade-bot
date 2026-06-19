import { z } from 'zod';
import type { PaginatedTrades, TradeHistorySummary } from '@horizon/shared';
import { getTradeSummary, getTrades, serializeTrade } from '../db/queries';
import { protectedProcedure, router } from '../lib/trpc';

/** Trade history with infinite-scroll pagination + filter tabs + summary. */
export const historyRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        filter: z.enum(['all', 'wins', 'losses']).default('all'),
        cursor: z.number().nullish(),
        limit: z.number().min(1).max(50).default(20),
      }),
    )
    .query(async ({ input }): Promise<PaginatedTrades> => {
      const { rows, nextCursor } = await getTrades({
        filter: input.filter,
        cursor: input.cursor ?? null,
        limit: input.limit,
      });
      const s = await getTradeSummary();
      const summary: TradeHistorySummary = {
        totalTrades: s.totalTrades,
        wins: s.wins,
        losses: s.losses,
        winRate: s.totalTrades > 0 ? (s.wins / (s.wins + s.losses || 1)) * 100 : 0,
        totalPnlDollars: s.totalPnlDollars,
      };
      return { trades: rows.map(serializeTrade), nextCursor, summary };
    }),

  summary: protectedProcedure.query(async (): Promise<TradeHistorySummary> => {
    const s = await getTradeSummary();
    return {
      totalTrades: s.totalTrades,
      wins: s.wins,
      losses: s.losses,
      winRate: s.totalTrades > 0 ? (s.wins / (s.wins + s.losses || 1)) * 100 : 0,
      totalPnlDollars: s.totalPnlDollars,
    };
  }),
});
