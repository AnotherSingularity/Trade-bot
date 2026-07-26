-- Phase 2A — dynamic universe + quantitative fingerprint observer.
--
-- Additive DDL. Migrations 0000-0013 remain immutable.
--
-- Adds:
--   1. universe_snapshots               — immutable, versioned enumeration
--   2. universe_products                — one row per product per snapshot
--   3. product_metadata_observations    — versioned metadata + payloadHash
--   4. product_hygiene_decisions        — Stage 0 result with reason codes
--   5. product_quarantines              — append-only quarantine events
--   6. feature_definitions              — versioned feature registry
--   7. feature_calculation_runs         — one row per run (Stage 1 / Stage 2)
--   8. feature_values                   — one row per (product, feature, run)
--   9. shortlist_decisions              — Stage 1 → Stage 2 gating
--  10. fingerprint_definitions          — versioned class + rule composition
--  11. fingerprint_snapshots            — one row per composed fingerprint
--  12. fingerprint_evidence             — feature membership + version audit
--  13. research_observer_runs           — one row per observer pass

-- ---------------------------------------------------------------------------
-- 1. universe_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE `universe_snapshots` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `snapshotVersion` VARCHAR(32) NOT NULL,
  `providerName` VARCHAR(64) NOT NULL,
  `providerVersion` VARCHAR(32) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `productCount` INT NOT NULL DEFAULT 0,
  `payloadHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `universe_snapshots_version_idx` (`snapshotVersion`),
  KEY `universe_snapshots_observed_idx` (`observedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. universe_products
-- ---------------------------------------------------------------------------
CREATE TABLE `universe_products` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `snapshotId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `baseCurrency` VARCHAR(16) NOT NULL,
  `quoteCurrency` VARCHAR(16) NOT NULL,
  `productType` VARCHAR(32) NOT NULL DEFAULT 'SPOT',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `universe_products_snap_prod_uq` (`snapshotId`, `productId`),
  KEY `universe_products_product_idx` (`productId`),
  CONSTRAINT `universe_products_snapshot_fk`
    FOREIGN KEY (`snapshotId`) REFERENCES `universe_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. product_metadata_observations — one row per (product, version)
-- ---------------------------------------------------------------------------
CREATE TABLE `product_metadata_observations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `productId` VARCHAR(30) NOT NULL,
  `sourceVersion` VARCHAR(32) NOT NULL,
  `providerName` VARCHAR(64) NOT NULL,
  `tradingStatus` VARCHAR(32) NOT NULL,
  `cancelOnly` BOOLEAN NOT NULL DEFAULT FALSE,
  `limitOnly` BOOLEAN NOT NULL DEFAULT FALSE,
  `postOnly` BOOLEAN NOT NULL DEFAULT FALSE,
  `auctionMode` BOOLEAN NOT NULL DEFAULT FALSE,
  `tradingDisabled` BOOLEAN NOT NULL DEFAULT FALSE,
  `baseIncrement` DECIMAL(30, 12) NOT NULL,
  `quoteIncrement` DECIMAL(30, 12) NOT NULL,
  `baseMinimum` DECIMAL(30, 12) NOT NULL,
  `quoteMinimum` DECIMAL(30, 12) NULL,
  `baseMaximum` DECIMAL(30, 12) NULL,
  `quoteMaximum` DECIMAL(30, 12) NULL,
  `priceIncrement` DECIMAL(30, 12) NULL,
  `approximateVolume24h` DECIMAL(30, 8) NULL,
  `metadataObservedAt` TIMESTAMP(3) NOT NULL,
  `metadataAvailableAt` TIMESTAMP(3) NOT NULL,
  `payloadHash` VARCHAR(64) NOT NULL,
  `rawPayload` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `product_metadata_hash_uq` (`payloadHash`),
  KEY `product_metadata_product_idx` (`productId`, `metadataObservedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. product_hygiene_decisions
-- ---------------------------------------------------------------------------
CREATE TABLE `product_hygiene_decisions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `snapshotId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `metadataId` INT NULL,
  `result` ENUM('eligible', 'ineligible', 'quarantined', 'insufficient_data') NOT NULL,
  `reasonCodes` VARCHAR(255) NOT NULL,
  `reasonDetail` TEXT NULL,
  `policyVersion` VARCHAR(32) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `decidedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `reEvaluateAt` TIMESTAMP(3) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `hygiene_snap_prod_uq` (`snapshotId`, `productId`),
  KEY `hygiene_result_idx` (`result`),
  CONSTRAINT `hygiene_snapshot_fk`
    FOREIGN KEY (`snapshotId`) REFERENCES `universe_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. product_quarantines — append-only
-- ---------------------------------------------------------------------------
CREATE TABLE `product_quarantines` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `productId` VARCHAR(30) NOT NULL,
  `reasonCode` VARCHAR(64) NOT NULL,
  `reasonDetail` TEXT NULL,
  `severity` ENUM('observe_only', 'feature_blocked', 'research_blocked', 'manual_review')
    NOT NULL DEFAULT 'research_blocked',
  `policyVersion` VARCHAR(32) NOT NULL,
  `startedAt` TIMESTAMP(3) NOT NULL,
  `expiresAt` TIMESTAMP(3) NULL,
  `clearedAt` TIMESTAMP(3) NULL,
  `clearedBy` VARCHAR(64) NULL,
  `evidenceHash` VARCHAR(64) NULL,
  `manualOverride` BOOLEAN NOT NULL DEFAULT FALSE,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `quarantine_product_idx` (`productId`, `startedAt`),
  KEY `quarantine_severity_idx` (`severity`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. feature_definitions — versioned; immutable after any value written
-- ---------------------------------------------------------------------------
CREATE TABLE `feature_definitions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `featureKey` VARCHAR(64) NOT NULL,
  `featureVersion` VARCHAR(32) NOT NULL,
  `description` TEXT NOT NULL,
  `inputRequirements` TEXT NOT NULL,
  `lookbackRequirement` INT NOT NULL,
  `minimumSampleCount` INT NOT NULL,
  `outputType` VARCHAR(32) NOT NULL,
  `unit` VARCHAR(32) NULL,
  `validRangeMin` DECIMAL(30, 12) NULL,
  `validRangeMax` DECIMAL(30, 12) NULL,
  `missingDataPolicy` VARCHAR(64) NOT NULL,
  `stalenessPolicy` VARCHAR(64) NOT NULL,
  `calculationHash` VARCHAR(64) NOT NULL,
  `implementationVersion` VARCHAR(32) NOT NULL,
  `status` ENUM('draft', 'observer', 'validated_for_research', 'deprecated', 'disabled')
    NOT NULL DEFAULT 'observer',
  `stage` ENUM('stage_1', 'stage_2') NOT NULL DEFAULT 'stage_1',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `feature_defs_key_version_uq` (`featureKey`, `featureVersion`),
  KEY `feature_defs_status_idx` (`status`, `stage`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. feature_calculation_runs — one row per stage run per snapshot
-- ---------------------------------------------------------------------------
CREATE TABLE `feature_calculation_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `snapshotId` INT NOT NULL,
  `stage` ENUM('stage_1', 'stage_2') NOT NULL,
  `startedAt` TIMESTAMP(3) NOT NULL,
  `completedAt` TIMESTAMP(3) NULL,
  `productCount` INT NOT NULL DEFAULT 0,
  `computedValues` INT NOT NULL DEFAULT 0,
  `failedValues` INT NOT NULL DEFAULT 0,
  `runVersion` VARCHAR(32) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `feature_runs_snap_stage_idx` (`snapshotId`, `stage`),
  CONSTRAINT `feature_runs_snapshot_fk`
    FOREIGN KEY (`snapshotId`) REFERENCES `universe_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. feature_values — one row per (run, product, feature)
-- ---------------------------------------------------------------------------
CREATE TABLE `feature_values` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `runId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `featureKey` VARCHAR(64) NOT NULL,
  `featureVersion` VARCHAR(32) NOT NULL,
  `status` ENUM(
    'valid',
    'insufficient_history',
    'stale',
    'invalid_input',
    'numerical_failure',
    'low_confidence',
    'gap_detected',
    'unsupported',
    'quarantined'
  ) NOT NULL,
  `value` DECIMAL(30, 12) NULL,
  `confidence` DECIMAL(6, 4) NULL,
  `sampleCount` INT NOT NULL DEFAULT 0,
  `lookbackStart` TIMESTAMP(3) NULL,
  `lookbackEnd` TIMESTAMP(3) NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `failureReason` VARCHAR(255) NULL,
  `diagnostics` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `feature_values_run_prod_feat_uq` (`runId`, `productId`, `featureKey`, `featureVersion`),
  KEY `feature_values_feat_idx` (`featureKey`, `status`),
  CONSTRAINT `feature_values_run_fk`
    FOREIGN KEY (`runId`) REFERENCES `feature_calculation_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. shortlist_decisions
-- ---------------------------------------------------------------------------
CREATE TABLE `shortlist_decisions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `snapshotId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `shortlisted` BOOLEAN NOT NULL DEFAULT FALSE,
  `rank` INT NULL,
  `score` DECIMAL(10, 6) NULL,
  `reasonCodes` VARCHAR(255) NOT NULL,
  `policyVersion` VARCHAR(32) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `decidedAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `shortlist_snap_prod_uq` (`snapshotId`, `productId`),
  KEY `shortlist_selected_idx` (`shortlisted`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 10. fingerprint_definitions — versioned composition rules
-- ---------------------------------------------------------------------------
CREATE TABLE `fingerprint_definitions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `classificationVersion` VARCHAR(32) NOT NULL,
  `description` TEXT NOT NULL,
  `requiredFeatures` TEXT NOT NULL,
  `overrideRules` TEXT NOT NULL,
  `implementationVersion` VARCHAR(32) NOT NULL,
  `status` ENUM('observer', 'validated_for_research', 'deprecated', 'disabled')
    NOT NULL DEFAULT 'observer',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `fingerprint_defs_version_uq` (`classificationVersion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 11. fingerprint_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE `fingerprint_snapshots` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `snapshotId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `fingerprintClass` ENUM(
    'REVERSION_CANDIDATE',
    'BREAKOUT_CANDIDATE',
    'MACRO_FLOOR_RESEARCH_CANDIDATE',
    'RANDOM_OR_NOISY',
    'ILLIQUID',
    'DISORDERED',
    'UNCLASSIFIED'
  ) NOT NULL,
  `confidence` DECIMAL(6, 4) NOT NULL,
  `qualityPenalty` DECIMAL(6, 4) NOT NULL DEFAULT 0,
  `liquidityPenalty` DECIMAL(6, 4) NOT NULL DEFAULT 0,
  `classificationVersion` VARCHAR(32) NOT NULL,
  `metadataVersion` VARCHAR(32) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `state` ENUM('complete', 'degraded', 'unresolved') NOT NULL DEFAULT 'complete',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `fingerprints_snap_prod_uq` (`snapshotId`, `productId`),
  KEY `fingerprints_class_idx` (`fingerprintClass`),
  CONSTRAINT `fingerprints_snapshot_fk`
    FOREIGN KEY (`snapshotId`) REFERENCES `universe_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 12. fingerprint_evidence — exact feature membership behind each fingerprint
-- ---------------------------------------------------------------------------
CREATE TABLE `fingerprint_evidence` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `fingerprintId` INT NOT NULL,
  `featureKey` VARCHAR(64) NOT NULL,
  `featureVersion` VARCHAR(32) NOT NULL,
  `role` ENUM('supporting', 'conflicting', 'missing') NOT NULL,
  `featureValueId` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fingerprint_evidence_fp_idx` (`fingerprintId`),
  KEY `fingerprint_evidence_role_idx` (`role`),
  CONSTRAINT `fingerprint_evidence_fp_fk`
    FOREIGN KEY (`fingerprintId`) REFERENCES `fingerprint_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 13. research_observer_runs
-- ---------------------------------------------------------------------------
CREATE TABLE `research_observer_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `snapshotId` INT NOT NULL,
  `startedAt` TIMESTAMP(3) NOT NULL,
  `completedAt` TIMESTAMP(3) NULL,
  `productsConsidered` INT NOT NULL DEFAULT 0,
  `productsEligible` INT NOT NULL DEFAULT 0,
  `productsQuarantined` INT NOT NULL DEFAULT 0,
  `productsShortlisted` INT NOT NULL DEFAULT 0,
  `fingerprintCounts` TEXT NULL,
  `runVersion` VARCHAR(32) NOT NULL,
  `notes` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `observer_runs_snap_idx` (`snapshotId`),
  CONSTRAINT `observer_runs_snapshot_fk`
    FOREIGN KEY (`snapshotId`) REFERENCES `universe_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
