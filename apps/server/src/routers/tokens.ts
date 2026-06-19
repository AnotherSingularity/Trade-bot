import { z } from 'zod';
import { STRATEGY, TOKEN_UNIVERSE, type TokenUniverseEntry } from '@horizon/shared';
import { getAllTokenStats, setTokenActive } from '../db/queries';
import { getProduct } from '../trading/coinbase';
import { protectedProcedure, router } from '../lib/trpc';

/**
 * Token universe routes: live market data merged with persisted per-token stats.
 */
export const tokensRouter = router({
  list: protectedProcedure.query(async (): Promise<TokenUniverseEntry[]> => {
    const stats = await getAllTokenStats();
    const statByToken = new Map(stats.map((s) => [s.token, s]));

    const entries = await Promise.all(
      TOKEN_UNIVERSE.map(async (token): Promise<TokenUniverseEntry> => {
        const stat = statByToken.get(token);
        let price: number | null = null;
        let volume24h: number | null = null;
        let changePct24h: number | null = null;
        try {
          const product = await getProduct(token);
          price = Number(product.price);
          volume24h = Number(product.volume_24h) * price;
          changePct24h = Number(product.price_percentage_change_24h);
        } catch {
          // Live data unavailable — return nulls; client shows "—".
        }
        return {
          token,
          price,
          volume24h,
          changePct24h,
          passesVolumeFilter: volume24h !== null && volume24h >= STRATEGY.MIN_VOLUME_24HR,
          totalTrades: stat?.totalTrades ?? 0,
          winRate: stat && stat.totalTrades > 0 ? Number(stat.winRate) : null,
          isActive: stat?.isActive ?? true,
        };
      }),
    );
    return entries;
  }),

  setActive: protectedProcedure
    .input(z.object({ token: z.string(), isActive: z.boolean() }))
    .mutation(async ({ input }): Promise<{ ok: boolean }> => {
      await setTokenActive(input.token, input.isActive);
      return { ok: true };
    }),

  volumeFilter: protectedProcedure.query(() => ({
    minVolume24h: STRATEGY.MIN_VOLUME_24HR,
  })),
});
