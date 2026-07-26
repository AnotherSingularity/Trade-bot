/**
 * Stage 3 §7 — Shadow Portfolio query.
 *
 * Reads Phase 2C `portfolio_risk_snapshots`. Column names match the
 * canonical schema (`cash`, `reservedCash`, `grossExposure`,
 * `netExposure`, `totalOpenStopRisk`, `pendingEntryRisk`,
 * `unprotectedExposure`, `btcBetaExposure`, `ethBetaExposure`,
 * `dailyLoss`, `weeklyLoss`, `currentDrawdown`, `historicalVaR`,
 * `historicalExpectedShortfall`, `worstStressLoss`). Fields the schema
 * does not carry (available cash net of reserved, pending-exit residual,
 * illiquid exposure, per-product/strategy/cluster breakdowns, per-scenario
 * stress) surface as `unknown` with an explicit `reasonCode` — never
 * fabricated.
 */

import { desc } from 'drizzle-orm';
import { type PortfolioPayload, type PortfolioEnvelope, type PortfolioMeasurement } from '@horizon/shared';
import { db, schema } from '../../db';
import { degraded, healthy, toDecimalStringNullable, toIsoNullable, unavailable, withTimeout } from './common';

export const PORTFOLIO_SOURCE_VERSION = 'portfolio.v1' as const;

function unknownM(reason: string, unit: PortfolioMeasurement['unit'] = 'usd'): PortfolioMeasurement {
  return { status: 'unknown', value: null, unit, observedAt: null, dataAvailableAt: null, policyVersion: null, confidence: null, reasonCode: reason };
}

function knownM(value: string, opts: { unit?: PortfolioMeasurement['unit']; observedAt?: string | null; dataAvailableAt?: string | null; policyVersion?: string | null } = {}): PortfolioMeasurement {
  return {
    status: 'known',
    value,
    unit: opts.unit ?? 'usd',
    observedAt: (opts.observedAt as PortfolioMeasurement['observedAt']) ?? null,
    dataAvailableAt: (opts.dataAvailableAt as PortfolioMeasurement['dataAvailableAt']) ?? null,
    policyVersion: opts.policyVersion ?? null,
    confidence: null,
    reasonCode: null,
  };
}

export async function getPortfolio(): Promise<PortfolioEnvelope> {
  try {
    return await withTimeout(async () => {
      const [snapshot] = await db
        .select()
        .from(schema.portfolioRiskSnapshots)
        .orderBy(desc(schema.portfolioRiskSnapshots.id))
        .limit(1);
      if (!snapshot) {
        return degraded<PortfolioPayload>(emptyPayload(), 'no_portfolio_snapshot_yet', { sourceVersion: PORTFOLIO_SOURCE_VERSION });
      }

      const observedAt = toIsoNullable(snapshot.observedAt);
      const availableAt = toIsoNullable(snapshot.dataAvailableAt);
      const policyVersion = snapshot.policyVersionId != null ? String(snapshot.policyVersionId) : null;

      const cashValue = toDecimalStringNullable(snapshot.cash);
      const reservedValue = toDecimalStringNullable(snapshot.reservedCash);
      // Available = cash - reservedCash, computed by the server (never the
      // renderer). If either is unknown we surface available as unknown.
      const availableValue = cashValue !== null && reservedValue !== null
        ? (Number(cashValue) - Number(reservedValue)).toFixed(10).replace(/\.?0+$/, '') || '0'
        : null;

      const payload: PortfolioPayload = {
        snapshotId: String(snapshot.id),
        snapshotAt: observedAt,
        policyVersion,
        cash: cashValue !== null ? knownM(cashValue, { observedAt, dataAvailableAt: availableAt, policyVersion }) : unknownM('cash_null'),
        reservedCash: reservedValue !== null ? knownM(reservedValue, { observedAt, dataAvailableAt: availableAt, policyVersion }) : unknownM('reserved_cash_null'),
        availableCash: availableValue !== null ? knownM(availableValue, { observedAt, dataAvailableAt: availableAt, policyVersion }) : unknownM('available_cash_requires_cash_and_reserved'),
        grossExposure: measurement(snapshot.grossExposure, observedAt, availableAt, policyVersion, 'gross_exposure_null'),
        netExposure: measurement(snapshot.netExposure, observedAt, availableAt, policyVersion, 'net_exposure_null'),
        openStopRisk: measurement(snapshot.totalOpenStopRisk, observedAt, availableAt, policyVersion, 'stop_risk_null'),
        pendingEntryExposure: measurement(snapshot.pendingEntryRisk, observedAt, availableAt, policyVersion, 'pending_entry_null'),
        pendingExitResidualExposure: unknownM('pending_exit_residual_not_persisted_in_schema'),
        unprotectedExposure: measurement(snapshot.unprotectedExposure, observedAt, availableAt, policyVersion, 'unprotected_null'),
        illiquidExposure: unknownM('illiquid_exposure_not_persisted_in_schema'),
        productExposures: [],
        strategyModeExposures: [],
        clusterExposures: [],
        btcBetaExposure: snapshot.btcBetaExposure != null ? measurement(snapshot.btcBetaExposure, observedAt, availableAt, policyVersion, 'btc_beta_null') : unknownM('btc_beta_null'),
        ethBetaExposure: snapshot.ethBetaExposure != null ? measurement(snapshot.ethBetaExposure, observedAt, availableAt, policyVersion, 'eth_beta_null') : unknownM('eth_beta_null'),
        dailyRealizedResult: measurement(snapshot.dailyLoss, observedAt, availableAt, policyVersion, 'daily_loss_null'),
        weeklyRealizedResult: measurement(snapshot.weeklyLoss, observedAt, availableAt, policyVersion, 'weekly_loss_null'),
        drawdown: measurement(snapshot.currentDrawdown, observedAt, availableAt, policyVersion, 'drawdown_null'),
        historicalVar: snapshot.historicalVaR != null ? measurement(snapshot.historicalVaR, observedAt, availableAt, policyVersion, 'var_null') : unknownM('historical_var_null'),
        historicalExpectedShortfall: snapshot.historicalExpectedShortfall != null ? measurement(snapshot.historicalExpectedShortfall, observedAt, availableAt, policyVersion, 'es_null') : unknownM('historical_es_null'),
        stressResults: snapshot.worstStressLoss != null
          ? [{ scenarioId: 'worst', scenarioName: 'worst_persisted_scenario', measurement: knownM(toDecimalStringNullable(snapshot.worstStressLoss) ?? '0', { observedAt, dataAvailableAt: availableAt, policyVersion }), runAt: observedAt }]
          : [],
      };

      return healthy(payload, {
        sourceVersion: PORTFOLIO_SOURCE_VERSION,
        observedAt: observedAt ?? undefined,
        dataAvailableAt: availableAt ?? undefined,
        policyVersions: policyVersion ? { risk: policyVersion } : undefined,
      });
    });
  } catch (err) {
    return unavailable<PortfolioPayload>('portfolio_query_failed', {
      sourceVersion: PORTFOLIO_SOURCE_VERSION,
      diagnostics: { detail: String(err).slice(0, 200) },
    });
  }
}

function measurement(raw: string | null | undefined, observedAt: string | null, dataAvailableAt: string | null, policyVersion: string | null, missingReason: string): PortfolioMeasurement {
  const value = toDecimalStringNullable(raw ?? null);
  if (value === null) return unknownM(missingReason);
  return knownM(value, { observedAt, dataAvailableAt, policyVersion });
}

function emptyPayload(): PortfolioPayload {
  const u = unknownM.bind(null, 'no_snapshot');
  return {
    snapshotId: null,
    snapshotAt: null,
    policyVersion: null,
    cash: u(), reservedCash: u(), availableCash: u(),
    grossExposure: u(), netExposure: u(), openStopRisk: u(),
    pendingEntryExposure: u(), pendingExitResidualExposure: u(),
    unprotectedExposure: u(), illiquidExposure: u(),
    productExposures: [], strategyModeExposures: [], clusterExposures: [],
    btcBetaExposure: u(), ethBetaExposure: u(),
    dailyRealizedResult: u(), weeklyRealizedResult: u(),
    drawdown: u(), historicalVar: u(), historicalExpectedShortfall: u(),
    stressResults: [],
  };
}
