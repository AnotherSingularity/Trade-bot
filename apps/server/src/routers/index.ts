import { router } from '../lib/trpc';
import { authRouter } from './auth';
import { tradingRouter } from './trading';
import { tokensRouter } from './tokens';
import { historyRouter } from './history';
import { settingsRouter } from './settings';
import { lineageRouter } from './lineage';
import { desktopRouter } from './desktop';

/** Root tRPC router — the single source of truth for the API surface. */
export const appRouter = router({
  auth: authRouter,
  trading: tradingRouter,
  tokens: tokensRouter,
  history: historyRouter,
  settings: settingsRouter,
  lineage: lineageRouter,
  desktop: desktopRouter,
});

export type AppRouter = typeof appRouter;
