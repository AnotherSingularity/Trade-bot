-- Phase 1 — Slice 1: immutable decision snapshots.
-- Adds fee-tier snapshots, execution-cost forecasts, signal candidates, and
-- quantitative decisions. Every scanner candidate — accepted or rejected —
-- lands in signal_candidates + quantitative_decisions with a machine-readable
-- reason. Cost forecasts land in execution_cost_forecasts and are later
-- reconciled to realized cost (slice 3, shadow-live).
--
-- All money columns use `decimal(20,8)` to match the shared Money type
-- (bigint scaled by 1e8) — never store money as double/float.
--
-- Tables are append-only in intent. A version column is included for the
-- forecast table so slice-3 shadow reconciliation can back-fill realized fields
-- without invalidating the original snapshot; the accepted-at-decision-time
-- numbers themselves must NEVER be mutated.

-- ---------------------------------------------------------------------------
-- fee_tier_snapshots — record every /transaction_summary fetch
-- ---------------------------------------------------------------------------
CREATE TABLE `fee_tier_snapshots` (
  `id` int AUTO_INCREMENT NOT NULL,
  `pricingTier` varchar(32) NOT NULL,
  `makerFeeRate` decimal(10,8) NOT NULL,
  `takerFeeRate` decimal(10,8) NOT NULL,
  `usdVolume30d` decimal(20,8),
  `usdFees30d` decimal(20,8),
  `usdFromVolume` decimal(20,8),
  `usdToVolume` decimal(20,8),
  `productType` varchar(16) NOT NULL DEFAULT 'SPOT',
  `fetchedAt` timestamp NOT NULL DEFAULT (now()),
  `rawResponse` json,
  CONSTRAINT `fee_tier_snapshots_id` PRIMARY KEY(`id`),
  KEY `fee_tier_snapshots_fetchedAt_idx` (`fetchedAt`)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- signal_candidates — one row per scanner evaluation, immutable
-- ---------------------------------------------------------------------------
CREATE TABLE `signal_candidates` (
  `id` int AUTO_INCREMENT NOT NULL,
  `scanSeed` varchar(64) NOT NULL,
  `token` varchar(20) NOT NULL,
  `mode` enum('reversion','breakout','macro') NOT NULL,
  `scanPrice` decimal(20,8) NOT NULL,
  `volume24h` decimal(20,8) NOT NULL,
  `changePct24h` decimal(10,4),
  `rsi` decimal(10,4),
  `macdHistogram` decimal(20,8),
  `emaTrend` varchar(16),
  `bollingerPosition` varchar(16),
  `passedSignals` int NOT NULL,
  `totalSignals` int NOT NULL,
  `tokenWinRate` decimal(6,4),
  `tokenTradeCount` int,
  `strategyVersion` varchar(32) NOT NULL,
  `featureVersion` varchar(32) NOT NULL,
  `regimeLabel` varchar(32) NOT NULL DEFAULT 'unclassified',
  `regimeConfidence` decimal(5,4),
  `marketWindow` enum('PRIME','ACTIVE','CLOSED') NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `signal_candidates_id` PRIMARY KEY(`id`),
  KEY `signal_candidates_scanSeed_idx` (`scanSeed`),
  KEY `signal_candidates_token_idx` (`token`, `createdAt`)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- execution_cost_forecasts — per-candidate cost model output, immutable
-- (Realized-comparison fields are nullable and set later by shadow-live
-- reconciliation in slice 3; those writes do not violate immutability of the
-- forecast itself, which lives in the un-suffixed columns.)
-- ---------------------------------------------------------------------------
CREATE TABLE `execution_cost_forecasts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `candidateId` int NOT NULL,
  `feeTierSnapshotId` int NOT NULL,
  `previewOrderTotal` decimal(20,8),
  `previewCommissionTotal` decimal(20,8),
  `previewBestBid` decimal(20,8),
  `previewBestAsk` decimal(20,8),
  `previewEstimatedAvgFillPrice` decimal(20,8),
  `previewBaseSize` decimal(20,8),
  `previewQuoteSize` decimal(20,8),
  `arrivalMid` decimal(20,8) NOT NULL,
  `spreadBps` decimal(10,4) NOT NULL,
  `entryFee` decimal(20,8) NOT NULL,
  `exitFeeEstimate` decimal(20,8) NOT NULL,
  `entryImpactBps` decimal(10,4) NOT NULL,
  `exitImpactBpsEstimate` decimal(10,4) NOT NULL,
  `latencySlippageBpsEstimate` decimal(10,4) NOT NULL,
  `roundTripCost` decimal(20,8) NOT NULL,
  `costToTargetPct` decimal(10,4) NOT NULL,
  `takeProfitPrice` decimal(20,8) NOT NULL,
  `stopLossPrice` decimal(20,8) NOT NULL,
  `netTpPnl` decimal(20,8) NOT NULL,
  `netSlPnl` decimal(20,8) NOT NULL,
  `netRewardRisk` decimal(10,4),
  `breakEvenWinProb` decimal(6,4),
  `costModelVersion` varchar(32) NOT NULL,
  `exitCostQuantile` decimal(6,4) NOT NULL,
  `previewWarnings` json,
  `previewRawResponse` json,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  -- Realized-comparison fields, filled by slice-3 reconciliation.
  `realizedEntryFee` decimal(20,8),
  `realizedExitFee` decimal(20,8),
  `realizedEntryImpactBps` decimal(10,4),
  `realizedExitImpactBps` decimal(10,4),
  `realizedRoundTripCost` decimal(20,8),
  `realizedAt` timestamp NULL,
  CONSTRAINT `execution_cost_forecasts_id` PRIMARY KEY(`id`),
  KEY `execution_cost_forecasts_candidateId_idx` (`candidateId`),
  KEY `execution_cost_forecasts_feeTierSnapshotId_idx` (`feeTierSnapshotId`),
  KEY `execution_cost_forecasts_createdAt_idx` (`createdAt`),
  CONSTRAINT `execution_cost_forecasts_candidateId_fk`
    FOREIGN KEY (`candidateId`) REFERENCES `signal_candidates` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `execution_cost_forecasts_feeTierSnapshotId_fk`
    FOREIGN KEY (`feeTierSnapshotId`) REFERENCES `fee_tier_snapshots` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- quantitative_decisions — the accept/reject outcome per candidate, immutable
-- ---------------------------------------------------------------------------
CREATE TABLE `quantitative_decisions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `candidateId` int NOT NULL,
  `costForecastId` int,
  `decision` enum(
    'accept',
    'reject_ev_gate',
    'reject_cost_gate',
    'reject_reward_risk_gate',
    'reject_data_stale',
    'reject_preview_warning',
    'reject_preview_error',
    'reject_fee_tier_stale',
    'reject_liquidity_gate',
    'reject_regime_gate',
    'reject_signal_gate',
    'reject_max_positions',
    'reject_already_open',
    'reject_circuit_breaker',
    'reject_paused',
    'reject_market_window',
    'reject_dedup'
  ) NOT NULL,
  `rejectionReason` varchar(255),
  `rejectionDetail` json,
  `netTpPnl` decimal(20,8),
  `netSlPnl` decimal(20,8),
  `netRewardRisk` decimal(10,4),
  `expectedValue` decimal(20,8),
  `breakEvenWinProb` decimal(6,4),
  `strategyVersion` varchar(32) NOT NULL,
  `costModelVersion` varchar(32) NOT NULL,
  `evGateVersion` varchar(32) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `quantitative_decisions_id` PRIMARY KEY(`id`),
  KEY `quantitative_decisions_candidateId_idx` (`candidateId`),
  KEY `quantitative_decisions_decision_idx` (`decision`, `createdAt`),
  CONSTRAINT `quantitative_decisions_candidateId_fk`
    FOREIGN KEY (`candidateId`) REFERENCES `signal_candidates` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `quantitative_decisions_costForecastId_fk`
    FOREIGN KEY (`costForecastId`) REFERENCES `execution_cost_forecasts` (`id`) ON DELETE RESTRICT
);
