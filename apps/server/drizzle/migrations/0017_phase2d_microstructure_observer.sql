-- Phase 2D — top-N microstructure and execution-quality observer.
--
-- Additive DDL. Migrations 0000-0016 remain immutable. This migration adds:
--   1.  microstructure_shortlist_policies
--   2.  microstructure_shortlist_runs
--   3.  microstructure_shortlist_memberships
--   4.  order_book_sessions
--   5.  order_book_events
--   6.  order_book_gaps
--   7.  order_book_snapshots
--   8.  order_book_levels
--   9.  microstructure_feature_definitions
--   10. microstructure_feature_values
--   11. trade_flow_windows
--   12. execution_cost_observer_snapshots
--   13. market_impact_curves
--   14. passive_fill_estimates
--   15. microstructure_execution_decisions
--   16. champion_microstructure_comparisons

-- ---------------------------------------------------------------------------
-- 1. microstructure_shortlist_policies
-- ---------------------------------------------------------------------------
CREATE TABLE `microstructure_shortlist_policies` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `policyKey` VARCHAR(64) NOT NULL,
  `policyVersion` VARCHAR(32) NOT NULL,
  `description` TEXT NOT NULL,
  `maxProducts` INT NOT NULL,
  `selectionCriteria` TEXT NOT NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `status` ENUM('draft','observer','deprecated','disabled') NOT NULL DEFAULT 'observer',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ms_shortlist_policy_uq` (`policyKey`,`policyVersion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. microstructure_shortlist_runs
-- ---------------------------------------------------------------------------
CREATE TABLE `microstructure_shortlist_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `policyVersionId` INT NOT NULL,
  `startedAt` TIMESTAMP(3) NOT NULL,
  `completedAt` TIMESTAMP(3) NULL,
  `productsConsidered` INT NOT NULL DEFAULT 0,
  `productsSelected` INT NOT NULL DEFAULT 0,
  `notes` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ms_shortlist_run_policy_idx` (`policyVersionId`,`startedAt`),
  CONSTRAINT `ms_shortlist_run_policy_fk`
    FOREIGN KEY (`policyVersionId`) REFERENCES `microstructure_shortlist_policies`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. microstructure_shortlist_memberships
-- ---------------------------------------------------------------------------
CREATE TABLE `microstructure_shortlist_memberships` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `runId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `selected` BOOLEAN NOT NULL DEFAULT FALSE,
  `rank` INT NULL,
  `selectionScore` DECIMAL(20,10) NULL,
  `reasonCodes` VARCHAR(255) NOT NULL,
  `policyVersion` VARCHAR(32) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ms_shortlist_mem_uq` (`runId`,`productId`),
  KEY `ms_shortlist_mem_sel_idx` (`selected`),
  CONSTRAINT `ms_shortlist_mem_run_fk`
    FOREIGN KEY (`runId`) REFERENCES `microstructure_shortlist_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. order_book_sessions
-- ---------------------------------------------------------------------------
CREATE TABLE `order_book_sessions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `productId` VARCHAR(30) NOT NULL,
  `providerId` VARCHAR(64) NOT NULL,
  `providerVersion` VARCHAR(32) NOT NULL,
  `startedAt` TIMESTAMP(3) NOT NULL,
  `endedAt` TIMESTAMP(3) NULL,
  `initialSnapshotId` INT NULL,
  `latestSnapshotId` INT NULL,
  `state` ENUM('empty','synchronizing','healthy','gap_detected','stale','inconsistent','resync_required','failed') NOT NULL DEFAULT 'empty',
  `sequenceNext` BIGINT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ob_sess_prod_idx` (`productId`,`startedAt`),
  KEY `ob_sess_state_idx` (`state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. order_book_events
-- ---------------------------------------------------------------------------
CREATE TABLE `order_book_events` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `sessionId` INT NOT NULL,
  `sequence` BIGINT NOT NULL,
  `eventType` ENUM('snapshot','delta','trade','heartbeat','gap') NOT NULL,
  `side` ENUM('bid','ask','trade','none') NOT NULL DEFAULT 'none',
  `price` DECIMAL(30,10) NULL,
  `size` DECIMAL(30,10) NULL,
  `aggregatedLevelCount` INT NULL,
  `payloadHash` VARCHAR(64) NOT NULL,
  `sourceTimestamp` TIMESTAMP(3) NOT NULL,
  `receivedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ob_evt_sess_seq_uq` (`sessionId`,`sequence`,`eventType`,`payloadHash`),
  KEY `ob_evt_sess_time_idx` (`sessionId`,`sourceTimestamp`),
  CONSTRAINT `ob_evt_sess_fk`
    FOREIGN KEY (`sessionId`) REFERENCES `order_book_sessions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. order_book_gaps
-- ---------------------------------------------------------------------------
CREATE TABLE `order_book_gaps` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `sessionId` INT NOT NULL,
  `expectedSequence` BIGINT NOT NULL,
  `observedSequence` BIGINT NOT NULL,
  `missingCount` INT NOT NULL,
  `detectedAt` TIMESTAMP(3) NOT NULL,
  `resolvedAt` TIMESTAMP(3) NULL,
  `resolution` ENUM('resynchronized','abandoned','pending') NOT NULL DEFAULT 'pending',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ob_gap_sess_idx` (`sessionId`,`detectedAt`),
  CONSTRAINT `ob_gap_sess_fk`
    FOREIGN KEY (`sessionId`) REFERENCES `order_book_sessions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. order_book_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE `order_book_snapshots` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `sessionId` INT NOT NULL,
  `sequence` BIGINT NOT NULL,
  `bestBid` DECIMAL(30,10) NULL,
  `bestAsk` DECIMAL(30,10) NULL,
  `midprice` DECIMAL(30,10) NULL,
  `quotedSpread` DECIMAL(30,10) NULL,
  `spreadBps` DECIMAL(20,6) NULL,
  `bidLevels` INT NOT NULL DEFAULT 0,
  `askLevels` INT NOT NULL DEFAULT 0,
  `bidDepthQuote` DECIMAL(30,10) NOT NULL DEFAULT 0,
  `askDepthQuote` DECIMAL(30,10) NOT NULL DEFAULT 0,
  `bookHealth` ENUM('healthy','degraded','stale','gap_detected','inconsistent','unknown') NOT NULL DEFAULT 'unknown',
  `staleAgeMs` INT NULL,
  `payloadHash` VARCHAR(64) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ob_snap_sess_seq_uq` (`sessionId`,`sequence`),
  KEY `ob_snap_health_idx` (`bookHealth`),
  CONSTRAINT `ob_snap_sess_fk`
    FOREIGN KEY (`sessionId`) REFERENCES `order_book_sessions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. order_book_levels
-- ---------------------------------------------------------------------------
CREATE TABLE `order_book_levels` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `snapshotId` INT NOT NULL,
  `side` ENUM('bid','ask') NOT NULL,
  `levelIndex` INT NOT NULL,
  `price` DECIMAL(30,10) NOT NULL,
  `size` DECIMAL(30,10) NOT NULL,
  `cumulativeSize` DECIMAL(30,10) NOT NULL,
  `cumulativeQuote` DECIMAL(30,10) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ob_lvl_snap_side_idx_uq` (`snapshotId`,`side`,`levelIndex`),
  CONSTRAINT `ob_lvl_snap_fk`
    FOREIGN KEY (`snapshotId`) REFERENCES `order_book_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. microstructure_feature_definitions
-- ---------------------------------------------------------------------------
CREATE TABLE `microstructure_feature_definitions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `featureKey` VARCHAR(64) NOT NULL,
  `featureVersion` VARCHAR(32) NOT NULL,
  `family` ENUM('price','depth','flow','quality') NOT NULL,
  `description` TEXT NOT NULL,
  `unit` VARCHAR(32) NOT NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `status` ENUM('draft','observer','deprecated','disabled') NOT NULL DEFAULT 'observer',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ms_feat_key_ver_uq` (`featureKey`,`featureVersion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 10. microstructure_feature_values
-- ---------------------------------------------------------------------------
CREATE TABLE `microstructure_feature_values` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `snapshotId` INT NOT NULL,
  `featureKey` VARCHAR(64) NOT NULL,
  `featureVersion` VARCHAR(32) NOT NULL,
  `status` ENUM('valid','low_confidence','insufficient_history','stale','gap_detected','invalid_input','numerical_failure','unsupported') NOT NULL,
  `value` DECIMAL(30,12) NULL,
  `confidence` DECIMAL(6,4) NULL,
  `sampleCount` INT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `failureReason` VARCHAR(255) NULL,
  `diagnostics` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ms_feat_val_uq` (`snapshotId`,`featureKey`,`featureVersion`),
  KEY `ms_feat_val_status_idx` (`featureKey`,`status`),
  CONSTRAINT `ms_feat_val_snap_fk`
    FOREIGN KEY (`snapshotId`) REFERENCES `order_book_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 11. trade_flow_windows
-- ---------------------------------------------------------------------------
CREATE TABLE `trade_flow_windows` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `sessionId` INT NOT NULL,
  `windowStart` TIMESTAMP(3) NOT NULL,
  `windowEnd` TIMESTAMP(3) NOT NULL,
  `buyerVolume` DECIMAL(30,10) NOT NULL DEFAULT 0,
  `sellerVolume` DECIMAL(30,10) NOT NULL DEFAULT 0,
  `unknownVolume` DECIMAL(30,10) NOT NULL DEFAULT 0,
  `cvd` DECIMAL(30,10) NOT NULL DEFAULT 0,
  `imbalance` DECIMAL(10,6) NULL,
  `classifierVersion` VARCHAR(32) NOT NULL,
  `windowPolicyVersion` VARCHAR(32) NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `flow_win_sess_idx` (`sessionId`,`windowStart`),
  CONSTRAINT `flow_win_sess_fk`
    FOREIGN KEY (`sessionId`) REFERENCES `order_book_sessions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 12. execution_cost_observer_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE `execution_cost_observer_snapshots` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `bookSnapshotId` INT NOT NULL,
  `entryNotional` DECIMAL(30,10) NOT NULL,
  `marketableVWAP` DECIMAL(30,10) NULL,
  `passiveLimitPrice` DECIMAL(30,10) NULL,
  `estimatedSpreadCost` DECIMAL(30,10) NULL,
  `estimatedImpact` DECIMAL(30,10) NULL,
  `estimatedLatencyCost` DECIMAL(30,10) NULL,
  `estimatedFee` DECIMAL(30,10) NULL,
  `estimatedFillProbability` DECIMAL(6,4) NULL,
  `estimatedUnfilledProbability` DECIMAL(6,4) NULL,
  `estimatedPartialFillProbability` DECIMAL(6,4) NULL,
  `estimatedQueueUncertainty` DECIMAL(6,4) NULL,
  `estimatedStopExecutionCost` DECIMAL(30,10) NULL,
  `isBookAware` BOOLEAN NOT NULL DEFAULT TRUE,
  `modelVersion` VARCHAR(32) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `exec_cost_snap_idx` (`bookSnapshotId`),
  CONSTRAINT `exec_cost_snap_fk`
    FOREIGN KEY (`bookSnapshotId`) REFERENCES `order_book_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 13. market_impact_curves
-- ---------------------------------------------------------------------------
CREATE TABLE `market_impact_curves` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `bookSnapshotId` INT NOT NULL,
  `side` ENUM('buy','sell') NOT NULL,
  `notional` DECIMAL(30,10) NOT NULL,
  `filledNotional` DECIMAL(30,10) NOT NULL,
  `unfilledNotional` DECIMAL(30,10) NOT NULL,
  `avgFillPrice` DECIMAL(30,10) NULL,
  `impactBps` DECIMAL(20,6) NULL,
  `extrapolated` BOOLEAN NOT NULL DEFAULT FALSE,
  `monotonic` BOOLEAN NOT NULL DEFAULT TRUE,
  `modelVersion` VARCHAR(32) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `impact_snap_idx` (`bookSnapshotId`,`side`,`notional`),
  CONSTRAINT `impact_snap_fk`
    FOREIGN KEY (`bookSnapshotId`) REFERENCES `order_book_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 14. passive_fill_estimates
-- ---------------------------------------------------------------------------
CREATE TABLE `passive_fill_estimates` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `bookSnapshotId` INT NOT NULL,
  `side` ENUM('buy','sell') NOT NULL,
  `limitPrice` DECIMAL(30,10) NOT NULL,
  `visibleSizeAhead` DECIMAL(30,10) NULL,
  `state` ENUM('unlikely','low_confidence','possible','probable','unknown') NOT NULL,
  `confidence` DECIMAL(6,4) NOT NULL DEFAULT 0,
  `modelVersion` VARCHAR(32) NOT NULL,
  `diagnostics` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `pass_fill_snap_idx` (`bookSnapshotId`),
  CONSTRAINT `pass_fill_snap_fk`
    FOREIGN KEY (`bookSnapshotId`) REFERENCES `order_book_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 15. microstructure_execution_decisions
-- ---------------------------------------------------------------------------
CREATE TABLE `microstructure_execution_decisions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `shortlistMembershipId` INT NULL,
  `bookSnapshotId` INT NULL,
  `policyVersion` VARCHAR(32) NOT NULL,
  `championOrderType` VARCHAR(32) NULL,
  `championSize` DECIMAL(30,10) NOT NULL,
  `recommendedAction` ENUM('proceed_as_planned','prefer_marketable','prefer_passive','reduce_size','delay','reject','abstain','data_failure') NOT NULL,
  `recommendedMaximumSize` DECIMAL(30,10) NOT NULL,
  `sizeMultiplier` DECIMAL(10,8) NOT NULL,
  `preferredOrderStyle` VARCHAR(32) NULL,
  `preferredPriceBand` VARCHAR(64) NULL,
  `expiryRecommendation` VARCHAR(64) NULL,
  `fillConfidence` DECIMAL(6,4) NULL,
  `impactEstimateBps` DECIMAL(20,6) NULL,
  `reasonCodes` VARCHAR(255) NOT NULL,
  `dataQualityState` VARCHAR(64) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ms_exec_chain_uq` (`decisionChainId`),
  KEY `ms_exec_action_idx` (`recommendedAction`),
  CONSTRAINT `ms_exec_chain_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `ms_exec_snap_fk`
    FOREIGN KEY (`bookSnapshotId`) REFERENCES `order_book_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 16. champion_microstructure_comparisons
-- ---------------------------------------------------------------------------
CREATE TABLE `champion_microstructure_comparisons` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `msExecutionDecisionId` INT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `championOrderType` VARCHAR(32) NULL,
  `championSize` DECIMAL(30,10) NOT NULL,
  `msRecommendation` ENUM('proceed_as_planned','prefer_marketable','prefer_passive','reduce_size','delay','reject','abstain','data_failure') NOT NULL,
  `msRecommendedSize` DECIMAL(30,10) NOT NULL,
  `agreementState` ENUM('agree','ms_prefers_style','ms_reduced','ms_delayed','ms_rejected','ms_abstained','unresolved') NOT NULL,
  `reasonCodes` VARCHAR(255) NOT NULL,
  `policyVersion` VARCHAR(32) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `champ_ms_chain_uq` (`decisionChainId`),
  KEY `champ_ms_agreement_idx` (`agreementState`),
  CONSTRAINT `champ_ms_chain_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `champ_ms_dec_fk`
    FOREIGN KEY (`msExecutionDecisionId`) REFERENCES `microstructure_execution_decisions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
