-- Phase 1.2-OPS — seven-day live-deployment soak.
--
-- Additive DDL. Migrations 0000-0012 remain immutable.
--
-- Adds:
--   1. soak_runs                — one immutable row per soak attempt.
--   2. soak_daily_reports       — one row per calendar day within a soak.
--   3. soak_incidents           — classified operational incidents.
--   4. adapter_selections       — audit of which provider bound at start.
--   5. soak_preflight_runs      — preflight results (must pass before soak).

-- ---------------------------------------------------------------------------
-- 1. soak_runs
-- ---------------------------------------------------------------------------
CREATE TABLE `soak_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `soakRunId` VARCHAR(64) NOT NULL,
  `commitHash` VARCHAR(40) NOT NULL,
  `deploymentId` VARCHAR(64) NOT NULL,
  `startedAt` TIMESTAMP NOT NULL,
  `requiredEndAt` TIMESTAMP NOT NULL,
  `completedAt` TIMESTAMP NULL,
  `strategyVersion` VARCHAR(32) NOT NULL,
  `marketDataVersion` VARCHAR(32) NOT NULL,
  `fillModelVersion` VARCHAR(32) NOT NULL,
  `costModelVersion` VARCHAR(32) NOT NULL,
  `protectionPolicyVersion` VARCHAR(32) NOT NULL,
  `schemaFingerprint` VARCHAR(64) NOT NULL,
  `safeFlagsSnapshot` TEXT NOT NULL,
  `productUniverseHash` VARCHAR(64) NOT NULL,
  `status` ENUM('preflight', 'running', 'failed', 'reset_required', 'completed')
    NOT NULL DEFAULT 'preflight',
  `verdict` ENUM('pending', 'soak_failed', 'soak_degraded', 'phase1_2_pass')
    NOT NULL DEFAULT 'pending',
  `verdictReason` VARCHAR(255) NULL,
  `preflightRunId` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `soak_runs_soakRunId_uq` (`soakRunId`),
  KEY `soak_runs_status_idx` (`status`),
  KEY `soak_runs_verdict_idx` (`verdict`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. soak_daily_reports — one immutable row per calendar day within a soak.
-- ---------------------------------------------------------------------------
CREATE TABLE `soak_daily_reports` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `soakRunId` VARCHAR(64) NOT NULL,
  `reportDate` TIMESTAMP NOT NULL,
  `windowStart` TIMESTAMP NOT NULL,
  `windowEnd` TIMESTAMP NOT NULL,
  `uptimeSeconds` INT NOT NULL DEFAULT 0,
  `webSocketSessions` INT NOT NULL DEFAULT 0,
  `reconnectCount` INT NOT NULL DEFAULT 0,
  `heartbeatGaps` INT NOT NULL DEFAULT 0,
  `dataGapsByProduct` TEXT NULL,
  `healthyProductCount` INT NOT NULL DEFAULT 0,
  `staleProductCount` INT NOT NULL DEFAULT 0,
  `scannerRuns` INT NOT NULL DEFAULT 0,
  `scannerFailures` INT NOT NULL DEFAULT 0,
  `productsEvaluated` INT NOT NULL DEFAULT 0,
  `ineligibleChains` INT NOT NULL DEFAULT 0,
  `noSetupChains` INT NOT NULL DEFAULT 0,
  `candidatesReversion` INT NOT NULL DEFAULT 0,
  `candidatesBreakout` INT NOT NULL DEFAULT 0,
  `candidatesMacro` INT NOT NULL DEFAULT 0,
  `plansApproved` INT NOT NULL DEFAULT 0,
  `simulatedOrders` INT NOT NULL DEFAULT 0,
  `fullFills` INT NOT NULL DEFAULT 0,
  `partialFills` INT NOT NULL DEFAULT 0,
  `openPositions` INT NOT NULL DEFAULT 0,
  `completedRoundTrips` INT NOT NULL DEFAULT 0,
  `grossPnl` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `simulatedFees` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `simulatedSpread` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `simulatedSlippage` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `netPnl` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `forecastCostError` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `accountingDifference` DECIMAL(20, 8) NOT NULL DEFAULT 0,
  `reconciliationStatus` VARCHAR(32) NOT NULL,
  `protectionStatus` VARCHAR(32) NOT NULL,
  `brokenLineageCount` INT NOT NULL DEFAULT 0,
  `createOrderFunctionInvocations` INT NOT NULL DEFAULT 0,
  `createOrderAttemptCount` INT NOT NULL DEFAULT 0,
  `createOrderNetworkCount` INT NOT NULL DEFAULT 0,
  `incidentIds` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `soak_daily_run_date_uq` (`soakRunId`, `reportDate`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. soak_incidents
-- ---------------------------------------------------------------------------
CREATE TABLE `soak_incidents` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `soakRunId` VARCHAR(64) NULL,
  `incidentKind` ENUM(
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
    'undocumented_deployment'
  ) NOT NULL,
  `classification` ENUM(
    'informational',
    'product_degraded',
    'system_degraded',
    'soak_invalidating'
  ) NOT NULL,
  `detectedAt` TIMESTAMP NOT NULL,
  `resolvedAt` TIMESTAMP NULL,
  `productId` VARCHAR(30) NULL,
  `detail` TEXT NULL,
  `metadata` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `soak_incidents_run_idx` (`soakRunId`),
  KEY `soak_incidents_class_idx` (`classification`),
  KEY `soak_incidents_kind_idx` (`incidentKind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. adapter_selections — audit of which provider bound at start-of-run
-- ---------------------------------------------------------------------------
CREATE TABLE `adapter_selections` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `soakRunId` VARCHAR(64) NULL,
  `boundAt` TIMESTAMP NOT NULL,
  `webSocketProvider` VARCHAR(128) NOT NULL,
  `restClient` VARCHAR(128) NOT NULL,
  `authClient` VARCHAR(128) NOT NULL,
  `redisClient` VARCHAR(128) NOT NULL,
  `dbDriver` VARCHAR(128) NOT NULL,
  `isProduction` BOOLEAN NOT NULL DEFAULT FALSE,
  `refusedReason` VARCHAR(255) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `adapter_selections_run_idx` (`soakRunId`),
  KEY `adapter_selections_prod_idx` (`isProduction`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. soak_preflight_runs
-- ---------------------------------------------------------------------------
CREATE TABLE `soak_preflight_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `soakRunId` VARCHAR(64) NULL,
  `startedAt` TIMESTAMP NOT NULL,
  `completedAt` TIMESTAMP NULL,
  `durationSeconds` INT NOT NULL DEFAULT 0,
  `connectionHealthy` BOOLEAN NOT NULL DEFAULT FALSE,
  `heartbeatsContinuous` BOOLEAN NOT NULL DEFAULT FALSE,
  `productsBootstrapped` INT NOT NULL DEFAULT 0,
  `productsFailed` INT NOT NULL DEFAULT 0,
  `candleHistoryOrdered` BOOLEAN NOT NULL DEFAULT FALSE,
  `scannerReadsLiveState` BOOLEAN NOT NULL DEFAULT FALSE,
  `scheduledManualSameSource` BOOLEAN NOT NULL DEFAULT FALSE,
  `feeTierRetrievalOk` BOOLEAN NOT NULL DEFAULT FALSE,
  `previewSucceededOrFailedClosed` BOOLEAN NOT NULL DEFAULT FALSE,
  `productMetadataFresh` BOOLEAN NOT NULL DEFAULT FALSE,
  `dataGapsPersisted` BOOLEAN NOT NULL DEFAULT FALSE,
  `reconnectWorks` BOOLEAN NOT NULL DEFAULT FALSE,
  `restartRestoresState` BOOLEAN NOT NULL DEFAULT FALSE,
  `createOrderFunctionInvocations` INT NOT NULL DEFAULT 0,
  `createOrderAttemptCount` INT NOT NULL DEFAULT 0,
  `createOrderNetworkCount` INT NOT NULL DEFAULT 0,
  `passed` BOOLEAN NOT NULL DEFAULT FALSE,
  `failureReasons` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `soak_preflight_run_idx` (`soakRunId`),
  KEY `soak_preflight_passed_idx` (`passed`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
