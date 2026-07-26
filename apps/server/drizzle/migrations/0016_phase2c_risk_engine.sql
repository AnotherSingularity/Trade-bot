-- Phase 2C — independent portfolio RiskEngine and conservative sizing observer.
--
-- Additive DDL. Migrations 0000-0015 remain immutable. This migration adds:
--   1.  risk_policy_versions            — versioned policy registry
--   2.  risk_limit_definitions          — normalized limit definitions
--   3.  portfolio_risk_runs             — one row per observer pass
--   4.  portfolio_risk_snapshots        — immutable per-run portfolio state
--   5.  position_risk_snapshots         — per-position risk state
--   6.  candidate_risk_decisions        — immutable candidate decision
--   7.  risk_limit_breaches             — append-only breach journal
--   8.  correlation_model_versions      — versioned correlation model
--   9.  correlation_snapshots           — per-run correlation snapshot
--   10. correlation_pairs               — one row per pair
--   11. risk_cluster_snapshots          — per-run cluster snapshot
--   12. risk_clusters                   — one row per cluster
--   13. risk_cluster_memberships        — one row per product/cluster
--   14. daily_loss_states               — per-day loss projection
--   15. weekly_loss_states              — per-week loss projection
--   16. portfolio_drawdown_states       — current + max drawdown projection
--   17. stress_scenario_definitions     — versioned scenario catalog
--   18. stress_test_runs                — one row per stress run
--   19. stress_test_results             — per-scenario per-run result
--   20. champion_risk_comparisons       — post-hoc champion/risk comparison

-- ---------------------------------------------------------------------------
-- 1. risk_policy_versions
-- ---------------------------------------------------------------------------
CREATE TABLE `risk_policy_versions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `policyKey` VARCHAR(64) NOT NULL,
  `policyVersion` VARCHAR(32) NOT NULL,
  `description` TEXT NOT NULL,
  `operatingScope` VARCHAR(64) NOT NULL,
  `status` ENUM('draft','observer','validated_for_research','approved_for_shadow_enforcement','deprecated','disabled')
    NOT NULL DEFAULT 'observer',
  `effectiveFrom` TIMESTAMP(3) NOT NULL,
  `effectiveTo` TIMESTAMP(3) NULL,
  `supersedesPolicyId` INT NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `configurationHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `risk_policy_key_ver_uq` (`policyKey`, `policyVersion`),
  KEY `risk_policy_status_idx` (`status`),
  CONSTRAINT `risk_policy_supersedes_fk`
    FOREIGN KEY (`supersedesPolicyId`) REFERENCES `risk_policy_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. risk_limit_definitions
-- ---------------------------------------------------------------------------
CREATE TABLE `risk_limit_definitions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `policyVersionId` INT NOT NULL,
  `limitKey` VARCHAR(64) NOT NULL,
  `scope` ENUM('candidate','product','strategy_mode','correlation_cluster','benchmark_beta',
               'portfolio','daily','weekly','drawdown','liquidity','system_integrity') NOT NULL,
  `measurementKey` VARCHAR(64) NOT NULL,
  `operator` ENUM('lte','lt','gte','gt','eq') NOT NULL DEFAULT 'lte',
  `warningThreshold` DECIMAL(30,12) NULL,
  `hardThreshold` DECIMAL(30,12) NOT NULL,
  `unit` VARCHAR(32) NOT NULL,
  `aggregationMethod` VARCHAR(64) NOT NULL,
  `lookbackWindow` INT NULL,
  `minimumSampleCount` INT NULL,
  `breachAction` ENUM('observe','reduce','reject','block_all_new_entries','require_reconciliation') NOT NULL,
  `missingDataAction` ENUM('abstain','reject','block_all_new_entries') NOT NULL,
  `priority` INT NOT NULL DEFAULT 100,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `risk_limit_policy_key_uq` (`policyVersionId`, `limitKey`),
  KEY `risk_limit_scope_idx` (`scope`, `measurementKey`),
  CONSTRAINT `risk_limit_policy_fk`
    FOREIGN KEY (`policyVersionId`) REFERENCES `risk_policy_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. portfolio_risk_runs
-- ---------------------------------------------------------------------------
CREATE TABLE `portfolio_risk_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `policyVersionId` INT NOT NULL,
  `startedAt` TIMESTAMP(3) NOT NULL,
  `completedAt` TIMESTAMP(3) NULL,
  `candidatesEvaluated` INT NOT NULL DEFAULT 0,
  `authorizeAsProposed` INT NOT NULL DEFAULT 0,
  `reduceSize` INT NOT NULL DEFAULT 0,
  `rejects` INT NOT NULL DEFAULT 0,
  `abstains` INT NOT NULL DEFAULT 0,
  `dataFailures` INT NOT NULL DEFAULT 0,
  `runnerVersion` VARCHAR(32) NOT NULL,
  `notes` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `risk_runs_policy_idx` (`policyVersionId`, `startedAt`),
  CONSTRAINT `risk_runs_policy_fk`
    FOREIGN KEY (`policyVersionId`) REFERENCES `risk_policy_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. portfolio_risk_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE `portfolio_risk_snapshots` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `observerRunId` INT NOT NULL,
  `policyVersionId` INT NOT NULL,
  `cash` DECIMAL(30,10) NOT NULL,
  `reservedCash` DECIMAL(30,10) NOT NULL,
  `grossExposure` DECIMAL(30,10) NOT NULL,
  `netExposure` DECIMAL(30,10) NOT NULL,
  `totalOpenStopRisk` DECIMAL(30,10) NOT NULL,
  `pendingEntryRisk` DECIMAL(30,10) NOT NULL,
  `unprotectedExposure` DECIMAL(30,10) NOT NULL,
  `btcBetaExposure` DECIMAL(30,10) NULL,
  `ethBetaExposure` DECIMAL(30,10) NULL,
  `dailyLoss` DECIMAL(30,10) NOT NULL DEFAULT '0',
  `weeklyLoss` DECIMAL(30,10) NOT NULL DEFAULT '0',
  `currentDrawdown` DECIMAL(30,10) NOT NULL DEFAULT '0',
  `historicalVaR` DECIMAL(30,10) NULL,
  `historicalExpectedShortfall` DECIMAL(30,10) NULL,
  `worstStressLoss` DECIMAL(30,10) NULL,
  `positionCount` INT NOT NULL DEFAULT 0,
  `clusterCount` INT NOT NULL DEFAULT 0,
  `dataQualityState` VARCHAR(64) NOT NULL,
  `systemIntegrityState` ENUM('healthy','degraded','block_all_new_entries_recommended','reconciliation_required','invalid') NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `risk_snap_run_uq` (`observerRunId`),
  KEY `risk_snap_integrity_idx` (`systemIntegrityState`),
  CONSTRAINT `risk_snap_run_fk`
    FOREIGN KEY (`observerRunId`) REFERENCES `portfolio_risk_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `risk_snap_policy_fk`
    FOREIGN KEY (`policyVersionId`) REFERENCES `risk_policy_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. position_risk_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE `position_risk_snapshots` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `portfolioRiskSnapshotId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `entryDecisionChainId` INT NULL,
  `remainingBaseSize` DECIMAL(30,10) NOT NULL,
  `weightedAverageEntry` DECIMAL(30,10) NOT NULL,
  `openStopRisk` DECIMAL(30,10) NULL,
  `grossQuoteExposure` DECIMAL(30,10) NOT NULL,
  `protectionState` VARCHAR(64) NOT NULL,
  `state` ENUM('measured','partially_measured','unprotected','reconciliation_required','unknown') NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `pos_risk_snap_idx` (`portfolioRiskSnapshotId`),
  KEY `pos_risk_prod_idx` (`productId`),
  CONSTRAINT `pos_risk_snap_fk`
    FOREIGN KEY (`portfolioRiskSnapshotId`) REFERENCES `portfolio_risk_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. candidate_risk_decisions
-- ---------------------------------------------------------------------------
CREATE TABLE `candidate_risk_decisions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `candidateId` VARCHAR(64) NOT NULL,
  `policyVersionId` INT NOT NULL,
  `portfolioRiskSnapshotId` INT NOT NULL,
  `proposedBaseSize` DECIMAL(30,10) NOT NULL,
  `proposedQuoteSize` DECIMAL(30,10) NOT NULL,
  `recommendedBaseSize` DECIMAL(30,10) NOT NULL,
  `recommendedQuoteSize` DECIMAL(30,10) NOT NULL,
  `sizeMultiplier` DECIMAL(10,8) NOT NULL,
  `decision` ENUM('authorize_as_proposed','reduce_size','reject','abstain','data_failure') NOT NULL,
  `bindingLimit` VARCHAR(64) NULL,
  `warningBreaches` INT NOT NULL DEFAULT 0,
  `hardBreaches` INT NOT NULL DEFAULT 0,
  `systemIntegrityState` ENUM('healthy','degraded','block_all_new_entries_recommended','reconciliation_required','invalid') NOT NULL,
  `confidence` DECIMAL(6,4) NOT NULL DEFAULT '0',
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `reasonCodes` VARCHAR(255) NOT NULL,
  `diagnostics` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `cand_risk_chain_cand_uq` (`decisionChainId`, `candidateId`),
  KEY `cand_risk_decision_idx` (`decision`),
  CONSTRAINT `cand_risk_chain_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `cand_risk_policy_fk`
    FOREIGN KEY (`policyVersionId`) REFERENCES `risk_policy_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `cand_risk_snap_fk`
    FOREIGN KEY (`portfolioRiskSnapshotId`) REFERENCES `portfolio_risk_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. risk_limit_breaches
-- ---------------------------------------------------------------------------
CREATE TABLE `risk_limit_breaches` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `portfolioRiskSnapshotId` INT NOT NULL,
  `candidateRiskDecisionId` INT NULL,
  `limitDefinitionId` INT NOT NULL,
  `scope` VARCHAR(64) NOT NULL,
  `subjectId` VARCHAR(64) NULL,
  `measuredValue` DECIMAL(30,12) NOT NULL,
  `warningThreshold` DECIMAL(30,12) NULL,
  `hardThreshold` DECIMAL(30,12) NOT NULL,
  `severity` ENUM('warning','hard','system_integrity') NOT NULL,
  `breachAction` VARCHAR(64) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `risk_breach_snap_idx` (`portfolioRiskSnapshotId`),
  KEY `risk_breach_severity_idx` (`severity`, `scope`),
  CONSTRAINT `risk_breach_snap_fk`
    FOREIGN KEY (`portfolioRiskSnapshotId`) REFERENCES `portfolio_risk_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `risk_breach_limit_fk`
    FOREIGN KEY (`limitDefinitionId`) REFERENCES `risk_limit_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `risk_breach_cand_fk`
    FOREIGN KEY (`candidateRiskDecisionId`) REFERENCES `candidate_risk_decisions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. correlation_model_versions
-- ---------------------------------------------------------------------------
CREATE TABLE `correlation_model_versions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `modelKey` VARCHAR(64) NOT NULL,
  `modelVersion` VARCHAR(32) NOT NULL,
  `estimator` VARCHAR(64) NOT NULL,
  `shrinkageMethod` VARCHAR(64) NOT NULL,
  `shrinkageCoefficient` DECIMAL(6,4) NULL,
  `minimumOverlap` INT NOT NULL,
  `returnInterval` VARCHAR(32) NOT NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `status` ENUM('draft','observer','deprecated','disabled') NOT NULL DEFAULT 'observer',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `corr_model_key_ver_uq` (`modelKey`, `modelVersion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. correlation_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE `correlation_snapshots` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `modelVersionId` INT NOT NULL,
  `observerRunId` INT NULL,
  `productCount` INT NOT NULL,
  `pairCount` INT NOT NULL,
  `rawCovarianceHash` VARCHAR(64) NULL,
  `shrunkCovarianceHash` VARCHAR(64) NULL,
  `numericalStatus` ENUM('ok','psd_failure','underflow_handled','failure') NOT NULL DEFAULT 'ok',
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `corr_snap_run_idx` (`observerRunId`),
  KEY `corr_snap_model_idx` (`modelVersionId`),
  CONSTRAINT `corr_snap_model_fk`
    FOREIGN KEY (`modelVersionId`) REFERENCES `correlation_model_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `corr_snap_run_fk`
    FOREIGN KEY (`observerRunId`) REFERENCES `portfolio_risk_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 10. correlation_pairs
-- ---------------------------------------------------------------------------
CREATE TABLE `correlation_pairs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `snapshotId` INT NOT NULL,
  `productA` VARCHAR(30) NOT NULL,
  `productB` VARCHAR(30) NOT NULL,
  `correlation` DECIMAL(10,6) NULL,
  `overlapCount` INT NOT NULL,
  `confidence` DECIMAL(6,4) NOT NULL DEFAULT '0',
  `status` ENUM('valid','low_confidence','insufficient_history','stale','invalid_input','numerical_failure','unresolved_state','unsupported') NOT NULL,
  `lookbackStart` TIMESTAMP(3) NOT NULL,
  `lookbackEnd` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `corr_pair_snap_ab_uq` (`snapshotId`, `productA`, `productB`),
  KEY `corr_pair_status_idx` (`status`),
  CONSTRAINT `corr_pair_snap_fk`
    FOREIGN KEY (`snapshotId`) REFERENCES `correlation_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 11. risk_cluster_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE `risk_cluster_snapshots` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `correlationSnapshotId` INT NOT NULL,
  `observerRunId` INT NULL,
  `clusteringPolicyVersion` VARCHAR(32) NOT NULL,
  `absoluteThreshold` DECIMAL(6,4) NOT NULL,
  `clusterCount` INT NOT NULL,
  `unclusteredCount` INT NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `cluster_snap_corr_idx` (`correlationSnapshotId`),
  CONSTRAINT `cluster_snap_corr_fk`
    FOREIGN KEY (`correlationSnapshotId`) REFERENCES `correlation_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `cluster_snap_run_fk`
    FOREIGN KEY (`observerRunId`) REFERENCES `portfolio_risk_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 12. risk_clusters
-- ---------------------------------------------------------------------------
CREATE TABLE `risk_clusters` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `clusterSnapshotId` INT NOT NULL,
  `clusterKey` VARCHAR(64) NOT NULL,
  `productCount` INT NOT NULL,
  `representativeProductId` VARCHAR(30) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `cluster_snap_key_uq` (`clusterSnapshotId`, `clusterKey`),
  CONSTRAINT `cluster_snap_fk`
    FOREIGN KEY (`clusterSnapshotId`) REFERENCES `risk_cluster_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 13. risk_cluster_memberships
-- ---------------------------------------------------------------------------
CREATE TABLE `risk_cluster_memberships` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `clusterSnapshotId` INT NOT NULL,
  `clusterId` INT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `membershipStrength` DECIMAL(6,4) NULL,
  `reason` VARCHAR(64) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `cluster_mem_snap_prod_uq` (`clusterSnapshotId`, `productId`),
  KEY `cluster_mem_cluster_idx` (`clusterId`),
  CONSTRAINT `cluster_mem_snap_fk`
    FOREIGN KEY (`clusterSnapshotId`) REFERENCES `risk_cluster_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `cluster_mem_cluster_fk`
    FOREIGN KEY (`clusterId`) REFERENCES `risk_clusters`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 14. daily_loss_states
-- ---------------------------------------------------------------------------
CREATE TABLE `daily_loss_states` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `policyVersion` VARCHAR(32) NOT NULL,
  `periodStart` TIMESTAMP(3) NOT NULL,
  `periodEnd` TIMESTAMP(3) NOT NULL,
  `startingEquity` DECIMAL(30,10) NOT NULL,
  `endingEquity` DECIMAL(30,10) NOT NULL,
  `realizedNetPnl` DECIMAL(30,10) NOT NULL,
  `fees` DECIMAL(30,10) NOT NULL,
  `status` ENUM('open','warning','hard_breached','closed','invalid') NOT NULL DEFAULT 'open',
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `daily_loss_period_policy_uq` (`policyVersion`, `periodStart`),
  KEY `daily_loss_status_idx` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 15. weekly_loss_states
-- ---------------------------------------------------------------------------
CREATE TABLE `weekly_loss_states` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `policyVersion` VARCHAR(32) NOT NULL,
  `periodStart` TIMESTAMP(3) NOT NULL,
  `periodEnd` TIMESTAMP(3) NOT NULL,
  `startingEquity` DECIMAL(30,10) NOT NULL,
  `endingEquity` DECIMAL(30,10) NOT NULL,
  `realizedNetPnl` DECIMAL(30,10) NOT NULL,
  `fees` DECIMAL(30,10) NOT NULL,
  `status` ENUM('open','warning','hard_breached','closed','invalid') NOT NULL DEFAULT 'open',
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `weekly_loss_period_policy_uq` (`policyVersion`, `periodStart`),
  KEY `weekly_loss_status_idx` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 16. portfolio_drawdown_states
-- ---------------------------------------------------------------------------
CREATE TABLE `portfolio_drawdown_states` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `policyVersion` VARCHAR(32) NOT NULL,
  `peakEquity` DECIMAL(30,10) NOT NULL,
  `currentEquity` DECIMAL(30,10) NOT NULL,
  `currentDrawdown` DECIMAL(30,10) NOT NULL,
  `maximumDrawdown` DECIMAL(30,10) NOT NULL,
  `peakEquityAt` TIMESTAMP(3) NOT NULL,
  `status` ENUM('healthy','warning','hard_breached','invalid') NOT NULL DEFAULT 'healthy',
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `drawdown_policy_idx` (`policyVersion`, `createdAt`),
  KEY `drawdown_status_idx` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 17. stress_scenario_definitions
-- ---------------------------------------------------------------------------
CREATE TABLE `stress_scenario_definitions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `scenarioKey` VARCHAR(64) NOT NULL,
  `scenarioVersion` VARCHAR(32) NOT NULL,
  `description` TEXT NOT NULL,
  `shockDefinitions` TEXT NOT NULL,
  `correlationPolicy` VARCHAR(64) NOT NULL,
  `liquidityPolicy` VARCHAR(64) NOT NULL,
  `protectionPolicy` VARCHAR(64) NOT NULL,
  `valuationPolicy` VARCHAR(64) NOT NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `status` ENUM('draft','observer','deprecated','disabled') NOT NULL DEFAULT 'observer',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `stress_key_ver_uq` (`scenarioKey`, `scenarioVersion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 18. stress_test_runs
-- ---------------------------------------------------------------------------
CREATE TABLE `stress_test_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `portfolioRiskSnapshotId` INT NOT NULL,
  `scenarioCount` INT NOT NULL,
  `worstScenarioKey` VARCHAR(64) NULL,
  `worstLoss` DECIMAL(30,10) NULL,
  `startedAt` TIMESTAMP(3) NOT NULL,
  `completedAt` TIMESTAMP(3) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `stress_runs_snap_idx` (`portfolioRiskSnapshotId`),
  CONSTRAINT `stress_runs_snap_fk`
    FOREIGN KEY (`portfolioRiskSnapshotId`) REFERENCES `portfolio_risk_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 19. stress_test_results
-- ---------------------------------------------------------------------------
CREATE TABLE `stress_test_results` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `stressTestRunId` INT NOT NULL,
  `scenarioDefinitionId` INT NOT NULL,
  `portfolioValueBefore` DECIMAL(30,10) NOT NULL,
  `portfolioValueAfter` DECIMAL(30,10) NOT NULL,
  `estimatedLoss` DECIMAL(30,10) NOT NULL,
  `candidateIncrementalLoss` DECIMAL(30,10) NULL,
  `largestPositionContribution` DECIMAL(30,10) NULL,
  `largestClusterContribution` DECIMAL(30,10) NULL,
  `assumptions` TEXT NOT NULL,
  `limitBreaches` INT NOT NULL DEFAULT 0,
  `dataQualityStatus` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `stress_result_run_scen_uq` (`stressTestRunId`, `scenarioDefinitionId`),
  CONSTRAINT `stress_result_run_fk`
    FOREIGN KEY (`stressTestRunId`) REFERENCES `stress_test_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `stress_result_scen_fk`
    FOREIGN KEY (`scenarioDefinitionId`) REFERENCES `stress_scenario_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 20. champion_risk_comparisons
-- ---------------------------------------------------------------------------
CREATE TABLE `champion_risk_comparisons` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `candidateRiskDecisionId` INT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `championProposedBaseSize` DECIMAL(30,10) NOT NULL,
  `championProposedQuoteSize` DECIMAL(30,10) NOT NULL,
  `riskRecommendedBaseSize` DECIMAL(30,10) NOT NULL,
  `riskRecommendedQuoteSize` DECIMAL(30,10) NOT NULL,
  `riskDecision` ENUM('authorize_as_proposed','reduce_size','reject','abstain','data_failure') NOT NULL,
  `bindingLimit` VARCHAR(64) NULL,
  `championExecutionOutcome` VARCHAR(64) NULL,
  `agreementState` ENUM('agree','risk_reduced','risk_rejected','risk_abstained','unresolved') NOT NULL,
  `policyVersion` VARCHAR(32) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `champ_risk_chain_uq` (`decisionChainId`),
  KEY `champ_risk_agreement_idx` (`agreementState`),
  CONSTRAINT `champ_risk_chain_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `champ_risk_cand_fk`
    FOREIGN KEY (`candidateRiskDecisionId`) REFERENCES `candidate_risk_decisions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
