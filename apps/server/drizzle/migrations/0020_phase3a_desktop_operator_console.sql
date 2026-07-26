-- Phase 3A — desktop operator console persistence.
--
-- Additive DDL. Migrations 0000-0019 remain immutable. This migration adds
-- 10 desktop-specific tables that capture install identity, session
-- lifecycle, service state history, configuration audit trail, operator
-- actions, export jobs + artifacts, desktop-scoped incidents, and build
-- manifests. Existing system incident and configuration truth is NOT
-- duplicated — desktop tables only record desktop-scoped facts.
--
-- Secrets never enter these tables.

-- ---------------------------------------------------------------------------
-- 1. desktop_installations
-- ---------------------------------------------------------------------------
CREATE TABLE `desktop_installations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `installationKey` VARCHAR(64) NOT NULL,
  `desktopVersion` VARCHAR(32) NOT NULL,
  `buildCommit` VARCHAR(64) NOT NULL,
  `platform` ENUM('win32','darwin','linux') NOT NULL,
  `firstInstalledAt` TIMESTAMP(3) NOT NULL,
  `lastLaunchAt` TIMESTAMP(3) NULL,
  `machineFingerprint` VARCHAR(128) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `desk_inst_key_uq` (`installationKey`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. desktop_sessions
-- ---------------------------------------------------------------------------
CREATE TABLE `desktop_sessions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `installationId` INT NOT NULL,
  `sessionTokenHash` VARCHAR(128) NOT NULL,
  `actor` VARCHAR(128) NOT NULL,
  `createdAt` TIMESTAMP(3) NOT NULL,
  `expiresAt` TIMESTAMP(3) NOT NULL,
  `revokedAt` TIMESTAMP(3) NULL,
  `revokeReason` VARCHAR(255) NULL,
  `createdRow` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `desk_sess_token_uq` (`sessionTokenHash`),
  KEY `desk_sess_inst_idx` (`installationId`,`createdAt`),
  CONSTRAINT `desk_sess_inst_fk`
    FOREIGN KEY (`installationId`) REFERENCES `desktop_installations`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. desktop_service_states
-- ---------------------------------------------------------------------------
CREATE TABLE `desktop_service_states` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `installationId` INT NOT NULL,
  `serviceKind` ENUM(
    'desktop_shell','server','scanner_worker','reconciliation_worker',
    'mariadb','redis','market_data','reporting'
  ) NOT NULL,
  `state` ENUM(
    'not_configured','checking_dependencies','starting','migrating',
    'synchronizing','healthy','degraded','stopping','stopped','failed','recovery_required'
  ) NOT NULL,
  `restartCount` INT NOT NULL DEFAULT 0,
  `crashLoopDetected` BOOLEAN NOT NULL DEFAULT FALSE,
  `detail` VARCHAR(500) NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `desk_svc_state_uq` (`installationId`,`serviceKind`),
  KEY `desk_svc_state_state_idx` (`state`),
  CONSTRAINT `desk_svc_state_inst_fk`
    FOREIGN KEY (`installationId`) REFERENCES `desktop_installations`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. desktop_service_events
-- ---------------------------------------------------------------------------
CREATE TABLE `desktop_service_events` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `installationId` INT NOT NULL,
  `serviceKind` ENUM(
    'desktop_shell','server','scanner_worker','reconciliation_worker',
    'mariadb','redis','market_data','reporting'
  ) NOT NULL,
  `previousState` VARCHAR(32) NOT NULL,
  `newState` VARCHAR(32) NOT NULL,
  `reasonCode` VARCHAR(64) NOT NULL,
  `detail` VARCHAR(500) NULL,
  `observedAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `desk_svc_evt_inst_idx` (`installationId`,`observedAt`),
  KEY `desk_svc_evt_svc_idx` (`serviceKind`,`observedAt`),
  CONSTRAINT `desk_svc_evt_inst_fk`
    FOREIGN KEY (`installationId`) REFERENCES `desktop_installations`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. desktop_configuration_versions
-- ---------------------------------------------------------------------------
CREATE TABLE `desktop_configuration_versions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `installationId` INT NOT NULL,
  `configKey` VARCHAR(64) NOT NULL,
  `configVersion` INT NOT NULL,
  `previousValue` TEXT NULL,
  `newValue` TEXT NOT NULL,
  `changedBy` VARCHAR(128) NOT NULL,
  `confirmationText` VARCHAR(255) NOT NULL,
  `changedAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `desk_cfg_ver_uq` (`installationId`,`configKey`,`configVersion`),
  CONSTRAINT `desk_cfg_ver_inst_fk`
    FOREIGN KEY (`installationId`) REFERENCES `desktop_installations`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. desktop_operator_actions
-- ---------------------------------------------------------------------------
CREATE TABLE `desktop_operator_actions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `installationId` INT NOT NULL,
  `actor` VARCHAR(128) NOT NULL,
  `actionKind` ENUM(
    'login','logout','session_expiry','session_revoke','service_start',
    'service_stop','service_restart','config_change_request','export_request',
    'incident_acknowledge','password_change','admin_setup'
  ) NOT NULL,
  `outcome` ENUM('success','failure','rejected','pending') NOT NULL,
  `details` TEXT NULL,
  `occurredAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `desk_op_act_inst_idx` (`installationId`,`occurredAt`),
  KEY `desk_op_act_kind_idx` (`actionKind`,`outcome`),
  CONSTRAINT `desk_op_act_inst_fk`
    FOREIGN KEY (`installationId`) REFERENCES `desktop_installations`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. desktop_export_jobs
-- ---------------------------------------------------------------------------
CREATE TABLE `desktop_export_jobs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `installationId` INT NOT NULL,
  `reportKind` ENUM(
    'decision_chain','daily_shadow','portfolio_risk','universe_and_hygiene',
    'fingerprints','regimes','microstructure','context','cost_attribution',
    'validation','incidents','safety_status','system_manifest'
  ) NOT NULL,
  `format` ENUM('json','csv','html') NOT NULL,
  `referenceId` VARCHAR(128) NULL,
  `targetFolder` VARCHAR(500) NOT NULL,
  `requestedBy` VARCHAR(128) NOT NULL,
  `requestedAt` TIMESTAMP(3) NOT NULL,
  `completedAt` TIMESTAMP(3) NULL,
  `status` ENUM('queued','running','completed','failed') NOT NULL DEFAULT 'queued',
  `failureReason` VARCHAR(500) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `desk_exp_job_status_idx` (`status`,`requestedAt`),
  CONSTRAINT `desk_exp_job_inst_fk`
    FOREIGN KEY (`installationId`) REFERENCES `desktop_installations`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. desktop_export_artifacts
-- ---------------------------------------------------------------------------
CREATE TABLE `desktop_export_artifacts` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `exportJobId` INT NOT NULL,
  `artifactPath` VARCHAR(500) NOT NULL,
  `checksumSha256` VARCHAR(64) NOT NULL,
  `sizeBytes` BIGINT NOT NULL,
  `reportVersion` VARCHAR(32) NOT NULL,
  `redactionsApplied` VARCHAR(500) NOT NULL,
  `generatedAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `desk_exp_art_job_uq` (`exportJobId`),
  KEY `desk_exp_art_hash_idx` (`checksumSha256`),
  CONSTRAINT `desk_exp_art_job_fk`
    FOREIGN KEY (`exportJobId`) REFERENCES `desktop_export_jobs`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. desktop_incidents
-- ---------------------------------------------------------------------------
CREATE TABLE `desktop_incidents` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `installationId` INT NOT NULL,
  `incidentType` ENUM(
    'startup_failure','service_crash_loop','dependency_missing',
    'schema_mismatch','safe_flag_violation','ipc_validation_failure',
    'authentication_failure','session_revoked','export_failure',
    'controlled_change_blocked','packaging_verification_missing'
  ) NOT NULL,
  `severity` ENUM('informational','degraded','high','blocking') NOT NULL,
  `reasonCode` VARCHAR(64) NOT NULL,
  `details` TEXT NULL,
  `startedAt` TIMESTAMP(3) NOT NULL,
  `resolvedAt` TIMESTAMP(3) NULL,
  `acknowledgedAt` TIMESTAMP(3) NULL,
  `acknowledgedBy` VARCHAR(128) NULL,
  `currentState` ENUM('open','acknowledged','resolved') NOT NULL DEFAULT 'open',
  `runbookUrl` VARCHAR(500) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `desk_inc_type_idx` (`incidentType`,`severity`),
  KEY `desk_inc_state_idx` (`currentState`,`startedAt`),
  CONSTRAINT `desk_inc_inst_fk`
    FOREIGN KEY (`installationId`) REFERENCES `desktop_installations`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 10. desktop_build_manifests
-- ---------------------------------------------------------------------------
CREATE TABLE `desktop_build_manifests` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `desktopVersion` VARCHAR(32) NOT NULL,
  `buildCommit` VARCHAR(64) NOT NULL,
  `buildTimestamp` TIMESTAMP(3) NOT NULL,
  `platform` ENUM('win32','darwin','linux') NOT NULL,
  `installerFilename` VARCHAR(255) NULL,
  `installerSizeBytes` BIGINT NULL,
  `installerSha256` VARCHAR(64) NULL,
  `artifactStatus` ENUM('pending','built','verified','absent') NOT NULL DEFAULT 'absent',
  `verifiedBy` VARCHAR(128) NULL,
  `verifiedAt` TIMESTAMP(3) NULL,
  `signingStatus` ENUM('unsigned','signed_self','signed_certificate','pending_signing') NOT NULL DEFAULT 'unsigned',
  `notes` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `desk_build_manifest_uq` (`desktopVersion`,`buildCommit`,`platform`),
  KEY `desk_build_status_idx` (`artifactStatus`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
