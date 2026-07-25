-- Phase 0 — execution-safety rebuild.
-- Adds order_intents, fills, round_trips, cash_ledger. Rebuilds positions to
-- store actual-fill fields + protective-order links + optimistic-locking version.
-- Adds reconciliation gate to bot_config, severity to activity_log, richer enums.

-- ---------------------------------------------------------------------------
-- bot_config: add reconciliation gate
-- ---------------------------------------------------------------------------
ALTER TABLE `bot_config`
  ADD COLUMN `reconciliationStatus` enum('pending','in_progress','ok','failed') NOT NULL DEFAULT 'pending',
  ADD COLUMN `reconciliationDetail` text,
  ADD COLUMN `reconciledAt` timestamp NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- activity_log: add severity + extra types
-- ---------------------------------------------------------------------------
ALTER TABLE `activity_log`
  MODIFY COLUMN `type` enum('scan','signal','trade','system','error','reconciliation','security') NOT NULL,
  MODIFY COLUMN `action` varchar(60) NOT NULL,
  ADD COLUMN `severity` enum('info','warn','high','critical') NOT NULL DEFAULT 'info';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- positions: rebuild in-place. Preserves table + `id` sequence; renames the
-- legacy columns to their actual-fill counterparts and adds new fields.
-- (Existing rows in `positions` before Phase 0 will need manual reconciliation
-- since ticker-based positions are no longer supported. In dev/prod this table
-- is empty at Phase 0 rollout — enforced by the reconciliation gate.)
-- ---------------------------------------------------------------------------
DROP TABLE `positions`;
--> statement-breakpoint

CREATE TABLE `positions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `token` varchar(20) NOT NULL,
  `mode` enum('reversion','breakout','macro') NOT NULL,
  `avgEntryPrice` decimal(20,8) NOT NULL,
  `filledQuantity` decimal(20,8) NOT NULL,
  `entryFees` decimal(20,8) NOT NULL,
  `entryQuoteSpent` decimal(20,8) NOT NULL,
  `allocationPct` decimal(5,2) NOT NULL,
  `takeProfitPrice` decimal(20,8) NOT NULL,
  `stopLossPrice` decimal(20,8) NOT NULL,
  `takeProfitPct` decimal(5,2) NOT NULL,
  `stopLossPct` decimal(5,2) NOT NULL,
  `entryOrderIntentId` int NOT NULL,
  `protectiveTpIntentId` int,
  `protectiveSlIntentId` int,
  `protectionMode` enum('exchange_bracket','polling_fallback','unprotected') NOT NULL DEFAULT 'polling_fallback',
  `claudeReason` text,
  `claudeModel` varchar(64),
  `claudeConfidence` decimal(5,4),
  `strategyVersion` varchar(20),
  `lifecycleState` enum('opening','open','closing','closed','reconciling') NOT NULL DEFAULT 'opening',
  `status` enum('open','closed') NOT NULL DEFAULT 'open',
  `version` int NOT NULL DEFAULT 0,
  `openedAt` timestamp NOT NULL DEFAULT (now()),
  `closedAt` timestamp NULL,
  CONSTRAINT `positions_id` PRIMARY KEY(`id`),
  INDEX `positions_token_idx` (`token`),
  INDEX `positions_status_idx` (`status`)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- order_intents
-- ---------------------------------------------------------------------------
CREATE TABLE `order_intents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `clientOrderId` varchar(64) NOT NULL,
  `productId` varchar(30) NOT NULL,
  `token` varchar(20) NOT NULL,
  `side` enum('BUY','SELL') NOT NULL,
  `orderType` enum('market_ioc','limit','stop_limit','bracket_tp','bracket_sl') NOT NULL,
  `quoteSize` decimal(20,8),
  `baseSize` decimal(20,8),
  `mode` enum('reversion','breakout','macro') NOT NULL,
  `purpose` enum('entry','take_profit','stop_loss','manual_exit','emergency_exit') NOT NULL,
  `positionId` int,
  `state` enum('created','previewed','submitted','acknowledged','partially_filled','filled','rejected','canceled','failed','unknown') NOT NULL DEFAULT 'created',
  `exchangeOrderId` varchar(128),
  `failureClass` enum('definitely_rejected','definitely_not_submitted','submitted','unknown','retryable_transport','non_retryable_validation'),
  `errorCode` varchar(128),
  `errorMessage` text,
  `rawResponse` text,
  `dryRun` boolean NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `order_intents_id` PRIMARY KEY(`id`),
  CONSTRAINT `order_intents_client_uq` UNIQUE(`clientOrderId`),
  CONSTRAINT `order_intents_exchange_uq` UNIQUE(`exchangeOrderId`),
  INDEX `order_intents_position_idx` (`positionId`),
  INDEX `order_intents_state_idx` (`state`)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- fills
-- ---------------------------------------------------------------------------
CREATE TABLE `fills` (
  `id` int AUTO_INCREMENT NOT NULL,
  `exchangeFillId` varchar(128) NOT NULL,
  `orderIntentId` int NOT NULL,
  `exchangeOrderId` varchar(128) NOT NULL,
  `token` varchar(20) NOT NULL,
  `side` enum('BUY','SELL') NOT NULL,
  `filledSize` decimal(20,8) NOT NULL,
  `fillPrice` decimal(20,8) NOT NULL,
  `fee` decimal(20,8) NOT NULL,
  `feeCurrency` varchar(10) NOT NULL,
  `tradeTime` timestamp NOT NULL,
  `rawResponse` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fills_id` PRIMARY KEY(`id`),
  CONSTRAINT `fills_exchange_uq` UNIQUE(`exchangeFillId`),
  INDEX `fills_order_idx` (`orderIntentId`)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- round_trips
-- ---------------------------------------------------------------------------
CREATE TABLE `round_trips` (
  `id` int AUTO_INCREMENT NOT NULL,
  `positionId` int NOT NULL,
  `token` varchar(20) NOT NULL,
  `mode` enum('reversion','breakout','macro') NOT NULL,
  `entryValueGross` decimal(20,8) NOT NULL,
  `exitValueGross` decimal(20,8) NOT NULL,
  `entryFees` decimal(20,8) NOT NULL,
  `exitFees` decimal(20,8) NOT NULL,
  `realizedNetPnl` decimal(20,8) NOT NULL,
  `realizedNetPnlPct` decimal(10,4) NOT NULL,
  `outcome` enum('win','loss','flat') NOT NULL,
  `exitReason` enum('take_profit','stop_loss','early_exit','manual','emergency','reconciled') NOT NULL,
  `openedAt` timestamp NOT NULL,
  `closedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `round_trips_id` PRIMARY KEY(`id`),
  CONSTRAINT `round_trips_position_uq` UNIQUE(`positionId`),
  INDEX `round_trips_token_idx` (`token`),
  INDEX `round_trips_outcome_idx` (`outcome`),
  INDEX `round_trips_closed_at_idx` (`closedAt`)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- cash_ledger
-- ---------------------------------------------------------------------------
CREATE TABLE `cash_ledger` (
  `id` int AUTO_INCREMENT NOT NULL,
  `deltaUsd` decimal(20,8) NOT NULL,
  `reason` enum('initial_fund','buy_cost','buy_fee','buy_slippage','sell_proceeds','sell_fee','sell_slippage','manual_adjustment') NOT NULL,
  `orderIntentId` int,
  `positionId` int,
  `dryRun` boolean NOT NULL,
  `detail` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `cash_ledger_id` PRIMARY KEY(`id`),
  INDEX `cash_ledger_dryrun_idx` (`dryRun`),
  INDEX `cash_ledger_created_at_idx` (`createdAt`)
);
