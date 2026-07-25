-- Phase 1.1 Gate 3D-FIX — runtime-integration certification.
--
-- Additive DDL. Migrations 0000-0010 remain immutable.
--
-- Extends shadow_certification_runs with:
--   - runtimeIntegrated       — was this cert run through the actual
--                                scanner + executor + reconciler paths?
--   - supersedesRunId         — the certificationRunId this run supersedes
--                                (used when the prior cert was module-only)
--   - createOrderFunctionInvocations
--                              — third createOrder counter (function-level)
--
-- All fields default nullable / 0 so the pre-3D-FIX row survives untouched.
ALTER TABLE `shadow_certification_runs`
  ADD COLUMN `runtimeIntegrated` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN `supersedesRunId` VARCHAR(64) NULL,
  ADD COLUMN `createOrderFunctionInvocations` INT NOT NULL DEFAULT 0;
