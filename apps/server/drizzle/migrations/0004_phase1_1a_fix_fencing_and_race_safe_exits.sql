-- Phase 1.1.a-FIX — migration integrity + durable fencing + race-safe exits.
--
-- This migration contains three logically separate changes that all belong to
-- the P1.1.a correction tranche:
--
--   1. The reconciliationStatus enum extension the previous tranche should
--      have delivered as a migration but instead added to 0003 after 0003
--      was already applied to live databases. Restoring 0003 to its
--      originally-applied form means the enum extension needs its own
--      immutable migration — this one.
--
--   2. Durable fencing generation on order_intents (§H FIX). The Redis lease
--      hands out a monotonic `fenceGeneration` at acquire; we persist that
--      generation on every order intent so a stale worker's transaction can
--      be rejected inside the DB — precheck-only fencing is insufficient.
--
--   3. Race-safe exit attempt-generation uniqueness (§B FIX). Two concurrent
--      workers cannot race to allocate the SAME (positionId, purpose,
--      attemptGeneration); the DB rejects the second one.

-- ---------------------------------------------------------------------------
-- 1. reconciliationStatus enum — add 'degraded' (formerly at end of 0003)
-- ---------------------------------------------------------------------------
ALTER TABLE `bot_config`
  MODIFY COLUMN `reconciliationStatus`
    ENUM('pending','in_progress','ok','failed','degraded')
    NOT NULL DEFAULT 'pending';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Durable fencing on order_intents.
--
-- Whenever the scanner (or reconciler) creates an intent under a lease, it
-- stores the lease's fenceGeneration on the row. The economic-state
-- transactions verify this generation is still the CURRENT max for the same
-- token/position — a stale worker whose lease was silently taken by a peer
-- with a higher generation cannot commit.
-- ---------------------------------------------------------------------------
ALTER TABLE `order_intents`
  ADD COLUMN `fenceGeneration` INT,
  ADD COLUMN `attemptGeneration` INT;
--> statement-breakpoint

CREATE INDEX `order_intents_fence_idx` ON `order_intents` (`fenceGeneration`);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Race-safe exit attempt uniqueness.
--
-- A UNIQUE index on (positionId, purpose, attemptGeneration) means two
-- workers cannot both allocate generation=N for the same (position, purpose).
-- The loser gets ER_DUP_ENTRY and reconciles.
--
-- The index intentionally does NOT include entries: entry intents have
-- purpose='entry' and positionId=NULL (position doesn't exist yet), so the
-- three-way key would allow duplicates. Entry uniqueness is enforced by
-- clientOrderId (already UNIQUE from Phase 0). Exit intents always have a
-- non-null positionId + one of the four exit purposes.
--
-- NULL values in MySQL UNIQUE indexes don't collide, so entries (positionId
-- NULL, attemptGeneration NULL) coexist happily.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX `order_intents_exit_attempt_uq`
  ON `order_intents` (`positionId`, `purpose`, `attemptGeneration`);
