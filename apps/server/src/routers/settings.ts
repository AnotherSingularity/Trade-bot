import { STRATEGY_VERSION, TOKEN_COUNT, STRATEGY, type ConnectionTestResult } from '@horizon/shared';
import { testConnection as testCoinbase } from '../trading/coinbase';
import { testConnection as testAnthropic } from '../trading/claude';
import { ENV } from '../env';
import { protectedProcedure, router } from '../lib/trpc';

/** Settings + diagnostics. No editable trading parameters are exposed. */
export const settingsRouter = router({
  info: protectedProcedure.query(() => ({
    strategyVersion: STRATEGY_VERSION,
    tokenCount: TOKEN_COUNT,
    maxOpenPositions: STRATEGY.MAX_OPEN_POSITIONS,
    minVolume24h: STRATEGY.MIN_VOLUME_24HR,
    dryRun: ENV.dryRun,
    coinbaseConfigured: ENV.coinbaseConfigured,
    anthropicConfigured: ENV.anthropicConfigured,
  })),

  testConnection: protectedProcedure.mutation(async (): Promise<ConnectionTestResult> => {
    const [coinbase, anthropic] = await Promise.all([testCoinbase(), testAnthropic()]);
    return { coinbase, anthropic };
  }),
});
