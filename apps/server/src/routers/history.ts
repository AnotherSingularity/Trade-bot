import { z } from 'zod';
import type { PaginatedTrades, TradeHistorySummary } from '@horizon/shared';
import { getRoundTrips, getRoundTripSummary, roundTripToTradeDTO } from '../db/queries';
import { protectedProcedure, router } from '../lib/trpc';

/**
 * Trade history — Phase 0 sources counts, win rate, and P&L from `round_trips`.
 * Each round-trip is ONE completed position; entry+exit are not double-counted.
 * Flats (zero P&L) are counted as neither wins nor losses in `winRate`.
 */
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
      const { rows, nextCursor } = await getRoundTrips({
        filter: input.filter,
        cursor: input.cursor ?? null,
        limit: input.limit,
      });
      const s = await getRoundTripSummary();
      const denom = s.wins + s.losses;
      const summary: TradeHistorySummary = {
        totalTrades: s.totalTrades,
        wins: s.wins,
        losses: s.losses,
        winRate: denom > 0 ? (s.wins / denom) * 100 : 0,
        totalPnlDollars: s.totalPnlDollars,
      };
      return { trades: rows.map(roundTripToTradeDTO), nextCursor, summary };
    }),

  summary: protectedProcedure.query(async (): Promise<TradeHistorySummary> => {
    const s = await getRoundTripSummary();
    const denom = s.wins + s.losses;
    return {
      totalTrades: s.totalTrades,
      wins: s.wins,
      losses: s.losses,
      winRate: denom > 0 ? (s.wins / denom) * 100 : 0,
      totalPnlDollars: s.totalPnlDollars,
    };
  }),
});
