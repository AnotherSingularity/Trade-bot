-- Phase 1.1.a — atomicity + open-position uniqueness + idempotency keys.
--
-- Corrections tranche §F (atomic transactions), §G (DB-enforced one-open-per-token),
-- and the idempotency-key infrastructure that lets the reconciler apply fills
-- to the ledger without double-booking.

-- ---------------------------------------------------------------------------
-- §G — one open position per token, enforced at the database.
--
-- MySQL 8+ supports generated columns with UNIQUE constraints. We compute an
-- `openTokenKey` that equals `token` when the row is open, and is NULL when
-- closed. A UNIQUE index on this column then blocks a second open row for the
-- same token while still allowing arbitrarily many closed rows. This is the
-- "invariant of last resort" behind the Redis lease + application check.
-- ---------------------------------------------------------------------------
ALTER TABLE `positions`
  ADD COLUMN `openTokenKey` VARCHAR(20)
    GENERATED ALWAYS AS (CASE WHEN `status` = 'open' THEN `token` ELSE NULL END) VIRTUAL,
  ADD UNIQUE KEY `positions_open_token_uq` (`openTokenKey`);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §F idempotency — cash_ledger unique key.
--
-- A ledger row can only be produced by exactly one economic event:
--   (a) a specific fill (buy_cost / buy_fee / sell_proceeds / sell_fee)
--   (b) a per-intent adjustment (initial_fund / manual_adjustment)
--
-- The `idempotencyKey` column, combined with a UNIQUE index, means replaying
-- the same fill (during startup reconciliation or crash recovery) can INSERT
-- with the same key and the DB will reject the duplicate cleanly — the
-- application need only catch the duplicate-key error and treat it as a no-op.
--
-- Format: <reason>:<causal-id>[:<discriminator>]
--   e.g. buy_cost:1234:fill-<exchange_fill_id>
--        initial_fund:dry-run
-- ---------------------------------------------------------------------------
ALTER TABLE `cash_ledger`
  ADD COLUMN `idempotencyKey` VARCHAR(128),
  ADD COLUMN `fillId` INT NULL,
  ADD UNIQUE KEY `cash_ledger_idempotency_uq` (`idempotencyKey`),
  ADD KEY `cash_ledger_fillId_idx` (`fillId`);
