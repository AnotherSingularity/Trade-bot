-- Stage 2 — desktop operator authentication.
--
-- Additive DDL. Migrations 0000-0020 remain immutable. Adds five
-- dedicated tables that model the single-operator authentication
-- boundary spanning bootstrap → operator session → account.
--
-- Not overloaded on desktop_sessions (0020) — those are
-- application-runtime records; operator sessions live here with
-- password state, refresh rotation, session families, and append-only
-- events.

-- ---------------------------------------------------------------------------
-- 1. local_operator_accounts
-- ---------------------------------------------------------------------------
CREATE TABLE `local_operator_accounts` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(128) NOT NULL,
  `usernameNormalized` VARCHAR(128) NOT NULL,
  `passwordHashHex` VARCHAR(256) NOT NULL,
  `passwordSaltHex` VARCHAR(128) NOT NULL,
  `passwordAlgorithm` VARCHAR(32) NOT NULL,
  `passwordParameters` JSON NOT NULL,
  `credentialVersion` INT NOT NULL DEFAULT 1,
  `status` ENUM('active','locked','disabled','recovery_required') NOT NULL DEFAULT 'active',
  `failedLoginCount` INT NOT NULL DEFAULT 0,
  `lockedUntil` TIMESTAMP(3) NULL,
  `passwordChangedAt` TIMESTAMP(3) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `loa_username_norm_uq` (`usernameNormalized`)
);

-- ---------------------------------------------------------------------------
-- 2. operator_auth_sessions
-- ---------------------------------------------------------------------------
CREATE TABLE `operator_auth_sessions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `accountId` INT NOT NULL,
  `installationId` INT NULL,
  `sessionFamilyId` CHAR(36) NOT NULL,
  `accessTokenHash` VARCHAR(128) NOT NULL,
  `refreshTokenHash` VARCHAR(128) NOT NULL,
  `accessExpiresAt` TIMESTAMP(3) NOT NULL,
  `refreshExpiresAt` TIMESTAMP(3) NOT NULL,
  `absoluteExpiresAt` TIMESTAMP(3) NOT NULL,
  `rotatedFromTokenId` INT NULL,
  `revokedAt` TIMESTAMP(3) NULL,
  `revocationReason` VARCHAR(64) NULL,
  `createdAt` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastUsedAt` TIMESTAMP(3) NULL,
  `clientVersion` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `oas_access_uq` (`accessTokenHash`),
  UNIQUE KEY `oas_refresh_uq` (`refreshTokenHash`),
  KEY `oas_family_idx` (`sessionFamilyId`, `createdAt`),
  KEY `oas_account_idx` (`accountId`, `createdAt`),
  CONSTRAINT `oas_account_fk` FOREIGN KEY (`accountId`) REFERENCES `local_operator_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- ---------------------------------------------------------------------------
-- 3. operator_auth_events (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE `operator_auth_events` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `eventType` VARCHAR(64) NOT NULL,
  `accountId` INT NULL,
  `sessionId` INT NULL,
  `installationId` INT NULL,
  `occurredAt` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `source` VARCHAR(32) NOT NULL,
  `reasonCode` VARCHAR(64) NULL,
  `sanitizedMetadata` JSON NULL,
  PRIMARY KEY (`id`),
  KEY `oae_time_idx` (`occurredAt`),
  KEY `oae_type_idx` (`eventType`, `occurredAt`),
  KEY `oae_account_idx` (`accountId`, `occurredAt`)
);

-- ---------------------------------------------------------------------------
-- 4. operator_login_limits (persistent lockout state)
-- ---------------------------------------------------------------------------
CREATE TABLE `operator_login_limits` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `keyType` ENUM('username','installation','composite') NOT NULL,
  `compositeKey` VARCHAR(255) NOT NULL,
  `failedAttempts` INT NOT NULL DEFAULT 0,
  `firstAttemptAt` TIMESTAMP(3) NULL,
  `lastAttemptAt` TIMESTAMP(3) NULL,
  `lockedUntil` TIMESTAMP(3) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `oll_key_uq` (`keyType`, `compositeKey`)
);

-- ---------------------------------------------------------------------------
-- 5. operator_recovery_records
-- ---------------------------------------------------------------------------
CREATE TABLE `operator_recovery_records` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `accountId` INT NOT NULL,
  `method` VARCHAR(64) NOT NULL,
  `requestedAt` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `performedAt` TIMESTAMP(3) NULL,
  `operatorNote` VARCHAR(500) NULL,
  PRIMARY KEY (`id`),
  KEY `orr_account_idx` (`accountId`, `requestedAt`),
  CONSTRAINT `orr_account_fk` FOREIGN KEY (`accountId`) REFERENCES `local_operator_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
);
