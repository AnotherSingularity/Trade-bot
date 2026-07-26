-- Phase 2E — contextual risk and veto observer.
--
-- Additive DDL. Migrations 0000-0017 remain immutable. This migration adds:
--   1.  context_provider_definitions
--   2.  context_provider_health
--   3.  context_signal_definitions
--   4.  context_policy_versions
--   5.  context_observer_runs
--   6.  context_observations
--   7.  context_signal_values
--   8.  sector_definitions
--   9.  sector_memberships
--   10. macro_event_definitions
--   11. macro_event_observations
--   12. global_context_snapshots
--   13. product_context_snapshots
--   14. context_ensemble_evidence
--   15. candidate_context_decisions
--   16. champion_context_comparisons
--   17. context_incidents

-- ---------------------------------------------------------------------------
-- 1. context_provider_definitions
-- ---------------------------------------------------------------------------
CREATE TABLE `context_provider_definitions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `providerKey` VARCHAR(64) NOT NULL,
  `providerVersion` VARCHAR(32) NOT NULL,
  `providerFamily` ENUM(
    'funding','derivatives_positioning','cross_exchange_premium','exchange_flows',
    'token_unlocks','etf_flows','stablecoin_flows','sentiment','sector_rotation',
    'macro_calendar','market_risk_calendar','cross_exchange_dislocation'
  ) NOT NULL,
  `description` TEXT NOT NULL,
  `expectedSchemaVersion` VARCHAR(32) NOT NULL,
  `expectedUpdateIntervalMs` INT NOT NULL,
  `maximumStalenessMs` INT NOT NULL,
  `authorityLevel` ENUM('informational','low','medium','high','hard_veto') NOT NULL,
  `supportedScopes` VARCHAR(255) NOT NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `status` ENUM('draft','observer','validated_for_research','deprecated','disabled') NOT NULL DEFAULT 'observer',
  `supersedesProviderId` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ctx_prov_key_ver_uq` (`providerKey`,`providerVersion`),
  KEY `ctx_prov_family_idx` (`providerFamily`,`status`),
  CONSTRAINT `ctx_prov_super_fk`
    FOREIGN KEY (`supersedesProviderId`) REFERENCES `context_provider_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. context_provider_health
-- ---------------------------------------------------------------------------
CREATE TABLE `context_provider_health` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `providerDefinitionId` INT NOT NULL,
  `healthState` ENUM(
    'healthy','degraded','stale','conflicted','unavailable','disabled',
    'schema_mismatch','clock_skew','authentication_failure','rate_limited'
  ) NOT NULL,
  `lastSuccessfulObservationAt` TIMESTAMP(3) NULL,
  `lastFailureAt` TIMESTAMP(3) NULL,
  `consecutiveFailures` INT NOT NULL DEFAULT 0,
  `stalenessAgeMs` INT NULL,
  `clockSkewMs` INT NULL,
  `observedSchemaVersion` VARCHAR(32) NULL,
  `expectedUpdateIntervalMs` INT NULL,
  `observedUpdateIntervalMs` INT NULL,
  `healthReason` VARCHAR(255) NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ctx_prov_health_prov_idx` (`providerDefinitionId`,`observedAt`),
  KEY `ctx_prov_health_state_idx` (`healthState`),
  CONSTRAINT `ctx_prov_health_prov_fk`
    FOREIGN KEY (`providerDefinitionId`) REFERENCES `context_provider_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. context_signal_definitions
-- ---------------------------------------------------------------------------
CREATE TABLE `context_signal_definitions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `signalKey` VARCHAR(64) NOT NULL,
  `signalVersion` VARCHAR(32) NOT NULL,
  `providerDefinitionId` INT NOT NULL,
  `scope` ENUM('global','sector','product','event') NOT NULL,
  `description` TEXT NOT NULL,
  `outputType` VARCHAR(32) NOT NULL,
  `unit` VARCHAR(32) NOT NULL,
  `directionPolicy` VARCHAR(64) NOT NULL,
  `severityPolicy` VARCHAR(64) NOT NULL,
  `confidencePolicy` VARCHAR(64) NOT NULL,
  `stalenessPolicy` VARCHAR(64) NOT NULL,
  `conflictPolicy` VARCHAR(64) NOT NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `status` ENUM('draft','observer','validated_for_research','deprecated','disabled') NOT NULL DEFAULT 'observer',
  `supersedesSignalId` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ctx_sig_key_ver_uq` (`signalKey`,`signalVersion`),
  KEY `ctx_sig_prov_idx` (`providerDefinitionId`),
  CONSTRAINT `ctx_sig_prov_fk`
    FOREIGN KEY (`providerDefinitionId`) REFERENCES `context_provider_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `ctx_sig_super_fk`
    FOREIGN KEY (`supersedesSignalId`) REFERENCES `context_signal_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. context_policy_versions
-- ---------------------------------------------------------------------------
CREATE TABLE `context_policy_versions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `policyKey` VARCHAR(64) NOT NULL,
  `policyVersion` VARCHAR(32) NOT NULL,
  `description` TEXT NOT NULL,
  `status` ENUM('draft','observer','validated_for_research','deprecated','disabled') NOT NULL DEFAULT 'observer',
  `maximumCombinedReduction` DECIMAL(6,4) NOT NULL,
  `hardVetoFamilies` VARCHAR(1000) NOT NULL,
  `missingDataPolicy` VARCHAR(64) NOT NULL,
  `conflictPolicy` VARCHAR(64) NOT NULL,
  `providerPriorityPolicy` VARCHAR(64) NOT NULL,
  `stalenessPolicy` VARCHAR(64) NOT NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `configurationHash` VARCHAR(64) NOT NULL,
  `supersedesPolicyId` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ctx_pol_key_ver_uq` (`policyKey`,`policyVersion`),
  CONSTRAINT `ctx_pol_super_fk`
    FOREIGN KEY (`supersedesPolicyId`) REFERENCES `context_policy_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. context_observer_runs
-- ---------------------------------------------------------------------------
CREATE TABLE `context_observer_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `policyVersionId` INT NOT NULL,
  `runnerVersion` VARCHAR(32) NOT NULL,
  `startedAt` TIMESTAMP(3) NOT NULL,
  `completedAt` TIMESTAMP(3) NULL,
  `productsConsidered` INT NOT NULL DEFAULT 0,
  `snapshotsPersisted` INT NOT NULL DEFAULT 0,
  `notes` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ctx_run_pol_idx` (`policyVersionId`,`startedAt`),
  CONSTRAINT `ctx_run_pol_fk`
    FOREIGN KEY (`policyVersionId`) REFERENCES `context_policy_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. context_observations
-- ---------------------------------------------------------------------------
CREATE TABLE `context_observations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `providerDefinitionId` INT NOT NULL,
  `productId` VARCHAR(30) NULL,
  `scope` ENUM('global','sector','product','event') NOT NULL,
  `sourceTimestamp` TIMESTAMP(3) NOT NULL,
  `receivedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `payloadHash` VARCHAR(64) NOT NULL,
  `schemaVersion` VARCHAR(32) NOT NULL,
  `healthState` ENUM(
    'healthy','degraded','stale','conflicted','unavailable','disabled',
    'schema_mismatch','clock_skew','authentication_failure','rate_limited'
  ) NOT NULL,
  `normalizedPayload` TEXT NOT NULL,
  `rawPayloadSanitized` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ctx_obs_prov_ts_uq` (`providerDefinitionId`,`sourceTimestamp`,`payloadHash`),
  KEY `ctx_obs_prod_idx` (`productId`,`sourceTimestamp`),
  KEY `ctx_obs_scope_idx` (`scope`,`sourceTimestamp`),
  CONSTRAINT `ctx_obs_prov_fk`
    FOREIGN KEY (`providerDefinitionId`) REFERENCES `context_provider_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. context_signal_values
-- ---------------------------------------------------------------------------
CREATE TABLE `context_signal_values` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `signalDefinitionId` INT NOT NULL,
  `observationId` BIGINT NULL,
  `productId` VARCHAR(30) NULL,
  `scope` ENUM('global','sector','product','event') NOT NULL,
  `status` ENUM(
    'valid','low_confidence','insufficient_history','stale','unavailable',
    'invalid_input','numerical_failure','provider_degraded','conflicted','unsupported'
  ) NOT NULL,
  `value` DECIMAL(30,12) NULL,
  `unit` VARCHAR(32) NOT NULL,
  `direction` ENUM('supportive','neutral','adverse','conflicted','unknown') NOT NULL,
  `severity` DECIMAL(6,4) NOT NULL,
  `confidence` DECIMAL(6,4) NOT NULL,
  `sampleCount` INT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `expiresAt` TIMESTAMP(3) NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `failureReason` VARCHAR(255) NULL,
  `diagnostics` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ctx_sv_sig_idx` (`signalDefinitionId`,`observedAt`),
  KEY `ctx_sv_prod_idx` (`productId`,`observedAt`),
  KEY `ctx_sv_status_idx` (`status`),
  CONSTRAINT `ctx_sv_sig_fk`
    FOREIGN KEY (`signalDefinitionId`) REFERENCES `context_signal_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `ctx_sv_obs_fk`
    FOREIGN KEY (`observationId`) REFERENCES `context_observations`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. sector_definitions
-- ---------------------------------------------------------------------------
CREATE TABLE `sector_definitions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `sectorKey` VARCHAR(64) NOT NULL,
  `sectorVersion` VARCHAR(32) NOT NULL,
  `description` TEXT NOT NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `status` ENUM('draft','observer','deprecated','disabled') NOT NULL DEFAULT 'observer',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `sec_def_key_ver_uq` (`sectorKey`,`sectorVersion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. sector_memberships
-- ---------------------------------------------------------------------------
CREATE TABLE `sector_memberships` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `sectorDefinitionId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `weight` DECIMAL(10,6) NOT NULL DEFAULT '1',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `sec_mem_uq` (`sectorDefinitionId`,`productId`),
  KEY `sec_mem_prod_idx` (`productId`),
  CONSTRAINT `sec_mem_def_fk`
    FOREIGN KEY (`sectorDefinitionId`) REFERENCES `sector_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 10. macro_event_definitions
-- ---------------------------------------------------------------------------
CREATE TABLE `macro_event_definitions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `eventKey` VARCHAR(64) NOT NULL,
  `eventVersion` VARCHAR(32) NOT NULL,
  `eventKind` ENUM(
    'fomc','cpi','jobs_report','regulatory_announcement','exchange_maintenance','other'
  ) NOT NULL,
  `description` TEXT NOT NULL,
  `timeZone` VARCHAR(64) NOT NULL,
  `preWindowMs` INT NOT NULL,
  `postWindowMs` INT NOT NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `status` ENUM('draft','observer','deprecated','disabled') NOT NULL DEFAULT 'observer',
  `supersedesEventId` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `macro_def_key_ver_uq` (`eventKey`,`eventVersion`),
  CONSTRAINT `macro_def_super_fk`
    FOREIGN KEY (`supersedesEventId`) REFERENCES `macro_event_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 11. macro_event_observations
-- ---------------------------------------------------------------------------
CREATE TABLE `macro_event_observations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `eventDefinitionId` INT NOT NULL,
  `scheduledAt` TIMESTAMP(3) NOT NULL,
  `windowStart` TIMESTAMP(3) NOT NULL,
  `windowEnd` TIMESTAMP(3) NOT NULL,
  `state` ENUM(
    'outside_window','pre_event_window','event_window','post_event_window','unknown'
  ) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `supersedesObservationId` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `macro_obs_def_idx` (`eventDefinitionId`,`observedAt`),
  CONSTRAINT `macro_obs_def_fk`
    FOREIGN KEY (`eventDefinitionId`) REFERENCES `macro_event_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `macro_obs_super_fk`
    FOREIGN KEY (`supersedesObservationId`) REFERENCES `macro_event_observations`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 12. global_context_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE `global_context_snapshots` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `observerRunId` INT NOT NULL,
  `policyVersionId` INT NOT NULL,
  `marketRiskState` VARCHAR(64) NOT NULL,
  `macroWindowState` VARCHAR(64) NOT NULL,
  `fundingState` VARCHAR(64) NOT NULL,
  `premiumState` VARCHAR(64) NOT NULL,
  `etfFlowState` VARCHAR(64) NOT NULL,
  `stablecoinState` VARCHAR(64) NOT NULL,
  `sentimentState` VARCHAR(64) NOT NULL,
  `providerHealthState` VARCHAR(64) NOT NULL,
  `confidence` DECIMAL(6,4) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `expiresAt` TIMESTAMP(3) NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `gctx_snap_run_idx` (`observerRunId`,`observedAt`),
  CONSTRAINT `gctx_snap_run_fk`
    FOREIGN KEY (`observerRunId`) REFERENCES `context_observer_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `gctx_snap_pol_fk`
    FOREIGN KEY (`policyVersionId`) REFERENCES `context_policy_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 13. product_context_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE `product_context_snapshots` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `observerRunId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `policyVersionId` INT NOT NULL,
  `unlockState` VARCHAR(64) NOT NULL,
  `exchangeFlowState` VARCHAR(64) NOT NULL,
  `sectorState` VARCHAR(64) NOT NULL,
  `productPremiumState` VARCHAR(64) NOT NULL,
  `fundingState` VARCHAR(64) NOT NULL,
  `dislocationState` VARCHAR(64) NOT NULL,
  `providerHealthState` VARCHAR(64) NOT NULL,
  `confidence` DECIMAL(6,4) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `expiresAt` TIMESTAMP(3) NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `pctx_snap_run_prod_uq` (`observerRunId`,`productId`),
  KEY `pctx_snap_prod_idx` (`productId`,`observedAt`),
  CONSTRAINT `pctx_snap_run_fk`
    FOREIGN KEY (`observerRunId`) REFERENCES `context_observer_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `pctx_snap_pol_fk`
    FOREIGN KEY (`policyVersionId`) REFERENCES `context_policy_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 14. context_ensemble_evidence
-- ---------------------------------------------------------------------------
CREATE TABLE `context_ensemble_evidence` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `globalSnapshotId` INT NULL,
  `productSnapshotId` INT NULL,
  `signalDefinitionId` INT NOT NULL,
  `signalValueId` BIGINT NULL,
  `vote` ENUM('supportive','neutral','adverse','veto','abstain','missing','conflicted') NOT NULL,
  `multiplierContribution` DECIMAL(6,4) NOT NULL,
  `authority` ENUM('informational','low','medium','high','hard_veto') NOT NULL,
  `weight` DECIMAL(6,4) NOT NULL,
  `reasonCode` VARCHAR(64) NOT NULL,
  `diagnostics` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ctx_ens_global_idx` (`globalSnapshotId`),
  KEY `ctx_ens_product_idx` (`productSnapshotId`),
  KEY `ctx_ens_sig_idx` (`signalDefinitionId`),
  CONSTRAINT `ctx_ens_global_fk`
    FOREIGN KEY (`globalSnapshotId`) REFERENCES `global_context_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `ctx_ens_product_fk`
    FOREIGN KEY (`productSnapshotId`) REFERENCES `product_context_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `ctx_ens_sig_fk`
    FOREIGN KEY (`signalDefinitionId`) REFERENCES `context_signal_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `ctx_ens_sv_fk`
    FOREIGN KEY (`signalValueId`) REFERENCES `context_signal_values`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 15. candidate_context_decisions
-- ---------------------------------------------------------------------------
CREATE TABLE `candidate_context_decisions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `contextPolicyVersionId` INT NOT NULL,
  `globalContextSnapshotId` INT NULL,
  `productContextSnapshotId` INT NULL,
  `phase2cRiskDecisionId` INT NULL,
  `phase2dExecutionDecisionId` INT NULL,
  `decision` ENUM('no_op','reduce','reject','abstain','data_failure') NOT NULL,
  `contextMultiplier` DECIMAL(6,4) NOT NULL,
  `warningSignals` TEXT NOT NULL,
  `vetoSignals` TEXT NOT NULL,
  `missingSignals` TEXT NOT NULL,
  `conflictingSignals` TEXT NOT NULL,
  `providerHealthState` VARCHAR(64) NOT NULL,
  `confidence` DECIMAL(6,4) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `expiresAt` TIMESTAMP(3) NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `reasonCodes` VARCHAR(500) NOT NULL,
  `diagnostics` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `cctx_dec_chain_uq` (`decisionChainId`),
  KEY `cctx_dec_prod_idx` (`productId`,`observedAt`),
  KEY `cctx_dec_action_idx` (`decision`),
  CONSTRAINT `cctx_dec_chain_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `cctx_dec_pol_fk`
    FOREIGN KEY (`contextPolicyVersionId`) REFERENCES `context_policy_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `cctx_dec_global_fk`
    FOREIGN KEY (`globalContextSnapshotId`) REFERENCES `global_context_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `cctx_dec_product_fk`
    FOREIGN KEY (`productContextSnapshotId`) REFERENCES `product_context_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 16. champion_context_comparisons
-- ---------------------------------------------------------------------------
CREATE TABLE `champion_context_comparisons` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `candidateContextDecisionId` INT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `championDecision` VARCHAR(64) NOT NULL,
  `championProposedSize` DECIMAL(30,10) NOT NULL,
  `contextDecision` ENUM('no_op','reduce','reject','abstain','data_failure') NOT NULL,
  `contextMultiplier` DECIMAL(6,4) NOT NULL,
  `observerRecommendedMaximumSize` DECIMAL(30,10) NOT NULL,
  `agreementState` ENUM(
    'agree','context_reduced','context_rejected','context_abstained','context_failed','unresolved'
  ) NOT NULL,
  `reasonCodes` VARCHAR(500) NOT NULL,
  `policyVersion` VARCHAR(32) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `champ_cctx_chain_uq` (`decisionChainId`),
  KEY `champ_cctx_agreement_idx` (`agreementState`),
  CONSTRAINT `champ_cctx_chain_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `champ_cctx_dec_fk`
    FOREIGN KEY (`candidateContextDecisionId`) REFERENCES `candidate_context_decisions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 17. context_incidents
-- ---------------------------------------------------------------------------
CREATE TABLE `context_incidents` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `providerDefinitionId` INT NULL,
  `signalDefinitionId` INT NULL,
  `policyVersionId` INT NULL,
  `incidentType` ENUM(
    'provider_outage','provider_stale','provider_conflict','schema_mismatch',
    'clock_skew','unexpected_value','authentication_failure','rate_limit',
    'manual_disable','signal_failure','policy_failure'
  ) NOT NULL,
  `severity` ENUM('informational','degraded','high','blocking') NOT NULL,
  `scope` ENUM('global','sector','product','event') NOT NULL,
  `productId` VARCHAR(30) NULL,
  `detectedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `reasonCode` VARCHAR(64) NOT NULL,
  `details` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ctx_inc_type_idx` (`incidentType`,`severity`,`detectedAt`),
  KEY `ctx_inc_prod_idx` (`productId`,`detectedAt`),
  CONSTRAINT `ctx_inc_prov_fk`
    FOREIGN KEY (`providerDefinitionId`) REFERENCES `context_provider_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `ctx_inc_sig_fk`
    FOREIGN KEY (`signalDefinitionId`) REFERENCES `context_signal_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `ctx_inc_pol_fk`
    FOREIGN KEY (`policyVersionId`) REFERENCES `context_policy_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
