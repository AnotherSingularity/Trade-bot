-- Phase 1.1 Gate 3D — integrated shadow execution + certification.
--
-- Additive DDL. Migrations 0000-0009 remain immutable.
--
-- Adds:
--   1. shadow_execution_plans — the immutable approved-preview-bound
--      execution plan the executor MUST consume without recomputation.
--   2. post_fill_revalidations — economic verdict after each entry fill.
--   3. shadow_certification_runs — the persisted certification record.

-- ---------------------------------------------------------------------------
-- 1. shadow_execution_plans
-- ---------------------------------------------------------------------------
CREATE TABLE `shadow_execution_plans` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `planVersion` INT NOT NULL DEFAULT 1,
  `decisionChainId` INT NOT NULL,
  `approvedPreviewId` INT NOT NULL,
  `quantitativeDecisionId` INT NULL,
  `costForecastId` INT NOT NULL,
  `protectionPolicyVersionId` INT NOT NULL,
  `protectionCapabilityId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `side` ENUM('BUY', 'SELL') NOT NULL,
  `orderType` VARCHAR(32) NOT NULL,
  `timeInForce` VARCHAR(16) NOT NULL,
  `exactBaseSize` DECIMAL(20, 8) NULL,
  `exactQuoteSize` DECIMAL(20, 8) NULL,
  `entryLimitPrice` DECIMAL(20, 8) NULL,
  `targetPrice` DECIMAL(20, 8) NOT NULL,
  `stopTriggerPrice` DECIMAL(20, 8) NOT NULL,
  `stopLimitPrice` DECIMAL(20, 8) NULL,
  `configurationHash` VARCHAR(64) NOT NULL,
  `feeTierSnapshotId` INT NOT NULL,
  `previewedAt` TIMESTAMP NOT NULL,
  `expiresAt` TIMESTAMP NOT NULL,
  `strategyVersion` VARCHAR(32) NOT NULL,
  `costModelVersion` VARCHAR(32) NOT NULL,
  `protectionPolicyVersion` VARCHAR(32) NOT NULL,
  `simulationMode` ENUM('STANDARD_DRY_RUN', 'SHADOW_LIVE') NOT NULL DEFAULT 'SHADOW_LIVE',
  `supersedesPlanId` INT NULL,
  `status` ENUM('approved', 'consumed', 'superseded', 'invalidated') NOT NULL DEFAULT 'approved',
  `invalidationReason` VARCHAR(255) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `shadow_plan_chain_version_uq` (`decisionChainId`, `planVersion`),
  KEY `shadow_plan_hash_idx` (`configurationHash`),
  KEY `shadow_plan_status_idx` (`status`),
  KEY `shadow_plan_product_idx` (`productId`),
  CONSTRAINT `shadow_plan_chain_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. post_fill_revalidations — economic verdict after each entry fill.
-- ---------------------------------------------------------------------------
CREATE TABLE `post_fill_revalidations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `executionPlanId` INT NOT NULL,
  `orderIntentId` INT NOT NULL,
  `positionId` INT NULL,
  `approvedEntryFillPrice` DECIMAL(20, 8) NOT NULL,
  `realizedEntryFillPrice` DECIMAL(20, 8) NOT NULL,
  `approvedEntryCommission` DECIMAL(20, 8) NOT NULL,
  `realizedEntryCommission` DECIMAL(20, 8) NOT NULL,
  `approvedEntryOutflow` DECIMAL(20, 8) NOT NULL,
  `realizedEntryOutflow` DECIMAL(20, 8) NOT NULL,
  `remainingTargetPayoff` DECIMAL(20, 8) NULL,
  `remainingStopLoss` DECIMAL(20, 8) NULL,
  `updatedCostToTargetPct` DECIMAL(10, 4) NULL,
  `updatedNetRewardRisk` DECIMAL(10, 4) NULL,
  `deviationBps` DECIMAL(10, 4) NOT NULL,
  `verdict` ENUM(
    'still_valid',
    'degraded_but_managed',
    'invalid_after_fill',
    'incomplete'
  ) NOT NULL,
  `reason` VARCHAR(255) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `post_fill_chain_idx` (`decisionChainId`),
  KEY `post_fill_plan_idx` (`executionPlanId`),
  KEY `post_fill_intent_idx` (`orderIntentId`),
  CONSTRAINT `post_fill_chain_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. shadow_certification_runs — one row per certification run.
-- ---------------------------------------------------------------------------
CREATE TABLE `shadow_certification_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `certificationRunId` VARCHAR(64) NOT NULL,
  `commitHash` VARCHAR(40) NULL,
  `migrationVersion` VARCHAR(64) NULL,
  `schemaFingerprint` VARCHAR(64) NULL,
  `simulationMode` VARCHAR(32) NOT NULL,
  `strategyVersion` VARCHAR(32) NULL,
  `costModelVersion` VARCHAR(32) NULL,
  `protectionPolicyVersion` VARCHAR(32) NULL,
  `lineageVersion` VARCHAR(32) NULL,
  `startedAt` TIMESTAMP NOT NULL,
  `completedAt` TIMESTAMP NULL,
  `fixtureCount` INT NOT NULL DEFAULT 0,
  `passedFixtures` INT NOT NULL DEFAULT 0,
  `failedFixtures` INT NOT NULL DEFAULT 0,
  `accountingDifference` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `unresolvedIntents` INT NOT NULL DEFAULT 0,
  `unprotectedPositions` INT NOT NULL DEFAULT 0,
  `incompleteAttributions` INT NOT NULL DEFAULT 0,
  `lineageFailures` INT NOT NULL DEFAULT 0,
  `createOrderAttemptCount` INT NOT NULL DEFAULT 0,
  `createOrderNetworkCount` INT NOT NULL DEFAULT 0,
  `safeFlagsSnapshot` TEXT NULL,
  `knownLimitations` TEXT NULL,
  `verdict` ENUM('not_ready', 'degraded', 'mechanically_ready_for_shadow')
    NOT NULL DEFAULT 'not_ready',
  `fixtureResults` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `shadow_cert_run_uq` (`certificationRunId`),
  KEY `shadow_cert_verdict_idx` (`verdict`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
