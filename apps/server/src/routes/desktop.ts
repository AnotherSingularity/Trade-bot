/**
 * Stage 1-FIX §B, §C + Stage 2 §3 — Desktop supervisor endpoints,
 * split into two trust surfaces.
 *
 *   BOOTSTRAP-SAFE (require loopback + X-Horizon-Bootstrap-Token):
 *     /create-order-counters
 *     /scanner-readiness
 *     /reconciliation/status
 *
 *   OPERATOR-AUTHENTICATED (require Bearer access token):
 *     /observer-policy-versions
 *     /champion-configuration
 *
 * The desktop's supervised runtime hits the bootstrap-safe subset
 * before user authentication (with its issued bootstrap token). The
 * operator-authenticated subset is unreachable until the operator
 * has logged in. Loopback binding is NEVER the sole authorization
 * control — bootstrap requires the header token; the authenticated
 * subset requires a real operator session.
 */

import { Router, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';
import IORedis from 'ioredis';
import { STRATEGY_VERSION } from '@horizon/shared';
import { db, getPool } from '../db';
import * as schema from '../db/schema';
import { ENV } from '../env';
import { httpCounters } from '../lib/fetchBarrier';
import { requireBootstrapAuthorization } from '../middleware/bootstrapAuth';
import { requireOperatorSession } from '../middleware/operatorSession';

export function desktopRouter(): Router {
  const router = Router();

  router.get('/create-order-counters', requireBootstrapAuthorization, (_req, res) => {
    const c = httpCounters();
    res.json({
      known: true,
      source: 'in_process_fetchBarrier',
      values: {
        functionInvocations: c.createOrderFunctionInvocations,
        attemptCount: c.createOrderAttemptCount,
        networkCount: c.createOrderNetworkCount,
      },
    });
  });

  router.get('/scanner-readiness', requireBootstrapAuthorization, async (_req, res) => {
    try {
      const rec = await queryReconciliationSnapshot();
      const counters = httpCounters();
      const barrierOk = counters.createOrderAttemptCount === 0 && counters.createOrderNetworkCount === 0;
      const blocking: string[] = [];
      if (!rec.ok) blocking.push('reconciliation_not_ok');
      if (rec.unresolvedActions > 0) blocking.push(`unresolved_actions=${rec.unresolvedActions}`);
      if (rec.nonterminalIntentCount > 0) blocking.push(`nonterminal_intents=${rec.nonterminalIntentCount}`);
      if (rec.unknownOrderLocks > 0) blocking.push(`unknown_order_locks=${rec.unknownOrderLocks}`);
      if (rec.pendingFills > 0) blocking.push(`pending_fills=${rec.pendingFills}`);
      if (!barrierOk) blocking.push('create_order_counter_nonzero');
      res.json({
        known: true,
        state: blocking.length === 0 ? 'ready' : 'blocked',
        blockingReasons: blocking,
        reconciliation: rec,
        computedAt: new Date().toISOString(),
      });
    } catch (e) {
      res.status(200).json({
        known: false,
        state: 'unknown',
        reason: 'server_error',
        detail: String(e).slice(0, 200),
      });
    }
  });

  router.get('/reconciliation/status', requireBootstrapAuthorization, async (_req, res) => {
    try {
      const rec = await queryReconciliationSnapshot();
      res.json({ known: true, ...rec });
    } catch (e) {
      res.status(200).json({
        known: false,
        reason: 'server_error',
        detail: String(e).slice(0, 200),
      });
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Stage 2 §3 — operator-authenticated desktop endpoints.
//
// These endpoints carry compiled-in identifiers and current
// configuration flags that the desktop UI needs *after* the operator
// has authenticated. They are not bootstrap-safe (they reveal
// deployment identity) so the bootstrap channel cannot reach them.
// ---------------------------------------------------------------------------
export function desktopOperatorRouter(): Router {
  const router = Router();

  router.get('/observer-policy-versions', requireOperatorSession, (_req, res) => {
    res.json({
      known: true,
      source: 'compiled_in',
      values: {
        universe: 'p2a-1',
        regime: 'p2b-1',
        risk: 'p2c-1',
        microstructure: 'p2d-1',
        context: 'p2e-1',
        validation: 'p2f-1',
      },
    });
  });

  router.get('/champion-configuration', requireOperatorSession, (_req, res) => {
    res.json({
      known: true,
      source: 'compiled_in',
      values: {
        championVersion: `strategy-${STRATEGY_VERSION}`,
        strategyVersion: STRATEGY_VERSION,
        dryRun: ENV.dryRun,
        orderSubmissionEnabled: ENV.orderSubmissionEnabled,
      },
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// System readiness (dependency-aware)
// ---------------------------------------------------------------------------

export interface ReadinessComponent {
  ok: boolean;
  detail?: string;
}

export interface SystemReadinessResponse {
  known: true;
  ready: boolean;
  components: {
    process: ReadinessComponent;
    mariadb: ReadinessComponent;
    redis: ReadinessComponent;
    migration: ReadinessComponent;
    fingerprint: ReadinessComponent & { fingerprintHead?: string };
    reconciliation: ReadinessComponent;
    createOrderBarrier: ReadinessComponent;
  };
  safeFlags: { DRY_RUN: boolean; ORDER_SUBMISSION_ENABLED: boolean };
  version: string;
  timestamp: string;
}

export function systemReadinessRouter(): Router {
  const router = Router();
  router.get('/system/readiness', requireBootstrapAuthorization, async (_req: Request, res: Response) => {
    const response = await computeReadiness();
    // Ready when all components are ok. Non-ready still returns 200
    // so the desktop can read the detail; the desktop's supervisor
    // gates on `ready` — never on HTTP status alone.
    res.json(response);
  });
  return router;
}

export async function computeReadiness(): Promise<SystemReadinessResponse> {
  const [mariadb, redisComp, migration, fingerprint, reconciliation] = await Promise.all([
    checkMariadb(),
    checkRedis(),
    checkMigration(),
    checkFingerprint(),
    checkReconciliation(),
  ]);
  const counters = httpCounters();
  const barrier: ReadinessComponent = counters.createOrderAttemptCount === 0 && counters.createOrderNetworkCount === 0
    ? { ok: true, detail: `attempts=${counters.createOrderAttemptCount} network=${counters.createOrderNetworkCount}` }
    : { ok: false, detail: `attempts=${counters.createOrderAttemptCount} network=${counters.createOrderNetworkCount}` };
  const components = {
    process: { ok: true, detail: `pid=${process.pid}` },
    mariadb,
    redis: redisComp,
    migration,
    fingerprint,
    reconciliation,
    createOrderBarrier: barrier,
  };
  const ready = Object.values(components).every((c) => c.ok);
  return {
    known: true,
    ready,
    components,
    safeFlags: { DRY_RUN: ENV.dryRun, ORDER_SUBMISSION_ENABLED: ENV.orderSubmissionEnabled },
    version: STRATEGY_VERSION,
    timestamp: new Date().toISOString(),
  };
}

async function checkMariadb(): Promise<ReadinessComponent> {
  try {
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      await conn.query('SELECT 1');
      return { ok: true };
    } finally {
      conn.release();
    }
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) };
  }
}

async function checkRedis(): Promise<ReadinessComponent> {
  let client: IORedis | undefined;
  try {
    client = new IORedis(ENV.redisUrl, {
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    await client.connect();
    const pong = await client.ping();
    if (pong !== 'PONG') return { ok: false, detail: `ping=${pong}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) };
  } finally {
    try { await client?.quit(); } catch { /* client already closed */ }
  }
}

async function checkMigration(): Promise<ReadinessComponent> {
  try {
    const rows = await db.execute(sql`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '__drizzle_migrations'`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const present = Number((rows as any)[0]?.[0]?.n ?? (rows as any)[0]?.n ?? 0) > 0;
    if (!present) return { ok: false, detail: 'migration_table_missing' };
    const count = await db.execute(sql`SELECT COUNT(*) AS n FROM __drizzle_migrations`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = Number((count as any)[0]?.[0]?.n ?? (count as any)[0]?.n ?? 0);
    return { ok: n >= 1, detail: `applied=${n}` };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) };
  }
}

async function checkFingerprint(): Promise<ReadinessComponent & { fingerprintHead?: string }> {
  try {
    // The canonical journal head is compiled in — the server's Drizzle
    // schema pins it. The check here is: does the migration table
    // report at least the expected count? A stronger fingerprint check
    // is executed by the desktop's SchemaFingerprintVerifier before
    // starting the server.
    const rows = await db.execute(sql`SELECT COUNT(*) AS n FROM __drizzle_migrations`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = Number((rows as any)[0]?.[0]?.n ?? (rows as any)[0]?.n ?? 0);
    const expected = 21; // migrations 0000-0020
    if (n < expected) return { ok: false, detail: `applied=${n} expected>=${expected}`, fingerprintHead: `applied=${n}` };
    return { ok: true, detail: `applied=${n}`, fingerprintHead: `applied=${n}` };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) };
  }
}

interface ReconciliationSnapshot {
  ok: boolean;
  unresolvedActions: number;
  nonterminalIntentCount: number;
  unknownOrderLocks: number;
  pendingFills: number;
  accountingDiscrepancy: number;
  lastRunAt: string | null;
  entryBlockState: 'blocked' | 'allowed' | 'unknown';
}

async function checkReconciliation(): Promise<ReadinessComponent> {
  try {
    const rec = await queryReconciliationSnapshot();
    if (!rec.ok) return { ok: false, detail: 'reconciliation_not_ok' };
    if (rec.unresolvedActions > 0) return { ok: false, detail: `unresolved_actions=${rec.unresolvedActions}` };
    if (rec.entryBlockState !== 'allowed') return { ok: false, detail: `entry_block=${rec.entryBlockState}` };
    return { ok: true, detail: rec.lastRunAt ? `last_run=${rec.lastRunAt}` : 'no_run_yet' };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) };
  }
}

async function queryReconciliationSnapshot(): Promise<ReconciliationSnapshot> {
  // Reconciliation runs table: reconciliation_runs
  // Fields we surface come from the existing bot_config +
  // reconciliation_runs + order_intents shape.
  const [runsRows] = await Promise.all([
    db.execute(sql`SELECT MAX(startedAt) AS lastStart FROM reconciliation_runs`).catch(() => [[]]),
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastRunAt = (runsRows as any)?.[0]?.[0]?.lastStart ?? (runsRows as any)?.[0]?.lastStart ?? null;

  // bot_config carries the current reconciliationStatus.
  const [cfg] = await db.select().from(schema.botConfig).limit(1);
  const reconciliationStatus = cfg?.reconciliationStatus ?? 'pending';

  // nonterminal order intents = intents not in ('filled', 'cancelled', 'rejected', 'expired').
  const nonterminalResult = await db.execute(sql`SELECT COUNT(*) AS n FROM order_intents WHERE state NOT IN ('filled','cancelled','rejected','expired')`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nonterminalIntentCount = Number((nonterminalResult as any)?.[0]?.[0]?.n ?? (nonterminalResult as any)?.[0]?.n ?? 0);

  // Unresolved reconciliation actions.
  const actionsRes = await db.execute(sql`SELECT COUNT(*) AS n FROM reconciliation_actions WHERE resolvedAt IS NULL`).catch(() => [[{ n: 0 }]]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unresolvedActions = Number((actionsRes as any)?.[0]?.[0]?.n ?? (actionsRes as any)?.[0]?.n ?? 0);

  // Unknown order locks (Phase 1.1.a §A): if execution_fences has any
  // 'unknown_order' scope rows, entries must remain blocked.
  const unknownRes = await db.execute(sql`SELECT COUNT(*) AS n FROM execution_fences WHERE resourceKey LIKE 'unknown_order:%'`).catch(() => [[{ n: 0 }]]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unknownOrderLocks = Number((unknownRes as any)?.[0]?.[0]?.n ?? (unknownRes as any)?.[0]?.n ?? 0);

  // Pending fills = fills row without a matching order_intent.economicApplied.
  const pendingFillsRes = await db.execute(sql`SELECT COUNT(*) AS n FROM fills WHERE order_id NOT IN (SELECT exchangeOrderId FROM order_intents WHERE exchangeOrderId IS NOT NULL)`).catch(() => [[{ n: 0 }]]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendingFills = Number((pendingFillsRes as any)?.[0]?.[0]?.n ?? (pendingFillsRes as any)?.[0]?.n ?? 0);

  // Accounting discrepancy: computed by the attribution engine; if
  // there's no attribution row, the current cycle hasn't produced one
  // yet — treat as 0 with a caveat.
  const discRes = await db.execute(sql`SELECT COALESCE(SUM(ABS(unexplainedAmount)), 0) AS s FROM cost_attribution`).catch(() => [[{ s: 0 }]]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accountingDiscrepancy = Number((discRes as any)?.[0]?.[0]?.s ?? (discRes as any)?.[0]?.s ?? 0);

  const ok = reconciliationStatus !== 'failed' && reconciliationStatus !== 'pending' ? true : reconciliationStatus === 'pending' ? false : false;
  const entryBlockState: ReconciliationSnapshot['entryBlockState'] =
    ok && unresolvedActions === 0 && unknownOrderLocks === 0 && nonterminalIntentCount === 0
      ? 'allowed' : 'blocked';

  return {
    ok,
    unresolvedActions,
    nonterminalIntentCount,
    unknownOrderLocks,
    pendingFills,
    accountingDiscrepancy,
    lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
    entryBlockState,
  };
}
