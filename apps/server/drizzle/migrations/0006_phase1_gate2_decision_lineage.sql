-- Phase 1.1 Gate 2 — canonical decision-to-outcome lineage.
--
-- All additive DDL. No existing migration is modified. Existing rows in
-- signal_candidates / execution_cost_forecasts / quantitative_decisions /
-- order_intents / positions / round_trips / cash_ledger are preserved
-- with lineage columns NULL until legacy backfill or the next chain
-- creation populates them.

-- ---------------------------------------------------------------------------
-- §A — scan_runs
-- ---------------------------------------------------------------------------
CREATE TABLE `scan_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `triggerType` VARCHAR(64) NOT NULL,
  `startedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completedAt` TIMESTAMP NULL,
  `status` ENUM('started', 'completed', 'partially_completed', 'blocked', 'failed') NOT NULL DEFAULT 'started',
  `botState` VARCHAR(32),
  `reconciliationStatus` VARCHAR(32),
  `marketWindowState` VARCHAR(32),
  `scannerVersion` VARCHAR(32) NOT NULL,
  `failureReason` VARCHAR(255),
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `scan_runs_started_idx` (`startedAt`),
  KEY `scan_runs_status_idx` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §B — decision_chains (the permanent root)
-- ---------------------------------------------------------------------------
CREATE TABLE `decision_chains` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `scanRunId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `strategyVersion` VARCHAR(32) NOT NULL,
  `currentStatus` ENUM(
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
    'failed'
  ) NOT NULL DEFAULT 'observed',
  `observedAt` TIMESTAMP NOT NULL,
  `dataAvailableAt` TIMESTAMP NOT NULL,
  `decisionStartedAt` TIMESTAMP NOT NULL,
  `decisionCompletedAt` TIMESTAMP NULL,
  `lineageCompleteness` ENUM('complete', 'partial', 'broken', 'legacy_unresolved') NOT NULL DEFAULT 'partial',
  `legacyStatus` ENUM('current', 'legacy_backfilled', 'legacy_unresolved') NOT NULL DEFAULT 'current',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `decision_chains_scan_idx` (`scanRunId`),
  KEY `decision_chains_product_idx` (`productId`, `observedAt`),
  KEY `decision_chains_status_idx` (`currentStatus`),
  CONSTRAINT `decision_chains_scanRunId_fk` FOREIGN KEY (`scanRunId`) REFERENCES `scan_runs`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §C.1 — market_observations
-- ---------------------------------------------------------------------------
CREATE TABLE `market_observations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `observedAt` TIMESTAMP NOT NULL,
  `dataAvailableAt` TIMESTAMP NOT NULL,
  `marketDataVersion` VARCHAR(32) NOT NULL,
  `inputDataHash` VARCHAR(64) NOT NULL,
  `price` DECIMAL(20, 8),
  `volume24h` DECIMAL(20, 8),
  `spread` DECIMAL(20, 8),
  `dataQualityStatus` ENUM('valid', 'stale', 'incomplete', 'invalid', 'unavailable') NOT NULL,
  `failureReason` VARCHAR(255),
  `immutablePayload` TEXT NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `market_observations_chain_idx` (`decisionChainId`),
  KEY `market_observations_hash_idx` (`inputDataHash`),
  CONSTRAINT `market_observations_decisionChainId_fk` FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §C.2 — eligibility_decisions
-- ---------------------------------------------------------------------------
CREATE TABLE `eligibility_decisions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `marketObservationId` INT NULL,
  `eligible` BOOLEAN NOT NULL,
  `reasonCode` ENUM(
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
    'circuit_breaker'
  ) NOT NULL,
  `reasonDetail` VARCHAR(255),
  `policyVersion` VARCHAR(32) NOT NULL,
  `decidedAt` TIMESTAMP NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `eligibility_decisions_chain_idx` (`decisionChainId`),
  CONSTRAINT `eligibility_decisions_decisionChainId_fk` FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `eligibility_decisions_marketObservationId_fk` FOREIGN KEY (`marketObservationId`) REFERENCES `market_observations`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §C.3 — setup_evaluations
-- ---------------------------------------------------------------------------
CREATE TABLE `setup_evaluations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `marketObservationId` INT NOT NULL,
  `modeEvaluated` VARCHAR(32),
  `setupDetected` BOOLEAN NOT NULL,
  `setupScore` DECIMAL(10, 6),
  `strategyVersion` VARCHAR(32) NOT NULL,
  `indicatorVersion` VARCHAR(32) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `reasonCodes` TEXT NOT NULL,
  `evaluatedAt` TIMESTAMP NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `setup_evaluations_chain_idx` (`decisionChainId`),
  CONSTRAINT `setup_evaluations_decisionChainId_fk` FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `setup_evaluations_marketObservationId_fk` FOREIGN KEY (`marketObservationId`) REFERENCES `market_observations`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §C.4 — strategy_routing_decisions
-- ---------------------------------------------------------------------------
CREATE TABLE `strategy_routing_decisions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `setupEvaluationId` INT NOT NULL,
  `selectedMode` VARCHAR(32),
  `routingOutcome` ENUM('reversion', 'breakout', 'macro_floor', 'no_trade', 'conflict', 'unclassified') NOT NULL,
  `reasonCodes` TEXT NOT NULL,
  `strategyVersion` VARCHAR(32) NOT NULL,
  `decidedAt` TIMESTAMP NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `strategy_routing_decisions_chain_idx` (`decisionChainId`),
  CONSTRAINT `strategy_routing_decisions_decisionChainId_fk` FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `strategy_routing_decisions_setupEvaluationId_fk` FOREIGN KEY (`setupEvaluationId`) REFERENCES `setup_evaluations`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §C.5 — outcome_labels
--
-- Version-bumped; UNIQUE(decisionChainId, labelVersion) enforces
-- "corrections create a new version, never overwrite."
-- ---------------------------------------------------------------------------
CREATE TABLE `outcome_labels` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `roundTripId` INT NULL,
  `labelVersion` INT NOT NULL,
  `labelType` VARCHAR(64) NOT NULL,
  `tpReachedFirst` BOOLEAN,
  `slReachedFirst` BOOLEAN,
  `timeout` BOOLEAN NOT NULL DEFAULT FALSE,
  `ambiguous` BOOLEAN NOT NULL DEFAULT FALSE,
  `maximumFavorableExcursion` DECIMAL(20, 8),
  `maximumAdverseExcursion` DECIMAL(20, 8),
  `timeToTp` INT,
  `timeToSl` INT,
  `grossPnl` DECIMAL(20, 8),
  `netPnl` DECIMAL(20, 8),
  `totalFees` DECIMAL(20, 8),
  `forecastCost` DECIMAL(20, 8),
  `realizedCost` DECIMAL(20, 8),
  `labelWindowStart` TIMESTAMP NOT NULL,
  `labelWindowEnd` TIMESTAMP NOT NULL,
  `dataAvailableAt` TIMESTAMP NOT NULL,
  `supersedesOutcomeLabelId` INT NULL,
  `correctionReason` VARCHAR(255),
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `outcome_labels_chain_version_uq` (`decisionChainId`, `labelVersion`),
  KEY `outcome_labels_chain_idx` (`decisionChainId`),
  KEY `outcome_labels_roundtrip_idx` (`roundTripId`),
  CONSTRAINT `outcome_labels_decisionChainId_fk` FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §C.6 — lineage_events (append-only journal)
-- ---------------------------------------------------------------------------
CREATE TABLE `lineage_events` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `eventType` VARCHAR(64) NOT NULL,
  `sourceEntityType` VARCHAR(64) NOT NULL,
  `sourceRecordId` INT,
  `eventTime` TIMESTAMP NOT NULL,
  `dataAvailableAt` TIMESTAMP,
  `actor` VARCHAR(64) NOT NULL,
  `componentVersion` VARCHAR(32) NOT NULL,
  `metadata` TEXT,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `lineage_events_chain_idx` (`decisionChainId`, `eventTime`),
  KEY `lineage_events_type_idx` (`eventType`),
  CONSTRAINT `lineage_events_decisionChainId_fk` FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §D — direct lineage on authorization records (all nullable for legacy rows)
-- ---------------------------------------------------------------------------
ALTER TABLE `signal_candidates`
  ADD COLUMN `decisionChainId` INT NULL,
  ADD COLUMN `marketObservationId` INT NULL,
  ADD COLUMN `setupEvaluationId` INT NULL,
  ADD COLUMN `routingDecisionId` INT NULL,
  ADD KEY `signal_candidates_chain_idx` (`decisionChainId`);
--> statement-breakpoint

ALTER TABLE `execution_cost_forecasts`
  ADD COLUMN `decisionChainId` INT NULL,
  ADD COLUMN `routingDecisionId` INT NULL,
  ADD KEY `execution_cost_forecasts_chain_idx` (`decisionChainId`);
--> statement-breakpoint

ALTER TABLE `quantitative_decisions`
  ADD COLUMN `decisionChainId` INT NULL,
  ADD KEY `quantitative_decisions_chain_idx` (`decisionChainId`);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §D — order_intents lineage columns (nullable for legacy rows)
--
-- Note: order_intents already carries `decisionId`, `costForecastId`,
-- `previewId`, `configHash` from Phase 1.1.b §G. We add `decisionChainId`
-- plus a `strategyVersion` + `costModelVersion` pair so an intent can be
-- audited without joining sibling tables.
-- ---------------------------------------------------------------------------
ALTER TABLE `order_intents`
  ADD COLUMN `decisionChainId` INT NULL,
  ADD COLUMN `entryDecisionChainId` INT NULL,
  ADD COLUMN `strategyVersionAt` VARCHAR(32),
  ADD COLUMN `costModelVersionAt` VARCHAR(32),
  ADD COLUMN `protectionGeneration` INT NULL,
  ADD KEY `order_intents_decision_chain_idx` (`decisionChainId`),
  ADD KEY `order_intents_entry_chain_idx` (`entryDecisionChainId`);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §E — position lineage
-- ---------------------------------------------------------------------------
ALTER TABLE `positions`
  ADD COLUMN `entryDecisionChainId` INT NULL,
  ADD KEY `positions_entry_chain_idx` (`entryDecisionChainId`);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §E — round_trips lineage (final entry + final exit references only;
-- multiple exit intents accessed transitively via positionId join).
-- ---------------------------------------------------------------------------
ALTER TABLE `round_trips`
  ADD COLUMN `entryDecisionChainId` INT NULL,
  ADD COLUMN `finalExitDecisionChainId` INT NULL,
  ADD COLUMN `entryOrderIntentId` INT NULL,
  ADD COLUMN `finalExitOrderIntentId` INT NULL,
  ADD KEY `round_trips_entry_chain_idx` (`entryDecisionChainId`),
  ADD KEY `round_trips_final_exit_chain_idx` (`finalExitDecisionChainId`);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §E — cash_ledger cause attribution
--
-- Every ledger event must have exactly one valid cause category. We keep
-- the existing columns (idempotencyKey, orderIntentId, fillId are pre-existing)
-- and add the categorical + attribution fields as nullable so legacy rows
-- remain valid; new rows should populate them.
-- ---------------------------------------------------------------------------
ALTER TABLE `cash_ledger`
  ADD COLUMN `decisionChainId` INT NULL,
  ADD COLUMN `adjustmentType` VARCHAR(32),
  ADD COLUMN `adjustmentReason` VARCHAR(255),
  ADD COLUMN `actor` VARCHAR(64),
  ADD COLUMN `reconciliationRunId` VARCHAR(64),
  ADD COLUMN `causeCategory` ENUM('fill_driven', 'explicit_adjustment', 'initial_funding') NULL,
  ADD KEY `cash_ledger_decision_chain_idx` (`decisionChainId`),
  ADD KEY `cash_ledger_cause_idx` (`causeCategory`);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §F — reconciliation_actions extension for lineage
-- ---------------------------------------------------------------------------
ALTER TABLE `reconciliation_actions`
  ADD COLUMN `decisionChainId` INT NULL,
  ADD COLUMN `economicStateApplied` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN `fillsDiscovered` INT NULL,
  ADD KEY `reconciliation_actions_chain_idx` (`decisionChainId`);
