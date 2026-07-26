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
// Phase 1.2-OPS — seven-day live-deployment soak
// ---------------------------------------------------------------------------
export const soakRuns = mysqlTable(
  'soak_runs',
  {
    id: int('id').autoincrement().primaryKey(),
    soakRunId: varchar('soakRunId', { length: 64 }).notNull(),
    commitHash: varchar('commitHash', { length: 40 }).notNull(),
    deploymentId: varchar('deploymentId', { length: 64 }).notNull(),
    startedAt: timestamp('startedAt').notNull(),
    requiredEndAt: timestamp('requiredEndAt').notNull(),
    completedAt: timestamp('completedAt'),
    strategyVersion: varchar('strategyVersion', { length: 32 }).notNull(),
    marketDataVersion: varchar('marketDataVersion', { length: 32 }).notNull(),
    fillModelVersion: varchar('fillModelVersion', { length: 32 }).notNull(),
    costModelVersion: varchar('costModelVersion', { length: 32 }).notNull(),
    protectionPolicyVersion: varchar('protectionPolicyVersion', { length: 32 }).notNull(),
    schemaFingerprint: varchar('schemaFingerprint', { length: 64 }).notNull(),
    safeFlagsSnapshot: text('safeFlagsSnapshot').notNull(),
    productUniverseHash: varchar('productUniverseHash', { length: 64 }).notNull(),
    status: mysqlEnum('status', ['preflight', 'running', 'failed', 'reset_required', 'completed'])
      .notNull()
      .default('preflight'),
    verdict: mysqlEnum('verdict', ['pending', 'soak_failed', 'soak_degraded', 'phase1_2_pass'])
      .notNull()
      .default('pending'),
    verdictReason: varchar('verdictReason', { length: 255 }),
    preflightRunId: int('preflightRunId'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    runIdUq: uniqueIndex('soak_runs_soakRunId_uq').on(t.soakRunId),
    statusIdx: index('soak_runs_status_idx').on(t.status),
    verdictIdx: index('soak_runs_verdict_idx').on(t.verdict),
  }),
);

export const soakDailyReports = mysqlTable(
  'soak_daily_reports',
  {
    id: int('id').autoincrement().primaryKey(),
    soakRunId: varchar('soakRunId', { length: 64 }).notNull(),
    reportDate: timestamp('reportDate').notNull(),
    windowStart: timestamp('windowStart').notNull(),
    windowEnd: timestamp('windowEnd').notNull(),
    uptimeSeconds: int('uptimeSeconds').notNull().default(0),
    webSocketSessions: int('webSocketSessions').notNull().default(0),
    reconnectCount: int('reconnectCount').notNull().default(0),
    heartbeatGaps: int('heartbeatGaps').notNull().default(0),
    dataGapsByProduct: text('dataGapsByProduct'),
    healthyProductCount: int('healthyProductCount').notNull().default(0),
    staleProductCount: int('staleProductCount').notNull().default(0),
    scannerRuns: int('scannerRuns').notNull().default(0),
    scannerFailures: int('scannerFailures').notNull().default(0),
    productsEvaluated: int('productsEvaluated').notNull().default(0),
    ineligibleChains: int('ineligibleChains').notNull().default(0),
    noSetupChains: int('noSetupChains').notNull().default(0),
    candidatesReversion: int('candidatesReversion').notNull().default(0),
    candidatesBreakout: int('candidatesBreakout').notNull().default(0),
    candidatesMacro: int('candidatesMacro').notNull().default(0),
    plansApproved: int('plansApproved').notNull().default(0),
    simulatedOrders: int('simulatedOrders').notNull().default(0),
    fullFills: int('fullFills').notNull().default(0),
    partialFills: int('partialFills').notNull().default(0),
    openPositions: int('openPositions').notNull().default(0),
    completedRoundTrips: int('completedRoundTrips').notNull().default(0),
    grossPnl: decimal('grossPnl', { precision: 20, scale: 8 }).notNull().default('0'),
    simulatedFees: decimal('simulatedFees', { precision: 20, scale: 8 }).notNull().default('0'),
    simulatedSpread: decimal('simulatedSpread', { precision: 20, scale: 8 }).notNull().default('0'),
    simulatedSlippage: decimal('simulatedSlippage', { precision: 20, scale: 8 }).notNull().default('0'),
    netPnl: decimal('netPnl', { precision: 20, scale: 8 }).notNull().default('0'),
    forecastCostError: decimal('forecastCostError', { precision: 20, scale: 8 }).notNull().default('0'),
    accountingDifference: decimal('accountingDifference', { precision: 20, scale: 8 }).notNull().default('0'),
    reconciliationStatus: varchar('reconciliationStatus', { length: 32 }).notNull(),
    protectionStatus: varchar('protectionStatus', { length: 32 }).notNull(),
    brokenLineageCount: int('brokenLineageCount').notNull().default(0),
    createOrderFunctionInvocations: int('createOrderFunctionInvocations').notNull().default(0),
    createOrderAttemptCount: int('createOrderAttemptCount').notNull().default(0),
    createOrderNetworkCount: int('createOrderNetworkCount').notNull().default(0),
    incidentIds: text('incidentIds'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    runDateUq: uniqueIndex('soak_daily_run_date_uq').on(t.soakRunId, t.reportDate),
  }),
);

export const soakIncidents = mysqlTable(
  'soak_incidents',
  {
    id: int('id').autoincrement().primaryKey(),
    soakRunId: varchar('soakRunId', { length: 64 }),
    incidentKind: mysqlEnum('incidentKind', [
      'websocket_outage',
      'reconnect_storm',
      'heartbeat_loss',
      'candle_gap',
      'rest_bootstrap_failure',
      'preview_outage',
      'fee_tier_outage',
      'credential_failure',
      'database_restart',
      'redis_restart',
      'process_restart',
      'stale_data_rejection',
      'protection_degradation',
      'accounting_discrepancy',
      'lineage_discrepancy',
      'create_order_barrier_event',
      'safe_flag_change',
      'mock_provider_active',
      'undocumented_deployment',
    ]).notNull(),
    classification: mysqlEnum('classification', [
      'informational',
      'product_degraded',
      'system_degraded',
      'soak_invalidating',
    ]).notNull(),
    detectedAt: timestamp('detectedAt').notNull(),
    resolvedAt: timestamp('resolvedAt'),
    productId: varchar('productId', { length: 30 }),
    detail: text('detail'),
    metadata: text('metadata'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('soak_incidents_run_idx').on(t.soakRunId),
    classIdx: index('soak_incidents_class_idx').on(t.classification),
    kindIdx: index('soak_incidents_kind_idx').on(t.incidentKind),
  }),
);

export const adapterSelections = mysqlTable(
  'adapter_selections',
  {
    id: int('id').autoincrement().primaryKey(),
    soakRunId: varchar('soakRunId', { length: 64 }),
    boundAt: timestamp('boundAt').notNull(),
    webSocketProvider: varchar('webSocketProvider', { length: 128 }).notNull(),
    restClient: varchar('restClient', { length: 128 }).notNull(),
    authClient: varchar('authClient', { length: 128 }).notNull(),
    redisClient: varchar('redisClient', { length: 128 }).notNull(),
    dbDriver: varchar('dbDriver', { length: 128 }).notNull(),
    isProduction: boolean('isProduction').notNull().default(false),
    refusedReason: varchar('refusedReason', { length: 255 }),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('adapter_selections_run_idx').on(t.soakRunId),
    prodIdx: index('adapter_selections_prod_idx').on(t.isProduction),
  }),
);

export const soakPreflightRuns = mysqlTable(
  'soak_preflight_runs',
  {
    id: int('id').autoincrement().primaryKey(),
    soakRunId: varchar('soakRunId', { length: 64 }),
    startedAt: timestamp('startedAt').notNull(),
    completedAt: timestamp('completedAt'),
    durationSeconds: int('durationSeconds').notNull().default(0),
    connectionHealthy: boolean('connectionHealthy').notNull().default(false),
    heartbeatsContinuous: boolean('heartbeatsContinuous').notNull().default(false),
    productsBootstrapped: int('productsBootstrapped').notNull().default(0),
    productsFailed: int('productsFailed').notNull().default(0),
    candleHistoryOrdered: boolean('candleHistoryOrdered').notNull().default(false),
    scannerReadsLiveState: boolean('scannerReadsLiveState').notNull().default(false),
    scheduledManualSameSource: boolean('scheduledManualSameSource').notNull().default(false),
    feeTierRetrievalOk: boolean('feeTierRetrievalOk').notNull().default(false),
    previewSucceededOrFailedClosed: boolean('previewSucceededOrFailedClosed').notNull().default(false),
    productMetadataFresh: boolean('productMetadataFresh').notNull().default(false),
    dataGapsPersisted: boolean('dataGapsPersisted').notNull().default(false),
    reconnectWorks: boolean('reconnectWorks').notNull().default(false),
    restartRestoresState: boolean('restartRestoresState').notNull().default(false),
    createOrderFunctionInvocations: int('createOrderFunctionInvocations').notNull().default(0),
    createOrderAttemptCount: int('createOrderAttemptCount').notNull().default(0),
    createOrderNetworkCount: int('createOrderNetworkCount').notNull().default(0),
    passed: boolean('passed').notNull().default(false),
    failureReasons: text('failureReasons'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('soak_preflight_run_idx').on(t.soakRunId),
    passedIdx: index('soak_preflight_passed_idx').on(t.passed),
  }),
);

// ---------------------------------------------------------------------------
// Phase 2A — dynamic universe + quantitative fingerprint observer
// ---------------------------------------------------------------------------
export const universeSnapshots = mysqlTable(
  'universe_snapshots',
  {
    id: int('id').autoincrement().primaryKey(),
    snapshotVersion: varchar('snapshotVersion', { length: 32 }).notNull(),
    providerName: varchar('providerName', { length: 64 }).notNull(),
    providerVersion: varchar('providerVersion', { length: 32 }).notNull(),
    observedAt: timestamp('observedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    productCount: int('productCount').notNull().default(0),
    payloadHash: varchar('payloadHash', { length: 64 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    versionIdx: index('universe_snapshots_version_idx').on(t.snapshotVersion),
    observedIdx: index('universe_snapshots_observed_idx').on(t.observedAt),
  }),
);

export const universeProducts = mysqlTable(
  'universe_products',
  {
    id: int('id').autoincrement().primaryKey(),
    snapshotId: int('snapshotId').notNull(),
    productId: varchar('productId', { length: 30 }).notNull(),
    baseCurrency: varchar('baseCurrency', { length: 16 }).notNull(),
    quoteCurrency: varchar('quoteCurrency', { length: 16 }).notNull(),
    productType: varchar('productType', { length: 32 }).notNull().default('SPOT'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    snapProdUq: uniqueIndex('universe_products_snap_prod_uq').on(t.snapshotId, t.productId),
    productIdx: index('universe_products_product_idx').on(t.productId),
    snapshotFk: foreignKey({
      name: 'universe_products_snapshot_fk',
      columns: [t.snapshotId],
      foreignColumns: [universeSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const productMetadataObservations = mysqlTable(
  'product_metadata_observations',
  {
    id: int('id').autoincrement().primaryKey(),
    productId: varchar('productId', { length: 30 }).notNull(),
    sourceVersion: varchar('sourceVersion', { length: 32 }).notNull(),
    providerName: varchar('providerName', { length: 64 }).notNull(),
    tradingStatus: varchar('tradingStatus', { length: 32 }).notNull(),
    cancelOnly: boolean('cancelOnly').notNull().default(false),
    limitOnly: boolean('limitOnly').notNull().default(false),
    postOnly: boolean('postOnly').notNull().default(false),
    auctionMode: boolean('auctionMode').notNull().default(false),
    tradingDisabled: boolean('tradingDisabled').notNull().default(false),
    baseIncrement: decimal('baseIncrement', { precision: 30, scale: 12 }).notNull(),
    quoteIncrement: decimal('quoteIncrement', { precision: 30, scale: 12 }).notNull(),
    baseMinimum: decimal('baseMinimum', { precision: 30, scale: 12 }).notNull(),
    quoteMinimum: decimal('quoteMinimum', { precision: 30, scale: 12 }),
    baseMaximum: decimal('baseMaximum', { precision: 30, scale: 12 }),
    quoteMaximum: decimal('quoteMaximum', { precision: 30, scale: 12 }),
    priceIncrement: decimal('priceIncrement', { precision: 30, scale: 12 }),
    approximateVolume24h: decimal('approximateVolume24h', { precision: 30, scale: 8 }),
    metadataObservedAt: timestamp('metadataObservedAt', { fsp: 3 }).notNull(),
    metadataAvailableAt: timestamp('metadataAvailableAt', { fsp: 3 }).notNull(),
    payloadHash: varchar('payloadHash', { length: 64 }).notNull(),
    rawPayload: text('rawPayload'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    hashUq: uniqueIndex('product_metadata_hash_uq').on(t.payloadHash),
    productIdx: index('product_metadata_product_idx').on(t.productId, t.metadataObservedAt),
  }),
);

export const productHygieneDecisions = mysqlTable(
  'product_hygiene_decisions',
  {
    id: int('id').autoincrement().primaryKey(),
    snapshotId: int('snapshotId').notNull(),
    productId: varchar('productId', { length: 30 }).notNull(),
    metadataId: int('metadataId'),
    result: mysqlEnum('result', ['eligible', 'ineligible', 'quarantined', 'insufficient_data'])
      .notNull(),
    reasonCodes: varchar('reasonCodes', { length: 255 }).notNull(),
    reasonDetail: text('reasonDetail'),
    policyVersion: varchar('policyVersion', { length: 32 }).notNull(),
    inputHash: varchar('inputHash', { length: 64 }).notNull(),
    decidedAt: timestamp('decidedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    reEvaluateAt: timestamp('reEvaluateAt', { fsp: 3 }),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    snapProdUq: uniqueIndex('hygiene_snap_prod_uq').on(t.snapshotId, t.productId),
    resultIdx: index('hygiene_result_idx').on(t.result),
    snapshotFk: foreignKey({
      name: 'hygiene_snapshot_fk',
      columns: [t.snapshotId],
      foreignColumns: [universeSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const productQuarantines = mysqlTable(
  'product_quarantines',
  {
    id: int('id').autoincrement().primaryKey(),
    productId: varchar('productId', { length: 30 }).notNull(),
    reasonCode: varchar('reasonCode', { length: 64 }).notNull(),
    reasonDetail: text('reasonDetail'),
    severity: mysqlEnum('severity', ['observe_only', 'feature_blocked', 'research_blocked', 'manual_review'])
      .notNull()
      .default('research_blocked'),
    policyVersion: varchar('policyVersion', { length: 32 }).notNull(),
    startedAt: timestamp('startedAt', { fsp: 3 }).notNull(),
    expiresAt: timestamp('expiresAt', { fsp: 3 }),
    clearedAt: timestamp('clearedAt', { fsp: 3 }),
    clearedBy: varchar('clearedBy', { length: 64 }),
    evidenceHash: varchar('evidenceHash', { length: 64 }),
    manualOverride: boolean('manualOverride').notNull().default(false),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    productIdx: index('quarantine_product_idx').on(t.productId, t.startedAt),
    severityIdx: index('quarantine_severity_idx').on(t.severity),
  }),
);

export const featureDefinitions = mysqlTable(
  'feature_definitions',
  {
    id: int('id').autoincrement().primaryKey(),
    featureKey: varchar('featureKey', { length: 64 }).notNull(),
    featureVersion: varchar('featureVersion', { length: 32 }).notNull(),
    description: text('description').notNull(),
    inputRequirements: text('inputRequirements').notNull(),
    lookbackRequirement: int('lookbackRequirement').notNull(),
    minimumSampleCount: int('minimumSampleCount').notNull(),
    outputType: varchar('outputType', { length: 32 }).notNull(),
    unit: varchar('unit', { length: 32 }),
    validRangeMin: decimal('validRangeMin', { precision: 30, scale: 12 }),
    validRangeMax: decimal('validRangeMax', { precision: 30, scale: 12 }),
    missingDataPolicy: varchar('missingDataPolicy', { length: 64 }).notNull(),
    stalenessPolicy: varchar('stalenessPolicy', { length: 64 }).notNull(),
    calculationHash: varchar('calculationHash', { length: 64 }).notNull(),
    implementationVersion: varchar('implementationVersion', { length: 32 }).notNull(),
    status: mysqlEnum('status', ['draft', 'observer', 'validated_for_research', 'deprecated', 'disabled'])
      .notNull()
      .default('observer'),
    stage: mysqlEnum('stage', ['stage_1', 'stage_2']).notNull().default('stage_1'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    keyVerUq: uniqueIndex('feature_defs_key_version_uq').on(t.featureKey, t.featureVersion),
    statusIdx: index('feature_defs_status_idx').on(t.status, t.stage),
  }),
);

export const featureCalculationRuns = mysqlTable(
  'feature_calculation_runs',
  {
    id: int('id').autoincrement().primaryKey(),
    snapshotId: int('snapshotId').notNull(),
    stage: mysqlEnum('stage', ['stage_1', 'stage_2']).notNull(),
    startedAt: timestamp('startedAt', { fsp: 3 }).notNull(),
    completedAt: timestamp('completedAt', { fsp: 3 }),
    productCount: int('productCount').notNull().default(0),
    computedValues: int('computedValues').notNull().default(0),
    failedValues: int('failedValues').notNull().default(0),
    runVersion: varchar('runVersion', { length: 32 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    snapStageIdx: index('feature_runs_snap_stage_idx').on(t.snapshotId, t.stage),
    snapshotFk: foreignKey({
      name: 'feature_runs_snapshot_fk',
      columns: [t.snapshotId],
      foreignColumns: [universeSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const featureValues = mysqlTable(
  'feature_values',
  {
    id: int('id').autoincrement().primaryKey(),
    runId: int('runId').notNull(),
    productId: varchar('productId', { length: 30 }).notNull(),
    featureKey: varchar('featureKey', { length: 64 }).notNull(),
    featureVersion: varchar('featureVersion', { length: 32 }).notNull(),
    status: mysqlEnum('status', [
      'valid',
      'insufficient_history',
      'stale',
      'invalid_input',
      'numerical_failure',
      'low_confidence',
      'gap_detected',
      'unsupported',
      'quarantined',
    ]).notNull(),
    value: decimal('value', { precision: 30, scale: 12 }),
    confidence: decimal('confidence', { precision: 6, scale: 4 }),
    sampleCount: int('sampleCount').notNull().default(0),
    lookbackStart: timestamp('lookbackStart', { fsp: 3 }),
    lookbackEnd: timestamp('lookbackEnd', { fsp: 3 }),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    inputHash: varchar('inputHash', { length: 64 }).notNull(),
    failureReason: varchar('failureReason', { length: 255 }),
    diagnostics: text('diagnostics'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    runProdFeatUq: uniqueIndex('feature_values_run_prod_feat_uq').on(t.runId, t.productId, t.featureKey, t.featureVersion),
    featIdx: index('feature_values_feat_idx').on(t.featureKey, t.status),
    runFk: foreignKey({
      name: 'feature_values_run_fk',
      columns: [t.runId],
      foreignColumns: [featureCalculationRuns.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const shortlistDecisions = mysqlTable(
  'shortlist_decisions',
  {
    id: int('id').autoincrement().primaryKey(),
    snapshotId: int('snapshotId').notNull(),
    productId: varchar('productId', { length: 30 }).notNull(),
    shortlisted: boolean('shortlisted').notNull().default(false),
    rank: int('rank'),
    score: decimal('score', { precision: 10, scale: 6 }),
    reasonCodes: varchar('reasonCodes', { length: 255 }).notNull(),
    policyVersion: varchar('policyVersion', { length: 32 }).notNull(),
    inputHash: varchar('inputHash', { length: 64 }).notNull(),
    decidedAt: timestamp('decidedAt', { fsp: 3 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    snapProdUq: uniqueIndex('shortlist_snap_prod_uq').on(t.snapshotId, t.productId),
    selectedIdx: index('shortlist_selected_idx').on(t.shortlisted),
  }),
);

export const fingerprintDefinitions = mysqlTable(
  'fingerprint_definitions',
  {
    id: int('id').autoincrement().primaryKey(),
    classificationVersion: varchar('classificationVersion', { length: 32 }).notNull(),
    description: text('description').notNull(),
    requiredFeatures: text('requiredFeatures').notNull(),
    overrideRules: text('overrideRules').notNull(),
    implementationVersion: varchar('implementationVersion', { length: 32 }).notNull(),
    status: mysqlEnum('status', ['observer', 'validated_for_research', 'deprecated', 'disabled'])
      .notNull()
      .default('observer'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    versionUq: uniqueIndex('fingerprint_defs_version_uq').on(t.classificationVersion),
  }),
);

export const fingerprintSnapshots = mysqlTable(
  'fingerprint_snapshots',
  {
    id: int('id').autoincrement().primaryKey(),
    snapshotId: int('snapshotId').notNull(),
    productId: varchar('productId', { length: 30 }).notNull(),
    fingerprintClass: mysqlEnum('fingerprintClass', [
      'REVERSION_CANDIDATE',
      'BREAKOUT_CANDIDATE',
      'MACRO_FLOOR_RESEARCH_CANDIDATE',
      'RANDOM_OR_NOISY',
      'ILLIQUID',
      'DISORDERED',
      'UNCLASSIFIED',
    ]).notNull(),
    confidence: decimal('confidence', { precision: 6, scale: 4 }).notNull(),
    qualityPenalty: decimal('qualityPenalty', { precision: 6, scale: 4 }).notNull().default('0'),
    liquidityPenalty: decimal('liquidityPenalty', { precision: 6, scale: 4 }).notNull().default('0'),
    classificationVersion: varchar('classificationVersion', { length: 32 }).notNull(),
    metadataVersion: varchar('metadataVersion', { length: 32 }).notNull(),
    inputHash: varchar('inputHash', { length: 64 }).notNull(),
    observedAt: timestamp('observedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    state: mysqlEnum('state', ['complete', 'degraded', 'unresolved']).notNull().default('complete'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    snapProdUq: uniqueIndex('fingerprints_snap_prod_uq').on(t.snapshotId, t.productId),
    classIdx: index('fingerprints_class_idx').on(t.fingerprintClass),
    snapshotFk: foreignKey({
      name: 'fingerprints_snapshot_fk',
      columns: [t.snapshotId],
      foreignColumns: [universeSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const fingerprintEvidence = mysqlTable(
  'fingerprint_evidence',
  {
    id: int('id').autoincrement().primaryKey(),
    fingerprintId: int('fingerprintId').notNull(),
    featureKey: varchar('featureKey', { length: 64 }).notNull(),
    featureVersion: varchar('featureVersion', { length: 32 }).notNull(),
    role: mysqlEnum('role', ['supporting', 'conflicting', 'missing']).notNull(),
    featureValueId: int('featureValueId'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    fpIdx: index('fingerprint_evidence_fp_idx').on(t.fingerprintId),
    roleIdx: index('fingerprint_evidence_role_idx').on(t.role),
    fpFk: foreignKey({
      name: 'fingerprint_evidence_fp_fk',
      columns: [t.fingerprintId],
      foreignColumns: [fingerprintSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const researchObserverRuns = mysqlTable(
  'research_observer_runs',
  {
    id: int('id').autoincrement().primaryKey(),
    snapshotId: int('snapshotId').notNull(),
    startedAt: timestamp('startedAt', { fsp: 3 }).notNull(),
    completedAt: timestamp('completedAt', { fsp: 3 }),
    productsConsidered: int('productsConsidered').notNull().default(0),
    productsEligible: int('productsEligible').notNull().default(0),
    productsQuarantined: int('productsQuarantined').notNull().default(0),
    productsShortlisted: int('productsShortlisted').notNull().default(0),
    fingerprintCounts: text('fingerprintCounts'),
    runVersion: varchar('runVersion', { length: 32 }).notNull(),
    notes: text('notes'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    snapIdx: index('observer_runs_snap_idx').on(t.snapshotId),
    snapshotFk: foreignKey({
      name: 'observer_runs_snapshot_fk',
      columns: [t.snapshotId],
      foreignColumns: [universeSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

// ---------------------------------------------------------------------------
// Phase 2B — regime observer, change detection, challenger routing
// ---------------------------------------------------------------------------

export const regimeDefinitions = mysqlTable(
  'regime_definitions',
  {
    id: int('id').autoincrement().primaryKey(),
    regimeKey: varchar('regimeKey', { length: 64 }).notNull(),
    regimeVersion: varchar('regimeVersion', { length: 32 }).notNull(),
    scope: mysqlEnum('scope', ['global', 'product']).notNull(),
    description: text('description').notNull(),
    requiredEvidence: text('requiredEvidence').notNull(),
    minimumValidEvidence: int('minimumValidEvidence').notNull(),
    conflictPolicy: varchar('conflictPolicy', { length: 64 }).notNull(),
    missingDataPolicy: varchar('missingDataPolicy', { length: 64 }).notNull(),
    transitionPolicyVersion: varchar('transitionPolicyVersion', { length: 32 }).notNull(),
    implementationHash: varchar('implementationHash', { length: 64 }).notNull(),
    status: mysqlEnum('status', [
      'draft',
      'observer',
      'validated_for_research',
      'deprecated',
      'disabled',
    ])
      .notNull()
      .default('observer'),
    supersedesDefinitionId: int('supersedesDefinitionId'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    keyVerUq: uniqueIndex('regime_defs_key_ver_uq').on(t.regimeKey, t.regimeVersion),
    scopeStatusIdx: index('regime_defs_scope_status_idx').on(t.scope, t.status),
    supersedesFk: foreignKey({
      name: 'regime_defs_supersedes_fk',
      columns: [t.supersedesDefinitionId],
      foreignColumns: [t.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const regimeTransitionPolicies = mysqlTable(
  'regime_transition_policies',
  {
    id: int('id').autoincrement().primaryKey(),
    policyVersion: varchar('policyVersion', { length: 32 }).notNull(),
    minimumDwellObservations: int('minimumDwellObservations').notNull(),
    candidateConfirmationCount: int('candidateConfirmationCount').notNull(),
    minimumTransitionConfidence: decimal('minimumTransitionConfidence', { precision: 6, scale: 4 }).notNull(),
    emergencyOverrideStates: text('emergencyOverrideStates').notNull(),
    confidenceDecay: decimal('confidenceDecay', { precision: 6, scale: 4 }).notNull(),
    staleStateExpiryMs: int('staleStateExpiryMs').notNull(),
    transitionMatrixPolicy: varchar('transitionMatrixPolicy', { length: 64 }).notNull(),
    description: text('description').notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    policyVerUq: uniqueIndex('regime_trans_policy_ver_uq').on(t.policyVersion),
  }),
);

export const regimeObserverRuns = mysqlTable(
  'regime_observer_runs',
  {
    id: int('id').autoincrement().primaryKey(),
    snapshotId: int('snapshotId').notNull(),
    startedAt: timestamp('startedAt', { fsp: 3 }).notNull(),
    completedAt: timestamp('completedAt', { fsp: 3 }),
    productsConsidered: int('productsConsidered').notNull().default(0),
    globalStatesEmitted: int('globalStatesEmitted').notNull().default(0),
    productStatesEmitted: int('productStatesEmitted').notNull().default(0),
    unknownCount: int('unknownCount').notNull().default(0),
    disorderedCount: int('disorderedCount').notNull().default(0),
    observerVersion: varchar('observerVersion', { length: 32 }).notNull(),
    transitionPolicyVersion: varchar('transitionPolicyVersion', { length: 32 }).notNull(),
    notes: text('notes'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    snapIdx: index('regime_runs_snap_idx').on(t.snapshotId),
    snapshotFk: foreignKey({
      name: 'regime_runs_snapshot_fk',
      columns: [t.snapshotId],
      foreignColumns: [universeSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

const REGIME_STATE_VALUES = [
  'TREND_UP',
  'TREND_DOWN',
  'RANGE',
  'VOLATILITY_EXPANSION',
  'CAPITULATION',
  'DISORDERED',
  'UNKNOWN',
] as const;

const REGIME_STATUS_VALUES = [
  'valid',
  'low_confidence',
  'insufficient_history',
  'stale',
  'gap_detected',
  'conflicted',
  'numerical_failure',
  'quarantined',
  'unknown',
] as const;

export const globalRegimeSnapshots = mysqlTable(
  'global_regime_snapshots',
  {
    id: int('id').autoincrement().primaryKey(),
    observerRunId: int('observerRunId').notNull(),
    regimeKey: varchar('regimeKey', { length: 64 }).notNull(),
    regimeVersion: varchar('regimeVersion', { length: 32 }).notNull(),
    state: mysqlEnum('state', REGIME_STATE_VALUES).notNull(),
    status: mysqlEnum('status', REGIME_STATUS_VALUES).notNull(),
    confidence: decimal('confidence', { precision: 6, scale: 4 }).notNull().default('0'),
    inputHash: varchar('inputHash', { length: 64 }).notNull(),
    observedAt: timestamp('observedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    diagnostics: text('diagnostics'),
    failureReason: varchar('failureReason', { length: 255 }),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    runUq: uniqueIndex('global_regime_run_uq').on(t.observerRunId),
    stateIdx: index('global_regime_state_idx').on(t.state, t.status),
    runFk: foreignKey({
      name: 'global_regime_run_fk',
      columns: [t.observerRunId],
      foreignColumns: [regimeObserverRuns.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const productRegimeSnapshots = mysqlTable(
  'product_regime_snapshots',
  {
    id: int('id').autoincrement().primaryKey(),
    observerRunId: int('observerRunId').notNull(),
    productId: varchar('productId', { length: 30 }).notNull(),
    regimeKey: varchar('regimeKey', { length: 64 }).notNull(),
    regimeVersion: varchar('regimeVersion', { length: 32 }).notNull(),
    rawState: mysqlEnum('rawState', REGIME_STATE_VALUES).notNull(),
    smoothedState: mysqlEnum('smoothedState', REGIME_STATE_VALUES).notNull(),
    status: mysqlEnum('status', REGIME_STATUS_VALUES).notNull(),
    confidence: decimal('confidence', { precision: 6, scale: 4 }).notNull().default('0'),
    globalStateId: int('globalStateId'),
    fingerprintSnapshotId: int('fingerprintSnapshotId'),
    inputHash: varchar('inputHash', { length: 64 }).notNull(),
    observedAt: timestamp('observedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    diagnostics: text('diagnostics'),
    failureReason: varchar('failureReason', { length: 255 }),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    runProdUq: uniqueIndex('product_regime_run_prod_uq').on(t.observerRunId, t.productId),
    stateIdx: index('product_regime_state_idx').on(t.rawState, t.smoothedState),
    prodIdx: index('product_regime_prod_idx').on(t.productId, t.observedAt),
    runFk: foreignKey({
      name: 'product_regime_run_fk',
      columns: [t.observerRunId],
      foreignColumns: [regimeObserverRuns.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    globalFk: foreignKey({
      name: 'product_regime_global_fk',
      columns: [t.globalStateId],
      foreignColumns: [globalRegimeSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    fingerprintFk: foreignKey({
      name: 'product_regime_fingerprint_fk',
      columns: [t.fingerprintSnapshotId],
      foreignColumns: [fingerprintSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const regimeEvidence = mysqlTable(
  'regime_evidence',
  {
    id: int('id').autoincrement().primaryKey(),
    scope: mysqlEnum('scope', ['global', 'product']).notNull(),
    globalRegimeId: int('globalRegimeId'),
    productRegimeId: int('productRegimeId'),
    component: varchar('component', { length: 64 }).notNull(),
    componentVersion: varchar('componentVersion', { length: 32 }).notNull(),
    role: mysqlEnum('role', ['supporting', 'conflicting', 'missing']).notNull(),
    weight: decimal('weight', { precision: 6, scale: 4 }).notNull().default('0'),
    detail: text('detail'),
    featureValueId: int('featureValueId'),
    changePointEventId: int('changePointEventId'),
    latentStateAssignmentId: int('latentStateAssignmentId'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    globalIdx: index('regime_evidence_global_idx').on(t.globalRegimeId),
    productIdx: index('regime_evidence_product_idx').on(t.productRegimeId),
    componentIdx: index('regime_evidence_component_idx').on(t.component, t.role),
    globalFk: foreignKey({
      name: 'regime_evidence_global_fk',
      columns: [t.globalRegimeId],
      foreignColumns: [globalRegimeSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    productFk: foreignKey({
      name: 'regime_evidence_product_fk',
      columns: [t.productRegimeId],
      foreignColumns: [productRegimeSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const changePointEvents = mysqlTable(
  'change_point_events',
  {
    id: int('id').autoincrement().primaryKey(),
    observerRunId: int('observerRunId').notNull(),
    scope: mysqlEnum('scope', ['global', 'product']).notNull(),
    productId: varchar('productId', { length: 30 }),
    detector: mysqlEnum('detector', ['cusum', 'segmented_variance', 'bocpd_deferred']).notNull(),
    detectorVersion: varchar('detectorVersion', { length: 32 }).notNull(),
    direction: mysqlEnum('direction', ['up', 'down', 'either', 'none']).notNull(),
    magnitude: decimal('magnitude', { precision: 20, scale: 10 }),
    changeProbability: decimal('changeProbability', { precision: 6, scale: 4 }),
    runLengthEstimate: int('runLengthEstimate'),
    thresholdVersion: varchar('thresholdVersion', { length: 32 }).notNull(),
    hazardPolicyVersion: varchar('hazardPolicyVersion', { length: 32 }),
    numericalStatus: mysqlEnum('numericalStatus', [
      'ok',
      'underflow_handled',
      'overflow_handled',
      'failure',
    ])
      .notNull()
      .default('ok'),
    confidence: decimal('confidence', { precision: 6, scale: 4 }).notNull().default('0'),
    detectedAt: timestamp('detectedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    inputHash: varchar('inputHash', { length: 64 }).notNull(),
    diagnostics: text('diagnostics'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('change_pt_run_idx').on(t.observerRunId),
    prodIdx: index('change_pt_prod_idx').on(t.productId, t.detectedAt),
    detectorIdx: index('change_pt_detector_idx').on(t.detector, t.direction),
    runFk: foreignKey({
      name: 'change_pt_run_fk',
      columns: [t.observerRunId],
      foreignColumns: [regimeObserverRuns.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const latentStateModelVersions = mysqlTable(
  'latent_state_model_versions',
  {
    id: int('id').autoincrement().primaryKey(),
    modelKey: varchar('modelKey', { length: 64 }).notNull(),
    modelVersion: varchar('modelVersion', { length: 32 }).notNull(),
    numLatentStates: int('numLatentStates').notNull(),
    observationDimensions: text('observationDimensions').notNull(),
    initializationPolicy: varchar('initializationPolicy', { length: 64 }).notNull(),
    convergencePolicy: varchar('convergencePolicy', { length: 64 }).notNull(),
    maxIterations: int('maxIterations').notNull(),
    numericalPolicy: varchar('numericalPolicy', { length: 64 }).notNull(),
    deterministicSeed: int('deterministicSeed').notNull(),
    trainingWindowStart: timestamp('trainingWindowStart', { fsp: 3 }).notNull(),
    trainingWindowEnd: timestamp('trainingWindowEnd', { fsp: 3 }).notNull(),
    trainingSampleCount: int('trainingSampleCount').notNull(),
    converged: boolean('converged').notNull().default(false),
    finalLogLikelihood: decimal('finalLogLikelihood', { precision: 20, scale: 10 }),
    implementationHash: varchar('implementationHash', { length: 64 }).notNull(),
    status: mysqlEnum('status', ['draft', 'observer', 'deprecated', 'disabled']).notNull().default('observer'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    keyVerUq: uniqueIndex('latent_model_key_ver_uq').on(t.modelKey, t.modelVersion),
    statusIdx: index('latent_model_status_idx').on(t.status),
  }),
);

export const latentStateAssignments = mysqlTable(
  'latent_state_assignments',
  {
    id: int('id').autoincrement().primaryKey(),
    modelVersionId: int('modelVersionId').notNull(),
    observerRunId: int('observerRunId').notNull(),
    productId: varchar('productId', { length: 30 }),
    scope: mysqlEnum('scope', ['global', 'product']).notNull(),
    latentState: int('latentState').notNull(),
    posterior: decimal('posterior', { precision: 6, scale: 4 }).notNull().default('0'),
    logLikelihood: decimal('logLikelihood', { precision: 20, scale: 10 }),
    numericalStatus: mysqlEnum('numericalStatus', [
      'ok',
      'underflow_handled',
      'overflow_handled',
      'failure',
    ])
      .notNull()
      .default('ok'),
    observedAt: timestamp('observedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    inputHash: varchar('inputHash', { length: 64 }).notNull(),
    diagnostics: text('diagnostics'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('latent_assign_run_idx').on(t.observerRunId),
    prodIdx: index('latent_assign_prod_idx').on(t.productId),
    modelIdx: index('latent_assign_model_idx').on(t.modelVersionId),
    modelFk: foreignKey({
      name: 'latent_assign_model_fk',
      columns: [t.modelVersionId],
      foreignColumns: [latentStateModelVersions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    runFk: foreignKey({
      name: 'latent_assign_run_fk',
      columns: [t.observerRunId],
      foreignColumns: [regimeObserverRuns.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const latentStateMappings = mysqlTable(
  'latent_state_mappings',
  {
    id: int('id').autoincrement().primaryKey(),
    modelVersionId: int('modelVersionId').notNull(),
    latentState: int('latentState').notNull(),
    semanticState: mysqlEnum('semanticState', REGIME_STATE_VALUES).notNull(),
    mappingEvidence: text('mappingEvidence').notNull(),
    mappingConfidence: decimal('mappingConfidence', { precision: 6, scale: 4 }).notNull().default('0'),
    mappedAt: timestamp('mappedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    mappingVersion: varchar('mappingVersion', { length: 32 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    modelStateVerUq: uniqueIndex('latent_map_model_state_ver_uq').on(
      t.modelVersionId,
      t.latentState,
      t.mappingVersion,
    ),
    modelFk: foreignKey({
      name: 'latent_map_model_fk',
      columns: [t.modelVersionId],
      foreignColumns: [latentStateModelVersions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const regimeTransitions = mysqlTable(
  'regime_transitions',
  {
    id: int('id').autoincrement().primaryKey(),
    observerRunId: int('observerRunId').notNull(),
    productId: varchar('productId', { length: 30 }),
    scope: mysqlEnum('scope', ['global', 'product']).notNull(),
    previousState: mysqlEnum('previousState', REGIME_STATE_VALUES).notNull(),
    candidateState: mysqlEnum('candidateState', REGIME_STATE_VALUES).notNull(),
    finalState: mysqlEnum('finalState', REGIME_STATE_VALUES).notNull(),
    transitionAccepted: boolean('transitionAccepted').notNull().default(false),
    reasonCodes: varchar('reasonCodes', { length: 255 }).notNull(),
    confidenceBefore: decimal('confidenceBefore', { precision: 6, scale: 4 }).notNull().default('0'),
    confidenceAfter: decimal('confidenceAfter', { precision: 6, scale: 4 }).notNull().default('0'),
    changePointEventId: int('changePointEventId'),
    transitionPolicyVersion: varchar('transitionPolicyVersion', { length: 32 }).notNull(),
    observedAt: timestamp('observedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('regime_trans_run_idx').on(t.observerRunId),
    prodIdx: index('regime_trans_prod_idx').on(t.productId, t.observedAt),
    runFk: foreignKey({
      name: 'regime_trans_run_fk',
      columns: [t.observerRunId],
      foreignColumns: [regimeObserverRuns.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    changePtFk: foreignKey({
      name: 'regime_trans_changept_fk',
      columns: [t.changePointEventId],
      foreignColumns: [changePointEvents.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

const CHALLENGER_RECOMMENDATION_VALUES = [
  'REVERSION',
  'BREAKOUT',
  'MACRO_FLOOR_RESEARCH',
  'NO_TRADE',
  'ABSTAIN',
  'CONFLICT',
] as const;

export const challengerRoutingDecisions = mysqlTable(
  'challenger_routing_decisions',
  {
    id: int('id').autoincrement().primaryKey(),
    observerRunId: int('observerRunId').notNull(),
    productId: varchar('productId', { length: 30 }).notNull(),
    productRegimeId: int('productRegimeId'),
    globalRegimeId: int('globalRegimeId'),
    fingerprintSnapshotId: int('fingerprintSnapshotId'),
    recommendation: mysqlEnum('recommendation', CHALLENGER_RECOMMENDATION_VALUES).notNull(),
    confidence: decimal('confidence', { precision: 6, scale: 4 }).notNull().default('0'),
    reasonCodes: varchar('reasonCodes', { length: 255 }).notNull(),
    routerVersion: varchar('routerVersion', { length: 32 }).notNull(),
    observedAt: timestamp('observedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    inputHash: varchar('inputHash', { length: 64 }).notNull(),
    diagnostics: text('diagnostics'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    runProdUq: uniqueIndex('challenger_run_prod_uq').on(t.observerRunId, t.productId),
    recIdx: index('challenger_recommendation_idx').on(t.recommendation),
    runFk: foreignKey({
      name: 'challenger_run_fk',
      columns: [t.observerRunId],
      foreignColumns: [regimeObserverRuns.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    productRegimeFk: foreignKey({
      name: 'challenger_product_regime_fk',
      columns: [t.productRegimeId],
      foreignColumns: [productRegimeSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    globalRegimeFk: foreignKey({
      name: 'challenger_global_regime_fk',
      columns: [t.globalRegimeId],
      foreignColumns: [globalRegimeSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    fingerprintFk: foreignKey({
      name: 'challenger_fingerprint_fk',
      columns: [t.fingerprintSnapshotId],
      foreignColumns: [fingerprintSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const championChallengerRoutingComparisons = mysqlTable(
  'champion_challenger_routing_comparisons',
  {
    id: int('id').autoincrement().primaryKey(),
    decisionChainId: int('decisionChainId').notNull(),
    challengerDecisionId: int('challengerDecisionId'),
    productId: varchar('productId', { length: 30 }).notNull(),
    championMode: varchar('championMode', { length: 64 }),
    championDecision: varchar('championDecision', { length: 64 }).notNull(),
    challengerRecommendation: mysqlEnum('challengerRecommendation', CHALLENGER_RECOMMENDATION_VALUES).notNull(),
    globalRegimeState: mysqlEnum('globalRegimeState', REGIME_STATE_VALUES),
    productRegimeState: mysqlEnum('productRegimeState', REGIME_STATE_VALUES),
    fingerprintClass: varchar('fingerprintClass', { length: 64 }),
    agreementState: mysqlEnum('agreementState', [
      'agree',
      'partial_agreement',
      'disagree',
      'champion_only',
      'challenger_abstained',
      'unresolved',
    ]).notNull(),
    reasonCodes: varchar('reasonCodes', { length: 255 }).notNull(),
    observerVersion: varchar('observerVersion', { length: 32 }).notNull(),
    observedAt: timestamp('observedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    chainUq: uniqueIndex('champ_chal_chain_uq').on(t.decisionChainId),
    agreementIdx: index('champ_chal_agreement_idx').on(t.agreementState),
    chainFk: foreignKey({
      name: 'champ_chal_chain_fk',
      columns: [t.decisionChainId],
      foreignColumns: [decisionChains.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    challengerFk: foreignKey({
      name: 'champ_chal_challenger_fk',
      columns: [t.challengerDecisionId],
      foreignColumns: [challengerRoutingDecisions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

// ---------------------------------------------------------------------------
// Phase 2C — independent portfolio RiskEngine + conservative sizing observer
// ---------------------------------------------------------------------------

export const riskPolicyVersions = mysqlTable(
  'risk_policy_versions',
  {
    id: int('id').autoincrement().primaryKey(),
    policyKey: varchar('policyKey', { length: 64 }).notNull(),
    policyVersion: varchar('policyVersion', { length: 32 }).notNull(),
    description: text('description').notNull(),
    operatingScope: varchar('operatingScope', { length: 64 }).notNull(),
    status: mysqlEnum('status', [
      'draft',
      'observer',
      'validated_for_research',
      'approved_for_shadow_enforcement',
      'deprecated',
      'disabled',
    ])
      .notNull()
      .default('observer'),
    effectiveFrom: timestamp('effectiveFrom', { fsp: 3 }).notNull(),
    effectiveTo: timestamp('effectiveTo', { fsp: 3 }),
    supersedesPolicyId: int('supersedesPolicyId'),
    implementationHash: varchar('implementationHash', { length: 64 }).notNull(),
    configurationHash: varchar('configurationHash', { length: 64 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    keyVerUq: uniqueIndex('risk_policy_key_ver_uq').on(t.policyKey, t.policyVersion),
    statusIdx: index('risk_policy_status_idx').on(t.status),
    supersedesFk: foreignKey({
      name: 'risk_policy_supersedes_fk',
      columns: [t.supersedesPolicyId],
      foreignColumns: [t.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const riskLimitDefinitions = mysqlTable(
  'risk_limit_definitions',
  {
    id: int('id').autoincrement().primaryKey(),
    policyVersionId: int('policyVersionId').notNull(),
    limitKey: varchar('limitKey', { length: 64 }).notNull(),
    scope: mysqlEnum('scope', [
      'candidate',
      'product',
      'strategy_mode',
      'correlation_cluster',
      'benchmark_beta',
      'portfolio',
      'daily',
      'weekly',
      'drawdown',
      'liquidity',
      'system_integrity',
    ]).notNull(),
    measurementKey: varchar('measurementKey', { length: 64 }).notNull(),
    operator: mysqlEnum('operator', ['lte', 'lt', 'gte', 'gt', 'eq']).notNull().default('lte'),
    warningThreshold: decimal('warningThreshold', { precision: 30, scale: 12 }),
    hardThreshold: decimal('hardThreshold', { precision: 30, scale: 12 }).notNull(),
    unit: varchar('unit', { length: 32 }).notNull(),
    aggregationMethod: varchar('aggregationMethod', { length: 64 }).notNull(),
    lookbackWindow: int('lookbackWindow'),
    minimumSampleCount: int('minimumSampleCount'),
    breachAction: mysqlEnum('breachAction', [
      'observe',
      'reduce',
      'reject',
      'block_all_new_entries',
      'require_reconciliation',
    ]).notNull(),
    missingDataAction: mysqlEnum('missingDataAction', [
      'abstain',
      'reject',
      'block_all_new_entries',
    ]).notNull(),
    priority: int('priority').notNull().default(100),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    policyLimitUq: uniqueIndex('risk_limit_policy_key_uq').on(t.policyVersionId, t.limitKey),
    scopeIdx: index('risk_limit_scope_idx').on(t.scope, t.measurementKey),
    policyFk: foreignKey({
      name: 'risk_limit_policy_fk',
      columns: [t.policyVersionId],
      foreignColumns: [riskPolicyVersions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const portfolioRiskRuns = mysqlTable(
  'portfolio_risk_runs',
  {
    id: int('id').autoincrement().primaryKey(),
    policyVersionId: int('policyVersionId').notNull(),
    startedAt: timestamp('startedAt', { fsp: 3 }).notNull(),
    completedAt: timestamp('completedAt', { fsp: 3 }),
    candidatesEvaluated: int('candidatesEvaluated').notNull().default(0),
    authorizeAsProposed: int('authorizeAsProposed').notNull().default(0),
    reduceSize: int('reduceSize').notNull().default(0),
    rejects: int('rejects').notNull().default(0),
    abstains: int('abstains').notNull().default(0),
    dataFailures: int('dataFailures').notNull().default(0),
    runnerVersion: varchar('runnerVersion', { length: 32 }).notNull(),
    notes: text('notes'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    policyIdx: index('risk_runs_policy_idx').on(t.policyVersionId, t.startedAt),
    policyFk: foreignKey({
      name: 'risk_runs_policy_fk',
      columns: [t.policyVersionId],
      foreignColumns: [riskPolicyVersions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

const SYSTEM_INTEGRITY_VALUES = [
  'healthy',
  'degraded',
  'block_all_new_entries_recommended',
  'reconciliation_required',
  'invalid',
] as const;

export const portfolioRiskSnapshots = mysqlTable(
  'portfolio_risk_snapshots',
  {
    id: int('id').autoincrement().primaryKey(),
    observerRunId: int('observerRunId').notNull(),
    policyVersionId: int('policyVersionId').notNull(),
    cash: decimal('cash', { precision: 30, scale: 10 }).notNull(),
    reservedCash: decimal('reservedCash', { precision: 30, scale: 10 }).notNull(),
    grossExposure: decimal('grossExposure', { precision: 30, scale: 10 }).notNull(),
    netExposure: decimal('netExposure', { precision: 30, scale: 10 }).notNull(),
    totalOpenStopRisk: decimal('totalOpenStopRisk', { precision: 30, scale: 10 }).notNull(),
    pendingEntryRisk: decimal('pendingEntryRisk', { precision: 30, scale: 10 }).notNull(),
    unprotectedExposure: decimal('unprotectedExposure', { precision: 30, scale: 10 }).notNull(),
    btcBetaExposure: decimal('btcBetaExposure', { precision: 30, scale: 10 }),
    ethBetaExposure: decimal('ethBetaExposure', { precision: 30, scale: 10 }),
    dailyLoss: decimal('dailyLoss', { precision: 30, scale: 10 }).notNull().default('0'),
    weeklyLoss: decimal('weeklyLoss', { precision: 30, scale: 10 }).notNull().default('0'),
    currentDrawdown: decimal('currentDrawdown', { precision: 30, scale: 10 }).notNull().default('0'),
    historicalVaR: decimal('historicalVaR', { precision: 30, scale: 10 }),
    historicalExpectedShortfall: decimal('historicalExpectedShortfall', { precision: 30, scale: 10 }),
    worstStressLoss: decimal('worstStressLoss', { precision: 30, scale: 10 }),
    positionCount: int('positionCount').notNull().default(0),
    clusterCount: int('clusterCount').notNull().default(0),
    dataQualityState: varchar('dataQualityState', { length: 64 }).notNull(),
    systemIntegrityState: mysqlEnum('systemIntegrityState', SYSTEM_INTEGRITY_VALUES).notNull(),
    observedAt: timestamp('observedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    inputHash: varchar('inputHash', { length: 64 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    runUq: uniqueIndex('risk_snap_run_uq').on(t.observerRunId),
    integrityIdx: index('risk_snap_integrity_idx').on(t.systemIntegrityState),
    runFk: foreignKey({
      name: 'risk_snap_run_fk',
      columns: [t.observerRunId],
      foreignColumns: [portfolioRiskRuns.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    policyFk: foreignKey({
      name: 'risk_snap_policy_fk',
      columns: [t.policyVersionId],
      foreignColumns: [riskPolicyVersions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const positionRiskSnapshots = mysqlTable(
  'position_risk_snapshots',
  {
    id: int('id').autoincrement().primaryKey(),
    portfolioRiskSnapshotId: int('portfolioRiskSnapshotId').notNull(),
    productId: varchar('productId', { length: 30 }).notNull(),
    entryDecisionChainId: int('entryDecisionChainId'),
    remainingBaseSize: decimal('remainingBaseSize', { precision: 30, scale: 10 }).notNull(),
    weightedAverageEntry: decimal('weightedAverageEntry', { precision: 30, scale: 10 }).notNull(),
    openStopRisk: decimal('openStopRisk', { precision: 30, scale: 10 }),
    grossQuoteExposure: decimal('grossQuoteExposure', { precision: 30, scale: 10 }).notNull(),
    protectionState: varchar('protectionState', { length: 64 }).notNull(),
    state: mysqlEnum('state', [
      'measured',
      'partially_measured',
      'unprotected',
      'reconciliation_required',
      'unknown',
    ]).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    snapIdx: index('pos_risk_snap_idx').on(t.portfolioRiskSnapshotId),
    prodIdx: index('pos_risk_prod_idx').on(t.productId),
    snapFk: foreignKey({
      name: 'pos_risk_snap_fk',
      columns: [t.portfolioRiskSnapshotId],
      foreignColumns: [portfolioRiskSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

const RISK_DECISION_VALUES = [
  'authorize_as_proposed',
  'reduce_size',
  'reject',
  'abstain',
  'data_failure',
] as const;

export const candidateRiskDecisions = mysqlTable(
  'candidate_risk_decisions',
  {
    id: int('id').autoincrement().primaryKey(),
    decisionChainId: int('decisionChainId').notNull(),
    candidateId: varchar('candidateId', { length: 64 }).notNull(),
    policyVersionId: int('policyVersionId').notNull(),
    portfolioRiskSnapshotId: int('portfolioRiskSnapshotId').notNull(),
    proposedBaseSize: decimal('proposedBaseSize', { precision: 30, scale: 10 }).notNull(),
    proposedQuoteSize: decimal('proposedQuoteSize', { precision: 30, scale: 10 }).notNull(),
    recommendedBaseSize: decimal('recommendedBaseSize', { precision: 30, scale: 10 }).notNull(),
    recommendedQuoteSize: decimal('recommendedQuoteSize', { precision: 30, scale: 10 }).notNull(),
    sizeMultiplier: decimal('sizeMultiplier', { precision: 10, scale: 8 }).notNull(),
    decision: mysqlEnum('decision', RISK_DECISION_VALUES).notNull(),
    bindingLimit: varchar('bindingLimit', { length: 64 }),
    warningBreaches: int('warningBreaches').notNull().default(0),
    hardBreaches: int('hardBreaches').notNull().default(0),
    systemIntegrityState: mysqlEnum('systemIntegrityState', SYSTEM_INTEGRITY_VALUES).notNull(),
    confidence: decimal('confidence', { precision: 6, scale: 4 }).notNull().default('0'),
    observedAt: timestamp('observedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    inputHash: varchar('inputHash', { length: 64 }).notNull(),
    reasonCodes: varchar('reasonCodes', { length: 255 }).notNull(),
    diagnostics: text('diagnostics'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    chainCandUq: uniqueIndex('cand_risk_chain_cand_uq').on(t.decisionChainId, t.candidateId),
    decisionIdx: index('cand_risk_decision_idx').on(t.decision),
    chainFk: foreignKey({
      name: 'cand_risk_chain_fk',
      columns: [t.decisionChainId],
      foreignColumns: [decisionChains.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    policyFk: foreignKey({
      name: 'cand_risk_policy_fk',
      columns: [t.policyVersionId],
      foreignColumns: [riskPolicyVersions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    snapFk: foreignKey({
      name: 'cand_risk_snap_fk',
      columns: [t.portfolioRiskSnapshotId],
      foreignColumns: [portfolioRiskSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const riskLimitBreaches = mysqlTable(
  'risk_limit_breaches',
  {
    id: int('id').autoincrement().primaryKey(),
    portfolioRiskSnapshotId: int('portfolioRiskSnapshotId').notNull(),
    candidateRiskDecisionId: int('candidateRiskDecisionId'),
    limitDefinitionId: int('limitDefinitionId').notNull(),
    scope: varchar('scope', { length: 64 }).notNull(),
    subjectId: varchar('subjectId', { length: 64 }),
    measuredValue: decimal('measuredValue', { precision: 30, scale: 12 }).notNull(),
    warningThreshold: decimal('warningThreshold', { precision: 30, scale: 12 }),
    hardThreshold: decimal('hardThreshold', { precision: 30, scale: 12 }).notNull(),
    severity: mysqlEnum('severity', ['warning', 'hard', 'system_integrity']).notNull(),
    breachAction: varchar('breachAction', { length: 64 }).notNull(),
    observedAt: timestamp('observedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    snapIdx: index('risk_breach_snap_idx').on(t.portfolioRiskSnapshotId),
    severityIdx: index('risk_breach_severity_idx').on(t.severity, t.scope),
    snapFk: foreignKey({
      name: 'risk_breach_snap_fk',
      columns: [t.portfolioRiskSnapshotId],
      foreignColumns: [portfolioRiskSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    limitFk: foreignKey({
      name: 'risk_breach_limit_fk',
      columns: [t.limitDefinitionId],
      foreignColumns: [riskLimitDefinitions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    candFk: foreignKey({
      name: 'risk_breach_cand_fk',
      columns: [t.candidateRiskDecisionId],
      foreignColumns: [candidateRiskDecisions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const correlationModelVersions = mysqlTable(
  'correlation_model_versions',
  {
    id: int('id').autoincrement().primaryKey(),
    modelKey: varchar('modelKey', { length: 64 }).notNull(),
    modelVersion: varchar('modelVersion', { length: 32 }).notNull(),
    estimator: varchar('estimator', { length: 64 }).notNull(),
    shrinkageMethod: varchar('shrinkageMethod', { length: 64 }).notNull(),
    shrinkageCoefficient: decimal('shrinkageCoefficient', { precision: 6, scale: 4 }),
    minimumOverlap: int('minimumOverlap').notNull(),
    returnInterval: varchar('returnInterval', { length: 32 }).notNull(),
    implementationHash: varchar('implementationHash', { length: 64 }).notNull(),
    status: mysqlEnum('status', ['draft', 'observer', 'deprecated', 'disabled']).notNull().default('observer'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    keyVerUq: uniqueIndex('corr_model_key_ver_uq').on(t.modelKey, t.modelVersion),
  }),
);

export const correlationSnapshots = mysqlTable(
  'correlation_snapshots',
  {
    id: int('id').autoincrement().primaryKey(),
    modelVersionId: int('modelVersionId').notNull(),
    observerRunId: int('observerRunId'),
    productCount: int('productCount').notNull(),
    pairCount: int('pairCount').notNull(),
    rawCovarianceHash: varchar('rawCovarianceHash', { length: 64 }),
    shrunkCovarianceHash: varchar('shrunkCovarianceHash', { length: 64 }),
    numericalStatus: mysqlEnum('numericalStatus', ['ok', 'psd_failure', 'underflow_handled', 'failure']).notNull().default('ok'),
    observedAt: timestamp('observedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    inputHash: varchar('inputHash', { length: 64 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('corr_snap_run_idx').on(t.observerRunId),
    modelIdx: index('corr_snap_model_idx').on(t.modelVersionId),
    modelFk: foreignKey({
      name: 'corr_snap_model_fk',
      columns: [t.modelVersionId],
      foreignColumns: [correlationModelVersions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    runFk: foreignKey({
      name: 'corr_snap_run_fk',
      columns: [t.observerRunId],
      foreignColumns: [portfolioRiskRuns.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

const RISK_MEASUREMENT_STATUS_VALUES = [
  'valid',
  'low_confidence',
  'insufficient_history',
  'stale',
  'invalid_input',
  'numerical_failure',
  'unresolved_state',
  'unsupported',
] as const;

export const correlationPairs = mysqlTable(
  'correlation_pairs',
  {
    id: int('id').autoincrement().primaryKey(),
    snapshotId: int('snapshotId').notNull(),
    productA: varchar('productA', { length: 30 }).notNull(),
    productB: varchar('productB', { length: 30 }).notNull(),
    correlation: decimal('correlation', { precision: 10, scale: 6 }),
    overlapCount: int('overlapCount').notNull(),
    confidence: decimal('confidence', { precision: 6, scale: 4 }).notNull().default('0'),
    status: mysqlEnum('status', RISK_MEASUREMENT_STATUS_VALUES).notNull(),
    lookbackStart: timestamp('lookbackStart', { fsp: 3 }).notNull(),
    lookbackEnd: timestamp('lookbackEnd', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    snapAbUq: uniqueIndex('corr_pair_snap_ab_uq').on(t.snapshotId, t.productA, t.productB),
    statusIdx: index('corr_pair_status_idx').on(t.status),
    snapFk: foreignKey({
      name: 'corr_pair_snap_fk',
      columns: [t.snapshotId],
      foreignColumns: [correlationSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const riskClusterSnapshots = mysqlTable(
  'risk_cluster_snapshots',
  {
    id: int('id').autoincrement().primaryKey(),
    correlationSnapshotId: int('correlationSnapshotId').notNull(),
    observerRunId: int('observerRunId'),
    clusteringPolicyVersion: varchar('clusteringPolicyVersion', { length: 32 }).notNull(),
    absoluteThreshold: decimal('absoluteThreshold', { precision: 6, scale: 4 }).notNull(),
    clusterCount: int('clusterCount').notNull(),
    unclusteredCount: int('unclusteredCount').notNull(),
    observedAt: timestamp('observedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    inputHash: varchar('inputHash', { length: 64 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    corrIdx: index('cluster_snap_corr_idx').on(t.correlationSnapshotId),
    corrFk: foreignKey({
      name: 'cluster_snap_corr_fk',
      columns: [t.correlationSnapshotId],
      foreignColumns: [correlationSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    runFk: foreignKey({
      name: 'cluster_snap_run_fk',
      columns: [t.observerRunId],
      foreignColumns: [portfolioRiskRuns.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const riskClusters = mysqlTable(
  'risk_clusters',
  {
    id: int('id').autoincrement().primaryKey(),
    clusterSnapshotId: int('clusterSnapshotId').notNull(),
    clusterKey: varchar('clusterKey', { length: 64 }).notNull(),
    productCount: int('productCount').notNull(),
    representativeProductId: varchar('representativeProductId', { length: 30 }),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    snapKeyUq: uniqueIndex('cluster_snap_key_uq').on(t.clusterSnapshotId, t.clusterKey),
    snapFk: foreignKey({
      name: 'cluster_snap_fk',
      columns: [t.clusterSnapshotId],
      foreignColumns: [riskClusterSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const riskClusterMemberships = mysqlTable(
  'risk_cluster_memberships',
  {
    id: int('id').autoincrement().primaryKey(),
    clusterSnapshotId: int('clusterSnapshotId').notNull(),
    clusterId: int('clusterId'),
    productId: varchar('productId', { length: 30 }).notNull(),
    membershipStrength: decimal('membershipStrength', { precision: 6, scale: 4 }),
    reason: varchar('reason', { length: 64 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    snapProdUq: uniqueIndex('cluster_mem_snap_prod_uq').on(t.clusterSnapshotId, t.productId),
    clusterIdx: index('cluster_mem_cluster_idx').on(t.clusterId),
    snapFk: foreignKey({
      name: 'cluster_mem_snap_fk',
      columns: [t.clusterSnapshotId],
      foreignColumns: [riskClusterSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    clusterFk: foreignKey({
      name: 'cluster_mem_cluster_fk',
      columns: [t.clusterId],
      foreignColumns: [riskClusters.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

const LOSS_STATE_VALUES = ['open', 'warning', 'hard_breached', 'closed', 'invalid'] as const;

export const dailyLossStates = mysqlTable(
  'daily_loss_states',
  {
    id: int('id').autoincrement().primaryKey(),
    policyVersion: varchar('policyVersion', { length: 32 }).notNull(),
    periodStart: timestamp('periodStart', { fsp: 3 }).notNull(),
    periodEnd: timestamp('periodEnd', { fsp: 3 }).notNull(),
    startingEquity: decimal('startingEquity', { precision: 30, scale: 10 }).notNull(),
    endingEquity: decimal('endingEquity', { precision: 30, scale: 10 }).notNull(),
    realizedNetPnl: decimal('realizedNetPnl', { precision: 30, scale: 10 }).notNull(),
    fees: decimal('fees', { precision: 30, scale: 10 }).notNull(),
    status: mysqlEnum('status', LOSS_STATE_VALUES).notNull().default('open'),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    periodUq: uniqueIndex('daily_loss_period_policy_uq').on(t.policyVersion, t.periodStart),
    statusIdx: index('daily_loss_status_idx').on(t.status),
  }),
);

export const weeklyLossStates = mysqlTable(
  'weekly_loss_states',
  {
    id: int('id').autoincrement().primaryKey(),
    policyVersion: varchar('policyVersion', { length: 32 }).notNull(),
    periodStart: timestamp('periodStart', { fsp: 3 }).notNull(),
    periodEnd: timestamp('periodEnd', { fsp: 3 }).notNull(),
    startingEquity: decimal('startingEquity', { precision: 30, scale: 10 }).notNull(),
    endingEquity: decimal('endingEquity', { precision: 30, scale: 10 }).notNull(),
    realizedNetPnl: decimal('realizedNetPnl', { precision: 30, scale: 10 }).notNull(),
    fees: decimal('fees', { precision: 30, scale: 10 }).notNull(),
    status: mysqlEnum('status', LOSS_STATE_VALUES).notNull().default('open'),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    periodUq: uniqueIndex('weekly_loss_period_policy_uq').on(t.policyVersion, t.periodStart),
    statusIdx: index('weekly_loss_status_idx').on(t.status),
  }),
);

export const portfolioDrawdownStates = mysqlTable(
  'portfolio_drawdown_states',
  {
    id: int('id').autoincrement().primaryKey(),
    policyVersion: varchar('policyVersion', { length: 32 }).notNull(),
    peakEquity: decimal('peakEquity', { precision: 30, scale: 10 }).notNull(),
    currentEquity: decimal('currentEquity', { precision: 30, scale: 10 }).notNull(),
    currentDrawdown: decimal('currentDrawdown', { precision: 30, scale: 10 }).notNull(),
    maximumDrawdown: decimal('maximumDrawdown', { precision: 30, scale: 10 }).notNull(),
    peakEquityAt: timestamp('peakEquityAt', { fsp: 3 }).notNull(),
    status: mysqlEnum('status', ['healthy', 'warning', 'hard_breached', 'invalid']).notNull().default('healthy'),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    policyIdx: index('drawdown_policy_idx').on(t.policyVersion, t.createdAt),
    statusIdx: index('drawdown_status_idx').on(t.status),
  }),
);

export const stressScenarioDefinitions = mysqlTable(
  'stress_scenario_definitions',
  {
    id: int('id').autoincrement().primaryKey(),
    scenarioKey: varchar('scenarioKey', { length: 64 }).notNull(),
    scenarioVersion: varchar('scenarioVersion', { length: 32 }).notNull(),
    description: text('description').notNull(),
    shockDefinitions: text('shockDefinitions').notNull(),
    correlationPolicy: varchar('correlationPolicy', { length: 64 }).notNull(),
    liquidityPolicy: varchar('liquidityPolicy', { length: 64 }).notNull(),
    protectionPolicy: varchar('protectionPolicy', { length: 64 }).notNull(),
    valuationPolicy: varchar('valuationPolicy', { length: 64 }).notNull(),
    implementationHash: varchar('implementationHash', { length: 64 }).notNull(),
    status: mysqlEnum('status', ['draft', 'observer', 'deprecated', 'disabled']).notNull().default('observer'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    keyVerUq: uniqueIndex('stress_key_ver_uq').on(t.scenarioKey, t.scenarioVersion),
  }),
);

export const stressTestRuns = mysqlTable(
  'stress_test_runs',
  {
    id: int('id').autoincrement().primaryKey(),
    portfolioRiskSnapshotId: int('portfolioRiskSnapshotId').notNull(),
    scenarioCount: int('scenarioCount').notNull(),
    worstScenarioKey: varchar('worstScenarioKey', { length: 64 }),
    worstLoss: decimal('worstLoss', { precision: 30, scale: 10 }),
    startedAt: timestamp('startedAt', { fsp: 3 }).notNull(),
    completedAt: timestamp('completedAt', { fsp: 3 }),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    snapIdx: index('stress_runs_snap_idx').on(t.portfolioRiskSnapshotId),
    snapFk: foreignKey({
      name: 'stress_runs_snap_fk',
      columns: [t.portfolioRiskSnapshotId],
      foreignColumns: [portfolioRiskSnapshots.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const stressTestResults = mysqlTable(
  'stress_test_results',
  {
    id: int('id').autoincrement().primaryKey(),
    stressTestRunId: int('stressTestRunId').notNull(),
    scenarioDefinitionId: int('scenarioDefinitionId').notNull(),
    portfolioValueBefore: decimal('portfolioValueBefore', { precision: 30, scale: 10 }).notNull(),
    portfolioValueAfter: decimal('portfolioValueAfter', { precision: 30, scale: 10 }).notNull(),
    estimatedLoss: decimal('estimatedLoss', { precision: 30, scale: 10 }).notNull(),
    candidateIncrementalLoss: decimal('candidateIncrementalLoss', { precision: 30, scale: 10 }),
    largestPositionContribution: decimal('largestPositionContribution', { precision: 30, scale: 10 }),
    largestClusterContribution: decimal('largestClusterContribution', { precision: 30, scale: 10 }),
    assumptions: text('assumptions').notNull(),
    limitBreaches: int('limitBreaches').notNull().default(0),
    dataQualityStatus: varchar('dataQualityStatus', { length: 64 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    runScenUq: uniqueIndex('stress_result_run_scen_uq').on(t.stressTestRunId, t.scenarioDefinitionId),
    runFk: foreignKey({
      name: 'stress_result_run_fk',
      columns: [t.stressTestRunId],
      foreignColumns: [stressTestRuns.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    scenFk: foreignKey({
      name: 'stress_result_scen_fk',
      columns: [t.scenarioDefinitionId],
      foreignColumns: [stressScenarioDefinitions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  }),
);

export const championRiskComparisons = mysqlTable(
  'champion_risk_comparisons',
  {
    id: int('id').autoincrement().primaryKey(),
    decisionChainId: int('decisionChainId').notNull(),
    candidateRiskDecisionId: int('candidateRiskDecisionId'),
    productId: varchar('productId', { length: 30 }).notNull(),
    championProposedBaseSize: decimal('championProposedBaseSize', { precision: 30, scale: 10 }).notNull(),
    championProposedQuoteSize: decimal('championProposedQuoteSize', { precision: 30, scale: 10 }).notNull(),
    riskRecommendedBaseSize: decimal('riskRecommendedBaseSize', { precision: 30, scale: 10 }).notNull(),
    riskRecommendedQuoteSize: decimal('riskRecommendedQuoteSize', { precision: 30, scale: 10 }).notNull(),
    riskDecision: mysqlEnum('riskDecision', RISK_DECISION_VALUES).notNull(),
    bindingLimit: varchar('bindingLimit', { length: 64 }),
    championExecutionOutcome: varchar('championExecutionOutcome', { length: 64 }),
    agreementState: mysqlEnum('agreementState', [
      'agree',
      'risk_reduced',
      'risk_rejected',
      'risk_abstained',
      'unresolved',
    ]).notNull(),
    policyVersion: varchar('policyVersion', { length: 32 }).notNull(),
    observedAt: timestamp('observedAt', { fsp: 3 }).notNull(),
    dataAvailableAt: timestamp('dataAvailableAt', { fsp: 3 }).notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => ({
    chainUq: uniqueIndex('champ_risk_chain_uq').on(t.decisionChainId),
    agreementIdx: index('champ_risk_agreement_idx').on(t.agreementState),
    chainFk: foreignKey({
      name: 'champ_risk_chain_fk',
      columns: [t.decisionChainId],
      foreignColumns: [decisionChains.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    candFk: foreignKey({
      name: 'champ_risk_cand_fk',
      columns: [t.candidateRiskDecisionId],
      foreignColumns: [candidateRiskDecisions.id],
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
export type SoakRunRow = typeof soakRuns.$inferSelect;
export type SoakRunInsert = typeof soakRuns.$inferInsert;
export type SoakDailyReportRow = typeof soakDailyReports.$inferSelect;
export type SoakDailyReportInsert = typeof soakDailyReports.$inferInsert;
export type SoakIncidentRow = typeof soakIncidents.$inferSelect;
export type SoakIncidentInsert = typeof soakIncidents.$inferInsert;
export type AdapterSelectionRow = typeof adapterSelections.$inferSelect;
export type AdapterSelectionInsert = typeof adapterSelections.$inferInsert;
export type SoakPreflightRunRow = typeof soakPreflightRuns.$inferSelect;
export type SoakPreflightRunInsert = typeof soakPreflightRuns.$inferInsert;
export type UniverseSnapshotRow = typeof universeSnapshots.$inferSelect;
export type UniverseSnapshotInsert = typeof universeSnapshots.$inferInsert;
export type UniverseProductRow = typeof universeProducts.$inferSelect;
export type UniverseProductInsert = typeof universeProducts.$inferInsert;
export type ProductMetadataObservationRow = typeof productMetadataObservations.$inferSelect;
export type ProductMetadataObservationInsert = typeof productMetadataObservations.$inferInsert;
export type ProductHygieneDecisionRow = typeof productHygieneDecisions.$inferSelect;
export type ProductHygieneDecisionInsert = typeof productHygieneDecisions.$inferInsert;
export type ProductQuarantineRow = typeof productQuarantines.$inferSelect;
export type ProductQuarantineInsert = typeof productQuarantines.$inferInsert;
export type FeatureDefinitionRow = typeof featureDefinitions.$inferSelect;
export type FeatureDefinitionInsert = typeof featureDefinitions.$inferInsert;
export type FeatureCalculationRunRow = typeof featureCalculationRuns.$inferSelect;
export type FeatureCalculationRunInsert = typeof featureCalculationRuns.$inferInsert;
export type FeatureValueRow = typeof featureValues.$inferSelect;
export type FeatureValueInsert = typeof featureValues.$inferInsert;
export type ShortlistDecisionRow = typeof shortlistDecisions.$inferSelect;
export type ShortlistDecisionInsert = typeof shortlistDecisions.$inferInsert;
export type FingerprintDefinitionRow = typeof fingerprintDefinitions.$inferSelect;
export type FingerprintDefinitionInsert = typeof fingerprintDefinitions.$inferInsert;
export type FingerprintSnapshotRow = typeof fingerprintSnapshots.$inferSelect;
export type FingerprintSnapshotInsert = typeof fingerprintSnapshots.$inferInsert;
export type FingerprintEvidenceRow = typeof fingerprintEvidence.$inferSelect;
export type FingerprintEvidenceInsert = typeof fingerprintEvidence.$inferInsert;
export type ResearchObserverRunRow = typeof researchObserverRuns.$inferSelect;
export type ResearchObserverRunInsert = typeof researchObserverRuns.$inferInsert;
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

// Phase 2B
export type RegimeDefinitionRow = typeof regimeDefinitions.$inferSelect;
export type RegimeDefinitionInsert = typeof regimeDefinitions.$inferInsert;
export type RegimeTransitionPolicyRow = typeof regimeTransitionPolicies.$inferSelect;
export type RegimeTransitionPolicyInsert = typeof regimeTransitionPolicies.$inferInsert;
export type RegimeObserverRunRow = typeof regimeObserverRuns.$inferSelect;
export type RegimeObserverRunInsert = typeof regimeObserverRuns.$inferInsert;
export type GlobalRegimeSnapshotRow = typeof globalRegimeSnapshots.$inferSelect;
export type GlobalRegimeSnapshotInsert = typeof globalRegimeSnapshots.$inferInsert;
export type ProductRegimeSnapshotRow = typeof productRegimeSnapshots.$inferSelect;
export type ProductRegimeSnapshotInsert = typeof productRegimeSnapshots.$inferInsert;
export type RegimeEvidenceRow = typeof regimeEvidence.$inferSelect;
export type RegimeEvidenceInsert = typeof regimeEvidence.$inferInsert;
export type ChangePointEventRow = typeof changePointEvents.$inferSelect;
export type ChangePointEventInsert = typeof changePointEvents.$inferInsert;
export type LatentStateModelVersionRow = typeof latentStateModelVersions.$inferSelect;
export type LatentStateModelVersionInsert = typeof latentStateModelVersions.$inferInsert;
export type LatentStateAssignmentRow = typeof latentStateAssignments.$inferSelect;
export type LatentStateAssignmentInsert = typeof latentStateAssignments.$inferInsert;
export type LatentStateMappingRow = typeof latentStateMappings.$inferSelect;
export type LatentStateMappingInsert = typeof latentStateMappings.$inferInsert;
export type RegimeTransitionRow = typeof regimeTransitions.$inferSelect;
export type RegimeTransitionInsert = typeof regimeTransitions.$inferInsert;
export type ChallengerRoutingDecisionRow = typeof challengerRoutingDecisions.$inferSelect;
export type ChallengerRoutingDecisionInsert = typeof challengerRoutingDecisions.$inferInsert;
export type ChampionChallengerRoutingComparisonRow = typeof championChallengerRoutingComparisons.$inferSelect;
export type ChampionChallengerRoutingComparisonInsert = typeof championChallengerRoutingComparisons.$inferInsert;

// Phase 2C
export type RiskPolicyVersionRow = typeof riskPolicyVersions.$inferSelect;
export type RiskPolicyVersionInsert = typeof riskPolicyVersions.$inferInsert;
export type RiskLimitDefinitionRow = typeof riskLimitDefinitions.$inferSelect;
export type RiskLimitDefinitionInsert = typeof riskLimitDefinitions.$inferInsert;
export type PortfolioRiskRunRow = typeof portfolioRiskRuns.$inferSelect;
export type PortfolioRiskRunInsert = typeof portfolioRiskRuns.$inferInsert;
export type PortfolioRiskSnapshotRow = typeof portfolioRiskSnapshots.$inferSelect;
export type PortfolioRiskSnapshotInsert = typeof portfolioRiskSnapshots.$inferInsert;
export type PositionRiskSnapshotRow = typeof positionRiskSnapshots.$inferSelect;
export type PositionRiskSnapshotInsert = typeof positionRiskSnapshots.$inferInsert;
export type CandidateRiskDecisionRow = typeof candidateRiskDecisions.$inferSelect;
export type CandidateRiskDecisionInsert = typeof candidateRiskDecisions.$inferInsert;
export type RiskLimitBreachRow = typeof riskLimitBreaches.$inferSelect;
export type RiskLimitBreachInsert = typeof riskLimitBreaches.$inferInsert;
export type CorrelationModelVersionRow = typeof correlationModelVersions.$inferSelect;
export type CorrelationModelVersionInsert = typeof correlationModelVersions.$inferInsert;
export type CorrelationSnapshotRow = typeof correlationSnapshots.$inferSelect;
export type CorrelationSnapshotInsert = typeof correlationSnapshots.$inferInsert;
export type CorrelationPairRow = typeof correlationPairs.$inferSelect;
export type CorrelationPairInsert = typeof correlationPairs.$inferInsert;
export type RiskClusterSnapshotRow = typeof riskClusterSnapshots.$inferSelect;
export type RiskClusterSnapshotInsert = typeof riskClusterSnapshots.$inferInsert;
export type RiskClusterRow = typeof riskClusters.$inferSelect;
export type RiskClusterInsert = typeof riskClusters.$inferInsert;
export type RiskClusterMembershipRow = typeof riskClusterMemberships.$inferSelect;
export type RiskClusterMembershipInsert = typeof riskClusterMemberships.$inferInsert;
export type DailyLossStateRow = typeof dailyLossStates.$inferSelect;
export type DailyLossStateInsert = typeof dailyLossStates.$inferInsert;
export type WeeklyLossStateRow = typeof weeklyLossStates.$inferSelect;
export type WeeklyLossStateInsert = typeof weeklyLossStates.$inferInsert;
export type PortfolioDrawdownStateRow = typeof portfolioDrawdownStates.$inferSelect;
export type PortfolioDrawdownStateInsert = typeof portfolioDrawdownStates.$inferInsert;
export type StressScenarioDefinitionRow = typeof stressScenarioDefinitions.$inferSelect;
export type StressScenarioDefinitionInsert = typeof stressScenarioDefinitions.$inferInsert;
export type StressTestRunRow = typeof stressTestRuns.$inferSelect;
export type StressTestRunInsert = typeof stressTestRuns.$inferInsert;
export type StressTestResultRow = typeof stressTestResults.$inferSelect;
export type StressTestResultInsert = typeof stressTestResults.$inferInsert;
export type ChampionRiskComparisonRow = typeof championRiskComparisons.$inferSelect;
export type ChampionRiskComparisonInsert = typeof championRiskComparisons.$inferInsert;
