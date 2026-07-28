import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { STRATEGY_VERSION } from '@horizon/shared';
import { ENV } from './env';
import { appRouter } from './routers';
import { createContext } from './lib/trpc';
import { createScanWorker } from './jobs/scanJob';
import { scheduleRecurringScan } from './jobs/queue';
import { getBotConfig, logActivity, updateBotConfig } from './db/queries';
import { authenticate, checkLoginRate, getBotStatusDTO } from './lib/services';
import { requireAuth } from './middleware/auth';
import { closeDb } from './db';
import { reconcileOnStartup } from './trading/reconciler';
import { withLease, RECONCILE_LEASE_KEY } from './jobs/lease';
import { desktopOperatorRouter, desktopRouter, systemReadinessRouter } from './routes/desktop';
import { operatorAuthRouter } from './routes/auth';
import { nativeInductionRouter, shouldMountNativeInduction } from './routes/nativeInduction';
import { nativeDiagnosticsRouter, shouldMountNativeDiagnostics } from './routes/nativeDiagnostics';
import { configureBootstrapToken } from './auth/bootstrap';

/**
 * Express server entry point — Phase 0.
 *
 * Boot sequence:
 *   1. HTTP/tRPC/REST surfaces come up (so /health responds immediately).
 *   2. Startup reconciler runs under a Redis lease (only one replica).
 *      Entries stay disabled until reconciliation succeeds.
 *   3. If the bot was `isRunning` before restart, the recurring scan is
 *      re-armed (risk management + entries as per the reconciled state).
 */
async function main() {
  // Stage 2 §2 — configure bootstrap channel BEFORE any router is
  // mounted. Production boot refuses to serve bootstrap endpoints
  // without a valid token; tests may skip if unset (routes will
  // return 503 for bootstrap-scoped calls until configured).
  configureBootstrapToken(ENV.bootstrapToken);
  if (ENV.isProduction && !ENV.bootstrapToken) {
    throw new Error(
      'HORIZON_BOOTSTRAP_TOKEN is required in production — the desktop supervisor issues one at spawn.',
    );
  }

  const app = express();

  // ── CORS: explicit allowlist. Dev falls back to '*'; prod refuses unknown.
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // non-browser callers
        if (ENV.corsOrigins.includes('*') || ENV.corsOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS: origin ${origin} not allowed`));
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  // Never log the raw Authorization header or JSON bodies in production.

  // ── Health
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

  // ── REST compatibility layer (rate-limited login)
  app.post('/api/auth/login', async (req: Request, res: Response) => {
    const ip = String(req.ip ?? req.socket.remoteAddress ?? 'unknown');
    const rate = checkLoginRate(ip);
    if (!rate.allowed) {
      res.status(429).json({
        error:
          rate.lockedUntil !== undefined
            ? 'IP temporarily locked'
            : 'Too many login attempts',
      });
      return;
    }
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

  // ── Stage 1-FIX §B: dependency-aware system readiness + desktop
  // bootstrap surfaces. Localhost-only, bootstrap-safe values only.
  app.set('trust proxy', 'loopback');
  app.use('/api', systemReadinessRouter());
  app.use('/api/desktop', desktopRouter());

  // ── Stage 2: operator-authenticated desktop surfaces (mounted at
  //    the SAME base path — Express routes fall through to the
  //    session-guarded router when the bootstrap router doesn't match).
  app.use('/api/desktop', desktopOperatorRouter());

  // ── Stage 2 §13: operator authentication endpoints (setup, login,
  //    refresh, logout, lock, change-password, revoke-all, session).
  app.use('/api/operator-auth', operatorAuthRouter());

  // Stage 3C-CI-RESET Part 2 Checkpoint D.1 — native induction
  // controller. Mounted ONLY when NODE_ENV=test AND
  // HORIZON_NATIVE_DIAGNOSTICS=true AND HORIZON_SERVER_EXTERNAL=true.
  // Every other build (production, dev, non-diagnostics test) has
  // no route mounted; requests return 404. See
  // packages/shared/src/nativeInduction.ts for the policy.
  if (shouldMountNativeInduction()) {
    app.use('/api/native-induction', nativeInductionRouter());
    // eslint-disable-next-line no-console
    console.log('[native-induction] mounted /api/native-induction (test-only)');
  }
  // Stage 3C-CI-RESET Part 2 Checkpoint D.1 §D.14/§D.16.
  if (shouldMountNativeDiagnostics()) {
    app.use('/api/native-diagnostics', nativeDiagnosticsRouter());
    // eslint-disable-next-line no-console
    console.log('[native-diagnostics] mounted /api/native-diagnostics (test-only)');
  }

  // ── tRPC
  app.use(
    '/trpc',
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );

  // ── Scan worker
  const worker = createScanWorker();
  worker.on('ready', () => {
    console.log('[server] BullMQ scan worker ready (connected to Redis)');
  });

  // ── Server listen (before reconciliation so /health responds fast)
  const server = app.listen(ENV.port, () => {
    console.log(`[server] Horizon Trade v${STRATEGY_VERSION} listening on :${ENV.port}`);
    console.log(
      `[server] dry-run: ${ENV.dryRun} | coinbase: ${ENV.coinbaseConfigured} | anthropic: ${ENV.anthropicConfigured} | reconciliation: pending`,
    );
  });

  // ── Startup reconciliation under a lease (single-writer).
  const leased = await withLease(RECONCILE_LEASE_KEY, 5 * 60 * 1000, async () => {
    try {
      await reconcileOnStartup();
    } catch (err) {
      await updateBotConfig({
        reconciliationStatus: 'failed',
        reconciliationDetail: err instanceof Error ? err.message : 'reconciliation exception',
      });
      await logActivity({
        type: 'reconciliation',
        severity: 'critical',
        action: 'RECONCILE_EXCEPTION',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  });
  if (!leased.ran) {
    console.log('[server] reconciliation held by another replica; will pick up its status');
  }

  // ── Re-arm recurring scan if bot was running before restart.
  try {
    const cfg = await getBotConfig();
    if (cfg.isRunning) {
      await scheduleRecurringScan();
      console.log('[server] bot was running — recurring scan re-armed');
    }
    console.log(`[server] reconciliation status: ${cfg.reconciliationStatus}`);
  } catch (err) {
    console.error('[server] could not check bot config on boot:', err);
  }

  // ── Shutdown
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
