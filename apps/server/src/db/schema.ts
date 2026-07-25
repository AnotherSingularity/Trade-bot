import {
  mysqlTable,
  int,
  varchar,
  text,
  boolean,
  timestamp,
  decimal,
  mysqlEnum,
  uniqueIndex,
  index,
} from 'drizzle-orm/mysql-core';

/**
 * Horizon Trade — order lifecycle schema (Phase 0 rebuild).
 *
 * Design principles enforced here:
 *   1. Every order has a durable, deterministic `clientOrderId` persisted BEFORE
 *      submission, with a UNIQUE index — this is our idempotency key.
 *   2. `exchangeOrderId` is UNIQUE (nullable until acknowledged) — Coinbase
 *      can never appear twice in our books.
 *   3. Positions are derived from actual `fills` (weighted avg price, filled
 *      qty, fees). No ticker-based positions.
 *   4. `round_trips` is the source of truth for completed-trade counting.
 *      The old `trades` table is deprecated for counting but kept for history.
 *   5. Only ONE open position per token (enforced with a MySQL unique-index
 *      trick using a computed nullable column).
 */

// ---------------------------------------------------------------------------
// Bot config (singleton)
// ---------------------------------------------------------------------------
export const botConfig = mysqlTable('bot_config', {
  id: int('id').autoincrement().primaryKey(),
  isRunning: boolean('isRunning').default(false).notNull(),
  isPaused: boolean('isPaused').default(false).notNull(),
  consecutiveLosses: int('consecutiveLosses').default(0).notNull(),
  circuitBreakerUntil: timestamp('circuitBreakerUntil'),
  // Startup-reconciliation gate: entries are blocked until this is 'ok'.
  reconciliationStatus: mysqlEnum('reconciliationStatus', [
    'pending',
    'in_progress',
    'ok',
    'failed',
  ])
    .default('pending')
    .notNull(),
  reconciliationDetail: text('reconciliationDetail'),
  reconciledAt: timestamp('reconciledAt'),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// ---------------------------------------------------------------------------
// Order intents — every economic order is recorded here before submission.
// ---------------------------------------------------------------------------
export const orderIntents = mysqlTable(
  'order_intents',
  {
    id: int('id').autoincrement().primaryKey(),

    // Deterministic idempotency key. Persisted BEFORE any HTTP submit; a retry
    // for the same economic order reuses this exact value so Coinbase treats
    // both attempts as one order.
    clientOrderId: varchar('clientOrderId', { length: 64 }).notNull(),

    productId: varchar('productId', { length: 30 }).notNull(),
    token: varchar('token', { length: 20 }).notNull(),
    side: mysqlEnum('side', ['BUY', 'SELL']).notNull(),
    orderType: mysqlEnum('orderType', [
      'market_ioc',
      'limit',
      'stop_limit',
      'bracket_tp',
      'bracket_sl',
    ]).notNull(),
    // For BUY market IOC we typically pass a quote size (USD to spend).
    // For SELL we pass base size (token qty). Exactly one is set.
    quoteSize: decimal('quoteSize', { precision: 20, scale: 8 }),
    baseSize: decimal('baseSize', { precision: 20, scale: 8 }),

    mode: mysqlEnum('mode', ['reversion', 'breakout', 'macro']).notNull(),
    purpose: mysqlEnum('purpose', [
      'entry',
      'take_profit',
      'stop_loss',
      'manual_exit',
      'emergency_exit',
    ]).notNull(),
    positionId: int('positionId'),

    state: mysqlEnum('state', [
      'created',
      'previewed',
      'submitted',
      'acknowledged',
      'partially_filled',
      'filled',
      'rejected',
      'canceled',
      'failed',
      'unknown',
    ])
      .default('created')
      .notNull(),

    exchangeOrderId: varchar('exchangeOrderId', { length: 128 }),

    // Failure classification (see coinbase.ts FailureClass).
    failureClass: mysqlEnum('failureClass', [
      'definitely_rejected',
      'definitely_not_submitted',
      'submitted',
      'unknown',
      'retryable_transport',
      'non_retryable_validation',
    ]),
    errorCode: varchar('errorCode', { length: 128 }),
    errorMessage: text('errorMessage'),
    rawResponse: text('rawResponse'), // JSON string, sanitized

    // Dry-run flag on the intent itself, so ledger accounting can distinguish
    // simulated from live orders unambiguously even if DRY_RUN changes later.
    dryRun: boolean('dryRun').notNull(),

    createdAt: timestamp('createdAt').defaultNow().notNull(),
    updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    // Idempotency: no two intents may share a clientOrderId.
    clientOrderIdUnique: uniqueIndex('order_intents_client_uq').on(table.clientOrderId),
    // No two intents may share an exchangeOrderId (NULLs are allowed multiple).
    exchangeOrderIdUnique: uniqueIndex('order_intents_exchange_uq').on(table.exchangeOrderId),
    positionIdIdx: index('order_intents_position_idx').on(table.positionId),
    stateIdx: index('order_intents_state_idx').on(table.state),
  }),
);

// ---------------------------------------------------------------------------
// Fills — one row per exchange fill event.
// ---------------------------------------------------------------------------
export const fills = mysqlTable(
  'fills',
  {
    id: int('id').autoincrement().primaryKey(),

    // Exchange fill identifier (Coinbase: trade_id). UNIQUE — same fill can be
    // re-fetched idempotently.
    exchangeFillId: varchar('exchangeFillId', { length: 128 }).notNull(),

    orderIntentId: int('orderIntentId').notNull(),
    exchangeOrderId: varchar('exchangeOrderId', { length: 128 }).notNull(),

    token: varchar('token', { length: 20 }).notNull(),
    side: mysqlEnum('side', ['BUY', 'SELL']).notNull(),

    filledSize: decimal('filledSize', { precision: 20, scale: 8 }).notNull(),
    fillPrice: decimal('fillPrice', { precision: 20, scale: 8 }).notNull(),
    // Fee IS included in P&L. Always populated even if 0 (dry-run models it).
    fee: decimal('fee', { precision: 20, scale: 8 }).notNull(),
    feeCurrency: varchar('feeCurrency', { length: 10 }).notNull(),

    tradeTime: timestamp('tradeTime').notNull(),
    rawResponse: text('rawResponse'), // JSON string, sanitized

    createdAt: timestamp('createdAt').defaultNow().notNull(),
  },
  (table) => ({
    exchangeFillIdUnique: uniqueIndex('fills_exchange_uq').on(table.exchangeFillId),
    orderIntentIdx: index('fills_order_idx').on(table.orderIntentId),
  }),
);

// ---------------------------------------------------------------------------
// Positions — derived from actual entry fills; hold protective-order IDs.
// ---------------------------------------------------------------------------
export const positions = mysqlTable(
  'positions',
  {
    id: int('id').autoincrement().primaryKey(),
    token: varchar('token', { length: 20 }).notNull(),
    mode: mysqlEnum('mode', ['reversion', 'breakout', 'macro']).notNull(),

    // ACTUAL execution values — computed from fills, not ticker.
    avgEntryPrice: decimal('avgEntryPrice', { precision: 20, scale: 8 }).notNull(),
    filledQuantity: decimal('filledQuantity', { precision: 20, scale: 8 }).notNull(),
    entryFees: decimal('entryFees', { precision: 20, scale: 8 }).notNull(),
    entryQuoteSpent: decimal('entryQuoteSpent', { precision: 20, scale: 8 }).notNull(),

    // Configuration used to compute the protective levels.
    allocationPct: decimal('allocationPct', { precision: 5, scale: 2 }).notNull(),
    takeProfitPrice: decimal('takeProfitPrice', { precision: 20, scale: 8 }).notNull(),
    stopLossPrice: decimal('stopLossPrice', { precision: 20, scale: 8 }).notNull(),
    takeProfitPct: decimal('takeProfitPct', { precision: 5, scale: 2 }).notNull(),
    stopLossPct: decimal('stopLossPct', { precision: 5, scale: 2 }).notNull(),

    // Provenance.
    entryOrderIntentId: int('entryOrderIntentId').notNull(),
    protectiveTpIntentId: int('protectiveTpIntentId'),
    protectiveSlIntentId: int('protectiveSlIntentId'),
    protectionMode: mysqlEnum('protectionMode', [
      'exchange_bracket',
      'polling_fallback',
      'unprotected',
    ])
      .default('polling_fallback')
      .notNull(),

    claudeReason: text('claudeReason'),
    claudeModel: varchar('claudeModel', { length: 64 }),
    claudeConfidence: decimal('claudeConfidence', { precision: 5, scale: 4 }),
    strategyVersion: varchar('strategyVersion', { length: 20 }),

    // Lifecycle. `opening`/`closing` are transient during multi-step exchange
    // interactions. `reconciling` marks a state pending startup reconciliation.
    lifecycleState: mysqlEnum('lifecycleState', [
      'opening',
      'open',
      'closing',
      'closed',
      'reconciling',
    ])
      .default('opening')
      .notNull(),

    // Legacy `status` retained for the mobile app's existing typing; mirrors
    // lifecycleState collapsed to open/closed.
    status: mysqlEnum('status', ['open', 'closed']).default('open').notNull(),

    // Optimistic-locking version.
    version: int('version').default(0).notNull(),

    openedAt: timestamp('openedAt').defaultNow().notNull(),
    closedAt: timestamp('closedAt'),
  },
  (table) => ({
    tokenIdx: index('positions_token_idx').on(table.token),
    statusIdx: index('positions_status_idx').on(table.status),
    // NOTE: MySQL unique on (token, status) would prevent two closed rows for
    // the same token. We enforce "one open per token" in the application layer
    // (via the leader lease + a SELECT ... FOR UPDATE check inside the tx).
  }),
);

// ---------------------------------------------------------------------------
// Round-trips — one row per completed position. Source of truth for P&L stats.
// ---------------------------------------------------------------------------
export const roundTrips = mysqlTable(
  'round_trips',
  {
    id: int('id').autoincrement().primaryKey(),
    positionId: int('positionId').notNull(),
    token: varchar('token', { length: 20 }).notNull(),
    mode: mysqlEnum('mode', ['reversion', 'breakout', 'macro']).notNull(),

    entryValueGross: decimal('entryValueGross', { precision: 20, scale: 8 }).notNull(),
    exitValueGross: decimal('exitValueGross', { precision: 20, scale: 8 }).notNull(),
    entryFees: decimal('entryFees', { precision: 20, scale: 8 }).notNull(),
    exitFees: decimal('exitFees', { precision: 20, scale: 8 }).notNull(),

    realizedNetPnl: decimal('realizedNetPnl', { precision: 20, scale: 8 }).notNull(),
    realizedNetPnlPct: decimal('realizedNetPnlPct', { precision: 10, scale: 4 }).notNull(),

    // 'flat' = zero P&L (rare, but explicit — see accounting rules).
    outcome: mysqlEnum('outcome', ['win', 'loss', 'flat']).notNull(),
    exitReason: mysqlEnum('exitReason', [
      'take_profit',
      'stop_loss',
      'early_exit',
      'manual',
      'emergency',
      'reconciled',
    ]).notNull(),

    openedAt: timestamp('openedAt').notNull(),
    closedAt: timestamp('closedAt').notNull(),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
  },
  (table) => ({
    positionIdUnique: uniqueIndex('round_trips_position_uq').on(table.positionId),
    tokenIdx: index('round_trips_token_idx').on(table.token),
    outcomeIdx: index('round_trips_outcome_idx').on(table.outcome),
    closedAtIdx: index('round_trips_closed_at_idx').on(table.closedAt),
  }),
);

// ---------------------------------------------------------------------------
// Cash ledger — deterministic accounting of dry-run (and eventually live) cash.
// ---------------------------------------------------------------------------
export const cashLedger = mysqlTable(
  'cash_ledger',
  {
    id: int('id').autoincrement().primaryKey(),
    // Positive = cash inflow (sell proceeds, initial fund).
    // Negative = cash outflow (buy cost, fees, spread).
    deltaUsd: decimal('deltaUsd', { precision: 20, scale: 8 }).notNull(),
    reason: mysqlEnum('reason', [
      'initial_fund',
      'buy_cost',
      'buy_fee',
      'buy_slippage',
      'sell_proceeds',
      'sell_fee',
      'sell_slippage',
      'manual_adjustment',
    ]).notNull(),
    // Optional links to the causal entity.
    orderIntentId: int('orderIntentId'),
    positionId: int('positionId'),
    dryRun: boolean('dryRun').notNull(),
    detail: text('detail'),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
  },
  (table) => ({
    dryRunIdx: index('cash_ledger_dryrun_idx').on(table.dryRun),
    createdAtIdx: index('cash_ledger_created_at_idx').on(table.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Legacy trades table — RETAINED for existing history / mobile-app typing,
// but is no longer the source of truth for counts or win rate. Round-trip
// counting reads from `round_trips` instead.
// ---------------------------------------------------------------------------
export const trades = mysqlTable('trades', {
  id: int('id').autoincrement().primaryKey(),
  token: varchar('token', { length: 20 }).notNull(),
  mode: mysqlEnum('mode', ['reversion', 'breakout', 'macro']).notNull(),
  side: mysqlEnum('side', ['buy', 'sell']).notNull(),
  entryPrice: decimal('entryPrice', { precision: 20, scale: 8 }),
  exitPrice: decimal('exitPrice', { precision: 20, scale: 8 }),
  quantity: decimal('quantity', { precision: 20, scale: 8 }).notNull(),
  pnlDollars: decimal('pnlDollars', { precision: 10, scale: 4 }),
  pnlPct: decimal('pnlPct', { precision: 8, scale: 4 }),
  outcome: mysqlEnum('outcome', ['win', 'loss', 'open']).default('open').notNull(),
  claudeReason: text('claudeReason'),
  coinbaseOrderId: varchar('coinbaseOrderId', { length: 128 }),
  executedAt: timestamp('executedAt').defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Activity log — expanded severity levels; execution safety writes here too.
// ---------------------------------------------------------------------------
export const activityLog = mysqlTable('activity_log', {
  id: int('id').autoincrement().primaryKey(),
  type: mysqlEnum('type', [
    'scan',
    'signal',
    'trade',
    'system',
    'error',
    'reconciliation',
    'security',
  ]).notNull(),
  severity: mysqlEnum('severity', ['info', 'warn', 'high', 'critical'])
    .default('info')
    .notNull(),
  token: varchar('token', { length: 20 }),
  action: varchar('action', { length: 60 }).notNull(),
  detail: text('detail').notNull(),
  tokensScanned: int('tokensScanned'),
  passedVolumeFilter: int('passedVolumeFilter'),
  passedSignalThreshold: int('passedSignalThreshold'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Token stats — kept for display; win-rate priority now uses Bayesian
// shrinkage computed at read time (queries.ts) instead of the naive column.
// ---------------------------------------------------------------------------
export const tokenStats = mysqlTable('token_stats', {
  id: int('id').autoincrement().primaryKey(),
  token: varchar('token', { length: 20 }).notNull().unique(),
  totalTrades: int('totalTrades').default(0).notNull(),
  wins: int('wins').default(0).notNull(),
  losses: int('losses').default(0).notNull(),
  winRate: decimal('winRate', { precision: 5, scale: 2 }).default('0').notNull(),
  isActive: boolean('isActive').default(true).notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------
export type BotConfigRow = typeof botConfig.$inferSelect;
export type OrderIntentRow = typeof orderIntents.$inferSelect;
export type OrderIntentInsert = typeof orderIntents.$inferInsert;
export type FillRow = typeof fills.$inferSelect;
export type FillInsert = typeof fills.$inferInsert;
export type PositionRow = typeof positions.$inferSelect;
export type PositionInsert = typeof positions.$inferInsert;
export type RoundTripRow = typeof roundTrips.$inferSelect;
export type RoundTripInsert = typeof roundTrips.$inferInsert;
export type CashLedgerRow = typeof cashLedger.$inferSelect;
export type CashLedgerInsert = typeof cashLedger.$inferInsert;
export type TradeRow = typeof trades.$inferSelect;
export type ActivityLogRow = typeof activityLog.$inferSelect;
export type TokenStatRow = typeof tokenStats.$inferSelect;
