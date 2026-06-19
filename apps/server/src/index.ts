import express from 'express';
import cors from 'cors';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { STRATEGY_VERSION } from '@horizon/shared';
import { ENV } from './env';
import { appRouter } from './routers';
import { createContext } from './lib/trpc';
import { createScanWorker } from './jobs/scanJob';
import { scheduleRecurringScan } from './jobs/queue';
import { getBotConfig } from './db/queries';
import { closeDb } from './db';

/**
 * Express server entry point.
 *
 * Mounts the tRPC API under /trpc, exposes a health check, starts the BullMQ
 * scan worker, and re-arms the recurring scan if the bot was running before a
 * restart (durability requirement).
 */
async function main() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: STRATEGY_VERSION, dryRun: ENV.dryRun });
  });

  app.use(
    '/trpc',
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );

  // Start the scan worker (processes the BullMQ queue).
  const worker = createScanWorker();

  // If the bot was running before a restart, re-register the recurring scan.
  try {
    const cfg = await getBotConfig();
    if (cfg.isRunning) {
      await scheduleRecurringScan();
      console.log('[server] bot was running — recurring scan re-armed');
    }
  } catch (err) {
    console.error('[server] could not check bot config on boot:', err);
  }

  const server = app.listen(ENV.port, () => {
    console.log(`[server] Horizon Trade v${STRATEGY_VERSION} listening on :${ENV.port}`);
    console.log(`[server] dry-run: ${ENV.dryRun} | coinbase: ${ENV.coinbaseConfigured} | anthropic: ${ENV.anthropicConfigured}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[server] received ${signal}, shutting down…`);
    server.close();
    await worker.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});
