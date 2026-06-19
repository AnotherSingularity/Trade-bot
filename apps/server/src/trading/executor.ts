import { STRATEGY, type TradingMode } from '@horizon/shared';
import { ENV } from '../env';
import {
  closePosition,
  getBotConfig,
  getPositionById,
  insertPosition,
  insertTrade,
  logActivity,
  recordTokenOutcome,
  updateBotConfig,
  type NewPosition,
} from '../db/queries';
import type { PositionRow } from '../db/schema';
import { getCashBalance, placeMarketOrder } from './coinbase';

/**
 * Order placement and position lifecycle management.
 *
 * Honors DRY_RUN: when enabled, orders are logged and recorded in the DB but no
 * live Coinbase order is sent. This lets the full pipeline (signals → Claude →
 * position tracking → exits) be demonstrated safely without real capital.
 */

export interface EntryDecision {
  token: string;
  mode: TradingMode;
  price: number;
  allocationPct: number;
  claudeReason: string;
}

/**
 * Opens a position: sizes by allocation %, places a market buy, persists the
 * position with computed take-profit / stop-loss levels.
 */
export async function openPosition(decision: EntryDecision): Promise<PositionRow | null> {
  const modeCfg = STRATEGY.MODES[decision.mode];
  const cashBalance = await getPortfolioCash();
  const allocationDollars = (cashBalance * decision.allocationPct) / 100;

  if (allocationDollars <= 0) {
    await logActivity({
      type: 'system',
      token: decision.token,
      action: 'SKIP_ENTRY',
      detail: `Insufficient cash balance for ${decision.token} (${decision.allocationPct}% of $${cashBalance.toFixed(2)})`,
    });
    return null;
  }

  const quantity = allocationDollars / decision.price;
  const takeProfitPrice = decision.price * (1 + modeCfg.takeProfitPct / 100);
  const stopLossPrice = decision.price * (1 - modeCfg.stopLossPct / 100);

  let coinbaseOrderId: string | null = null;
  if (!ENV.dryRun) {
    const order = await placeMarketOrder({
      token: decision.token,
      side: 'BUY',
      amount: allocationDollars,
    });
    if (!order.success) {
      await logActivity({
        type: 'error',
        token: decision.token,
        action: 'ORDER_FAILED',
        detail: order.error_response?.message ?? 'Coinbase rejected the buy order',
      });
      return null;
    }
    coinbaseOrderId = order.order_id ?? null;
  }

  const newPos: NewPosition = {
    token: decision.token,
    mode: decision.mode,
    entryPrice: decision.price,
    quantity,
    allocationPct: decision.allocationPct,
    takeProfitPrice,
    stopLossPrice,
    takeProfitPct: modeCfg.takeProfitPct,
    stopLossPct: modeCfg.stopLossPct,
    claudeReason: decision.claudeReason,
    coinbaseOrderId,
  };
  const id = await insertPosition(newPos);

  await insertTrade({
    token: decision.token,
    mode: decision.mode,
    side: 'buy',
    entryPrice: decision.price,
    exitPrice: null,
    quantity,
    pnlDollars: null,
    pnlPct: null,
    outcome: 'open',
    claudeReason: decision.claudeReason,
    coinbaseOrderId,
  });

  await logActivity({
    type: 'trade',
    token: decision.token,
    action: 'OPEN_POSITION',
    detail: `${ENV.dryRun ? '[DRY RUN] ' : ''}Opened ${decision.mode} position: ${quantity.toFixed(
      6,
    )} ${decision.token} @ $${decision.price} (TP $${takeProfitPrice.toFixed(4)}, SL $${stopLossPrice.toFixed(4)})`,
  });

  return (await getPositionById(id)) ?? null;
}

export type ExitReason = 'take_profit' | 'stop_loss' | 'early_exit' | 'manual';

/**
 * Closes a position at the given current price, records realized P&L, updates
 * token stats and the consecutive-loss circuit breaker.
 */
export async function closePositionAtPrice(
  position: PositionRow,
  currentPrice: number,
  reason: ExitReason,
): Promise<void> {
  const entryPrice = Number(position.entryPrice);
  const quantity = Number(position.quantity);
  const pnlDollars = (currentPrice - entryPrice) * quantity;
  const pnlPct = entryPrice === 0 ? 0 : ((currentPrice - entryPrice) / entryPrice) * 100;
  const outcome: 'win' | 'loss' = pnlDollars >= 0 ? 'win' : 'loss';

  if (!ENV.dryRun) {
    const order = await placeMarketOrder({
      token: position.token,
      side: 'SELL',
      amount: quantity,
    });
    if (!order.success) {
      await logActivity({
        type: 'error',
        token: position.token,
        action: 'EXIT_FAILED',
        detail: order.error_response?.message ?? 'Coinbase rejected the sell order',
      });
      return;
    }
  }

  await closePosition(position.id);
  await insertTrade({
    token: position.token,
    mode: position.mode,
    side: 'sell',
    entryPrice,
    exitPrice: currentPrice,
    quantity,
    pnlDollars,
    pnlPct,
    outcome,
    claudeReason: `Exit: ${reason}`,
    coinbaseOrderId: position.coinbaseOrderId,
  });
  await recordTokenOutcome(position.token, outcome);
  await updateCircuitBreaker(outcome);

  await logActivity({
    type: 'trade',
    token: position.token,
    action: 'CLOSE_POSITION',
    detail: `${ENV.dryRun ? '[DRY RUN] ' : ''}Closed ${position.token} (${reason}): ${
      outcome === 'win' ? '+' : ''
    }$${pnlDollars.toFixed(2)} (${pnlPct.toFixed(2)}%)`,
  });
}

/**
 * Updates the consecutive-loss counter; trips the circuit breaker after
 * CONSECUTIVE_LOSS_LIMIT losses in a row.
 */
async function updateCircuitBreaker(outcome: 'win' | 'loss'): Promise<void> {
  const cfg = await getBotConfig();
  if (outcome === 'win') {
    if (cfg.consecutiveLosses !== 0) await updateBotConfig({ consecutiveLosses: 0 });
    return;
  }
  const consecutiveLosses = cfg.consecutiveLosses + 1;
  if (consecutiveLosses >= STRATEGY.CONSECUTIVE_LOSS_LIMIT) {
    const until = new Date(Date.now() + STRATEGY.CIRCUIT_BREAKER_HOURS * 60 * 60 * 1000);
    await updateBotConfig({ consecutiveLosses, circuitBreakerUntil: until });
    await logActivity({
      type: 'system',
      action: 'CIRCUIT_BREAKER',
      detail: `Circuit breaker tripped after ${consecutiveLosses} consecutive losses. Paused until ${until.toISOString()}`,
    });
  } else {
    await updateBotConfig({ consecutiveLosses });
  }
}

/** Evaluates take-profit / stop-loss / early-exit for an open position. */
export function shouldExit(
  position: PositionRow,
  currentPrice: number,
): { exit: boolean; reason: ExitReason } {
  const takeProfit = Number(position.takeProfitPrice);
  const stopLoss = Number(position.stopLossPrice);
  if (currentPrice >= takeProfit) return { exit: true, reason: 'take_profit' };
  if (currentPrice <= stopLoss) return { exit: true, reason: 'stop_loss' };

  // Reversion mode has an early-exit rule to lock in smaller gains.
  const modeCfg = STRATEGY.MODES[position.mode];
  if (position.mode === 'reversion' && 'earlyExitPct' in modeCfg && modeCfg.earlyExitPct) {
    const entryPrice = Number(position.entryPrice);
    const gainPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    if (gainPct >= modeCfg.earlyExitPct) return { exit: true, reason: 'early_exit' };
  }
  return { exit: false, reason: 'manual' };
}

async function getPortfolioCash(): Promise<number> {
  if (ENV.dryRun || !ENV.coinbaseConfigured) {
    // In dry-run/demo mode, assume a nominal $10k bankroll for sizing math.
    return 10_000;
  }
  return getCashBalance();
}
