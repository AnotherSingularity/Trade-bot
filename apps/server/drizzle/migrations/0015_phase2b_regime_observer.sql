-- Phase 2B — regime-state observer, change detection, and challenger routing.
--
-- Additive DDL. Migrations 0000-0014 remain immutable. This migration adds:
--   1.  regime_definitions                       — versioned regime catalog
--   2.  regime_transition_policies               — versioned hysteresis rules
--   3.  regime_observer_runs                     — one row per observer pass
--   4.  global_regime_snapshots                  — per-observer global state
--   5.  product_regime_snapshots                 — per-observer product state
--   6.  regime_evidence                          — per-snapshot evidence rows
--   7.  change_point_events                      — CUSUM + secondary detector
--   8.  latent_state_model_versions              — versioned HMM configuration
--   9.  latent_state_assignments                 — per-observation latent state
--  10.  latent_state_mappings                    — latent → semantic mapping
--  11.  regime_transitions                       — append-only journal
--  12.  challenger_routing_decisions             — research-only routing
--  13.  champion_challenger_routing_comparisons  — post-hoc comparison

-- ---------------------------------------------------------------------------
-- 1. regime_definitions
-- ---------------------------------------------------------------------------
CREATE TABLE `regime_definitions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `regimeKey` VARCHAR(64) NOT NULL,
  `regimeVersion` VARCHAR(32) NOT NULL,
  `scope` ENUM('global','product') NOT NULL,
  `description` TEXT NOT NULL,
  `requiredEvidence` TEXT NOT NULL,
  `minimumValidEvidence` INT NOT NULL,
  `conflictPolicy` VARCHAR(64) NOT NULL,
  `missingDataPolicy` VARCHAR(64) NOT NULL,
  `transitionPolicyVersion` VARCHAR(32) NOT NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `status` ENUM('draft','observer','validated_for_research','deprecated','disabled')
    NOT NULL DEFAULT 'observer',
  `supersedesDefinitionId` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `regime_defs_key_ver_uq` (`regimeKey`, `regimeVersion`),
  KEY `regime_defs_scope_status_idx` (`scope`, `status`),
  CONSTRAINT `regime_defs_supersedes_fk`
    FOREIGN KEY (`supersedesDefinitionId`) REFERENCES `regime_definitions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. regime_transition_policies
-- ---------------------------------------------------------------------------
CREATE TABLE `regime_transition_policies` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `policyVersion` VARCHAR(32) NOT NULL,
  `minimumDwellObservations` INT NOT NULL,
  `candidateConfirmationCount` INT NOT NULL,
  `minimumTransitionConfidence` DECIMAL(6,4) NOT NULL,
  `emergencyOverrideStates` TEXT NOT NULL,
  `confidenceDecay` DECIMAL(6,4) NOT NULL,
  `staleStateExpiryMs` INT NOT NULL,
  `transitionMatrixPolicy` VARCHAR(64) NOT NULL,
  `description` TEXT NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `regime_trans_policy_ver_uq` (`policyVersion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. regime_observer_runs
-- ---------------------------------------------------------------------------
CREATE TABLE `regime_observer_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `snapshotId` INT NOT NULL,
  `startedAt` TIMESTAMP(3) NOT NULL,
  `completedAt` TIMESTAMP(3) NULL,
  `productsConsidered` INT NOT NULL DEFAULT 0,
  `globalStatesEmitted` INT NOT NULL DEFAULT 0,
  `productStatesEmitted` INT NOT NULL DEFAULT 0,
  `unknownCount` INT NOT NULL DEFAULT 0,
  `disorderedCount` INT NOT NULL DEFAULT 0,
  `observerVersion` VARCHAR(32) NOT NULL,
  `transitionPolicyVersion` VARCHAR(32) NOT NULL,
  `notes` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `regime_runs_snap_idx` (`snapshotId`),
  CONSTRAINT `regime_runs_snapshot_fk`
    FOREIGN KEY (`snapshotId`) REFERENCES `universe_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. global_regime_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE `global_regime_snapshots` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `observerRunId` INT NOT NULL,
  `regimeKey` VARCHAR(64) NOT NULL,
  `regimeVersion` VARCHAR(32) NOT NULL,
  `state` ENUM('TREND_UP','TREND_DOWN','RANGE','VOLATILITY_EXPANSION',
               'CAPITULATION','DISORDERED','UNKNOWN') NOT NULL,
  `status` ENUM('valid','low_confidence','insufficient_history','stale',
                'gap_detected','conflicted','numerical_failure','quarantined','unknown')
    NOT NULL,
  `confidence` DECIMAL(6,4) NOT NULL DEFAULT 0,
  `inputHash` VARCHAR(64) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `diagnostics` TEXT NULL,
  `failureReason` VARCHAR(255) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `global_regime_run_uq` (`observerRunId`),
  KEY `global_regime_state_idx` (`state`, `status`),
  CONSTRAINT `global_regime_run_fk`
    FOREIGN KEY (`observerRunId`) REFERENCES `regime_observer_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. product_regime_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE `product_regime_snapshots` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `observerRunId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `regimeKey` VARCHAR(64) NOT NULL,
  `regimeVersion` VARCHAR(32) NOT NULL,
  `rawState` ENUM('TREND_UP','TREND_DOWN','RANGE','VOLATILITY_EXPANSION',
                  'CAPITULATION','DISORDERED','UNKNOWN') NOT NULL,
  `smoothedState` ENUM('TREND_UP','TREND_DOWN','RANGE','VOLATILITY_EXPANSION',
                       'CAPITULATION','DISORDERED','UNKNOWN') NOT NULL,
  `status` ENUM('valid','low_confidence','insufficient_history','stale',
                'gap_detected','conflicted','numerical_failure','quarantined','unknown')
    NOT NULL,
  `confidence` DECIMAL(6,4) NOT NULL DEFAULT 0,
  `globalStateId` INT NULL,
  `fingerprintSnapshotId` INT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `diagnostics` TEXT NULL,
  `failureReason` VARCHAR(255) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `product_regime_run_prod_uq` (`observerRunId`, `productId`),
  KEY `product_regime_state_idx` (`rawState`, `smoothedState`),
  KEY `product_regime_prod_idx` (`productId`, `observedAt`),
  CONSTRAINT `product_regime_run_fk`
    FOREIGN KEY (`observerRunId`) REFERENCES `regime_observer_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `product_regime_global_fk`
    FOREIGN KEY (`globalStateId`) REFERENCES `global_regime_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `product_regime_fingerprint_fk`
    FOREIGN KEY (`fingerprintSnapshotId`) REFERENCES `fingerprint_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. regime_evidence
-- ---------------------------------------------------------------------------
CREATE TABLE `regime_evidence` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `scope` ENUM('global','product') NOT NULL,
  `globalRegimeId` INT NULL,
  `productRegimeId` INT NULL,
  `component` VARCHAR(64) NOT NULL,
  `componentVersion` VARCHAR(32) NOT NULL,
  `role` ENUM('supporting','conflicting','missing') NOT NULL,
  `weight` DECIMAL(6,4) NOT NULL DEFAULT 0,
  `detail` TEXT NULL,
  `featureValueId` INT NULL,
  `changePointEventId` INT NULL,
  `latentStateAssignmentId` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `regime_evidence_global_idx` (`globalRegimeId`),
  KEY `regime_evidence_product_idx` (`productRegimeId`),
  KEY `regime_evidence_component_idx` (`component`, `role`),
  CONSTRAINT `regime_evidence_global_fk`
    FOREIGN KEY (`globalRegimeId`) REFERENCES `global_regime_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `regime_evidence_product_fk`
    FOREIGN KEY (`productRegimeId`) REFERENCES `product_regime_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. change_point_events
-- ---------------------------------------------------------------------------
CREATE TABLE `change_point_events` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `observerRunId` INT NOT NULL,
  `scope` ENUM('global','product') NOT NULL,
  `productId` VARCHAR(30) NULL,
  `detector` ENUM('cusum','segmented_variance','bocpd_deferred') NOT NULL,
  `detectorVersion` VARCHAR(32) NOT NULL,
  `direction` ENUM('up','down','either','none') NOT NULL,
  `magnitude` DECIMAL(20,10) NULL,
  `changeProbability` DECIMAL(6,4) NULL,
  `runLengthEstimate` INT NULL,
  `thresholdVersion` VARCHAR(32) NOT NULL,
  `hazardPolicyVersion` VARCHAR(32) NULL,
  `numericalStatus` ENUM('ok','underflow_handled','overflow_handled','failure') NOT NULL DEFAULT 'ok',
  `confidence` DECIMAL(6,4) NOT NULL DEFAULT 0,
  `detectedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `diagnostics` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `change_pt_run_idx` (`observerRunId`),
  KEY `change_pt_prod_idx` (`productId`, `detectedAt`),
  KEY `change_pt_detector_idx` (`detector`, `direction`),
  CONSTRAINT `change_pt_run_fk`
    FOREIGN KEY (`observerRunId`) REFERENCES `regime_observer_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. latent_state_model_versions
-- ---------------------------------------------------------------------------
CREATE TABLE `latent_state_model_versions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `modelKey` VARCHAR(64) NOT NULL,
  `modelVersion` VARCHAR(32) NOT NULL,
  `numLatentStates` INT NOT NULL,
  `observationDimensions` TEXT NOT NULL,
  `initializationPolicy` VARCHAR(64) NOT NULL,
  `convergencePolicy` VARCHAR(64) NOT NULL,
  `maxIterations` INT NOT NULL,
  `numericalPolicy` VARCHAR(64) NOT NULL,
  `deterministicSeed` INT NOT NULL,
  `trainingWindowStart` TIMESTAMP(3) NOT NULL,
  `trainingWindowEnd` TIMESTAMP(3) NOT NULL,
  `trainingSampleCount` INT NOT NULL,
  `converged` BOOLEAN NOT NULL DEFAULT FALSE,
  `finalLogLikelihood` DECIMAL(20,10) NULL,
  `implementationHash` VARCHAR(64) NOT NULL,
  `status` ENUM('draft','observer','deprecated','disabled') NOT NULL DEFAULT 'observer',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `latent_model_key_ver_uq` (`modelKey`, `modelVersion`),
  KEY `latent_model_status_idx` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. latent_state_assignments
-- ---------------------------------------------------------------------------
CREATE TABLE `latent_state_assignments` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `modelVersionId` INT NOT NULL,
  `observerRunId` INT NOT NULL,
  `productId` VARCHAR(30) NULL,
  `scope` ENUM('global','product') NOT NULL,
  `latentState` INT NOT NULL,
  `posterior` DECIMAL(6,4) NOT NULL DEFAULT 0,
  `logLikelihood` DECIMAL(20,10) NULL,
  `numericalStatus` ENUM('ok','underflow_handled','overflow_handled','failure') NOT NULL DEFAULT 'ok',
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `diagnostics` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `latent_assign_run_idx` (`observerRunId`),
  KEY `latent_assign_prod_idx` (`productId`),
  KEY `latent_assign_model_idx` (`modelVersionId`),
  CONSTRAINT `latent_assign_model_fk`
    FOREIGN KEY (`modelVersionId`) REFERENCES `latent_state_model_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `latent_assign_run_fk`
    FOREIGN KEY (`observerRunId`) REFERENCES `regime_observer_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 10. latent_state_mappings
-- ---------------------------------------------------------------------------
CREATE TABLE `latent_state_mappings` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `modelVersionId` INT NOT NULL,
  `latentState` INT NOT NULL,
  `semanticState` ENUM('TREND_UP','TREND_DOWN','RANGE','VOLATILITY_EXPANSION',
                       'CAPITULATION','DISORDERED','UNKNOWN') NOT NULL,
  `mappingEvidence` TEXT NOT NULL,
  `mappingConfidence` DECIMAL(6,4) NOT NULL DEFAULT 0,
  `mappedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `mappingVersion` VARCHAR(32) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `latent_map_model_state_ver_uq`
    (`modelVersionId`, `latentState`, `mappingVersion`),
  CONSTRAINT `latent_map_model_fk`
    FOREIGN KEY (`modelVersionId`) REFERENCES `latent_state_model_versions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 11. regime_transitions
-- ---------------------------------------------------------------------------
CREATE TABLE `regime_transitions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `observerRunId` INT NOT NULL,
  `productId` VARCHAR(30) NULL,
  `scope` ENUM('global','product') NOT NULL,
  `previousState` ENUM('TREND_UP','TREND_DOWN','RANGE','VOLATILITY_EXPANSION',
                       'CAPITULATION','DISORDERED','UNKNOWN') NOT NULL,
  `candidateState` ENUM('TREND_UP','TREND_DOWN','RANGE','VOLATILITY_EXPANSION',
                        'CAPITULATION','DISORDERED','UNKNOWN') NOT NULL,
  `finalState` ENUM('TREND_UP','TREND_DOWN','RANGE','VOLATILITY_EXPANSION',
                    'CAPITULATION','DISORDERED','UNKNOWN') NOT NULL,
  `transitionAccepted` BOOLEAN NOT NULL DEFAULT FALSE,
  `reasonCodes` VARCHAR(255) NOT NULL,
  `confidenceBefore` DECIMAL(6,4) NOT NULL DEFAULT 0,
  `confidenceAfter` DECIMAL(6,4) NOT NULL DEFAULT 0,
  `changePointEventId` INT NULL,
  `transitionPolicyVersion` VARCHAR(32) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `regime_trans_run_idx` (`observerRunId`),
  KEY `regime_trans_prod_idx` (`productId`, `observedAt`),
  CONSTRAINT `regime_trans_run_fk`
    FOREIGN KEY (`observerRunId`) REFERENCES `regime_observer_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `regime_trans_changept_fk`
    FOREIGN KEY (`changePointEventId`) REFERENCES `change_point_events`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 12. challenger_routing_decisions
-- ---------------------------------------------------------------------------
CREATE TABLE `challenger_routing_decisions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `observerRunId` INT NOT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `productRegimeId` INT NULL,
  `globalRegimeId` INT NULL,
  `fingerprintSnapshotId` INT NULL,
  `recommendation` ENUM('REVERSION','BREAKOUT','MACRO_FLOOR_RESEARCH',
                        'NO_TRADE','ABSTAIN','CONFLICT') NOT NULL,
  `confidence` DECIMAL(6,4) NOT NULL DEFAULT 0,
  `reasonCodes` VARCHAR(255) NOT NULL,
  `routerVersion` VARCHAR(32) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `inputHash` VARCHAR(64) NOT NULL,
  `diagnostics` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `challenger_run_prod_uq` (`observerRunId`, `productId`),
  KEY `challenger_recommendation_idx` (`recommendation`),
  CONSTRAINT `challenger_run_fk`
    FOREIGN KEY (`observerRunId`) REFERENCES `regime_observer_runs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `challenger_product_regime_fk`
    FOREIGN KEY (`productRegimeId`) REFERENCES `product_regime_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `challenger_global_regime_fk`
    FOREIGN KEY (`globalRegimeId`) REFERENCES `global_regime_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `challenger_fingerprint_fk`
    FOREIGN KEY (`fingerprintSnapshotId`) REFERENCES `fingerprint_snapshots`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 13. champion_challenger_routing_comparisons
-- ---------------------------------------------------------------------------
CREATE TABLE `champion_challenger_routing_comparisons` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `decisionChainId` INT NOT NULL,
  `challengerDecisionId` INT NULL,
  `productId` VARCHAR(30) NOT NULL,
  `championMode` VARCHAR(64) NULL,
  `championDecision` VARCHAR(64) NOT NULL,
  `challengerRecommendation` ENUM('REVERSION','BREAKOUT','MACRO_FLOOR_RESEARCH',
                                  'NO_TRADE','ABSTAIN','CONFLICT') NOT NULL,
  `globalRegimeState` ENUM('TREND_UP','TREND_DOWN','RANGE','VOLATILITY_EXPANSION',
                           'CAPITULATION','DISORDERED','UNKNOWN') NULL,
  `productRegimeState` ENUM('TREND_UP','TREND_DOWN','RANGE','VOLATILITY_EXPANSION',
                            'CAPITULATION','DISORDERED','UNKNOWN') NULL,
  `fingerprintClass` VARCHAR(64) NULL,
  `agreementState` ENUM('agree','partial_agreement','disagree',
                        'champion_only','challenger_abstained','unresolved') NOT NULL,
  `reasonCodes` VARCHAR(255) NOT NULL,
  `observerVersion` VARCHAR(32) NOT NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `dataAvailableAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `champ_chal_chain_uq` (`decisionChainId`),
  KEY `champ_chal_agreement_idx` (`agreementState`),
  CONSTRAINT `champ_chal_chain_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `champ_chal_challenger_fk`
    FOREIGN KEY (`challengerDecisionId`) REFERENCES `challenger_routing_decisions`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
