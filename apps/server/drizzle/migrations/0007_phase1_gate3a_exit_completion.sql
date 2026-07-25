-- Phase 1.1 Gate 3A — exit + recovery completion.
--
-- Additive DDL. Migrations 0000-0006 remain immutable.
--
-- Adds:
--   1. Extended positions.lifecycleState enum for the canonical position
--      state model (§A).
--   2. Dust policy fields on positions (§F).
--   3. Protection state field on positions (§Q — placeholder; the full
--      protection capability matrix lands in Gate 3C).

-- ---------------------------------------------------------------------------
-- 1. Position lifecycle state — canonical model
--
-- MariaDB's ENUM MODIFY is safe: the operation only ADDS new values (all
-- existing rows' values remain valid). The old drizzle enum was:
--   ('opening', 'open', 'closing', 'closed', 'reconciling')
-- New enum adds:
--   'partially_open', 'open_unprotected', 'open_protected',
--   'partially_closing', 'dust_residual', 'reconciliation_required',
--   'failed'
-- ---------------------------------------------------------------------------
ALTER TABLE `positions`
  MODIFY COLUMN `lifecycleState` ENUM(
    'opening',
    'open',
    'closing',
    'closed',
    'reconciling',
    'pending_entry',
    'partially_open',
    'open_unprotected',
    'open_protected',
    'partially_closing',
    'dust_residual',
    'reconciliation_required',
    'failed'
  ) NOT NULL DEFAULT 'opening';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Dust policy fields — record explicitly, never fabricate a sale.
-- ---------------------------------------------------------------------------
ALTER TABLE `positions`
  ADD COLUMN `dustQuantity` DECIMAL(20, 8),
  ADD COLUMN `dustEstimatedValue` DECIMAL(20, 8),
  ADD COLUMN `dustReason` VARCHAR(64),
  ADD COLUMN `dustDetectedAt` TIMESTAMP NULL,
  ADD COLUMN `dustPolicyVersion` VARCHAR(32);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Protection state (Gate 3A places the field; Gate 3C wires the matrix).
-- ---------------------------------------------------------------------------
ALTER TABLE `positions`
  ADD COLUMN `protectionState` ENUM(
    'unknown',
    'none',
    'polling_only',
    'attached_active',
    'attached_partial',
    'degraded'
  ) NOT NULL DEFAULT 'unknown';
