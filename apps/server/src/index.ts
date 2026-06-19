import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { STRATEGY_VERSION } from '@horizon/shared';
import { ENV } from './env';
import { appRouter } from './routers';
import { createContext } from './lib/trpc';
import { createScanWorker } from './jobs/scanJob';
import { scheduleRecurringScan } from './jobs/queue';
import { getBotConfig } from './db/queries';
import { authenticate, getBotStatusDTO } from './lib/services';
import { requireAuth } from './middleware/auth';
import { closeDb } from './db';

/**
 * Express server entry point.
 *
 * Mounts the type-safe tRPC API under /trpc, a REST compatibility layer under
 * /api (health, auth, bot status — for curl/integrations), starts the BullMQ
 * scan worker, and re-arms the recurring scan if the bot was running before a
 * restart (durability requirement).
 */
async function main() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // --- Health (both bare and /api-prefixed) ---
  const healthHandler = (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: STRATEGY_VERSION,
      dryRun: ENV.dryRun,
      timestamp: new Date().toISOString(),
    });
  };
  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  // --- REST compatibility layer (mirrors core tRPC procedures) ---
  app.post('/api/auth/login', async (req: Request, res: Response) => {
    const password = req.body?.password as string | undefined;
    if (!password) {
      res.status(400).json({ error: 'password is required' });
      return;
    }
    try {
      const token = await authenticate(password);
      if (!token) {
        res.status(401).json({ error: 'Invalid password' });
        return;
      }
      res.json({ token, expiresIn: 0 });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Login failed' });
    }
  });

  app.get('/api/trading/status', requireAuth, async (_req: Request, res: Response) => {
    res.json(await getBotStatusDTO());
  });

  // --- tRPC API (primary surface, consumed by the mobile app) ---
  app.use(
    '/trpc',
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );

  // Start the scan worker (processes the BullMQ queue).
  const worker = createScanWorker();
  worker.on('ready', () => {
    console.log('[server] BullMQ scan worker ready (connected to Redis)');
  });

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
