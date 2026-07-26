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

    // Phase 1.1 Gate 2: direct lineage back to the decision chain that
    // authorized this intent. Nullable for legacy rows created before Gate 2.
    decisionChainId: int('decisionChainId'),
    // For exit intents: the ENTRY decision chain the position originated from.
    entryDecisionChainId: int('entryDecisionChainId'),
    strategyVersionAt: varchar('strategyVersionAt', { length: 32 }),
    costModelVersionAt: varchar('costModelVersionAt', { length: 32 }),
    protectionGeneration: int('protectionGeneration'),

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
    decisionChainIdx: index('order_intents_decision_chain_idx').on(table.decisionChainId),
    entryChainIdx: index('order_intents_entry_chain_idx').on(table.entryDecisionChainId),
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

    // Canonical position lifecycle state (Gate 3A §A).
    // Legacy values 'opening', 'open', 'closing', 'closed', 'reconciling'
    // remain valid for pre-Gate-3 rows. New Gate 3A states surface exact
    // conditions: partially_open (some fills in, remainder still working),
    // open_unprotected/open_protected (protection state known),
    // partially_closing (partial exit in progress), dust_residual (closed
    // by policy with a documented dust remainder), reconciliation_required
    // (state ambiguous — blocks new entries), failed (terminal error).
    lifecycleState: mysqlEnum('lifecycleState', [
      'opening',
      'open',
      'closing',
      'closed',
      'reconciling',
      'pending_entry',
      'partially_open',
      'open_unprotected',
      'open_protected',
      'partially_closing',
      'dust_residual',
      'reconciliation_required',
      'failed',
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

    // Phase 1.1 Gate 2: entry decision chain that authorized this position.
    // A position may span multiple exit-decision chains; those are accessed
    // via order_intents.entryDecisionChainId + positionId join.
    entryDecisionChainId: int('entryDecisionChainId'),

    // Phase 1.1 Gate 3A §F: dust policy fields — populated when the
    // position is closed with a documented dust remainder. Never fabricated
    // as a sale at the last market price.
    dustQuantity: decimal('dustQuantity', { precision: 20, scale: 8 }),
    dustEstimatedValue: decimal('dustEstimatedValue', { precision: 20, scale: 8 }),
    dustReason: varchar('dustReason', { length: 64 }),
    dustDetectedAt: timestamp('dustDetectedAt'),
    dustPolicyVersion: varchar('dustPolicyVersion', { length: 32 }),

    // Phase 1.1 Gate 3A §Q (placeholder; Gate 3C wires the matrix). Records
    // the position's current protection state so the RiskEngine + entry
    // gate can block on `open_unprotected` / `degraded`.
    protectionState: mysqlEnum('protectionState', [
      'unknown',
      'none',
      'polling_only',
      'attached_active',
      'attached_partial',
      'degraded',
    ])
      .notNull()
      .default('unknown'),

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
    entryChainIdx: index('positions_entry_chain_idx').on(table.entryDecisionChainId),
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

    // Phase 1.1 Gate 2: lineage back-references. entryDecisionChainId is the
    // chain that authorized the entry; finalExitDecisionChainId is the LAST
    // exit chain (there may have been earlier partial-exit chains which are
    // discoverable via order_intents.entryDecisionChainId + positionId).
    entryDecisionChainId: int('entryDecisionChainId'),
    finalExitDecisionChainId: int('finalExitDecisionChainId'),
    entryOrderIntentId: int('entryOrderIntentId'),
    finalExitOrderIntentId: int('finalExitOrderIntentId'),
  },
  (table) => ({
    positionIdUnique: uniqueIndex('round_trips_position_uq').on(table.positionId),
    tokenIdx: index('round_trips_token_idx').on(table.token),
    outcomeIdx: index('round_trips_outcome_idx').on(table.outcome),
    closedAtIdx: index('round_trips_closed_at_idx').on(table.closedAt),
    entryChainIdx: index('round_trips_entry_chain_idx').on(table.entryDecisionChainId),
    finalExitChainIdx: index('round_trips_final_exit_chain_idx').on(table.finalExitDecisionChainId),
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
    // Phase 1.1 Gate 2: every ledger event must have exactly one valid cause
    // category. Fill-driven credits/debits carry fillId + orderIntentId +
    // decisionChainId; explicit adjustments carry adjustmentType/Reason/actor;
    // initial funding is its own category.
    decisionChainId: int('decisionChainId'),
    adjustmentType: varchar('adjustmentType', { length: 32 }),
    adjustmentReason: varchar('adjustmentReason', { length: 255 }),
    actor: varchar('actor', { length: 64 }),
    reconciliationRunId: varchar('reconciliationRunId', { length: 64 }),
    causeCategory: mysqlEnum('causeCategory', ['fill_driven', 'explicit_adjustment', 'initial_funding']),
  },
  (table) => ({
    dryRunIdx: index('cash_ledger_dryrun_idx').on(table.dryRun),
    createdAtIdx: index('cash_ledger_created_at_idx').on(table.createdAt),
    idempotencyUq: uniqueIndex('cash_ledger_idempotency_uq').on(table.idempotencyKey),
    fillIdIdx: index('cash_ledger_fillId_idx').on(table.fillId),
    decisionChainIdx: index('cash_ledger_decision_chain_idx').on(table.decisionChainId),
    causeIdx: index('cash_ledger_cause_idx').on(table.causeCategory),
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
    // Phase 1.1 Gate 2 lineage refs (nullable for legacy rows).
    decisionChainId: int('decisionChainId'),
    marketObservationId: int('marketObservationId'),
    setupEvaluationId: int('setupEvaluationId'),
    routingDecisionId: int('routingDecisionId'),
  },
  (t) => ({
    scanSeedIdx: index('signal_candidates_scanSeed_idx').on(t.scanSeed),
    tokenIdx: index('signal_candidates_token_idx').on(t.token, t.createdAt),
    chainIdx: index('signal_candidates_chain_idx').on(t.decisionChainId),
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
    // Phase 1.1 Gate 2 lineage refs (nullable for legacy rows).
    decisionChainId: int('decisionChainId'),
    routingDecisionId: int('routingDecisionId'),
    // Phase 1.1 Gate 3B — exact cash-flow columns (§I).
    expectedFilledBase: decimal('expectedFilledBase', { precision: 20, scale: 8 }),
    previewEntryFillPrice: decimal('previewEntryFillPrice', { precision: 20, scale: 8 }),
    conservativeTargetExitPrice: decimal('conservativeTargetExitPrice', { precision: 20, scale: 8 }),
    conservativeStopExitPrice: decimal('conservativeStopExitPrice', { precision: 20, scale: 8 }),
    conservativeTimeoutExitPrice: decimal('conservativeTimeoutExitPrice', { precision: 20, scale: 8 }),
    entryOutflow: decimal('entryOutflow', { precision: 20, scale: 8 }),
    targetInflow: decimal('targetInflow', { precision: 20, scale: 8 }),
    stopInflow: decimal('stopInflow', { precision: 20, scale: 8 }),
    timeoutInflow: decimal('timeoutInflow', { precision: 20, scale: 8 }),
    netTargetPnl: decimal('netTargetPnl', { precision: 20, scale: 8 }),
    netStopPnl: decimal('netStopPnl', { precision: 20, scale: 8 }),
    netTimeoutPnl: decimal('netTimeoutPnl', { precision: 20, scale: 8 }),
    // Phase 1.1 Gate 3B — separated cost components (§J).
    entryCommission: decimal('entryCommission', { precision: 20, scale: 8 }),
    targetExitCommission: decimal('targetExitCommission', { precision: 20, scale: 8 }),
    stopExitCommission: decimal('stopExitCommission', { precision: 20, scale: 8 }),
    timeoutExitCommission: decimal('timeoutExitCommission', { precision: 20, scale: 8 }),
    quotedSpread: decimal('quotedSpread', { precision: 20, scale: 8 }),
    effectiveSpread: decimal('effectiveSpread', { precision: 20, scale: 8 }),
    entryImpact: decimal('entryImpact', { precision: 20, scale: 8 }),
    targetExitImpact: decimal('targetExitImpact', { precision: 20, scale: 8 }),
    stopExitImpact: decimal('stopExitImpact', { precision: 20, scale: 8 }),
    latencyBufferAbs: decimal('latencyBufferAbs', { precision: 20, scale: 8 }),
    stopGapBufferAbs: decimal('stopGapBufferAbs', { precision: 20, scale: 8 }),
    partialFillBufferAbs: decimal('partialFillBufferAbs', { precision: 20, scale: 8 }),
    unfilledOpportunityEstimate: decimal('unfilledOpportunityEstimate', { precision: 20, scale: 8 }),
    residualDustEstimate: decimal('residualDustEstimate', { precision: 20, scale: 8 }),
    totalForecastCost: decimal('totalForecastCost', { precision: 20, scale: 8 }),
    // Phase 1.1 Gate 3B §K — which price basis TP/SL were derived from.
    targetStopBasis: mysqlEnum('targetStopBasis', ['preview_entry', 'reconciled_entry']),
    // Phase 1.1 Gate 3B §L — honest buffer metadata.
    bufferSource: varchar('bufferSource', { length: 64 }),
    bufferVersion: varchar('bufferVersion', { length: 32 }),
    bufferSampleCount: int('bufferSampleCount'),
    isEmpiricalBuffer: boolean('isEmpiricalBuffer').notNull().default(false),
    // Phase 1.1 Gate 3B §N — outcome probability estimates (not_calibrated).
    pTarget: decimal('pTarget', { precision: 6, scale: 4 }),
    pStop: decimal('pStop', { precision: 6, scale: 4 }),
    pTimeout: decimal('pTimeout', { precision: 6, scale: 4 }),
    probabilityUncertaintyLower: decimal('probabilityUncertaintyLower', { precision: 6, scale: 4 }),
    probabilityUncertaintyUpper: decimal('probabilityUncertaintyUpper', { precision: 6, scale: 4 }),
    probabilityModelVersion: varchar('probabilityModelVersion', { length: 32 }),
    probabilitySampleCount: int('probabilitySampleCount'),
    probabilityCalibrationStatus: mysqlEnum('probabilityCalibrationStatus', [
      'not_calibrated',
      'calibrating',
      'calibrated_low_conf',
      'calibrated',
    ])
      .notNull()
      .default('not_calibrated'),
    // Phase 1.1 Gate 3B §K — post-fill deviation from preview.
    postFillDeviationBps: decimal('postFillDeviationBps', { precision: 10, scale: 4 }),
    revalidationRequired: boolean('revalidationRequired').notNull().default(false),
  },
  (t) => ({
    candidateIdx: index('execution_cost_forecasts_candidateId_idx').on(t.candidateId),
    feeTierIdx: index('execution_cost_forecasts_feeTierSnapshotId_idx').on(t.feeTierSnapshotId),
    createdIdx: index('execution_cost_forecasts_createdAt_idx').on(t.createdAt),
    chainIdx: index('execution_cost_forecasts_chain_idx').on(t.decisionChainId),
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
    // Phase 1.1 Gate 2 lineage refs.
    decisionChainId: int('decisionChainId'),
  },
  (t) => ({
    candidateIdx: index('quantitative_decisions_candidateId_idx').on(t.candidateId),
    decisionIdx: index('quantitative_decisions_decision_idx').on(t.decision, t.createdAt),
    chainIdx: index('quantitative_decisions_chain_idx').on(t.decisionChainId),
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
    // Phase 1.1 Gate 2 lineage extension.
    decisionChainId: int('decisionChainId'),
    economicStateApplied: boolean('economicStateApplied').notNull().default(false),
    fillsDiscovered: int('fillsDiscovered'),
  },
  (table) => ({
    runIdx: index('reconciliation_actions_run_idx').on(table.runId),
    intentIdx: index('reconciliation_actions_intent_idx').on(table.intentId),
    chainIdx: index('reconciliation_actions_chain_idx').on(table.decisionChainId),
  }),
);

// ---------------------------------------------------------------------------
// Phase 1.1 Gate 2 — decision-to-outcome lineage
// ---------------------------------------------------------------------------

/** One scanner cycle or manually initiated evaluation run. */
export const scanRuns = mysqlTable(
  'scan_runs',
  {
    id: int('id').autoincrement().primaryKey(),
    triggerType: varchar('triggerType', { length: 64 }).notNull(),
    startedAt: timestamp('startedAt').notNull().defaultNow(),
    completedAt: timestamp('completedAt'),
    status: mysqlEnum('status', [
      'started',
      'completed',
      'partially_completed',
      'blocked',
      'failed',
    ])
      .notNull()
      .default('started'),
    botState: varchar('botState', { length: 32 }),
    reconciliationStatus: varchar('reconciliationStatus', { length: 32 }),
    marketWindowState: varchar('marketWindowState', { length: 32 }),
    scannerVersion: varchar('scannerVersion', { length: 32 }).notNull(),
    failureReason: varchar('failureReason', { length: 255 }),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    startedIdx: index('scan_runs_started_idx').on(t.startedAt),
    statusIdx: index('scan_runs_status_idx').on(t.status),
  }),
);

/**
 * Permanent decision-chain root — one chain per product evaluation per scan
 * run. Every evaluated product gets a chain, whether it's rejected at
 * eligibility, has no setup, is a candidate that's economically rejected, or
 * proceeds all the way to a filled position and an outcome label.
 */
export const decisionChains = mysqlTable(
  'decision_chains',
  {
    id: int('id').autoincrement().primaryKey(),
    scanRunId: int('scanRunId').notNull(),
    productId: varchar('productId', { length: 30 }).notNull(),
    strategyVersion: varchar('strategyVersion', { length: 32 }).notNull(),
    currentStatus: mysqlEnum('currentStatus', [
      'observed',
      'ineligible',
      'no_setup',
      'candidate',
      'economically_rejected',
      'quantitatively_rejected',
      'approved',
      'order_pending',
      'partially_filled',
      'position_open',
      'position_closed',
      'outcome_labeled',
      'failed',
    ])
      .notNull()
      .default('observed'),
    observedAt: timestamp('observedAt').notNull(),
    dataAvailableAt: timestamp('dataAvailableAt').notNull(),
    decisionStartedAt: timestamp('decisionStartedAt').notNull(),
    decisionCompletedAt: timestamp('decisionCompletedAt'),
    lineageCompleteness: mysqlEnum('lineageCompleteness', [
      'complete',
      'partial',
      'broken',
      'legacy_unresolved',
    ])
      .notNull()
      .default('partial'),
    legacyStatus: mysqlEnum('legacyStatus', ['current', 'legacy_backfilled', 'legacy_unresolved'])
      .notNull()
      .default('current'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt').notNull().defaultNow().onUpdateNow(),
  },
  (t) => ({
    scanIdx: index('decision_chains_scan_idx').on(t.scanRunId),
    productIdx: index('decision_chains_product_idx').on(t.productId, t.observedAt),
    statusIdx: index('decision_chains_status_idx').on(t.currentStatus),
    scanFk: foreignKey({
      name: 'decision_chains_scanRunId_fk',
      columns: [t.scanRunId],
      foreignColumns: [scanRuns.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

/** Immutable snapshot of market data available at decision time. */
export const marketObservations = mysqlTable(
  'market_observations',
  {
    id: int('id').autoincrement().primaryKey(),
    decisionChainId: int('decisionChainId').notNull(),
    productId: varchar('productId', { length: 30 }).notNull(),
    observedAt: timestamp('observedAt').notNull(),
    dataAvailableAt: timestamp('dataAvailableAt').notNull(),
    marketDataVersion: varchar('marketDataVersion', { length: 32 }).notNull(),
    inputDataHash: varchar('inputDataHash', { length: 64 }).notNull(),
    price: decimal('price', { precision: 20, scale: 8 }),
    volume24h: decimal('volume24h', { precision: 20, scale: 8 }),
    spread: decimal('spread', { precision: 20, scale: 8 }),
    dataQualityStatus: mysqlEnum('dataQualityStatus', [
      'valid',
      'stale',
      'incomplete',
      'invalid',
      'unavailable',
    ]).notNull(),
    failureReason: varchar('failureReason', { length: 255 }),
    immutablePayload: text('immutablePayload').notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    chainIdx: index('market_observations_chain_idx').on(t.decisionChainId),
    hashIdx: index('market_observations_hash_idx').on(t.inputDataHash),
    chainFk: foreignKey({
      name: 'market_observations_decisionChainId_fk',
      columns: [t.decisionChainId],
      foreignColumns: [decisionChains.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

/** Why a product was (in)eligible for this scan cycle. */
export const eligibilityDecisions = mysqlTable(
  'eligibility_decisions',
  {
    id: int('id').autoincrement().primaryKey(),
    decisionChainId: int('decisionChainId').notNull(),
    marketObservationId: int('marketObservationId'),
    eligible: boolean('eligible').notNull(),
    reasonCode: mysqlEnum('reasonCode', [
      'eligible',
      'reconciliation_degraded',
      'unsupported_product',
      'invalid_product_state',
      'insufficient_volume',
      'insufficient_history',
      'stale_market_data',
      'market_data_failure',
      'existing_position',
      'position_limit',
      'market_window_exclusion',
      'paused',
      'circuit_breaker',
    ]).notNull(),
    reasonDetail: varchar('reasonDetail', { length: 255 }),
    policyVersion: varchar('policyVersion', { length: 32 }).notNull(),
    decidedAt: timestamp('decidedAt').notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    chainIdx: index('eligibility_decisions_chain_idx').on(t.decisionChainId),
    chainFk: foreignKey({
      name: 'eligibility_decisions_decisionChainId_fk',
      columns: [t.decisionChainId],
      foreignColumns: [decisionChains.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    obsFk: foreignKey({
      name: 'eligibility_decisions_marketObservationId_fk',
      columns: [t.marketObservationId],
      foreignColumns: [marketObservations.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

/** Records the current three-mode scanner evaluation for one product. */
export const setupEvaluations = mysqlTable(
  'setup_evaluations',
  {
    id: int('id').autoincrement().primaryKey(),
    decisionChainId: int('decisionChainId').notNull(),
    marketObservationId: int('marketObservationId').notNull(),
    modeEvaluated: varchar('modeEvaluated', { length: 32 }),
    setupDetected: boolean('setupDetected').notNull(),
    setupScore: decimal('setupScore', { precision: 10, scale: 6 }),
    strategyVersion: varchar('strategyVersion', { length: 32 }).notNull(),
    indicatorVersion: varchar('indicatorVersion', { length: 32 }).notNull(),
    inputHash: varchar('inputHash', { length: 64 }).notNull(),
    reasonCodes: text('reasonCodes').notNull(),
    evaluatedAt: timestamp('evaluatedAt').notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    chainIdx: index('setup_evaluations_chain_idx').on(t.decisionChainId),
    chainFk: foreignKey({
      name: 'setup_evaluations_decisionChainId_fk',
      columns: [t.decisionChainId],
      foreignColumns: [decisionChains.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    obsFk: foreignKey({
      name: 'setup_evaluations_marketObservationId_fk',
      columns: [t.marketObservationId],
      foreignColumns: [marketObservations.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

/** Which mode routed this product this scan, or a no-trade outcome. */
export const strategyRoutingDecisions = mysqlTable(
  'strategy_routing_decisions',
  {
    id: int('id').autoincrement().primaryKey(),
    decisionChainId: int('decisionChainId').notNull(),
    setupEvaluationId: int('setupEvaluationId').notNull(),
    selectedMode: varchar('selectedMode', { length: 32 }),
    routingOutcome: mysqlEnum('routingOutcome', [
      'reversion',
      'breakout',
      'macro_floor',
      'no_trade',
      'conflict',
      'unclassified',
    ]).notNull(),
    reasonCodes: text('reasonCodes').notNull(),
    strategyVersion: varchar('strategyVersion', { length: 32 }).notNull(),
    decidedAt: timestamp('decidedAt').notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    chainIdx: index('strategy_routing_decisions_chain_idx').on(t.decisionChainId),
    chainFk: foreignKey({
      name: 'strategy_routing_decisions_decisionChainId_fk',
      columns: [t.decisionChainId],
      foreignColumns: [decisionChains.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    setupFk: foreignKey({
      name: 'strategy_routing_decisions_setupEvaluationId_fk',
      columns: [t.setupEvaluationId],
      foreignColumns: [setupEvaluations.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

/**
 * Outcome labels — version-bumped; corrections create a NEW row with
 * `supersedesOutcomeLabelId` set. UNIQUE(decisionChainId, labelVersion)
 * enforces "immutable once written".
 */
export const outcomeLabels = mysqlTable(
  'outcome_labels',
  {
    id: int('id').autoincrement().primaryKey(),
    decisionChainId: int('decisionChainId').notNull(),
    roundTripId: int('roundTripId'),
    labelVersion: int('labelVersion').notNull(),
    labelType: varchar('labelType', { length: 64 }).notNull(),
    tpReachedFirst: boolean('tpReachedFirst'),
    slReachedFirst: boolean('slReachedFirst'),
    timeout: boolean('timeout').notNull().default(false),
    ambiguous: boolean('ambiguous').notNull().default(false),
    maximumFavorableExcursion: decimal('maximumFavorableExcursion', { precision: 20, scale: 8 }),
    maximumAdverseExcursion: decimal('maximumAdverseExcursion', { precision: 20, scale: 8 }),
    timeToTp: int('timeToTp'),
    timeToSl: int('timeToSl'),
    grossPnl: decimal('grossPnl', { precision: 20, scale: 8 }),
    netPnl: decimal('netPnl', { precision: 20, scale: 8 }),
    totalFees: decimal('totalFees', { precision: 20, scale: 8 }),
    forecastCost: decimal('forecastCost', { precision: 20, scale: 8 }),
    realizedCost: decimal('realizedCost', { precision: 20, scale: 8 }),
    labelWindowStart: timestamp('labelWindowStart').notNull(),
    labelWindowEnd: timestamp('labelWindowEnd').notNull(),
    dataAvailableAt: timestamp('dataAvailableAt').notNull(),
    supersedesOutcomeLabelId: int('supersedesOutcomeLabelId'),
    correctionReason: varchar('correctionReason', { length: 255 }),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    chainVersionUq: uniqueIndex('outcome_labels_chain_version_uq').on(
      t.decisionChainId,
      t.labelVersion,
    ),
    chainIdx: index('outcome_labels_chain_idx').on(t.decisionChainId),
    roundtripIdx: index('outcome_labels_roundtrip_idx').on(t.roundTripId),
    chainFk: foreignKey({
      name: 'outcome_labels_decisionChainId_fk',
      columns: [t.decisionChainId],
      foreignColumns: [decisionChains.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

/** Append-only journal of state transitions + reconciliation events. */
export const lineageEvents = mysqlTable(
  'lineage_events',
  {
    id: int('id').autoincrement().primaryKey(),
    decisionChainId: int('decisionChainId').notNull(),
    eventType: varchar('eventType', { length: 64 }).notNull(),
    sourceEntityType: varchar('sourceEntityType', { length: 64 }).notNull(),
    sourceRecordId: int('sourceRecordId'),
    eventTime: timestamp('eventTime').notNull(),
    dataAvailableAt: timestamp('dataAvailableAt'),
    actor: varchar('actor', { length: 64 }).notNull(),
    componentVersion: varchar('componentVersion', { length: 32 }).notNull(),
    metadata: text('metadata'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    chainIdx: index('lineage_events_chain_idx').on(t.decisionChainId, t.eventTime),
    typeIdx: index('lineage_events_type_idx').on(t.eventType),
    chainFk: foreignKey({
      name: 'lineage_events_decisionChainId_fk',
      columns: [t.decisionChainId],
      foreignColumns: [decisionChains.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

// ---------------------------------------------------------------------------
// Phase 1.1 Gate 3B — forecast-vs-realized attribution (§O)
// ---------------------------------------------------------------------------
export const forecastVsRealizedAttributions = mysqlTable(
  'forecast_vs_realized_attributions',
  {
    id: int('id').autoincrement().primaryKey(),
    roundTripId: int('roundTripId').notNull(),
    decisionChainId: int('decisionChainId').notNull(),
    costForecastId: int('costForecastId').notNull(),
    forecastEntryCost: decimal('forecastEntryCost', { precision: 20, scale: 8 }).notNull(),
    realizedEntryCost: decimal('realizedEntryCost', { precision: 20, scale: 8 }).notNull(),
    forecastExitCost: decimal('forecastExitCost', { precision: 20, scale: 8 }).notNull(),
    realizedExitCost: decimal('realizedExitCost', { precision: 20, scale: 8 }).notNull(),
    forecastTotalCost: decimal('forecastTotalCost', { precision: 20, scale: 8 }).notNull(),
    realizedTotalCost: decimal('realizedTotalCost', { precision: 20, scale: 8 }).notNull(),
    forecastSlippage: decimal('forecastSlippage', { precision: 20, scale: 8 }),
    realizedSlippage: decimal('realizedSlippage', { precision: 20, scale: 8 }),
    forecastCommission: decimal('forecastCommission', { precision: 20, scale: 8 }),
    realizedCommission: decimal('realizedCommission', { precision: 20, scale: 8 }),
    forecastNetTargetPnl: decimal('forecastNetTargetPnl', { precision: 20, scale: 8 }),
    forecastNetStopPnl: decimal('forecastNetStopPnl', { precision: 20, scale: 8 }),
    forecastNetTimeoutPnl: decimal('forecastNetTimeoutPnl', { precision: 20, scale: 8 }),
    realizedNetPnl: decimal('realizedNetPnl', { precision: 20, scale: 8 }).notNull(),
    absoluteForecastError: decimal('absoluteForecastError', { precision: 20, scale: 8 }).notNull(),
    forecastErrorBps: decimal('forecastErrorBps', { precision: 10, scale: 4 }),
    outcomeTaken: mysqlEnum('outcomeTaken', ['target', 'stop', 'timeout', 'ambiguous', 'other']).notNull(),
    attributionVersion: varchar('attributionVersion', { length: 32 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    roundTripUq: uniqueIndex('forecast_vs_realized_roundtrip_uq').on(t.roundTripId),
    chainIdx: index('forecast_vs_realized_chain_idx').on(t.decisionChainId),
    chainFk: foreignKey({
      name: 'forecast_vs_realized_decisionChainId_fk',
      columns: [t.decisionChainId],
      foreignColumns: [decisionChains.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

// ---------------------------------------------------------------------------
// Phase 1.1 Gate 3C — protection capability + validation + instance + events
// ---------------------------------------------------------------------------
export const protectionPolicyVersions = mysqlTable(
  'protection_policy_versions',
  {
    id: int('id').autoincrement().primaryKey(),
    version: varchar('version', { length: 32 }).notNull(),
    status: mysqlEnum('status', ['draft', 'active', 'superseded', 'retired']).notNull().default('draft'),
    description: text('description'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    activatedAt: timestamp('activatedAt'),
    supersedesPolicyId: int('supersedesPolicyId'),
  },
  (t) => ({
    versionUq: uniqueIndex('protection_policy_version_uq').on(t.version),
    statusIdx: index('protection_policy_status_idx').on(t.status),
  }),
);

export const protectionCapabilities = mysqlTable(
  'protection_capabilities',
  {
    id: int('id').autoincrement().primaryKey(),
    policyVersionId: int('policyVersionId').notNull(),
    productId: varchar('productId', { length: 30 }).notNull(),
    side: mysqlEnum('side', ['BUY', 'SELL']).notNull(),
    entryOrderType: varchar('entryOrderType', { length: 32 }).notNull(),
    timeInForce: varchar('timeInForce', { length: 16 }).notNull(),
    protectionType: mysqlEnum('protectionType', [
      'attached_trigger_bracket_gtc',
      'independent_stop_limit',
      'independent_take_profit',
      'independent_bracket',
      'application_polling',
      'none',
    ]).notNull(),
    capabilityState: mysqlEnum('capabilityState', [
      'unknown',
      'documented_unverified',
      'preview_supported',
      'preview_rejected',
      'shadow_validated',
      'sandbox_validated',
      'live_canary_validated',
      'unsupported',
      'temporarily_degraded',
    ])
      .notNull()
      .default('unknown'),
    source: varchar('source', { length: 64 }).notNull(),
    validatedAt: timestamp('validatedAt'),
    expiresAt: timestamp('expiresAt'),
    evidenceHash: varchar('evidenceHash', { length: 64 }),
    limitations: text('limitations'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    identityUq: uniqueIndex('protection_capability_identity_uq').on(
      t.policyVersionId,
      t.productId,
      t.side,
      t.entryOrderType,
      t.timeInForce,
      t.protectionType,
    ),
    stateIdx: index('protection_capability_state_idx').on(t.capabilityState),
    productIdx: index('protection_capability_product_idx').on(t.productId),
    policyFk: foreignKey({
      name: 'protection_capability_policy_fk',
      columns: [t.policyVersionId],
      foreignColumns: [protectionPolicyVersions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const protectionValidationRuns = mysqlTable(
  'protection_validation_runs',
  {
    id: int('id').autoincrement().primaryKey(),
    policyVersionId: int('policyVersionId').notNull(),
    capabilityId: int('capabilityId'),
    productId: varchar('productId', { length: 30 }).notNull(),
    configurationHash: varchar('configurationHash', { length: 64 }).notNull(),
    validationType: mysqlEnum('validationType', [
      'documentation_review',
      'preview_fixture',
      'shadow_fixture',
      'sandbox',
      'live_canary',
    ]).notNull(),
    startedAt: timestamp('startedAt').notNull(),
    completedAt: timestamp('completedAt'),
    result: mysqlEnum('result', ['pending', 'passed', 'failed', 'inconclusive', 'aborted'])
      .notNull()
      .default('pending'),
    previewRequest: text('previewRequest'),
    previewResponseSanitized: text('previewResponseSanitized'),
    failureCode: varchar('failureCode', { length: 64 }),
    failureReason: text('failureReason'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    policyIdx: index('protection_validation_policy_idx').on(t.policyVersionId),
    capabilityIdx: index('protection_validation_capability_idx').on(t.capabilityId),
    hashIdx: index('protection_validation_hash_idx').on(t.configurationHash),
    policyFk: foreignKey({
      name: 'protection_validation_policy_fk',
      columns: [t.policyVersionId],
      foreignColumns: [protectionPolicyVersions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    capabilityFk: foreignKey({
      name: 'protection_validation_capability_fk',
      columns: [t.capabilityId],
      foreignColumns: [protectionCapabilities.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const protectionInstances = mysqlTable(
  'protection_instances',
  {
    id: int('id').autoincrement().primaryKey(),
    positionId: int('positionId').notNull(),
    decisionChainId: int('decisionChainId').notNull(),
    entryOrderIntentId: int('entryOrderIntentId').notNull(),
    policyVersionId: int('policyVersionId').notNull(),
    capabilityId: int('capabilityId').notNull(),
    protectionType: mysqlEnum('protectionType', [
      'attached_trigger_bracket_gtc',
      'independent_stop_limit',
      'independent_take_profit',
      'independent_bracket',
      'application_polling',
      'none',
    ]).notNull(),
    requiredBaseQuantity: decimal('requiredBaseQuantity', { precision: 20, scale: 8 }).notNull(),
    confirmedBaseQuantity: decimal('confirmedBaseQuantity', { precision: 20, scale: 8 })
      .notNull()
      .default('0'),
    targetPrice: decimal('targetPrice', { precision: 20, scale: 8 }).notNull(),
    stopTriggerPrice: decimal('stopTriggerPrice', { precision: 20, scale: 8 }).notNull(),
    stopLimitPrice: decimal('stopLimitPrice', { precision: 20, scale: 8 }),
    takeProfitLegState: mysqlEnum('takeProfitLegState', [
      'pending',
      'active',
      'partially_filled',
      'filled',
      'disabled',
      'canceled',
      'rejected',
      'unknown',
    ])
      .notNull()
      .default('pending'),
    stopLossLegState: mysqlEnum('stopLossLegState', [
      'pending',
      'active',
      'partially_filled',
      'filled',
      'disabled',
      'canceled',
      'rejected',
      'unknown',
    ])
      .notNull()
      .default('pending'),
    state: mysqlEnum('state', [
      'required',
      'pending',
      'confirmed',
      'partially_confirmed',
      'missing',
      'rejected',
      'canceled',
      'triggered',
      'completed',
      'inconsistent',
      'degraded',
    ])
      .notNull()
      .default('required'),
    lastVerifiedAt: timestamp('lastVerifiedAt'),
    failureReason: varchar('failureReason', { length: 255 }),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt').notNull().defaultNow().onUpdateNow(),
  },
  (t) => ({
    positionUq: uniqueIndex('protection_instance_position_uq').on(t.positionId),
    stateIdx: index('protection_instance_state_idx').on(t.state),
    chainIdx: index('protection_instance_chain_idx').on(t.decisionChainId),
    policyIdx: index('protection_instance_policy_idx').on(t.policyVersionId),
    policyFk: foreignKey({
      name: 'protection_instance_policy_fk',
      columns: [t.policyVersionId],
      foreignColumns: [protectionPolicyVersions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    capabilityFk: foreignKey({
      name: 'protection_instance_capability_fk',
      columns: [t.capabilityId],
      foreignColumns: [protectionCapabilities.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    chainFk: foreignKey({
      name: 'protection_instance_chain_fk',
      columns: [t.decisionChainId],
      foreignColumns: [decisionChains.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const protectionEvents = mysqlTable(
  'protection_events',
  {
    id: int('id').autoincrement().primaryKey(),
    protectionInstanceId: int('protectionInstanceId').notNull(),
    decisionChainId: int('decisionChainId').notNull(),
    eventType: varchar('eventType', { length: 64 }).notNull(),
    previousState: varchar('previousState', { length: 48 }),
    newState: varchar('newState', { length: 48 }).notNull(),
    leg: mysqlEnum('leg', ['take_profit_leg', 'stop_loss_leg', 'instance'])
      .notNull()
      .default('instance'),
    reason: varchar('reason', { length: 255 }),
    metadata: text('metadata'),
    eventTime: timestamp('eventTime').notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    instanceIdx: index('protection_events_instance_idx').on(t.protectionInstanceId, t.eventTime),
    chainIdx: index('protection_events_chain_idx').on(t.decisionChainId),
    typeIdx: index('protection_events_type_idx').on(t.eventType),
    instanceFk: foreignKey({
      name: 'protection_events_instance_fk',
      columns: [t.protectionInstanceId],
      foreignColumns: [protectionInstances.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    chainFk: foreignKey({
      name: 'protection_events_chain_fk',
      columns: [t.decisionChainId],
      foreignColumns: [decisionChains.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

// ---------------------------------------------------------------------------
// Phase 1.1 Gate 3D — integrated shadow execution + certification
// ---------------------------------------------------------------------------
export const shadowExecutionPlans = mysqlTable(
  'shadow_execution_plans',
  {
    id: int('id').autoincrement().primaryKey(),
    planVersion: int('planVersion').notNull().default(1),
    decisionChainId: int('decisionChainId').notNull(),
    approvedPreviewId: int('approvedPreviewId').notNull(),
    quantitativeDecisionId: int('quantitativeDecisionId'),
    costForecastId: int('costForecastId').notNull(),
    protectionPolicyVersionId: int('protectionPolicyVersionId').notNull(),
    protectionCapabilityId: int('protectionCapabilityId').notNull(),
    productId: varchar('productId', { length: 30 }).notNull(),
    side: mysqlEnum('side', ['BUY', 'SELL']).notNull(),
    orderType: varchar('orderType', { length: 32 }).notNull(),
    timeInForce: varchar('timeInForce', { length: 16 }).notNull(),
    exactBaseSize: decimal('exactBaseSize', { precision: 20, scale: 8 }),
    exactQuoteSize: decimal('exactQuoteSize', { precision: 20, scale: 8 }),
    entryLimitPrice: decimal('entryLimitPrice', { precision: 20, scale: 8 }),
    targetPrice: decimal('targetPrice', { precision: 20, scale: 8 }).notNull(),
    stopTriggerPrice: decimal('stopTriggerPrice', { precision: 20, scale: 8 }).notNull(),
    stopLimitPrice: decimal('stopLimitPrice', { precision: 20, scale: 8 }),
    configurationHash: varchar('configurationHash', { length: 64 }).notNull(),
    feeTierSnapshotId: int('feeTierSnapshotId').notNull(),
    previewedAt: timestamp('previewedAt').notNull(),
    expiresAt: timestamp('expiresAt').notNull(),
    strategyVersion: varchar('strategyVersion', { length: 32 }).notNull(),
    costModelVersion: varchar('costModelVersion', { length: 32 }).notNull(),
    protectionPolicyVersion: varchar('protectionPolicyVersion', { length: 32 }).notNull(),
    simulationMode: mysqlEnum('simulationMode', ['STANDARD_DRY_RUN', 'SHADOW_LIVE'])
      .notNull()
      .default('SHADOW_LIVE'),
    supersedesPlanId: int('supersedesPlanId'),
    status: mysqlEnum('status', ['approved', 'consumed', 'superseded', 'invalidated'])
      .notNull()
      .default('approved'),
    invalidationReason: varchar('invalidationReason', { length: 255 }),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    chainVersionUq: uniqueIndex('shadow_plan_chain_version_uq').on(t.decisionChainId, t.planVersion),
    hashIdx: index('shadow_plan_hash_idx').on(t.configurationHash),
    statusIdx: index('shadow_plan_status_idx').on(t.status),
    productIdx: index('shadow_plan_product_idx').on(t.productId),
    chainFk: foreignKey({
      name: 'shadow_plan_chain_fk',
      columns: [t.decisionChainId],
      foreignColumns: [decisionChains.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const postFillRevalidations = mysqlTable(
  'post_fill_revalidations',
  {
    id: int('id').autoincrement().primaryKey(),
    decisionChainId: int('decisionChainId').notNull(),
    executionPlanId: int('executionPlanId').notNull(),
    orderIntentId: int('orderIntentId').notNull(),
    positionId: int('positionId'),
    approvedEntryFillPrice: decimal('approvedEntryFillPrice', { precision: 20, scale: 8 }).notNull(),
    realizedEntryFillPrice: decimal('realizedEntryFillPrice', { precision: 20, scale: 8 }).notNull(),
    approvedEntryCommission: decimal('approvedEntryCommission', { precision: 20, scale: 8 }).notNull(),
    realizedEntryCommission: decimal('realizedEntryCommission', { precision: 20, scale: 8 }).notNull(),
    approvedEntryOutflow: decimal('approvedEntryOutflow', { precision: 20, scale: 8 }).notNull(),
    realizedEntryOutflow: decimal('realizedEntryOutflow', { precision: 20, scale: 8 }).notNull(),
    remainingTargetPayoff: decimal('remainingTargetPayoff', { precision: 20, scale: 8 }),
    remainingStopLoss: decimal('remainingStopLoss', { precision: 20, scale: 8 }),
    updatedCostToTargetPct: decimal('updatedCostToTargetPct', { precision: 10, scale: 4 }),
    updatedNetRewardRisk: decimal('updatedNetRewardRisk', { precision: 10, scale: 4 }),
    deviationBps: decimal('deviationBps', { precision: 10, scale: 4 }).notNull(),
    verdict: mysqlEnum('verdict', [
      'still_valid',
      'degraded_but_managed',
      'invalid_after_fill',
      'incomplete',
    ]).notNull(),
    reason: varchar('reason', { length: 255 }),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    chainIdx: index('post_fill_chain_idx').on(t.decisionChainId),
    planIdx: index('post_fill_plan_idx').on(t.executionPlanId),
    intentIdx: index('post_fill_intent_idx').on(t.orderIntentId),
    chainFk: foreignKey({
      name: 'post_fill_chain_fk',
      columns: [t.decisionChainId],
      foreignColumns: [decisionChains.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const shadowCertificationRuns = mysqlTable(
  'shadow_certification_runs',
  {
    id: int('id').autoincrement().primaryKey(),
    certificationRunId: varchar('certificationRunId', { length: 64 }).notNull(),
    commitHash: varchar('commitHash', { length: 40 }),
    migrationVersion: varchar('migrationVersion', { length: 64 }),
    schemaFingerprint: varchar('schemaFingerprint', { length: 64 }),
    simulationMode: varchar('simulationMode', { length: 32 }).notNull(),
    strategyVersion: varchar('strategyVersion', { length: 32 }),
    costModelVersion: varchar('costModelVersion', { length: 32 }),
    protectionPolicyVersion: varchar('protectionPolicyVersion', { length: 32 }),
    lineageVersion: varchar('lineageVersion', { length: 32 }),
    startedAt: timestamp('startedAt').notNull(),
    completedAt: timestamp('completedAt'),
    fixtureCount: int('fixtureCount').notNull().default(0),
    passedFixtures: int('passedFixtures').notNull().default(0),
    failedFixtures: int('failedFixtures').notNull().default(0),
    accountingDifference: decimal('accountingDifference', { precision: 20, scale: 8 })
      .notNull()
      .default('0'),
    unresolvedIntents: int('unresolvedIntents').notNull().default(0),
    unprotectedPositions: int('unprotectedPositions').notNull().default(0),
    incompleteAttributions: int('incompleteAttributions').notNull().default(0),
    lineageFailures: int('lineageFailures').notNull().default(0),
    createOrderAttemptCount: int('createOrderAttemptCount').notNull().default(0),
    createOrderNetworkCount: int('createOrderNetworkCount').notNull().default(0),
    safeFlagsSnapshot: text('safeFlagsSnapshot'),
    knownLimitations: text('knownLimitations'),
    verdict: mysqlEnum('verdict', ['not_ready', 'degraded', 'mechanically_ready_for_shadow'])
      .notNull()
      .default('not_ready'),
    fixtureResults: text('fixtureResults'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    // Phase 1.1 Gate 3D-FIX
    runtimeIntegrated: boolean('runtimeIntegrated').notNull().default(false),
    supersedesRunId: varchar('supersedesRunId', { length: 64 }),
    createOrderFunctionInvocations: int('createOrderFunctionInvocations').notNull().default(0),
  },
  (t) => ({
    runUq: uniqueIndex('shadow_cert_run_uq').on(t.certificationRunId),
    verdictIdx: index('shadow_cert_verdict_idx').on(t.verdict),
  }),
);

// ---------------------------------------------------------------------------
// Phase 1.2 — live Coinbase data plane
// ---------------------------------------------------------------------------
export const marketStreamSessions = mysqlTable(
  'market_stream_sessions',
  {
    id: int('id').autoincrement().primaryKey(),
    endpoint: varchar('endpoint', { length: 255 }).notNull(),
    connectionGroup: varchar('connectionGroup', { length: 32 }).notNull(),
    startedAt: timestamp('startedAt').notNull(),
    endedAt: timestamp('endedAt'),
    state: mysqlEnum('state', [
      'disconnected',
      'connecting',
      'subscribing',
      'synchronizing',
      'healthy',
      'stale',
      'degraded',
      'reconnecting',
      'failed',
      'stopped',
    ])
      .notNull()
      .default('disconnected'),
    reconnectCount: int('reconnectCount').notNull().default(0),
    lastHeartbeatAt: timestamp('lastHeartbeatAt'),
    lastHeartbeatCounter: int('lastHeartbeatCounter'),
    messagesReceived: int('messagesReceived').notNull().default(0),
    messagesRejected: int('messagesRejected').notNull().default(0),
    failureReason: varchar('failureReason', { length: 255 }),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    stateIdx: index('stream_sessions_state_idx').on(t.state),
    groupIdx: index('stream_sessions_group_idx').on(t.connectionGroup),
  }),
);

export const marketStreamSubscriptions = mysqlTable(
  'market_stream_subscriptions',
  {
    id: int('id').autoincrement().primaryKey(),
    sessionId: int('sessionId').notNull(),
    channel: varchar('channel', { length: 32 }).notNull(),
    productId: varchar('productId', { length: 30 }),
    state: mysqlEnum('state', ['requested', 'acknowledged', 'closed', 'rejected'])
      .notNull()
      .default('requested'),
    requestedAt: timestamp('requestedAt').notNull(),
    acknowledgedAt: timestamp('acknowledgedAt'),
    closedAt: timestamp('closedAt'),
    failureReason: varchar('failureReason', { length: 255 }),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: index('stream_subs_session_idx').on(t.sessionId),
    channelIdx: index('stream_subs_channel_idx').on(t.channel, t.productId),
    sessionFk: foreignKey({
      name: 'stream_subs_session_fk',
      columns: [t.sessionId],
      foreignColumns: [marketStreamSessions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const marketDataEvents = mysqlTable(
  'market_data_events',
  {
    id: int('id').autoincrement().primaryKey(),
    eventId: varchar('eventId', { length: 96 }).notNull(),
    source: varchar('source', { length: 32 }).notNull(),
    channel: varchar('channel', { length: 32 }).notNull(),
    productId: varchar('productId', { length: 30 }),
    sourceTimestamp: timestamp('sourceTimestamp', { fsp: 3 }).notNull(),
    receivedAt: timestamp('receivedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    connectionId: int('connectionId'),
    sequenceNumber: int('sequenceNumber'),
    eventType: varchar('eventType', { length: 48 }).notNull(),
    schemaVersion: varchar('schemaVersion', { length: 32 }).notNull(),
    payloadHash: varchar('payloadHash', { length: 64 }).notNull(),
    normalizedPayload: text('normalizedPayload').notNull(),
    validationStatus: mysqlEnum('validationStatus', [
      'valid',
      'rejected_malformed',
      'rejected_unknown',
      'duplicate',
    ])
      .notNull()
      .default('valid'),
    failureReason: varchar('failureReason', { length: 255 }),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    dedupUq: uniqueIndex('market_events_dedup_uq').on(t.payloadHash),
    channelIdx: index('market_events_channel_idx').on(t.channel, t.productId, t.sourceTimestamp),
    sessionIdx: index('market_events_session_idx').on(t.connectionId),
  }),
);

export const marketDataGaps = mysqlTable(
  'market_data_gaps',
  {
    id: int('id').autoincrement().primaryKey(),
    sessionId: int('sessionId'),
    channel: varchar('channel', { length: 32 }).notNull(),
    productId: varchar('productId', { length: 30 }),
    detectedAt: timestamp('detectedAt').notNull(),
    expectedSequence: int('expectedSequence'),
    actualSequence: int('actualSequence'),
    lastKnownEventAt: timestamp('lastKnownEventAt'),
    gapType: mysqlEnum('gapType', [
      'missing_sequence',
      'missing_heartbeat',
      'missing_candle_bucket',
      'stale_ticker',
      'connection_closed',
      'bootstrap_missing_interval',
    ]).notNull(),
    recoveryMethod: varchar('recoveryMethod', { length: 64 }),
    recoveredAt: timestamp('recoveredAt'),
    state: mysqlEnum('state', ['open', 'recovered', 'degraded', 'failed'])
      .notNull()
      .default('open'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: index('market_gaps_session_idx').on(t.sessionId),
    stateIdx: index('market_gaps_state_idx').on(t.state),
    channelIdx: index('market_gaps_channel_idx').on(t.channel, t.productId),
  }),
);

export const productMarketStates = mysqlTable(
  'product_market_states',
  {
    productId: varchar('productId', { length: 30 }).primaryKey(),
    tickerState: mysqlEnum('tickerState', ['healthy', 'stale', 'unknown'])
      .notNull()
      .default('unknown'),
    candleState: mysqlEnum('candleState', [
      'healthy',
      'stale',
      'incomplete_history',
      'gap_detected',
      'unknown',
    ])
      .notNull()
      .default('unknown'),
    tradeState: mysqlEnum('tradeState', ['healthy', 'stale', 'unknown']).notNull().default('unknown'),
    statusState: mysqlEnum('statusState', ['online', 'offline', 'delisted', 'unknown'])
      .notNull()
      .default('unknown'),
    lastTickerAt: timestamp('lastTickerAt', { fsp: 3 }),
    lastCandleAt: timestamp('lastCandleAt', { fsp: 3 }),
    lastTradeAt: timestamp('lastTradeAt', { fsp: 3 }),
    lastStatusAt: timestamp('lastStatusAt', { fsp: 3 }),
    latestPrice: decimal('latestPrice', { precision: 20, scale: 8 }),
    currentCandleStart: timestamp('currentCandleStart', { fsp: 3 }),
    dataQualityState: mysqlEnum('dataQualityState', [
      'healthy',
      'stale',
      'incomplete_history',
      'gap_detected',
      'desynchronized',
      'invalid_value',
      'product_unavailable',
      'connection_degraded',
    ])
      .notNull()
      .default('incomplete_history'),
    dataVersion: varchar('dataVersion', { length: 32 }).notNull().default('p1_2-1'),
    updatedAt: timestamp('updatedAt').notNull().defaultNow().onUpdateNow(),
  },
  (t) => ({
    qualityIdx: index('product_states_quality_idx').on(t.dataQualityState),
  }),
);

export const candleObservations = mysqlTable(
  'candle_observations',
  {
    id: int('id').autoincrement().primaryKey(),
    productId: varchar('productId', { length: 30 }).notNull(),
    granularitySeconds: int('granularitySeconds').notNull().default(300),
    bucketStart: timestamp('bucketStart', { fsp: 3 }).notNull(),
    open: decimal('open', { precision: 20, scale: 8 }).notNull(),
    high: decimal('high', { precision: 20, scale: 8 }).notNull(),
    low: decimal('low', { precision: 20, scale: 8 }).notNull(),
    close: decimal('close', { precision: 20, scale: 8 }).notNull(),
    volume: decimal('volume', { precision: 30, scale: 8 }).notNull(),
    finalized: boolean('finalized').notNull().default(false),
    finalizedAt: timestamp('finalizedAt', { fsp: 3 }),
    sourceEventId: int('sourceEventId'),
    sourceTimestamp: timestamp('sourceTimestamp', { fsp: 3 }).notNull(),
    receivedAt: timestamp('receivedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    version: int('version').notNull().default(1),
    supersedesCandleId: int('supersedesCandleId'),
    correctionReason: varchar('correctionReason', { length: 128 }),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    bucketVersionUq: uniqueIndex('candles_bucket_version_uq').on(
      t.productId,
      t.granularitySeconds,
      t.bucketStart,
      t.version,
    ),
    productBucketIdx: index('candles_product_bucket_idx').on(t.productId, t.bucketStart),
  }),
);

export const tickerObservations = mysqlTable(
  'ticker_observations',
  {
    id: int('id').autoincrement().primaryKey(),
    productId: varchar('productId', { length: 30 }).notNull(),
    price: decimal('price', { precision: 20, scale: 8 }).notNull(),
    bestBid: decimal('bestBid', { precision: 20, scale: 8 }),
    bestAsk: decimal('bestAsk', { precision: 20, scale: 8 }),
    spreadBps: decimal('spreadBps', { precision: 10, scale: 4 }),
    sourceTimestamp: timestamp('sourceTimestamp', { fsp: 3 }).notNull(),
    receivedAt: timestamp('receivedAt', { fsp: 3 }).notNull(),
    sourceEventId: int('sourceEventId'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    productTimeIdx: index('ticker_product_time_idx').on(t.productId, t.sourceTimestamp),
  }),
);

export const marketTradeObservations = mysqlTable(
  'market_trade_observations',
  {
    id: int('id').autoincrement().primaryKey(),
    productId: varchar('productId', { length: 30 }).notNull(),
    tradeId: varchar('tradeId', { length: 64 }).notNull(),
    price: decimal('price', { precision: 20, scale: 8 }).notNull(),
    size: decimal('size', { precision: 30, scale: 8 }).notNull(),
    side: mysqlEnum('side', ['BUY', 'SELL']).notNull(),
    sourceTimestamp: timestamp('sourceTimestamp', { fsp: 3 }).notNull(),
    receivedAt: timestamp('receivedAt', { fsp: 3 }).notNull(),
    sourceEventId: int('sourceEventId'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    dedupUq: uniqueIndex('market_trades_dedup_uq').on(t.productId, t.tradeId),
    productTimeIdx: index('market_trades_product_time_idx').on(t.productId, t.sourceTimestamp),
  }),
);

export const shadowOperationRuns = mysqlTable(
  'shadow_operation_runs',
  {
    id: int('id').autoincrement().primaryKey(),
    reportedAt: timestamp('reportedAt').notNull(),
    windowStart: timestamp('windowStart').notNull(),
    windowEnd: timestamp('windowEnd').notNull(),
    activeConnections: int('activeConnections').notNull().default(0),
    healthyConnections: int('healthyConnections').notNull().default(0),
    reconnectCount: int('reconnectCount').notNull().default(0),
    heartbeatGaps: int('heartbeatGaps').notNull().default(0),
    healthyProductCount: int('healthyProductCount').notNull().default(0),
    staleProductCount: int('staleProductCount').notNull().default(0),
    scannerRuns: int('scannerRuns').notNull().default(0),
    scannerFailures: int('scannerFailures').notNull().default(0),
    candidateCount: int('candidateCount').notNull().default(0),
    approvedPlanCount: int('approvedPlanCount').notNull().default(0),
    openPositions: int('openPositions').notNull().default(0),
    reconciliationStatus: varchar('reconciliationStatus', { length: 32 }).notNull(),
    createOrderFunctionInvocations: int('createOrderFunctionInvocations').notNull().default(0),
    createOrderAttemptCount: int('createOrderAttemptCount').notNull().default(0),
    createOrderNetworkCount: int('createOrderNetworkCount').notNull().default(0),
    notes: text('notes'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    timeIdx: index('shadow_operation_time_idx').on(t.reportedAt),
  }),
);

export const shadowDailyReports = mysqlTable(
  'shadow_daily_reports',
  {
    id: int('id').autoincrement().primaryKey(),
    reportDate: timestamp('reportDate').notNull(),
    productsEvaluated: int('productsEvaluated').notNull().default(0),
    completeChains: int('completeChains').notNull().default(0),
    rejectedChains: int('rejectedChains').notNull().default(0),
    candidatesReversion: int('candidatesReversion').notNull().default(0),
    candidatesBreakout: int('candidatesBreakout').notNull().default(0),
    candidatesMacro: int('candidatesMacro').notNull().default(0),
    approvedPlans: int('approvedPlans').notNull().default(0),
    simulatedFills: int('simulatedFills').notNull().default(0),
    partialFills: int('partialFills').notNull().default(0),
    completedRoundTrips: int('completedRoundTrips').notNull().default(0),
    grossPnl: decimal('grossPnl', { precision: 20, scale: 8 }).notNull().default('0'),
    feesPaid: decimal('feesPaid', { precision: 20, scale: 8 }).notNull().default('0'),
    modeledSpread: decimal('modeledSpread', { precision: 20, scale: 8 }).notNull().default('0'),
    modeledSlippage: decimal('modeledSlippage', { precision: 20, scale: 8 }).notNull().default('0'),
    netPnl: decimal('netPnl', { precision: 20, scale: 8 }).notNull().default('0'),
    forecastCostError: decimal('forecastCostError', { precision: 20, scale: 8 }).notNull().default('0'),
    accountingDifference: decimal('accountingDifference', { precision: 20, scale: 8 }).notNull().default('0'),
    unresolvedLineage: int('unresolvedLineage').notNull().default(0),
    unprotectedExposure: int('unprotectedExposure').notNull().default(0),
    missingAttribution: int('missingAttribution').notNull().default(0),
    webSocketUptimePct: decimal('webSocketUptimePct', { precision: 6, scale: 3 }).notNull().default('0'),
    detectedGaps: int('detectedGaps').notNull().default(0),
    createOrderFunctionInvocations: int('createOrderFunctionInvocations').notNull().default(0),
    createOrderAttemptCount: int('createOrderAttemptCount').notNull().default(0),
    createOrderNetworkCount: int('createOrderNetworkCount').notNull().default(0),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    dateUq: uniqueIndex('shadow_daily_date_uq').on(t.reportDate),
  }),
);

export const forwardOutcomeLabels = mysqlTable(
  'forward_outcome_labels',
  {
    id: int('id').autoincrement().primaryKey(),
    decisionChainId: int('decisionChainId').notNull(),
    productId: varchar('productId', { length: 30 }).notNull(),
    mode: mysqlEnum('mode', ['reversion', 'breakout', 'macro']).notNull(),
    decisionOutcome: mysqlEnum('decisionOutcome', ['accepted', 'rejected']).notNull(),
    decisionCompletedAt: timestamp('decisionCompletedAt', { fsp: 3 }).notNull(),
    targetPrice: decimal('targetPrice', { precision: 20, scale: 8 }).notNull(),
    stopPrice: decimal('stopPrice', { precision: 20, scale: 8 }).notNull(),
    hypotheticalBase: decimal('hypotheticalBase', { precision: 20, scale: 8 }).notNull(),
    entryReference: decimal('entryReference', { precision: 20, scale: 8 }).notNull(),
    tpFirst: boolean('tpFirst'),
    slFirst: boolean('slFirst'),
    timeout: boolean('timeout'),
    ambiguous: boolean('ambiguous'),
    maxFavorableExcursion: decimal('maxFavorableExcursion', { precision: 20, scale: 8 }),
    maxAdverseExcursion: decimal('maxAdverseExcursion', { precision: 20, scale: 8 }),
    timeToTpMs: int('timeToTpMs'),
    timeToSlMs: int('timeToSlMs'),
    grossHypotheticalResult: decimal('grossHypotheticalResult', { precision: 20, scale: 8 }),
    netHypotheticalResult: decimal('netHypotheticalResult', { precision: 20, scale: 8 }),
    forecastCost: decimal('forecastCost', { precision: 20, scale: 8 }),
    realizedSimulatedCost: decimal('realizedSimulatedCost', { precision: 20, scale: 8 }),
    labelStatus: mysqlEnum('labelStatus', ['pending', 'labeled', 'ambiguous', 'timeout', 'error'])
      .notNull()
      .default('pending'),
    firstEventAt: timestamp('firstEventAt', { fsp: 3 }),
    lastEventAt: timestamp('lastEventAt', { fsp: 3 }),
    labelerVersion: varchar('labelerVersion', { length: 32 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt').notNull().defaultNow().onUpdateNow(),
  },
  (t) => ({
    chainUq: uniqueIndex('forward_labels_chain_uq').on(t.decisionChainId),
    statusIdx: index('forward_labels_status_idx').on(t.labelStatus),
    productIdx: index('forward_labels_product_idx').on(t.productId, t.decisionCompletedAt),
    chainFk: foreignKey({
      name: 'forward_labels_chain_fk',
      columns: [t.decisionChainId],
      foreignColumns: [decisionChains.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
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
export type ScanRunRow = typeof scanRuns.$inferSelect;
export type ScanRunInsert = typeof scanRuns.$inferInsert;
export type DecisionChainRow = typeof decisionChains.$inferSelect;
export type DecisionChainInsert = typeof decisionChains.$inferInsert;
export type MarketObservationRow = typeof marketObservations.$inferSelect;
export type MarketObservationInsert = typeof marketObservations.$inferInsert;
export type EligibilityDecisionRow = typeof eligibilityDecisions.$inferSelect;
export type EligibilityDecisionInsert = typeof eligibilityDecisions.$inferInsert;
export type SetupEvaluationRow = typeof setupEvaluations.$inferSelect;
export type SetupEvaluationInsert = typeof setupEvaluations.$inferInsert;
export type StrategyRoutingDecisionRow = typeof strategyRoutingDecisions.$inferSelect;
export type StrategyRoutingDecisionInsert = typeof strategyRoutingDecisions.$inferInsert;
export type OutcomeLabelRow = typeof outcomeLabels.$inferSelect;
export type OutcomeLabelInsert = typeof outcomeLabels.$inferInsert;
export type LineageEventRow = typeof lineageEvents.$inferSelect;
export type LineageEventInsert = typeof lineageEvents.$inferInsert;
export type ForecastVsRealizedAttributionRow = typeof forecastVsRealizedAttributions.$inferSelect;
export type ForecastVsRealizedAttributionInsert = typeof forecastVsRealizedAttributions.$inferInsert;
export type ProtectionPolicyVersionRow = typeof protectionPolicyVersions.$inferSelect;
export type ProtectionPolicyVersionInsert = typeof protectionPolicyVersions.$inferInsert;
export type ProtectionCapabilityRow = typeof protectionCapabilities.$inferSelect;
export type ProtectionCapabilityInsert = typeof protectionCapabilities.$inferInsert;
export type ProtectionValidationRunRow = typeof protectionValidationRuns.$inferSelect;
export type ProtectionValidationRunInsert = typeof protectionValidationRuns.$inferInsert;
export type ProtectionInstanceRow = typeof protectionInstances.$inferSelect;
export type ProtectionInstanceInsert = typeof protectionInstances.$inferInsert;
export type ProtectionEventRow = typeof protectionEvents.$inferSelect;
export type ProtectionEventInsert = typeof protectionEvents.$inferInsert;
export type ShadowExecutionPlanRow = typeof shadowExecutionPlans.$inferSelect;
export type ShadowExecutionPlanInsert = typeof shadowExecutionPlans.$inferInsert;
export type PostFillRevalidationRow = typeof postFillRevalidations.$inferSelect;
export type PostFillRevalidationInsert = typeof postFillRevalidations.$inferInsert;
export type ShadowCertificationRunRow = typeof shadowCertificationRuns.$inferSelect;
export type ShadowCertificationRunInsert = typeof shadowCertificationRuns.$inferInsert;
export type MarketStreamSessionRow = typeof marketStreamSessions.$inferSelect;
export type MarketStreamSessionInsert = typeof marketStreamSessions.$inferInsert;
export type MarketStreamSubscriptionRow = typeof marketStreamSubscriptions.$inferSelect;
export type MarketStreamSubscriptionInsert = typeof marketStreamSubscriptions.$inferInsert;
export type MarketDataEventRow = typeof marketDataEvents.$inferSelect;
export type MarketDataEventInsert = typeof marketDataEvents.$inferInsert;
export type MarketDataGapRow = typeof marketDataGaps.$inferSelect;
export type MarketDataGapInsert = typeof marketDataGaps.$inferInsert;
export type ProductMarketStateRow = typeof productMarketStates.$inferSelect;
export type ProductMarketStateInsert = typeof productMarketStates.$inferInsert;
export type CandleObservationRow = typeof candleObservations.$inferSelect;
export type CandleObservationInsert = typeof candleObservations.$inferInsert;
export type TickerObservationRow = typeof tickerObservations.$inferSelect;
export type TickerObservationInsert = typeof tickerObservations.$inferInsert;
export type MarketTradeObservationRow = typeof marketTradeObservations.$inferSelect;
export type MarketTradeObservationInsert = typeof marketTradeObservations.$inferInsert;
export type ShadowOperationRunRow = typeof shadowOperationRuns.$inferSelect;
export type ShadowOperationRunInsert = typeof shadowOperationRuns.$inferInsert;
export type ShadowDailyReportRow = typeof shadowDailyReports.$inferSelect;
export type ShadowDailyReportInsert = typeof shadowDailyReports.$inferInsert;
export type ForwardOutcomeLabelRow = typeof forwardOutcomeLabels.$inferSelect;
export type ForwardOutcomeLabelInsert = typeof forwardOutcomeLabels.$inferInsert;
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
