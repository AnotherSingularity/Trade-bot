-- Phase 1.1 Gate 3C — protection capability, validation, and degradation.
--
-- Additive DDL. Migrations 0000-0008 remain immutable.
--
-- Adds:
--   1. protection_policy_versions — versioned protection policies.
--   2. protection_capabilities — per-product/config capability determinations
--      (unknown → documented_unverified → preview_supported → shadow_validated
--      → sandbox_validated → live_canary_validated). Immutable rows.
--   3. protection_validation_runs — evidence trail for each capability.
--   4. protection_instances — one row per position representing the exact
--      exposure that must be protected. State machine.
--   5. protection_events — append-only leg-state and instance transitions.

-- ---------------------------------------------------------------------------
-- 1. protection_policy_versions
-- ---------------------------------------------------------------------------
CREATE TABLE `protection_policy_versions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `version` VARCHAR(32) NOT NULL,
  `status` ENUM('draft', 'active', 'superseded', 'retired') NOT NULL DEFAULT 'draft',
  `description` TEXT,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `activatedAt` TIMESTAMP NULL,
  `supersedesPolicyId` INT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `protection_policy_version_uq` (`version`),
  KEY `protection_policy_status_idx` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. protection_capabilities — immutable per-(policy, product, config) row.
-- ---------------------------------------------------------------------------
CREATE TABLE `protection_capabilities` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `policyVersionId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `side` ENUM('BUY', 'SELL') NOT NULL,
  `entryOrderType` VARCHAR(32) NOT NULL,
  `timeInForce` VARCHAR(16) NOT NULL,
  `protectionType` ENUM(
    'attached_trigger_bracket_gtc',
    'independent_stop_limit',
    'independent_take_profit',
    'independent_bracket',
    'application_polling',
    'none'
  ) NOT NULL,
  `capabilityState` ENUM(
    'unknown',
    'documented_unverified',
    'preview_supported',
    'preview_rejected',
    'shadow_validated',
    'sandbox_validated',
    'live_canary_validated',
    'unsupported',
    'temporarily_degraded'
  ) NOT NULL DEFAULT 'unknown',
  `source` VARCHAR(64) NOT NULL,
  `validatedAt` TIMESTAMP NULL,
  `expiresAt` TIMESTAMP NULL,
  `evidenceHash` VARCHAR(64) NULL,
  `limitations` TEXT,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `protection_capability_identity_uq` (
    `policyVersionId`, `productId`, `side`, `entryOrderType`,
    `timeInForce`, `protectionType`
  ),
  KEY `protection_capability_state_idx` (`capabilityState`),
  KEY `protection_capability_product_idx` (`productId`),
  CONSTRAINT `protection_capability_policy_fk`
    FOREIGN KEY (`policyVersionId`) REFERENCES `protection_policy_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. protection_validation_runs — evidence trail per capability determination.
-- ---------------------------------------------------------------------------
CREATE TABLE `protection_validation_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `policyVersionId` INT NOT NULL,
  `capabilityId` INT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `configurationHash` VARCHAR(64) NOT NULL,
  `validationType` ENUM(
    'documentation_review',
    'preview_fixture',
    'shadow_fixture',
    'sandbox',
    'live_canary'
  ) NOT NULL,
  `startedAt` TIMESTAMP NOT NULL,
  `completedAt` TIMESTAMP NULL,
  `result` ENUM(
    'pending',
    'passed',
    'failed',
    'inconclusive',
    'aborted'
  ) NOT NULL DEFAULT 'pending',
  `previewRequest` TEXT,
  `previewResponseSanitized` TEXT,
  `failureCode` VARCHAR(64),
  `failureReason` TEXT,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `protection_validation_policy_idx` (`policyVersionId`),
  KEY `protection_validation_capability_idx` (`capabilityId`),
  KEY `protection_validation_hash_idx` (`configurationHash`),
  CONSTRAINT `protection_validation_policy_fk`
    FOREIGN KEY (`policyVersionId`) REFERENCES `protection_policy_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `protection_validation_capability_fk`
    FOREIGN KEY (`capabilityId`) REFERENCES `protection_capabilities`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. protection_instances — the actual protection contract for one position.
-- ---------------------------------------------------------------------------
CREATE TABLE `protection_instances` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `positionId` INT NOT NULL,
  `decisionChainId` INT NOT NULL,
  `entryOrderIntentId` INT NOT NULL,
  `policyVersionId` INT NOT NULL,
  `capabilityId` INT NOT NULL,
  `protectionType` ENUM(
    'attached_trigger_bracket_gtc',
    'independent_stop_limit',
    'independent_take_profit',
    'independent_bracket',
    'application_polling',
    'none'
  ) NOT NULL,
  `requiredBaseQuantity` DECIMAL(20, 8) NOT NULL,
  `confirmedBaseQuantity` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `targetPrice` DECIMAL(20, 8) NOT NULL,
  `stopTriggerPrice` DECIMAL(20, 8) NOT NULL,
  `stopLimitPrice` DECIMAL(20, 8) NULL,
  `takeProfitLegState` ENUM(
    'pending',
    'active',
    'partially_filled',
    'filled',
    'disabled',
    'canceled',
    'rejected',
    'unknown'
  ) NOT NULL DEFAULT 'pending',
  `stopLossLegState` ENUM(
    'pending',
    'active',
    'partially_filled',
    'filled',
    'disabled',
    'canceled',
    'rejected',
    'unknown'
  ) NOT NULL DEFAULT 'pending',
  `state` ENUM(
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
    'degraded'
  ) NOT NULL DEFAULT 'required',
  `lastVerifiedAt` TIMESTAMP NULL,
  `failureReason` VARCHAR(255),
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `protection_instance_position_uq` (`positionId`),
  KEY `protection_instance_state_idx` (`state`),
  KEY `protection_instance_chain_idx` (`decisionChainId`),
  KEY `protection_instance_policy_idx` (`policyVersionId`),
  CONSTRAINT `protection_instance_policy_fk`
    FOREIGN KEY (`policyVersionId`) REFERENCES `protection_policy_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `protection_instance_capability_fk`
    FOREIGN KEY (`capabilityId`) REFERENCES `protection_capabilities`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `protection_instance_chain_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. protection_events — append-only history of leg + instance transitions.
-- ---------------------------------------------------------------------------
CREATE TABLE `protection_events` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `protectionInstanceId` INT NOT NULL,
  `decisionChainId` INT NOT NULL,
  `eventType` VARCHAR(64) NOT NULL,
  `previousState` VARCHAR(48),
  `newState` VARCHAR(48) NOT NULL,
  `leg` ENUM('take_profit_leg', 'stop_loss_leg', 'instance') NOT NULL DEFAULT 'instance',
  `reason` VARCHAR(255),
  `metadata` TEXT,
  `eventTime` TIMESTAMP NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `protection_events_instance_idx` (`protectionInstanceId`, `eventTime`),
  KEY `protection_events_chain_idx` (`decisionChainId`),
  KEY `protection_events_type_idx` (`eventType`),
  CONSTRAINT `protection_events_instance_fk`
    FOREIGN KEY (`protectionInstanceId`) REFERENCES `protection_instances`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `protection_events_chain_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
