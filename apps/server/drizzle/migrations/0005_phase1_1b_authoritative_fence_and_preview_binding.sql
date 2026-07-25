-- Phase 1.1.b — authoritative DB fencing, preview binding, reconciliation observability.
--
-- This migration adds four groups of infrastructure. All changes are additive
-- (new columns/tables) so upgrading from 0004 preserves every existing row.

-- ---------------------------------------------------------------------------
-- 1. execution_fences — the AUTHORITATIVE fence generation (§A).
--
-- Redis leases handle expiry + fast leader election, but Redis ownership
-- alone must not authorize a database commit. Every lease acquire also bumps
-- this row atomically; every economic mutation transaction takes a
-- `SELECT ... FOR UPDATE` on the matching row and rejects any writer whose
-- generation is older than currentGeneration.
--
-- state:
--   'active'   — currently held by ownerId
--   'released' — cleanly released by ownerId
--   'expired'  — TTL elapsed without renewal (best-effort informational label)
-- ---------------------------------------------------------------------------
CREATE TABLE `execution_fences` (
  `resourceKey` VARCHAR(64) NOT NULL,
  `currentGeneration` INT NOT NULL,
  `ownerId` VARCHAR(64),
  `acquiredAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `renewedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `state` ENUM('active','released','expired') NOT NULL DEFAULT 'active',
  PRIMARY KEY (`resourceKey`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. order_intents — bind the fence resource + preview + config hash.
--
-- fenceResourceKey  — which execution_fences row authorizes this intent
-- previewId         — hash of the preview response captured at authorization
-- decisionId        — the quantitative_decisions.id that authorized it
-- costForecastId    — the execution_cost_forecast.id used
-- feeTierSnapshotId — the fee_tier_snapshot.id at authorization
-- configHash        — SHA-256 hex of the normalized serialized order config
-- previewedAt       — when the preview was captured
-- previewExpiresAt  — freshness deadline
-- normalizedConfig  — the exact JSON the executor MUST submit
-- ---------------------------------------------------------------------------
ALTER TABLE `order_intents`
  ADD COLUMN `fenceResourceKey` VARCHAR(64),
  ADD COLUMN `previewId` VARCHAR(64),
  ADD COLUMN `decisionId` INT,
  ADD COLUMN `costForecastId` INT,
  ADD COLUMN `feeTierSnapshotId` INT,
  ADD COLUMN `configHash` VARCHAR(64),
  ADD COLUMN `previewedAt` TIMESTAMP NULL,
  ADD COLUMN `previewExpiresAt` TIMESTAMP NULL,
  ADD COLUMN `normalizedConfig` TEXT,
  ADD COLUMN `residualBaseSize` DECIMAL(20,8),
  ADD COLUMN `fillState` ENUM(
    'unfilled_open',
    'unfilled_terminal',
    'partially_filled_open',
    'partially_filled_terminal',
    'completely_filled',
    'filled_with_dust_residual',
    'inconsistent',
    'unknown'
  );
--> statement-breakpoint

CREATE INDEX `order_intents_fence_resource_idx` ON `order_intents` (`fenceResourceKey`);
--> statement-breakpoint
CREATE INDEX `order_intents_config_hash_idx` ON `order_intents` (`configHash`);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. positions — track exact residual quantity for partial fills (§E).
-- ---------------------------------------------------------------------------
ALTER TABLE `positions`
  ADD COLUMN `residualBaseSize` DECIMAL(20,8);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. reconciliation observability (§I).
--
-- One row per reconciliation run + one row per per-intent action within
-- the run. `failureReasonCode` is machine-readable; `detail` is free text
-- (with sensitive values redacted by the caller).
-- ---------------------------------------------------------------------------
CREATE TABLE `reconciliation_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `runId` VARCHAR(64) NOT NULL,
  `triggerReason` VARCHAR(64) NOT NULL,
  `startedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completedAt` TIMESTAMP NULL,
  `ownerId` VARCHAR(64),
  `fenceGeneration` INT,
  `intentsExamined` INT NOT NULL DEFAULT 0,
  `intentsResolved` INT NOT NULL DEFAULT 0,
  `intentsStillUnknown` INT NOT NULL DEFAULT 0,
  `fillsDiscovered` INT NOT NULL DEFAULT 0,
  `economicRecordsApplied` INT NOT NULL DEFAULT 0,
  `discrepancyCount` INT NOT NULL DEFAULT 0,
  `finalStatus` ENUM('running','ok','degraded','failed') NOT NULL DEFAULT 'running',
  `failureReasonCode` VARCHAR(64),
  `detail` TEXT,
  PRIMARY KEY (`id`),
  UNIQUE KEY `reconciliation_runs_runid_uq` (`runId`),
  KEY `reconciliation_runs_started_idx` (`startedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

CREATE TABLE `reconciliation_actions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `runId` VARCHAR(64) NOT NULL,
  `intentId` INT,
  `clientOrderId` VARCHAR(64),
  `action` VARCHAR(64) NOT NULL,
  `previousState` VARCHAR(32),
  `newState` VARCHAR(32),
  `fillsBefore` INT,
  `fillsAfter` INT,
  `paginationResult` VARCHAR(64),
  `failureReasonCode` VARCHAR(64),
  `detail` TEXT,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `reconciliation_actions_run_idx` (`runId`),
  KEY `reconciliation_actions_intent_idx` (`intentId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
