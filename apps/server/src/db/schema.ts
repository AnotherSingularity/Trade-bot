import { sql } from 'drizzle-orm';
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
  json,
  foreignKey,
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
  // 'degraded' = a live intent transitioned to `unknown`; new economic activity
  // is blocked until continuous reconciliation resolves it (Phase 1.1.a §A).
  reconciliationStatus: mysqlEnum('reconciliationStatus', [
    'pending',
    'in_progress',
    'ok',
    'failed',
    'degraded',
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

    // Phase 1.1.a-FIX §H: durable fencing. The scanner's Redis lease hands
    // out a monotonic `fenceGeneration`; every intent stamps the generation
    // that authorized it, and the atomic economic transaction verifies that
    // no NEWER generation exists for the same token/position before writing.
    // A stale worker whose lease was silently taken cannot commit.
    fenceGeneration: int('fenceGeneration'),

    // Phase 1.1.a-FIX §B: attempt generation for exit intents. Combined with
    // (positionId, purpose) forms a UNIQUE key so two workers cannot race to
    // allocate the same generation. Null for entries (entry uniqueness is via
    // clientOrderId).
    attemptGeneration: int('attemptGeneration'),

    // Phase 1.1.b §A: which execution_fences row authorizes this intent.
    // verifyFencingTx uses (fenceResourceKey, fenceGeneration) to lookup the
    // authoritative currentGeneration inside the atomic tx.
    fenceResourceKey: varchar('fenceResourceKey', { length: 64 }),

    // Phase 1.1.b §G: preview binding.
    previewId: varchar('previewId', { length: 64 }),
    decisionId: int('decisionId'),
    costForecastId: int('costForecastId'),
    feeTierSnapshotId: int('feeTierSnapshotId'),
    configHash: varchar('configHash', { length: 64 }),
    previewedAt: timestamp('previewedAt'),
    previewExpiresAt: timestamp('previewExpiresAt'),
    normalizedConfig: text('normalizedConfig'),

    // Phase 1.1.b §E: partial-fill state model. Populated by the fill-state
    // classifier after each fills fetch. `residualBaseSize` = remaining base
    // qty on the exchange (not yet filled).
    residualBaseSize: decimal('residualBaseSize', { precision: 20, scale: 8 }),
    fillState: mysqlEnum('fillState', [
      'unfilled_open',
      'unfilled_terminal',
      'partially_filled_open',
      'partially_filled_terminal',
      'completely_filled',
      'filled_with_dust_residual',
      'inconsistent',
      'unknown',
    ]),

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
    fenceIdx: index('order_intents_fence_idx').on(table.fenceGeneration),
    fenceResourceIdx: index('order_intents_fence_resource_idx').on(table.fenceResourceKey),
    configHashIdx: index('order_intents_config_hash_idx').on(table.configHash),
    // (positionId, purpose, attemptGeneration) UNIQUE — race-safe exit
    // allocation. NULL positionId (entries) doesn't collide, so this only
    // constrains exit intents in practice.
    exitAttemptUq: uniqueIndex('order_intents_exit_attempt_uq').on(
      table.positionId,
      table.purpose,
      table.attemptGeneration,
    ),
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

    // Phase 1.1.b §E: after a partial exit that reduces exposure but doesn't
    // close, `residualBaseSize` is the remaining base quantity. Null when the
    // position has never been partially exited (equal to filledQuantity by
    // implication).
    residualBaseSize: decimal('residualBaseSize', { precision: 20, scale: 8 }),

    openedAt: timestamp('openedAt').defaultNow().notNull(),
    closedAt: timestamp('closedAt'),

    // Phase 1.1.a §G: generated column used by the UNIQUE index below to
    // enforce "at most one open position per token" at the database. Non-null
    // only when status='open'; NULL values are permitted to repeat, so
    // arbitrarily many closed rows per token coexist.
    openTokenKey: varchar('openTokenKey', { length: 20 }).generatedAlwaysAs(
      sql`(case when \`status\` = 'open' then \`token\` else NULL end)`,
      { mode: 'virtual' },
    ),
  },
  (table) => ({
    tokenIdx: index('positions_token_idx').on(table.token),
    statusIdx: index('positions_status_idx').on(table.status),
    openTokenUq: uniqueIndex('positions_open_token_uq').on(table.openTokenKey),
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
    fillId: int('fillId'),
    dryRun: boolean('dryRun').notNull(),
    detail: text('detail'),
    // Phase 1.1.a §F: unique-per-causal-event so a replay of the same fill
    // during startup reconciliation cannot double-book the ledger. The DB
    // rejects duplicates; the application catches ER_DUP_ENTRY as a no-op.
    idempotencyKey: varchar('idempotencyKey', { length: 128 }),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
  },
  (table) => ({
    dryRunIdx: index('cash_ledger_dryrun_idx').on(table.dryRun),
    createdAtIdx: index('cash_ledger_created_at_idx').on(table.createdAt),
    idempotencyUq: uniqueIndex('cash_ledger_idempotency_uq').on(table.idempotencyKey),
    fillIdIdx: index('cash_ledger_fillId_idx').on(table.fillId),
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
// Phase 1 — Slice 1: immutable decision snapshots
// ---------------------------------------------------------------------------

/** One row per /transaction_summary fetch. Fee tier drives every cost forecast. */
export const feeTierSnapshots = mysqlTable(
  'fee_tier_snapshots',
  {
    id: int('id').autoincrement().primaryKey(),
    pricingTier: varchar('pricingTier', { length: 32 }).notNull(),
    makerFeeRate: decimal('makerFeeRate', { precision: 10, scale: 8 }).notNull(),
    takerFeeRate: decimal('takerFeeRate', { precision: 10, scale: 8 }).notNull(),
    usdVolume30d: decimal('usdVolume30d', { precision: 20, scale: 8 }),
    usdFees30d: decimal('usdFees30d', { precision: 20, scale: 8 }),
    usdFromVolume: decimal('usdFromVolume', { precision: 20, scale: 8 }),
    usdToVolume: decimal('usdToVolume', { precision: 20, scale: 8 }),
    productType: varchar('productType', { length: 16 }).notNull().default('SPOT'),
    fetchedAt: timestamp('fetchedAt').notNull().defaultNow(),
    rawResponse: json('rawResponse'),
  },
  (t) => ({
    fetchedAtIdx: index('fee_tier_snapshots_fetchedAt_idx').on(t.fetchedAt),
  }),
);

/** One row per scanner candidate — the raw features, immutable. */
export const signalCandidates = mysqlTable(
  'signal_candidates',
  {
    id: int('id').autoincrement().primaryKey(),
    scanSeed: varchar('scanSeed', { length: 64 }).notNull(),
    token: varchar('token', { length: 20 }).notNull(),
    mode: mysqlEnum('mode', ['reversion', 'breakout', 'macro']).notNull(),
    scanPrice: decimal('scanPrice', { precision: 20, scale: 8 }).notNull(),
    volume24h: decimal('volume24h', { precision: 20, scale: 8 }).notNull(),
    changePct24h: decimal('changePct24h', { precision: 10, scale: 4 }),
    rsi: decimal('rsi', { precision: 10, scale: 4 }),
    macdHistogram: decimal('macdHistogram', { precision: 20, scale: 8 }),
    emaTrend: varchar('emaTrend', { length: 16 }),
    bollingerPosition: varchar('bollingerPosition', { length: 16 }),
    passedSignals: int('passedSignals').notNull(),
    totalSignals: int('totalSignals').notNull(),
    tokenWinRate: decimal('tokenWinRate', { precision: 6, scale: 4 }),
    tokenTradeCount: int('tokenTradeCount'),
    strategyVersion: varchar('strategyVersion', { length: 32 }).notNull(),
    featureVersion: varchar('featureVersion', { length: 32 }).notNull(),
    regimeLabel: varchar('regimeLabel', { length: 32 }).notNull().default('unclassified'),
    regimeConfidence: decimal('regimeConfidence', { precision: 5, scale: 4 }),
    marketWindow: mysqlEnum('marketWindow', ['PRIME', 'ACTIVE', 'CLOSED']).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    scanSeedIdx: index('signal_candidates_scanSeed_idx').on(t.scanSeed),
    tokenIdx: index('signal_candidates_token_idx').on(t.token, t.createdAt),
  }),
);

/** One row per cost-model output. Realized-* fields set later by slice-3 reconciliation. */
export const executionCostForecasts = mysqlTable(
  'execution_cost_forecasts',
  {
    id: int('id').autoincrement().primaryKey(),
    candidateId: int('candidateId').notNull(),
    feeTierSnapshotId: int('feeTierSnapshotId').notNull(),
    previewOrderTotal: decimal('previewOrderTotal', { precision: 20, scale: 8 }),
    previewCommissionTotal: decimal('previewCommissionTotal', { precision: 20, scale: 8 }),
    previewBestBid: decimal('previewBestBid', { precision: 20, scale: 8 }),
    previewBestAsk: decimal('previewBestAsk', { precision: 20, scale: 8 }),
    previewEstimatedAvgFillPrice: decimal('previewEstimatedAvgFillPrice', {
      precision: 20,
      scale: 8,
    }),
    previewBaseSize: decimal('previewBaseSize', { precision: 20, scale: 8 }),
    previewQuoteSize: decimal('previewQuoteSize', { precision: 20, scale: 8 }),
    arrivalMid: decimal('arrivalMid', { precision: 20, scale: 8 }).notNull(),
    spreadBps: decimal('spreadBps', { precision: 10, scale: 4 }).notNull(),
    entryFee: decimal('entryFee', { precision: 20, scale: 8 }).notNull(),
    exitFeeEstimate: decimal('exitFeeEstimate', { precision: 20, scale: 8 }).notNull(),
    entryImpactBps: decimal('entryImpactBps', { precision: 10, scale: 4 }).notNull(),
    exitImpactBpsEstimate: decimal('exitImpactBpsEstimate', {
      precision: 10,
      scale: 4,
    }).notNull(),
    latencySlippageBpsEstimate: decimal('latencySlippageBpsEstimate', {
      precision: 10,
      scale: 4,
    }).notNull(),
    roundTripCost: decimal('roundTripCost', { precision: 20, scale: 8 }).notNull(),
    costToTargetPct: decimal('costToTargetPct', { precision: 10, scale: 4 }).notNull(),
    takeProfitPrice: decimal('takeProfitPrice', { precision: 20, scale: 8 }).notNull(),
    stopLossPrice: decimal('stopLossPrice', { precision: 20, scale: 8 }).notNull(),
    netTpPnl: decimal('netTpPnl', { precision: 20, scale: 8 }).notNull(),
    netSlPnl: decimal('netSlPnl', { precision: 20, scale: 8 }).notNull(),
    netRewardRisk: decimal('netRewardRisk', { precision: 10, scale: 4 }),
    breakEvenWinProb: decimal('breakEvenWinProb', { precision: 6, scale: 4 }),
    costModelVersion: varchar('costModelVersion', { length: 32 }).notNull(),
    exitCostQuantile: decimal('exitCostQuantile', { precision: 6, scale: 4 }).notNull(),
    previewWarnings: json('previewWarnings'),
    previewRawResponse: json('previewRawResponse'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    realizedEntryFee: decimal('realizedEntryFee', { precision: 20, scale: 8 }),
    realizedExitFee: decimal('realizedExitFee', { precision: 20, scale: 8 }),
    realizedEntryImpactBps: decimal('realizedEntryImpactBps', { precision: 10, scale: 4 }),
    realizedExitImpactBps: decimal('realizedExitImpactBps', { precision: 10, scale: 4 }),
    realizedRoundTripCost: decimal('realizedRoundTripCost', { precision: 20, scale: 8 }),
    realizedAt: timestamp('realizedAt'),
  },
  (t) => ({
    candidateIdx: index('execution_cost_forecasts_candidateId_idx').on(t.candidateId),
    feeTierIdx: index('execution_cost_forecasts_feeTierSnapshotId_idx').on(t.feeTierSnapshotId),
    createdIdx: index('execution_cost_forecasts_createdAt_idx').on(t.createdAt),
    // Named FKs to match the original migration-0002 constraint names so
    // drizzle-kit's snapshot equals the actual DB state.
    candidateFk: foreignKey({
      name: 'execution_cost_forecasts_candidateId_fk',
      columns: [t.candidateId],
      foreignColumns: [signalCandidates.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    feeTierFk: foreignKey({
      name: 'execution_cost_forecasts_feeTierSnapshotId_fk',
      columns: [t.feeTierSnapshotId],
      foreignColumns: [feeTierSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

/** The final accept/reject decision per candidate, with machine-readable reason. */
export const quantitativeDecisions = mysqlTable(
  'quantitative_decisions',
  {
    id: int('id').autoincrement().primaryKey(),
    candidateId: int('candidateId').notNull(),
    costForecastId: int('costForecastId'),
    decision: mysqlEnum('decision', [
      'accept',
      'reject_ev_gate',
      'reject_cost_gate',
      'reject_reward_risk_gate',
      'reject_data_stale',
      'reject_preview_warning',
      'reject_preview_error',
      'reject_fee_tier_stale',
      'reject_liquidity_gate',
      'reject_regime_gate',
      'reject_signal_gate',
      'reject_max_positions',
      'reject_already_open',
      'reject_circuit_breaker',
      'reject_paused',
      'reject_market_window',
      'reject_dedup',
    ]).notNull(),
    rejectionReason: varchar('rejectionReason', { length: 255 }),
    rejectionDetail: json('rejectionDetail'),
    netTpPnl: decimal('netTpPnl', { precision: 20, scale: 8 }),
    netSlPnl: decimal('netSlPnl', { precision: 20, scale: 8 }),
    netRewardRisk: decimal('netRewardRisk', { precision: 10, scale: 4 }),
    expectedValue: decimal('expectedValue', { precision: 20, scale: 8 }),
    breakEvenWinProb: decimal('breakEvenWinProb', { precision: 6, scale: 4 }),
    strategyVersion: varchar('strategyVersion', { length: 32 }).notNull(),
    costModelVersion: varchar('costModelVersion', { length: 32 }).notNull(),
    evGateVersion: varchar('evGateVersion', { length: 32 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    candidateIdx: index('quantitative_decisions_candidateId_idx').on(t.candidateId),
    decisionIdx: index('quantitative_decisions_decision_idx').on(t.decision, t.createdAt),
    // Named FKs to match the original migration-0002 constraint names.
    candidateFk: foreignKey({
      name: 'quantitative_decisions_candidateId_fk',
      columns: [t.candidateId],
      foreignColumns: [signalCandidates.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    costForecastFk: foreignKey({
      name: 'quantitative_decisions_costForecastId_fk',
      columns: [t.costForecastId],
      foreignColumns: [executionCostForecasts.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

// ---------------------------------------------------------------------------
// Execution fences (§A) — the authoritative fencing generation table.
//
// One row per lease resource key. Every acquireLease bumps
// `currentGeneration` atomically; every economic mutation transaction takes
// `SELECT ... FOR UPDATE` on the matching row and rejects any writer whose
// generation is older than currentGeneration.
// ---------------------------------------------------------------------------
export const executionFences = mysqlTable('execution_fences', {
  resourceKey: varchar('resourceKey', { length: 64 }).notNull().primaryKey(),
  currentGeneration: int('currentGeneration').notNull(),
  ownerId: varchar('ownerId', { length: 64 }),
  acquiredAt: timestamp('acquiredAt').notNull().defaultNow(),
  renewedAt: timestamp('renewedAt').notNull().defaultNow(),
  state: mysqlEnum('state', ['active', 'released', 'expired']).notNull().default('active'),
});

// ---------------------------------------------------------------------------
// Reconciliation observability (§I) — one row per run, one row per action.
// ---------------------------------------------------------------------------
export const reconciliationRuns = mysqlTable(
  'reconciliation_runs',
  {
    id: int('id').autoincrement().primaryKey(),
    runId: varchar('runId', { length: 64 }).notNull(),
    triggerReason: varchar('triggerReason', { length: 64 }).notNull(),
    startedAt: timestamp('startedAt').notNull().defaultNow(),
    completedAt: timestamp('completedAt'),
    ownerId: varchar('ownerId', { length: 64 }),
    fenceGeneration: int('fenceGeneration'),
    intentsExamined: int('intentsExamined').notNull().default(0),
    intentsResolved: int('intentsResolved').notNull().default(0),
    intentsStillUnknown: int('intentsStillUnknown').notNull().default(0),
    fillsDiscovered: int('fillsDiscovered').notNull().default(0),
    economicRecordsApplied: int('economicRecordsApplied').notNull().default(0),
    discrepancyCount: int('discrepancyCount').notNull().default(0),
    finalStatus: mysqlEnum('finalStatus', ['running', 'ok', 'degraded', 'failed'])
      .notNull()
      .default('running'),
    failureReasonCode: varchar('failureReasonCode', { length: 64 }),
    detail: text('detail'),
  },
  (table) => ({
    runIdUnique: uniqueIndex('reconciliation_runs_runid_uq').on(table.runId),
    startedIdx: index('reconciliation_runs_started_idx').on(table.startedAt),
  }),
);

export const reconciliationActions = mysqlTable(
  'reconciliation_actions',
  {
    id: int('id').autoincrement().primaryKey(),
    runId: varchar('runId', { length: 64 }).notNull(),
    intentId: int('intentId'),
    clientOrderId: varchar('clientOrderId', { length: 64 }),
    action: varchar('action', { length: 64 }).notNull(),
    previousState: varchar('previousState', { length: 32 }),
    newState: varchar('newState', { length: 32 }),
    fillsBefore: int('fillsBefore'),
    fillsAfter: int('fillsAfter'),
    paginationResult: varchar('paginationResult', { length: 64 }),
    failureReasonCode: varchar('failureReasonCode', { length: 64 }),
    detail: text('detail'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index('reconciliation_actions_run_idx').on(table.runId),
    intentIdx: index('reconciliation_actions_intent_idx').on(table.intentId),
  }),
);

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------
export type BotConfigRow = typeof botConfig.$inferSelect;
export type OrderIntentRow = typeof orderIntents.$inferSelect;
export type OrderIntentInsert = typeof orderIntents.$inferInsert;
export type ExecutionFenceRow = typeof executionFences.$inferSelect;
export type ReconciliationRunRow = typeof reconciliationRuns.$inferSelect;
export type ReconciliationRunInsert = typeof reconciliationRuns.$inferInsert;
export type ReconciliationActionRow = typeof reconciliationActions.$inferSelect;
export type ReconciliationActionInsert = typeof reconciliationActions.$inferInsert;
export type FillRow = typeof fills.$inferSelect;
export type FillInsert = typeof fills.$inferInsert;
export type PositionRow = typeof positions.$inferSelect;
export type PositionInsert = typeof positions.$inferInsert;
export type RoundTripRow = typeof roundTrips.$inferSelect;
export type RoundTripInsert = typeof roundTrips.$inferInsert;
export type CashLedgerRow = typeof cashLedger.$inferSelect;
export type CashLedgerInsert = typeof cashLedger.$inferInsert;
export type FeeTierSnapshotRow = typeof feeTierSnapshots.$inferSelect;
export type FeeTierSnapshotInsert = typeof feeTierSnapshots.$inferInsert;
export type SignalCandidateRow = typeof signalCandidates.$inferSelect;
export type SignalCandidateInsert = typeof signalCandidates.$inferInsert;
export type ExecutionCostForecastRow = typeof executionCostForecasts.$inferSelect;
export type ExecutionCostForecastInsert = typeof executionCostForecasts.$inferInsert;
export type QuantitativeDecisionRow = typeof quantitativeDecisions.$inferSelect;
export type QuantitativeDecisionInsert = typeof quantitativeDecisions.$inferInsert;
export type TradeRow = typeof trades.$inferSelect;
export type ActivityLogRow = typeof activityLog.$inferSelect;
export type TokenStatRow = typeof tokenStats.$inferSelect;
