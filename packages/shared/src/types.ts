/**
 * Horizon Trade — shared domain types used by both the mobile app and server.
 *
 * These mirror the persisted DB shapes but use primitive `number` for decimals
 * (the server serializes Drizzle decimal strings into numbers at the tRPC
 * boundary so the client never has to parse strings).
 */

import type { TradingMode } from './constants';

export type { TradingMode } from './constants';
export type { Token, MarketWindow } from './constants';

export type PositionStatus = 'open' | 'closed';
export type TradeOutcome = 'win' | 'loss' | 'open';
export type TradeSide = 'buy' | 'sell';
export type ActivityType = 'scan' | 'signal' | 'trade' | 'system' | 'error';

export interface BotStatus {
  isRunning: boolean;
  isPaused: boolean;
  consecutiveLosses: number;
  circuitBreakerUntil: string | null; // ISO timestamp
  circuitBreakerActive: boolean;
  openPositions: number;
  maxPositions: number;
  marketWindow: import('./constants').MarketWindow;
  updatedAt: string;
}

export interface Position {
  id: number;
  token: string;
  mode: TradingMode;
  entryPrice: number;
  quantity: number;
  allocationPct: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  takeProfitPct: number;
  stopLossPct: number;
  claudeReason: string | null;
  coinbaseOrderId: string | null;
  status: PositionStatus;
  openedAt: string;
  closedAt: string | null;
  // Derived (computed live from current market price)
  currentPrice?: number;
  unrealizedPnlDollars?: number;
  unrealizedPnlPct?: number;
}

export interface Trade {
  id: number;
  token: string;
  mode: TradingMode;
  side: TradeSide;
  entryPrice: number | null;
  exitPrice: number | null;
  quantity: number;
  pnlDollars: number | null;
  pnlPct: number | null;
  outcome: TradeOutcome;
  claudeReason: string | null;
  coinbaseOrderId: string | null;
  executedAt: string;
}

export interface ActivityLogEntry {
  id: number;
  type: ActivityType;
  token: string | null;
  action: string;
  detail: string;
  tokensScanned: number | null;
  passedVolumeFilter: number | null;
  passedSignalThreshold: number | null;
  createdAt: string;
}

export interface TokenStat {
  id: number;
  token: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  isActive: boolean;
  updatedAt: string;
}

/** Live market data for a token, merged with its persisted stats. */
export interface TokenUniverseEntry {
  token: string;
  price: number | null;
  volume24h: number | null;
  changePct24h: number | null;
  passesVolumeFilter: boolean;
  totalTrades: number;
  winRate: number | null; // null until first trade
  isActive: boolean;
}

export interface PortfolioSummary {
  totalValue: number;
  cashBalance: number;
  positionsValue: number;
  unrealizedPnlDollars: number;
  unrealizedPnlPct: number;
  openPositions: Position[];
}

export interface TradeHistorySummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlDollars: number;
}

export type HistoryFilter = 'all' | 'wins' | 'losses';

export interface PaginatedTrades {
  trades: Trade[];
  nextCursor: number | null;
  summary: TradeHistorySummary;
}

export interface ConnectionTestResult {
  coinbase: { connected: boolean; message: string };
  anthropic: { connected: boolean; message: string };
}

export interface AuthResponse {
  token: string;
  expiresIn: number;
}

/** Claude signal evaluation output. */
export interface ClaudeSignal {
  confidence: number; // 0..1
  shouldEnter: boolean;
  reason: string;
}
