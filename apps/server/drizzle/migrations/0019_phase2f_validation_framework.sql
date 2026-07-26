-- Phase 2F — validation, anti-overfitting, attribution, and promotion governance.
--
-- Additive DDL. Migrations 0000-0018 remain immutable. This migration adds
-- 38 tables covering: dataset provenance, experiment registry, split/fold
-- policies, CPCV, PBO, DSR, statistical audits, net metrics + slices,
-- unified challenger, attribution, Claude framework, promotion registry,
-- champion immutability, rollback, Kelly gate, and validation incidents.

-- ---------------------------------------------------------------------------
-- 1. dataset_definitions
-- ---------------------------------------------------------------------------
CREATE TABLE `dataset_definitions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `datasetKey` VARCHAR(64) NOT NULL,
  `description` TEXT NOT NULL,
  `sourceCategory` ENUM(
    'synthetic_fixture','deterministic_replay','historical_replay',
    'captured_live_shadow','prospective_shadow'
  ) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ds_def_key_uq` (`datasetKey`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. dataset_versions
-- ---------------------------------------------------------------------------
CREATE TABLE `dataset_versions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `datasetDefinitionId` INT NOT NULL,
  `datasetVersion` VARCHAR(32) NOT NULL,
  `sourceCategory` ENUM(
    'synthetic_fixture','deterministic_replay','historical_replay',
    'captured_live_shadow','prospective_shadow'
  ) NOT NULL,
  `sourceIdentity` VARCHAR(255) NOT NULL,
  `productUniverseHash` VARCHAR(64) NOT NULL,
  `startTime` TIMESTAMP(3) NOT NULL,
  `endTime` TIMESTAMP(3) NOT NULL,
  `dataAvailabilityCutoff` TIMESTAMP(3) NOT NULL,
  `featureVersions` VARCHAR(500) NOT NULL,
  `fingerprintVersion` VARCHAR(32) NOT NULL,
  `regimeVersion` VARCHAR(32) NOT NULL,
  `riskPolicyVersion` VARCHAR(32) NOT NULL,
  `microstructurePolicyVersion` VARCHAR(32) NOT NULL,
  `contextPolicyVersion` VARCHAR(32) NOT NULL,
  `costModelVersion` VARCHAR(32) NOT NULL,
  `fillModelVersion` VARCHAR(32) NOT NULL,
  `labelVersion` VARCHAR(32) NOT NULL,
  `exclusionPolicyVersion` VARCHAR(32) NOT NULL,
  `codeCommit` VARCHAR(64) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ds_ver_uq` (`datasetDefinitionId`,`datasetVersion`),
  KEY `ds_ver_source_idx` (`sourceCategory`),
  CONSTRAINT `ds_ver_def_fk`
    FOREIGN KEY (`datasetDefinitionId`) REFERENCES `dataset_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. dataset_memberships
-- ---------------------------------------------------------------------------
CREATE TABLE `dataset_memberships` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `datasetVersionId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `included` BOOLEAN NOT NULL DEFAULT true,
  `reasonCode` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ds_mem_uq` (`datasetVersionId`,`productId`),
  CONSTRAINT `ds_mem_ver_fk`
    FOREIGN KEY (`datasetVersionId`) REFERENCES `dataset_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. dataset_exclusions
-- ---------------------------------------------------------------------------
CREATE TABLE `dataset_exclusions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `datasetVersionId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `exclusionReason` VARCHAR(255) NOT NULL,
  `exclusionKind` ENUM('a_priori','structural','operator_manual') NOT NULL,
  `excludedAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ds_exc_ver_idx` (`datasetVersionId`),
  CONSTRAINT `ds_exc_ver_fk`
    FOREIGN KEY (`datasetVersionId`) REFERENCES `dataset_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. dataset_integrity_checks
-- ---------------------------------------------------------------------------
CREATE TABLE `dataset_integrity_checks` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `datasetVersionId` INT NOT NULL,
  `checkName` VARCHAR(64) NOT NULL,
  `passed` BOOLEAN NOT NULL,
  `details` TEXT NULL,
  `checkedAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ds_ic_ver_idx` (`datasetVersionId`,`checkName`),
  CONSTRAINT `ds_ic_ver_fk`
    FOREIGN KEY (`datasetVersionId`) REFERENCES `dataset_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. research_experiments
-- ---------------------------------------------------------------------------
CREATE TABLE `research_experiments` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `experimentKey` VARCHAR(64) NOT NULL,
  `experimentVersion` VARCHAR(32) NOT NULL,
  `hypothesis` TEXT NOT NULL,
  `championVersion` VARCHAR(32) NOT NULL,
  `challengerVersion` VARCHAR(32) NOT NULL,
  `datasetVersionId` INT NOT NULL,
  `primaryMetric` VARCHAR(64) NOT NULL,
  `secondaryMetrics` VARCHAR(500) NOT NULL,
  `parameterSearchSpace` TEXT NOT NULL,
  `multipleTestingFamily` VARCHAR(64) NOT NULL,
  `validationPolicyVersion` VARCHAR(32) NOT NULL,
  `registeredAt` TIMESTAMP(3) NOT NULL,
  `registeredBy` VARCHAR(64) NOT NULL,
  `codeCommit` VARCHAR(64) NOT NULL,
  `randomSeed` BIGINT NOT NULL,
  `status` ENUM('registered','running','completed','failed','invalidated','superseded') NOT NULL DEFAULT 'registered',
  `failureReason` VARCHAR(255) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `exp_key_ver_uq` (`experimentKey`,`experimentVersion`),
  KEY `exp_status_idx` (`status`),
  CONSTRAINT `exp_ds_fk`
    FOREIGN KEY (`datasetVersionId`) REFERENCES `dataset_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. experiment_runs
-- ---------------------------------------------------------------------------
CREATE TABLE `experiment_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `experimentId` INT NOT NULL,
  `startedAt` TIMESTAMP(3) NOT NULL,
  `completedAt` TIMESTAMP(3) NULL,
  `status` ENUM('running','completed','failed','invalidated') NOT NULL DEFAULT 'running',
  `failureReason` VARCHAR(255) NULL,
  `foldsExecuted` INT NOT NULL DEFAULT 0,
  `pathsExecuted` INT NOT NULL DEFAULT 0,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `exp_run_exp_idx` (`experimentId`,`startedAt`),
  CONSTRAINT `exp_run_exp_fk`
    FOREIGN KEY (`experimentId`) REFERENCES `research_experiments`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. experiment_parameters
-- ---------------------------------------------------------------------------
CREATE TABLE `experiment_parameters` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `experimentId` INT NOT NULL,
  `parameterKey` VARCHAR(64) NOT NULL,
  `parameterType` ENUM('scalar','categorical','vector','ordinal') NOT NULL,
  `parameterSpace` TEXT NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `exp_param_uq` (`experimentId`,`parameterKey`),
  CONSTRAINT `exp_param_exp_fk`
    FOREIGN KEY (`experimentId`) REFERENCES `research_experiments`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. experiment_candidate_versions
-- ---------------------------------------------------------------------------
CREATE TABLE `experiment_candidate_versions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `experimentId` INT NOT NULL,
  `candidateKey` VARCHAR(64) NOT NULL,
  `candidateVersion` VARCHAR(32) NOT NULL,
  `parameterAssignment` TEXT NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `exp_cand_uq` (`experimentId`,`candidateKey`,`candidateVersion`),
  CONSTRAINT `exp_cand_exp_fk`
    FOREIGN KEY (`experimentId`) REFERENCES `research_experiments`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 10. validation_split_policies
-- ---------------------------------------------------------------------------
CREATE TABLE `validation_split_policies` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `policyKey` VARCHAR(64) NOT NULL,
  `policyVersion` VARCHAR(32) NOT NULL,
  `splitKind` ENUM(
    'expanding_walk_forward','rolling_walk_forward','anchored_walk_forward',
    'purged_k_fold','combinatorial_purged_cross_validation','final_holdout'
  ) NOT NULL,
  `description` TEXT NOT NULL,
  `purgeWindowMs` INT NOT NULL,
  `embargoWindowMs` INT NOT NULL,
  `labelHorizonMs` INT NOT NULL,
  `configuration` TEXT NOT NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `status` ENUM('draft','observer','validated_for_research','deprecated','disabled') NOT NULL DEFAULT 'observer',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `vsp_key_ver_uq` (`policyKey`,`policyVersion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 11. validation_folds
-- ---------------------------------------------------------------------------
CREATE TABLE `validation_folds` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `experimentRunId` INT NOT NULL,
  `splitPolicyId` INT NOT NULL,
  `foldIndex` INT NOT NULL,
  `trainingStart` TIMESTAMP(3) NOT NULL,
  `trainingEnd` TIMESTAMP(3) NOT NULL,
  `purgeStart` TIMESTAMP(3) NOT NULL,
  `purgeEnd` TIMESTAMP(3) NOT NULL,
  `embargoStart` TIMESTAMP(3) NOT NULL,
  `embargoEnd` TIMESTAMP(3) NOT NULL,
  `validationStart` TIMESTAMP(3) NOT NULL,
  `validationEnd` TIMESTAMP(3) NOT NULL,
  `holdout` BOOLEAN NOT NULL DEFAULT false,
  `status` ENUM('pending','completed','empty','failed','invalidated') NOT NULL DEFAULT 'pending',
  `sampleCount` INT NOT NULL DEFAULT 0,
  `failureReason` VARCHAR(255) NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `vf_run_idx_uq` (`experimentRunId`,`foldIndex`),
  KEY `vf_status_idx` (`status`),
  CONSTRAINT `vf_run_fk`
    FOREIGN KEY (`experimentRunId`) REFERENCES `experiment_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `vf_pol_fk`
    FOREIGN KEY (`splitPolicyId`) REFERENCES `validation_split_policies`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 12. validation_fold_memberships
-- ---------------------------------------------------------------------------
CREATE TABLE `validation_fold_memberships` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `foldId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `observationTimestamp` TIMESTAMP(3) NOT NULL,
  `roleInFold` ENUM('training','validation','purged','embargoed') NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `vfm_fold_idx` (`foldId`,`roleInFold`),
  CONSTRAINT `vfm_fold_fk`
    FOREIGN KEY (`foldId`) REFERENCES `validation_folds`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 13. validation_embargoes
-- ---------------------------------------------------------------------------
CREATE TABLE `validation_embargoes` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `splitPolicyId` INT NOT NULL,
  `embargoKind` ENUM('leading','trailing','both') NOT NULL,
  `embargoWindowMs` INT NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `ve_pol_fk`
    FOREIGN KEY (`splitPolicyId`) REFERENCES `validation_split_policies`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 14. cpcv_definitions
-- ---------------------------------------------------------------------------
CREATE TABLE `cpcv_definitions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `experimentId` INT NOT NULL,
  `numberOfGroups` INT NOT NULL,
  `numberOfTestGroups` INT NOT NULL,
  `purgeWindowMs` INT NOT NULL,
  `embargoWindowMs` INT NOT NULL,
  `labelHorizonMs` INT NOT NULL,
  `pathConstructionPolicy` VARCHAR(64) NOT NULL,
  `maximumPathCount` INT NOT NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `cpcv_def_exp_uq` (`experimentId`),
  CONSTRAINT `cpcv_def_exp_fk`
    FOREIGN KEY (`experimentId`) REFERENCES `research_experiments`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 15. cpcv_paths
-- ---------------------------------------------------------------------------
CREATE TABLE `cpcv_paths` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `cpcvDefinitionId` INT NOT NULL,
  `pathIndex` INT NOT NULL,
  `testGroups` VARCHAR(255) NOT NULL,
  `trainingGroups` VARCHAR(255) NOT NULL,
  `pathHash` VARCHAR(64) NOT NULL,
  `status` ENUM('pending','completed','empty','failed') NOT NULL DEFAULT 'pending',
  `failureReason` VARCHAR(255) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `cpcv_path_uq` (`cpcvDefinitionId`,`pathIndex`),
  KEY `cpcv_path_status_idx` (`status`),
  CONSTRAINT `cpcv_path_def_fk`
    FOREIGN KEY (`cpcvDefinitionId`) REFERENCES `cpcv_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 16. cpcv_path_folds
-- ---------------------------------------------------------------------------
CREATE TABLE `cpcv_path_folds` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `cpcvPathId` INT NOT NULL,
  `foldId` INT NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `cpcv_path_fold_uq` (`cpcvPathId`,`foldId`),
  CONSTRAINT `cpcv_path_fold_path_fk`
    FOREIGN KEY (`cpcvPathId`) REFERENCES `cpcv_paths`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `cpcv_path_fold_fold_fk`
    FOREIGN KEY (`foldId`) REFERENCES `validation_folds`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 17. cpcv_path_results
-- ---------------------------------------------------------------------------
CREATE TABLE `cpcv_path_results` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `cpcvPathId` INT NOT NULL,
  `netReturn` DECIMAL(20,10) NULL,
  `netSharpe` DECIMAL(20,10) NULL,
  `maximumDrawdown` DECIMAL(20,10) NULL,
  `sampleCount` INT NOT NULL DEFAULT 0,
  `status` ENUM('valid','insufficient_samples','failed','invalid') NOT NULL,
  `failureReason` VARCHAR(255) NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `cpcv_res_path_uq` (`cpcvPathId`),
  CONSTRAINT `cpcv_res_path_fk`
    FOREIGN KEY (`cpcvPathId`) REFERENCES `cpcv_paths`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 18. validation_metrics
-- ---------------------------------------------------------------------------
CREATE TABLE `validation_metrics` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `experimentRunId` INT NOT NULL,
  `metricKey` VARCHAR(64) NOT NULL,
  `metricScope` ENUM('aggregate','per_fold','per_path','per_product','per_regime') NOT NULL,
  `value` DECIMAL(30,12) NULL,
  `unit` VARCHAR(32) NOT NULL,
  `netOfCosts` BOOLEAN NOT NULL DEFAULT true,
  `status` ENUM('valid','insufficient_samples','failed','invalid') NOT NULL,
  `sampleCount` INT NOT NULL DEFAULT 0,
  `failureReason` VARCHAR(255) NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `vm_run_key_uq` (`experimentRunId`,`metricKey`,`metricScope`),
  KEY `vm_key_idx` (`metricKey`),
  CONSTRAINT `vm_run_fk`
    FOREIGN KEY (`experimentRunId`) REFERENCES `experiment_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 19. validation_metric_slices
-- ---------------------------------------------------------------------------
CREATE TABLE `validation_metric_slices` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `experimentRunId` INT NOT NULL,
  `sliceKey` VARCHAR(64) NOT NULL,
  `sliceValue` VARCHAR(128) NOT NULL,
  `metricKey` VARCHAR(64) NOT NULL,
  `value` DECIMAL(30,12) NULL,
  `sampleCount` INT NOT NULL DEFAULT 0,
  `status` ENUM('valid','insufficient_samples','catastrophic','failed') NOT NULL,
  `failureReason` VARCHAR(255) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `vms_uq` (`experimentRunId`,`sliceKey`,`sliceValue`,`metricKey`),
  KEY `vms_status_idx` (`status`),
  CONSTRAINT `vms_run_fk`
    FOREIGN KEY (`experimentRunId`) REFERENCES `experiment_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 20. validation_slice_failures
-- ---------------------------------------------------------------------------
CREATE TABLE `validation_slice_failures` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `experimentRunId` INT NOT NULL,
  `sliceKey` VARCHAR(64) NOT NULL,
  `sliceValue` VARCHAR(128) NOT NULL,
  `failureReason` VARCHAR(255) NOT NULL,
  `severity` ENUM('warning','high','catastrophic') NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `vsf_run_idx` (`experimentRunId`,`severity`),
  CONSTRAINT `vsf_run_fk`
    FOREIGN KEY (`experimentRunId`) REFERENCES `experiment_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 21. pbo_evaluations
-- ---------------------------------------------------------------------------
CREATE TABLE `pbo_evaluations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `experimentId` INT NOT NULL,
  `candidateCount` INT NOT NULL,
  `partitionCount` INT NOT NULL,
  `pboEstimate` DECIMAL(10,8) NULL,
  `logitRank` DECIMAL(20,10) NULL,
  `sampleCount` INT NOT NULL,
  `confidenceStatus` ENUM('valid','insufficient_candidates','insufficient_partitions','failed') NOT NULL,
  `failureReason` VARCHAR(255) NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `pbo_exp_uq` (`experimentId`),
  CONSTRAINT `pbo_exp_fk`
    FOREIGN KEY (`experimentId`) REFERENCES `research_experiments`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 22. pbo_candidate_rankings
-- ---------------------------------------------------------------------------
CREATE TABLE `pbo_candidate_rankings` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `pboEvaluationId` INT NOT NULL,
  `candidateKey` VARCHAR(64) NOT NULL,
  `inSampleRank` INT NOT NULL,
  `outOfSampleRank` INT NOT NULL,
  `relativeRank` DECIMAL(10,8) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `pbo_rank_uq` (`pboEvaluationId`,`candidateKey`),
  CONSTRAINT `pbo_rank_ev_fk`
    FOREIGN KEY (`pboEvaluationId`) REFERENCES `pbo_evaluations`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 23. pbo_partition_results
-- ---------------------------------------------------------------------------
CREATE TABLE `pbo_partition_results` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `pboEvaluationId` INT NOT NULL,
  `partitionIndex` INT NOT NULL,
  `bestInSampleCandidate` VARCHAR(64) NOT NULL,
  `bestInSampleValue` DECIMAL(20,10) NULL,
  `outOfSampleValue` DECIMAL(20,10) NULL,
  `medianOutOfSample` DECIMAL(20,10) NULL,
  `logitScore` DECIMAL(20,10) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `pbo_part_uq` (`pboEvaluationId`,`partitionIndex`),
  CONSTRAINT `pbo_part_ev_fk`
    FOREIGN KEY (`pboEvaluationId`) REFERENCES `pbo_evaluations`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 24. deflated_sharpe_evaluations
-- ---------------------------------------------------------------------------
CREATE TABLE `deflated_sharpe_evaluations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `experimentId` INT NOT NULL,
  `observedSharpe` DECIMAL(20,10) NULL,
  `deflatedSharpe` DECIMAL(20,10) NULL,
  `numberOfTrials` INT NOT NULL,
  `sampleCount` INT NOT NULL,
  `returnInterval` VARCHAR(32) NOT NULL,
  `annualizationFactor` DECIMAL(20,10) NOT NULL,
  `returnSkewness` DECIMAL(20,10) NULL,
  `returnKurtosis` DECIMAL(20,10) NULL,
  `expectedMaximumSharpe` DECIMAL(20,10) NULL,
  `benchmarkSharpe` DECIMAL(20,10) NULL,
  `netOfCosts` BOOLEAN NOT NULL DEFAULT true,
  `status` ENUM('valid','insufficient_samples','invalid_variance','failed') NOT NULL,
  `failureReason` VARCHAR(255) NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `dsr_exp_uq` (`experimentId`),
  CONSTRAINT `dsr_exp_fk`
    FOREIGN KEY (`experimentId`) REFERENCES `research_experiments`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 25. statistical_audits
-- ---------------------------------------------------------------------------
CREATE TABLE `statistical_audits` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `implementationKey` VARCHAR(64) NOT NULL,
  `implementationVersion` VARCHAR(32) NOT NULL,
  `referenceDefinition` TEXT NOT NULL,
  `implementationStatus` ENUM(
    'canonical','audited_approximation','research_heuristic',
    'known_deviation','failed_audit','deferred'
  ) NOT NULL,
  `knownDeviation` TEXT NULL,
  `minimumSamples` INT NULL,
  `numericalLimitations` TEXT NULL,
  `failurePolicy` VARCHAR(64) NOT NULL,
  `referenceSourceIdentity` VARCHAR(255) NOT NULL,
  `auditVersion` VARCHAR(32) NOT NULL,
  `auditedAt` TIMESTAMP(3) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `sa_key_ver_uq` (`implementationKey`,`implementationVersion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 26. statistical_reference_vectors
-- ---------------------------------------------------------------------------
CREATE TABLE `statistical_reference_vectors` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `statisticalAuditId` INT NOT NULL,
  `vectorKey` VARCHAR(64) NOT NULL,
  `inputVector` TEXT NOT NULL,
  `expectedOutput` TEXT NOT NULL,
  `tolerance` DECIMAL(20,10) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `srv_uq` (`statisticalAuditId`,`vectorKey`),
  CONSTRAINT `srv_audit_fk`
    FOREIGN KEY (`statisticalAuditId`) REFERENCES `statistical_audits`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 27. statistical_audit_results
-- ---------------------------------------------------------------------------
CREATE TABLE `statistical_audit_results` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `statisticalAuditId` INT NOT NULL,
  `referenceVectorId` INT NULL,
  `observedOutput` TEXT NULL,
  `deviation` DECIMAL(20,10) NULL,
  `passed` BOOLEAN NOT NULL,
  `notes` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `sar_audit_idx` (`statisticalAuditId`,`passed`),
  CONSTRAINT `sar_audit_fk`
    FOREIGN KEY (`statisticalAuditId`) REFERENCES `statistical_audits`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `sar_ref_fk`
    FOREIGN KEY (`referenceVectorId`) REFERENCES `statistical_reference_vectors`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 28. unified_challenger_decisions
-- ---------------------------------------------------------------------------
CREATE TABLE `unified_challenger_decisions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `fingerprintSnapshotId` INT NULL,
  `productRegimeSnapshotId` INT NULL,
  `challengerRoutingDecisionId` INT NULL,
  `candidateRiskDecisionId` INT NULL,
  `microstructureExecutionDecisionId` INT NULL,
  `candidateContextDecisionId` INT NULL,
  `championDecisionId` INT NULL,
  `routeRecommendation` VARCHAR(64) NOT NULL,
  `riskMultiplier` DECIMAL(6,4) NOT NULL,
  `microstructureMultiplier` DECIMAL(6,4) NOT NULL,
  `contextMultiplier` DECIMAL(6,4) NOT NULL,
  `finalObserverMultiplier` DECIMAL(6,4) NOT NULL,
  `executionPreference` VARCHAR(64) NULL,
  `decision` ENUM('agree_with_champion','reduce','reject','abstain','conflict','data_failure') NOT NULL,
  `confidence` DECIMAL(6,4) NOT NULL,
  `hardRejections` VARCHAR(500) NOT NULL,
  `conflicts` VARCHAR(500) NOT NULL,
  `missingEvidence` VARCHAR(500) NOT NULL,
  `reasonCodes` VARCHAR(500) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `expiresAt` TIMESTAMP(3) NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ucd_chain_uq` (`decisionChainId`),
  KEY `ucd_decision_idx` (`decision`),
  CONSTRAINT `ucd_chain_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 29. unified_challenger_evidence
-- ---------------------------------------------------------------------------
CREATE TABLE `unified_challenger_evidence` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `unifiedChallengerDecisionId` INT NOT NULL,
  `evidenceKey` VARCHAR(64) NOT NULL,
  `evidenceKind` VARCHAR(64) NOT NULL,
  `contributionMultiplier` DECIMAL(6,4) NULL,
  `reasonCode` VARCHAR(64) NOT NULL,
  `details` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `uce_ucd_idx` (`unifiedChallengerDecisionId`),
  CONSTRAINT `uce_ucd_fk`
    FOREIGN KEY (`unifiedChallengerDecisionId`) REFERENCES `unified_challenger_decisions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 30. observer_incremental_attribution
-- ---------------------------------------------------------------------------
CREATE TABLE `observer_incremental_attribution` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `observerKey` VARCHAR(64) NOT NULL,
  `wouldHaveDecision` VARCHAR(64) NOT NULL,
  `wouldHaveMultiplier` DECIMAL(6,4) NOT NULL,
  `informationCutoff` TIMESTAMP(3) NOT NULL,
  `sourceCategory` ENUM(
    'synthetic_fixture','deterministic_replay','historical_replay',
    'captured_live_shadow','prospective_shadow'
  ) NOT NULL,
  `reasonCode` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `oia_chain_obs_uq` (`decisionChainId`,`observerKey`),
  CONSTRAINT `oia_chain_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 31. champion_challenger_outcome_comparisons
-- ---------------------------------------------------------------------------
CREATE TABLE `champion_challenger_outcome_comparisons` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `championOutcome` VARCHAR(64) NOT NULL,
  `challengerOutcome` VARCHAR(64) NOT NULL,
  `championNetPnl` DECIMAL(30,10) NULL,
  `challengerNetPnl` DECIMAL(30,10) NULL,
  `attributionMode` ENUM(
    'construction_only','deterministic_replay','historical_replay',
    'captured_live_shadow','prospective_shadow'
  ) NOT NULL,
  `notes` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ccoc_chain_uq` (`decisionChainId`),
  CONSTRAINT `ccoc_chain_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 32. claude_attribution_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE `claude_attribution_snapshots` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `snapshotAt` TIMESTAMP(3) NOT NULL,
  `datasetVersionId` INT NULL,
  `approvalRate` DECIMAL(10,6) NULL,
  `rejectionRate` DECIMAL(10,6) NULL,
  `abstentionRate` DECIMAL(10,6) NULL,
  `netOutcomeConditional` DECIMAL(30,10) NULL,
  `falseApprovalRate` DECIMAL(10,6) NULL,
  `falseRejectionRate` DECIMAL(10,6) NULL,
  `incrementalNetContribution` DECIMAL(30,10) NULL,
  `status` ENUM(
    'prospective_evidence_unavailable','insufficient_samples','pending','ready'
  ) NOT NULL DEFAULT 'prospective_evidence_unavailable',
  `notes` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `cas_status_idx` (`status`,`snapshotAt`),
  CONSTRAINT `cas_ds_fk`
    FOREIGN KEY (`datasetVersionId`) REFERENCES `dataset_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 33. challenger_versions
-- ---------------------------------------------------------------------------
CREATE TABLE `challenger_versions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `challengerKey` VARCHAR(64) NOT NULL,
  `challengerVersion` VARCHAR(32) NOT NULL,
  `description` TEXT NOT NULL,
  `codeCommit` VARCHAR(64) NOT NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `status` ENUM('draft','observer','validated_for_research','deprecated','disabled') NOT NULL DEFAULT 'observer',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `cv_key_ver_uq` (`challengerKey`,`challengerVersion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 34. challenger_evaluations
-- ---------------------------------------------------------------------------
CREATE TABLE `challenger_evaluations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `challengerVersionId` INT NOT NULL,
  `experimentId` INT NOT NULL,
  `pboEvaluationId` INT NULL,
  `dsrEvaluationId` INT NULL,
  `netResult` DECIMAL(30,10) NULL,
  `subgroupStability` ENUM('stable','unstable','catastrophic','insufficient') NOT NULL,
  `leakageIncidentsCount` INT NOT NULL DEFAULT 0,
  `notes` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ce_cv_exp_uq` (`challengerVersionId`,`experimentId`),
  CONSTRAINT `ce_cv_fk`
    FOREIGN KEY (`challengerVersionId`) REFERENCES `challenger_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `ce_exp_fk`
    FOREIGN KEY (`experimentId`) REFERENCES `research_experiments`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `ce_pbo_fk`
    FOREIGN KEY (`pboEvaluationId`) REFERENCES `pbo_evaluations`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `ce_dsr_fk`
    FOREIGN KEY (`dsrEvaluationId`) REFERENCES `deflated_sharpe_evaluations`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 35. promotion_criteria
-- ---------------------------------------------------------------------------
CREATE TABLE `promotion_criteria` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `criteriaKey` VARCHAR(64) NOT NULL,
  `criteriaVersion` VARCHAR(32) NOT NULL,
  `description` TEXT NOT NULL,
  `requirements` TEXT NOT NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `status` ENUM('draft','observer','validated_for_research','deprecated','disabled') NOT NULL DEFAULT 'observer',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `pc_key_ver_uq` (`criteriaKey`,`criteriaVersion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 36. promotion_evidence_bundles
-- ---------------------------------------------------------------------------
CREATE TABLE `promotion_evidence_bundles` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `bundleKey` VARCHAR(64) NOT NULL,
  `bundleHash` VARCHAR(64) NOT NULL,
  `experimentId` INT NULL,
  `challengerEvaluationId` INT NULL,
  `pboEvaluationId` INT NULL,
  `dsrEvaluationId` INT NULL,
  `prospectiveEvidenceAvailable` BOOLEAN NOT NULL DEFAULT false,
  `contents` TEXT NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `peb_hash_uq` (`bundleHash`),
  CONSTRAINT `peb_exp_fk`
    FOREIGN KEY (`experimentId`) REFERENCES `research_experiments`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `peb_ce_fk`
    FOREIGN KEY (`challengerEvaluationId`) REFERENCES `challenger_evaluations`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 37. model_promotion_decisions
-- ---------------------------------------------------------------------------
CREATE TABLE `model_promotion_decisions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `challengerVersionId` INT NOT NULL,
  `registeredExperimentId` INT NOT NULL,
  `promotionCriteriaId` INT NOT NULL,
  `evidenceBundleId` INT NOT NULL,
  `previousChampionVersion` VARCHAR(32) NOT NULL,
  `newChampionVersion` VARCHAR(32) NULL,
  `rollbackVersion` VARCHAR(32) NOT NULL,
  `humanApprovalActor` VARCHAR(128) NULL,
  `humanApprovalAt` TIMESTAMP(3) NULL,
  `decision` ENUM('approved','rejected','blocked','pending') NOT NULL DEFAULT 'blocked',
  `blockReasons` VARCHAR(1000) NOT NULL,
  `deploymentPlan` TEXT NULL,
  `evidenceBundleHash` VARCHAR(64) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `mpd_status_idx` (`decision`),
  CONSTRAINT `mpd_cv_fk`
    FOREIGN KEY (`challengerVersionId`) REFERENCES `challenger_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `mpd_exp_fk`
    FOREIGN KEY (`registeredExperimentId`) REFERENCES `research_experiments`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `mpd_criteria_fk`
    FOREIGN KEY (`promotionCriteriaId`) REFERENCES `promotion_criteria`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `mpd_bundle_fk`
    FOREIGN KEY (`evidenceBundleId`) REFERENCES `promotion_evidence_bundles`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 38. rollback_records
-- ---------------------------------------------------------------------------
CREATE TABLE `rollback_records` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `modelPromotionDecisionId` INT NOT NULL,
  `rollbackVersion` VARCHAR(32) NOT NULL,
  `rollbackConditions` TEXT NOT NULL,
  `executed` BOOLEAN NOT NULL DEFAULT false,
  `executedAt` TIMESTAMP(3) NULL,
  `executorActor` VARCHAR(128) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `rr_mpd_idx` (`modelPromotionDecisionId`),
  CONSTRAINT `rr_mpd_fk`
    FOREIGN KEY (`modelPromotionDecisionId`) REFERENCES `model_promotion_decisions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 39. kelly_activation_evaluations
-- ---------------------------------------------------------------------------
CREATE TABLE `kelly_activation_evaluations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `challengerVersionId` INT NULL,
  `experimentId` INT NULL,
  `sampleCount` INT NOT NULL,
  `netOutcomeMean` DECIMAL(30,10) NULL,
  `posteriorLowerBound` DECIMAL(30,10) NULL,
  `bayesianShrinkageApplied` BOOLEAN NOT NULL DEFAULT false,
  `calibrationStable` BOOLEAN NOT NULL DEFAULT false,
  `regimeStable` BOOLEAN NOT NULL DEFAULT false,
  `productStable` BOOLEAN NOT NULL DEFAULT false,
  `quarterKellyCapEnforced` BOOLEAN NOT NULL DEFAULT true,
  `minimumFloorEnforced` BOOLEAN NOT NULL DEFAULT false,
  `humanApprovalActor` VARCHAR(128) NULL,
  `outcome` ENUM('rejected_not_calibrated','disabled','deferred') NOT NULL DEFAULT 'rejected_not_calibrated',
  `reasonCodes` VARCHAR(500) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `kae_outcome_idx` (`outcome`),
  CONSTRAINT `kae_cv_fk`
    FOREIGN KEY (`challengerVersionId`) REFERENCES `challenger_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `kae_exp_fk`
    FOREIGN KEY (`experimentId`) REFERENCES `research_experiments`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 40. validation_incidents
-- ---------------------------------------------------------------------------
CREATE TABLE `validation_incidents` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `experimentId` INT NULL,
  `experimentRunId` INT NULL,
  `foldId` INT NULL,
  `cpcvPathId` INT NULL,
  `datasetVersionId` INT NULL,
  `incidentType` ENUM(
    'future_observation','future_label','revised_data_leak',
    'overlapping_label_horizon','train_test_overlap','embargo_violation',
    'final_holdout_contamination','product_survivorship','future_universe_selection',
    'outcome_informed_exclusion','cost_model_version_leak','feature_version_mismatch',
    'champion_challenger_version_mismatch','statistical_audit_failure','other'
  ) NOT NULL,
  `severity` ENUM('warning','high','blocking') NOT NULL,
  `reasonCode` VARCHAR(64) NOT NULL,
  `details` TEXT NULL,
  `detectedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `vi_type_idx` (`incidentType`,`severity`),
  KEY `vi_run_idx` (`experimentRunId`),
  CONSTRAINT `vi_exp_fk`
    FOREIGN KEY (`experimentId`) REFERENCES `research_experiments`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `vi_run_fk`
    FOREIGN KEY (`experimentRunId`) REFERENCES `experiment_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `vi_fold_fk`
    FOREIGN KEY (`foldId`) REFERENCES `validation_folds`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `vi_path_fk`
    FOREIGN KEY (`cpcvPathId`) REFERENCES `cpcv_paths`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `vi_ds_fk`
    FOREIGN KEY (`datasetVersionId`) REFERENCES `dataset_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
