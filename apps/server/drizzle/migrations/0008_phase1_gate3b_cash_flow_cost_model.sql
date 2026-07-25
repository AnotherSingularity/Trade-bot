-- Phase 1.1 Gate 3B — cash-flow cost model.
--
-- Additive DDL. Migrations 0000-0007 remain immutable.
--
-- Adds:
--   1. Exact cash-flow columns on execution_cost_forecasts (§I).
--   2. Separated cost-component columns (§J) — every modeled cost stored
--      independently so nothing is counted twice.
--   3. Honest buffer-source metadata (§L) — bufferSource, bufferVersion,
--      sampleCount, isEmpirical.
--   4. Outcome-probability-estimate columns (§N) — defined but marked
--      not_calibrated; do NOT affect allocations.
--   5. forecast_vs_realized_attributions table (§O) — one row per completed
--      round trip.

-- ---------------------------------------------------------------------------
-- 1-4. execution_cost_forecasts additions — all nullable so legacy rows survive.
-- ---------------------------------------------------------------------------
ALTER TABLE `execution_cost_forecasts`
  -- §I — exact cash flows (long-only for now; short adds later).
  ADD COLUMN `expectedFilledBase` DECIMAL(20, 8),
  ADD COLUMN `previewEntryFillPrice` DECIMAL(20, 8),
  ADD COLUMN `conservativeTargetExitPrice` DECIMAL(20, 8),
  ADD COLUMN `conservativeStopExitPrice` DECIMAL(20, 8),
  ADD COLUMN `conservativeTimeoutExitPrice` DECIMAL(20, 8),
  ADD COLUMN `entryOutflow` DECIMAL(20, 8),
  ADD COLUMN `targetInflow` DECIMAL(20, 8),
  ADD COLUMN `stopInflow` DECIMAL(20, 8),
  ADD COLUMN `timeoutInflow` DECIMAL(20, 8),
  ADD COLUMN `netTargetPnl` DECIMAL(20, 8),
  ADD COLUMN `netStopPnl` DECIMAL(20, 8),
  ADD COLUMN `netTimeoutPnl` DECIMAL(20, 8),

  -- §J — separated cost components (Money-typed decimals).
  ADD COLUMN `entryCommission` DECIMAL(20, 8),
  ADD COLUMN `targetExitCommission` DECIMAL(20, 8),
  ADD COLUMN `stopExitCommission` DECIMAL(20, 8),
  ADD COLUMN `timeoutExitCommission` DECIMAL(20, 8),
  ADD COLUMN `quotedSpread` DECIMAL(20, 8),
  ADD COLUMN `effectiveSpread` DECIMAL(20, 8),
  ADD COLUMN `entryImpact` DECIMAL(20, 8),
  ADD COLUMN `targetExitImpact` DECIMAL(20, 8),
  ADD COLUMN `stopExitImpact` DECIMAL(20, 8),
  ADD COLUMN `latencyBufferAbs` DECIMAL(20, 8),
  ADD COLUMN `stopGapBufferAbs` DECIMAL(20, 8),
  ADD COLUMN `partialFillBufferAbs` DECIMAL(20, 8),
  ADD COLUMN `unfilledOpportunityEstimate` DECIMAL(20, 8),
  ADD COLUMN `residualDustEstimate` DECIMAL(20, 8),
  ADD COLUMN `totalForecastCost` DECIMAL(20, 8),

  -- §K — target/stop basis (which price the TP/SL were derived from).
  ADD COLUMN `targetStopBasis` ENUM('preview_entry', 'reconciled_entry') NULL,

  -- §L — honest buffer metadata; source and sample count expose whether
  -- the buffer came from a configured constant or an empirical distribution.
  ADD COLUMN `bufferSource` VARCHAR(64),
  ADD COLUMN `bufferVersion` VARCHAR(32),
  ADD COLUMN `bufferSampleCount` INT,
  ADD COLUMN `isEmpiricalBuffer` BOOLEAN NOT NULL DEFAULT FALSE,

  -- §N — outcome probability estimates (defined but not_calibrated).
  ADD COLUMN `pTarget` DECIMAL(6, 4),
  ADD COLUMN `pStop` DECIMAL(6, 4),
  ADD COLUMN `pTimeout` DECIMAL(6, 4),
  ADD COLUMN `probabilityUncertaintyLower` DECIMAL(6, 4),
  ADD COLUMN `probabilityUncertaintyUpper` DECIMAL(6, 4),
  ADD COLUMN `probabilityModelVersion` VARCHAR(32),
  ADD COLUMN `probabilitySampleCount` INT,
  ADD COLUMN `probabilityCalibrationStatus` ENUM(
    'not_calibrated',
    'calibrating',
    'calibrated_low_conf',
    'calibrated'
  ) NOT NULL DEFAULT 'not_calibrated',

  -- §K post-fill deviation flag.
  ADD COLUMN `postFillDeviationBps` DECIMAL(10, 4),
  ADD COLUMN `revalidationRequired` BOOLEAN NOT NULL DEFAULT FALSE;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. forecast_vs_realized_attributions — one row per completed round trip.
-- ---------------------------------------------------------------------------
CREATE TABLE `forecast_vs_realized_attributions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `roundTripId` INT NOT NULL,
  `decisionChainId` INT NOT NULL,
  `costForecastId` INT NOT NULL,
  `forecastEntryCost` DECIMAL(20, 8) NOT NULL,
  `realizedEntryCost` DECIMAL(20, 8) NOT NULL,
  `forecastExitCost` DECIMAL(20, 8) NOT NULL,
  `realizedExitCost` DECIMAL(20, 8) NOT NULL,
  `forecastTotalCost` DECIMAL(20, 8) NOT NULL,
  `realizedTotalCost` DECIMAL(20, 8) NOT NULL,
  `forecastSlippage` DECIMAL(20, 8),
  `realizedSlippage` DECIMAL(20, 8),
  `forecastCommission` DECIMAL(20, 8),
  `realizedCommission` DECIMAL(20, 8),
  `forecastNetTargetPnl` DECIMAL(20, 8),
  `forecastNetStopPnl` DECIMAL(20, 8),
  `forecastNetTimeoutPnl` DECIMAL(20, 8),
  `realizedNetPnl` DECIMAL(20, 8) NOT NULL,
  `absoluteForecastError` DECIMAL(20, 8) NOT NULL,
  `forecastErrorBps` DECIMAL(10, 4),
  `outcomeTaken` ENUM('target', 'stop', 'timeout', 'ambiguous', 'other') NOT NULL,
  `attributionVersion` VARCHAR(32) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `forecast_vs_realized_roundtrip_uq` (`roundTripId`),
  KEY `forecast_vs_realized_chain_idx` (`decisionChainId`),
  CONSTRAINT `forecast_vs_realized_decisionChainId_fk`
    FOREIGN KEY (`decisionChainId`) REFERENCES `decision_chains`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
