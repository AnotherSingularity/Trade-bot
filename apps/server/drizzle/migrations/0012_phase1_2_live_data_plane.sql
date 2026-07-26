-- Phase 1.2 — live Coinbase data plane + continuous shadow operation.
--
-- Additive DDL. Migrations 0000-0011 remain immutable.
--
-- Adds:
--   1. market_stream_sessions          — one row per WebSocket connection
--   2. market_stream_subscriptions     — channel×product subscription log
--   3. market_data_events              — raw event envelope (bounded retention)
--   4. market_data_gaps                — detected gaps + recovery state
--   5. product_market_states           — MUTABLE operational projection
--   6. candle_observations             — assembled/finalized candles (immutable)
--   7. ticker_observations             — bounded ticker history
--   8. market_trade_observations       — bounded trade history
--   9. shadow_operation_runs           — hourly operational reports
--  10. shadow_daily_reports            — daily net-cost performance reports
--  11. forward_outcome_labels          — prospective outcome labels (accepted
--                                        AND rejected candidates)

-- ---------------------------------------------------------------------------
-- 1. market_stream_sessions
-- ---------------------------------------------------------------------------
CREATE TABLE `market_stream_sessions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `endpoint` VARCHAR(255) NOT NULL,
  `connectionGroup` VARCHAR(32) NOT NULL,
  `startedAt` TIMESTAMP NOT NULL,
  `endedAt` TIMESTAMP NULL,
  `state` ENUM(
    'disconnected',
    'connecting',
    'subscribing',
    'synchronizing',
    'healthy',
    'stale',
    'degraded',
    'reconnecting',
    'failed',
    'stopped'
  ) NOT NULL DEFAULT 'disconnected',
  `reconnectCount` INT NOT NULL DEFAULT 0,
  `lastHeartbeatAt` TIMESTAMP NULL,
  `lastHeartbeatCounter` INT NULL,
  `messagesReceived` INT NOT NULL DEFAULT 0,
  `messagesRejected` INT NOT NULL DEFAULT 0,
  `failureReason` VARCHAR(255) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `stream_sessions_state_idx` (`state`),
  KEY `stream_sessions_group_idx` (`connectionGroup`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. market_stream_subscriptions
-- ---------------------------------------------------------------------------
CREATE TABLE `market_stream_subscriptions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `sessionId` INT NOT NULL,
  `channel` VARCHAR(32) NOT NULL,
  `productId` VARCHAR(30) NULL,
  `state` ENUM('requested', 'acknowledged', 'closed', 'rejected') NOT NULL DEFAULT 'requested',
  `requestedAt` TIMESTAMP NOT NULL,
  `acknowledgedAt` TIMESTAMP NULL,
  `closedAt` TIMESTAMP NULL,
  `failureReason` VARCHAR(255) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `stream_subs_session_idx` (`sessionId`),
  KEY `stream_subs_channel_idx` (`channel`, `productId`),
  CONSTRAINT `stream_subs_session_fk`
    FOREIGN KEY (`sessionId`) REFERENCES `market_stream_sessions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. market_data_events — bounded-retention raw envelope log
-- ---------------------------------------------------------------------------
CREATE TABLE `market_data_events` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `eventId` VARCHAR(96) NOT NULL,
  `source` VARCHAR(32) NOT NULL,
  `channel` VARCHAR(32) NOT NULL,
  `productId` VARCHAR(30) NULL,
  `sourceTimestamp` TIMESTAMP(3) NOT NULL,
  `receivedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `connectionId` INT NULL,
  `sequenceNumber` INT NULL,
  `eventType` VARCHAR(48) NOT NULL,
  `schemaVersion` VARCHAR(32) NOT NULL,
  `payloadHash` VARCHAR(64) NOT NULL,
  `normalizedPayload` TEXT NOT NULL,
  `validationStatus` ENUM('valid', 'rejected_malformed', 'rejected_unknown', 'duplicate')
    NOT NULL DEFAULT 'valid',
  `failureReason` VARCHAR(255) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `market_events_dedup_uq` (`payloadHash`),
  KEY `market_events_channel_idx` (`channel`, `productId`, `sourceTimestamp`),
  KEY `market_events_session_idx` (`connectionId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. market_data_gaps
-- ---------------------------------------------------------------------------
CREATE TABLE `market_data_gaps` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `sessionId` INT NULL,
  `channel` VARCHAR(32) NOT NULL,
  `productId` VARCHAR(30) NULL,
  `detectedAt` TIMESTAMP NOT NULL,
  `expectedSequence` INT NULL,
  `actualSequence` INT NULL,
  `lastKnownEventAt` TIMESTAMP NULL,
  `gapType` ENUM(
    'missing_sequence',
    'missing_heartbeat',
    'missing_candle_bucket',
    'stale_ticker',
    'connection_closed',
    'bootstrap_missing_interval'
  ) NOT NULL,
  `recoveryMethod` VARCHAR(64) NULL,
  `recoveredAt` TIMESTAMP NULL,
  `state` ENUM('open', 'recovered', 'degraded', 'failed') NOT NULL DEFAULT 'open',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `market_gaps_session_idx` (`sessionId`),
  KEY `market_gaps_state_idx` (`state`),
  KEY `market_gaps_channel_idx` (`channel`, `productId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. product_market_states — MUTABLE per-product operational projection
-- ---------------------------------------------------------------------------
CREATE TABLE `product_market_states` (
  `productId` VARCHAR(30) NOT NULL,
  `tickerState` ENUM('healthy', 'stale', 'unknown') NOT NULL DEFAULT 'unknown',
  `candleState` ENUM('healthy', 'stale', 'incomplete_history', 'gap_detected', 'unknown')
    NOT NULL DEFAULT 'unknown',
  `tradeState` ENUM('healthy', 'stale', 'unknown') NOT NULL DEFAULT 'unknown',
  `statusState` ENUM('online', 'offline', 'delisted', 'unknown') NOT NULL DEFAULT 'unknown',
  `lastTickerAt` TIMESTAMP(3) NULL,
  `lastCandleAt` TIMESTAMP(3) NULL,
  `lastTradeAt` TIMESTAMP(3) NULL,
  `lastStatusAt` TIMESTAMP(3) NULL,
  `latestPrice` DECIMAL(20, 8) NULL,
  `currentCandleStart` TIMESTAMP(3) NULL,
  `dataQualityState` ENUM(
    'healthy',
    'stale',
    'incomplete_history',
    'gap_detected',
    'desynchronized',
    'invalid_value',
    'product_unavailable',
    'connection_degraded'
  ) NOT NULL DEFAULT 'incomplete_history',
  `dataVersion` VARCHAR(32) NOT NULL DEFAULT 'p1_2-1',
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`productId`),
  KEY `product_states_quality_idx` (`dataQualityState`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. candle_observations — assembled + finalized candles (immutable rows;
--    corrections create a new version pointing back via supersedesCandleId)
-- ---------------------------------------------------------------------------
CREATE TABLE `candle_observations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `productId` VARCHAR(30) NOT NULL,
  `granularitySeconds` INT NOT NULL DEFAULT 300,
  `bucketStart` TIMESTAMP(3) NOT NULL,
  `open` DECIMAL(20, 8) NOT NULL,
  `high` DECIMAL(20, 8) NOT NULL,
  `low` DECIMAL(20, 8) NOT NULL,
  `close` DECIMAL(20, 8) NOT NULL,
  `volume` DECIMAL(30, 8) NOT NULL,
  `finalized` BOOLEAN NOT NULL DEFAULT FALSE,
  `finalizedAt` TIMESTAMP(3) NULL,
  `sourceEventId` INT NULL,
  `sourceTimestamp` TIMESTAMP(3) NOT NULL,
  `receivedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `version` INT NOT NULL DEFAULT 1,
  `supersedesCandleId` INT NULL,
  `correctionReason` VARCHAR(128) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `candles_bucket_version_uq` (`productId`, `granularitySeconds`, `bucketStart`, `version`),
  KEY `candles_product_bucket_idx` (`productId`, `bucketStart`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. ticker_observations — bounded ticker history
-- ---------------------------------------------------------------------------
CREATE TABLE `ticker_observations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `productId` VARCHAR(30) NOT NULL,
  `price` DECIMAL(20, 8) NOT NULL,
  `bestBid` DECIMAL(20, 8) NULL,
  `bestAsk` DECIMAL(20, 8) NULL,
  `spreadBps` DECIMAL(10, 4) NULL,
  `sourceTimestamp` TIMESTAMP(3) NOT NULL,
  `receivedAt` TIMESTAMP(3) NOT NULL,
  `sourceEventId` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ticker_product_time_idx` (`productId`, `sourceTimestamp`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. market_trade_observations
-- ---------------------------------------------------------------------------
CREATE TABLE `market_trade_observations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `productId` VARCHAR(30) NOT NULL,
  `tradeId` VARCHAR(64) NOT NULL,
  `price` DECIMAL(20, 8) NOT NULL,
  `size` DECIMAL(30, 8) NOT NULL,
  `side` ENUM('BUY', 'SELL') NOT NULL,
  `sourceTimestamp` TIMESTAMP(3) NOT NULL,
  `receivedAt` TIMESTAMP(3) NOT NULL,
  `sourceEventId` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `market_trades_dedup_uq` (`productId`, `tradeId`),
  KEY `market_trades_product_time_idx` (`productId`, `sourceTimestamp`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. shadow_operation_runs — hourly operational reports
-- ---------------------------------------------------------------------------
CREATE TABLE `shadow_operation_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `reportedAt` TIMESTAMP NOT NULL,
  `windowStart` TIMESTAMP NOT NULL,
  `windowEnd` TIMESTAMP NOT NULL,
  `activeConnections` INT NOT NULL DEFAULT 0,
  `healthyConnections` INT NOT NULL DEFAULT 0,
  `reconnectCount` INT NOT NULL DEFAULT 0,
  `heartbeatGaps` INT NOT NULL DEFAULT 0,
  `healthyProductCount` INT NOT NULL DEFAULT 0,
  `staleProductCount` INT NOT NULL DEFAULT 0,
  `scannerRuns` INT NOT NULL DEFAULT 0,
  `scannerFailures` INT NOT NULL DEFAULT 0,
  `candidateCount` INT NOT NULL DEFAULT 0,
  `approvedPlanCount` INT NOT NULL DEFAULT 0,
  `openPositions` INT NOT NULL DEFAULT 0,
  `reconciliationStatus` VARCHAR(32) NOT NULL,
  `createOrderFunctionInvocations` INT NOT NULL DEFAULT 0,
  `createOrderAttemptCount` INT NOT NULL DEFAULT 0,
  `createOrderNetworkCount` INT NOT NULL DEFAULT 0,
  `notes` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `shadow_operation_time_idx` (`reportedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 10. shadow_daily_reports
-- ---------------------------------------------------------------------------
CREATE TABLE `shadow_daily_reports` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `reportDate` TIMESTAMP NOT NULL,
  `productsEvaluated` INT NOT NULL DEFAULT 0,
  `completeChains` INT NOT NULL DEFAULT 0,
  `rejectedChains` INT NOT NULL DEFAULT 0,
  `candidatesReversion` INT NOT NULL DEFAULT 0,
  `candidatesBreakout` INT NOT NULL DEFAULT 0,
  `candidatesMacro` INT NOT NULL DEFAULT 0,
  `approvedPlans` INT NOT NULL DEFAULT 0,
  `simulatedFills` INT NOT NULL DEFAULT 0,
  `partialFills` INT NOT NULL DEFAULT 0,
  `completedRoundTrips` INT NOT NULL DEFAULT 0,
  `grossPnl` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `feesPaid` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `modeledSpread` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `modeledSlippage` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `netPnl` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `forecastCostError` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `accountingDifference` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `unresolvedLineage` INT NOT NULL DEFAULT 0,
  `unprotectedExposure` INT NOT NULL DEFAULT 0,
  `missingAttribution` INT NOT NULL DEFAULT 0,
  `webSocketUptimePct` DECIMAL(6, 3) NOT NULL DEFAULT 0,
  `detectedGaps` INT NOT NULL DEFAULT 0,
  `createOrderFunctionInvocations` INT NOT NULL DEFAULT 0,
  `createOrderAttemptCount` INT NOT NULL DEFAULT 0,
  `createOrderNetworkCount` INT NOT NULL DEFAULT 0,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `shadow_daily_date_uq` (`reportDate`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 11. forward_outcome_labels — prospective outcome labels for accepted AND
--     rejected candidates. Independent from strategy execution.
-- ---------------------------------------------------------------------------
CREATE TABLE `forward_outcome_labels` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `mode` ENUM('reversion', 'breakout', 'macro') NOT NULL,
  `decisionOutcome` ENUM('accepted', 'rejected') NOT NULL,
  `decisionCompletedAt` TIMESTAMP(3) NOT NULL,
  `targetPrice` DECIMAL(20, 8) NOT NULL,
  `stopPrice` DECIMAL(20, 8) NOT NULL,
  `hypotheticalBase` DECIMAL(20, 8) NOT NULL,
  `entryReference` DECIMAL(20, 8) NOT NULL,
  `tpFirst` BOOLEAN NULL,
  `slFirst` BOOLEAN NULL,
  `timeout` BOOLEAN NULL,
  `ambiguous` BOOLEAN NULL,
  `maxFavorableExcursion` DECIMAL(20, 8) NULL,
  `maxAdverseExcursion` DECIMAL(20, 8) NULL,
  `timeToTpMs` INT NULL,
  `timeToSlMs` INT NULL,
  `grossHypotheticalResult` DECIMAL(20, 8) NULL,
  `netHypotheticalResult` DECIMAL(20, 8) NULL,
  `forecastCost` DECIMAL(20, 8) NULL,
  `realizedSimulatedCost` DECIMAL(20, 8) NULL,
  `labelStatus` ENUM('pending', 'labeled', 'ambiguous', 'timeout', 'error') NOT NULL DEFAULT 'pending',
  `firstEventAt` TIMESTAMP(3) NULL,
  `lastEventAt` TIMESTAMP(3) NULL,
  `labelerVersion` VARCHAR(32) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `forward_labels_chain_uq` (`decisionChainId`),
  KEY `forward_labels_status_idx` (`labelStatus`),
  KEY `forward_labels_product_idx` (`productId`, `decisionCompletedAt`),
  CONSTRAINT `forward_labels_chain_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
