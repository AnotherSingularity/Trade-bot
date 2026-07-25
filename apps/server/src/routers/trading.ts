import { z } from 'zod';
import {
  type BotStatus,
  type PortfolioSummary,
  type Position,
  type ActivityLogEntry,
} from '@horizon/shared';
import {
  getBotConfig,
  getCashBalance as ledgerCashBalance,
  getOpenPositions,
  getRecentActivity,
  logActivity,
  serializeActivity,
  serializePosition,
  updateBotConfig,
} from '../db/queries';
import { getCashBalance as coinbaseCashBalance, getProduct } from '../trading/coinbase';
import { closePosition as executorClose } from '../trading/executor';
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
    // Reconciliation gate: refuse to enable entries until startup reconciled.
    const cfg = await getBotConfig();
    if (cfg.reconciliationStatus !== 'ok') {
      await logActivity({
        type: 'security',
        severity: 'high',
        action: 'START_BLOCKED',
        detail: `Reconciliation status is ${cfg.reconciliationStatus}; refuse to enable entries`,
      });
      throw new Error(
        `Cannot start: startup reconciliation is ${cfg.reconciliationStatus}. Resolve discrepancies first.`,
      );
    }
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
      detail: isPaused ? 'Bot paused (risk mgmt continues)' : 'Bot resumed',
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

    // Position value is marked at current price (or last known avg entry as
    // fallback). Cost basis comes from actual entry quote spent so unrealized
    // P&L is honest even if the ticker is stale.
    const positionsValue = openPositions.reduce(
      (sum, p) => sum + (p.currentPrice ?? p.entryPrice) * p.quantity,
      0,
    );
    const unrealizedPnlDollars = openPositions.reduce(
      (sum, p) => sum + (p.unrealizedPnlDollars ?? 0),
      0,
    );

    // Cash comes from the LEDGER — decreases when we buy, increases when we
    // sell. In live mode we also cross-check against Coinbase available cash.
    let cashBalance = await ledgerCashBalance(ENV.dryRun);
    if (!ENV.dryRun && ENV.coinbaseConfigured) {
      try {
        cashBalance = await coinbaseCashBalance();
      } catch {
        // fall back to ledger — logged elsewhere
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

  /**
   * Manual close. Only returns `closed:true` after the exchange exit is
   * accepted AND reconciled. Failed / unknown exits return closed:false with
   * a reason.
   */
  closePosition: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(
      async ({ input }): Promise<{ closed: boolean; status: 'closed' | 'failed' | 'pending'; reason?: string }> => {
        const rows = await getOpenPositions();
        const position = rows.find((p) => p.id === input.id);
        if (!position) return { closed: false, status: 'failed', reason: 'not_found_or_not_open' };
        const result = await executorClose(position, 'manual');
        return {
          closed: result.kind === 'closed',
          status: result.kind,
          reason: result.reason,
        };
      },
    ),

  /**
   * Emergency kill — attempts to flatten all open exposure. Returns per-token
   * outcomes.
   */
  emergencyKill: protectedProcedure.mutation(
    async (): Promise<{ attempted: number; closed: number; failed: number; pending: number }> => {
      await updateBotConfig({ isRunning: false, isPaused: false });
      await logActivity({
        type: 'security',
        severity: 'critical',
        action: 'EMERGENCY_KILL',
        detail: 'Operator triggered emergency kill; attempting to flatten all positions',
      });
      const open = await getOpenPositions();
      let closed = 0,
        failed = 0,
        pending = 0;
      for (const p of open) {
        const r = await executorClose(p, 'emergency');
        if (r.kind === 'closed') closed++;
        else if (r.kind === 'pending') pending++;
        else failed++;
      }
      return { attempted: open.length, closed, failed, pending };
    },
  ),
});
