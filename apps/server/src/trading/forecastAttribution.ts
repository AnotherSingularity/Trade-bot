import { Money } from '@horizon/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import {
  executionCostForecasts,
  fills,
  forecastVsRealizedAttributions,
  orderIntents,
  roundTrips,
  type ForecastVsRealizedAttributionRow,
} from '../db/schema';
import { CASH_FLOW_ATTRIBUTION_VERSION } from './cashFlowForecast';

/**
 * Forecast-vs-realized attribution (Phase 1.1 Gate 3B §O).
 *
 * For every completed round trip, build a single attribution row comparing:
 *   - Forecast vs realized entry cost
 *   - Forecast vs realized exit cost
 *   - Forecast vs realized total cost
 *   - Forecast vs realized slippage
 *   - Forecast vs realized commission
 *   - Forecast net (target / stop / timeout) vs realized net PnL along the
 *     actual path taken
 *   - Absolute forecast error
 *   - Forecast error in basis points
 *
 * The row is attached to the Gate 2 decision chain and to the exact
 * cost-forecast row that authorized the trade. UNIQUE(roundTripId)
 * enforces at-most-one attribution per round trip; corrections would
 * need a versioned successor (not yet needed).
 */

export interface AttributionInput {
  roundTripId: number;
  /** Was the actual outcome the target, stop, timeout, ambiguous, or other? */
  outcomeTaken: ForecastVsRealizedAttributionRow['outcomeTaken'];
}

/**
 * Build + persist an attribution row for a completed round trip. Reads the
 * cost forecast + all fills for the position from the DB — nothing
 * derived; every value is EXACT decimal arithmetic on the persisted rows.
 */
export async function persistForecastAttribution(
  input: AttributionInput,
): Promise<ForecastVsRealizedAttributionRow | null> {
  const [rt] = await db.select().from(roundTrips).where(eq(roundTrips.id, input.roundTripId)).limit(1);
  if (!rt) return null;

  // Locate the cost forecast that authorized the entry.
  const entryIntentId = rt.entryOrderIntentId;
  if (!entryIntentId) return null;
  const [entryIntent] = await db
    .select()
    .from(orderIntents)
    .where(eq(orderIntents.id, entryIntentId))
    .limit(1);
  if (!entryIntent) return null;
  const costForecastId = entryIntent.costForecastId;
  if (!costForecastId) return null;
  const [forecast] = await db
    .select()
    .from(executionCostForecasts)
    .where(eq(executionCostForecasts.id, costForecastId))
    .limit(1);
  if (!forecast) return null;
  const decisionChainId = entryIntent.decisionChainId ?? forecast.decisionChainId;
  if (!decisionChainId) return null;

  // Realized values from fills.
  const entryFills = await db
    .select({ size: fills.filledSize, price: fills.fillPrice, fee: fills.fee })
    .from(fills)
    .where(eq(fills.orderIntentId, entryIntentId));
  let realizedEntryCommission = Money.zero();
  let realizedEntryQuote = Money.zero();
  let realizedEntryBase = Money.zero();
  for (const f of entryFills) {
    const s = Money.fromString(f.size);
    const p = Money.fromString(f.price);
    realizedEntryBase = realizedEntryBase.add(s);
    realizedEntryQuote = realizedEntryQuote.add(s.mul(p));
    realizedEntryCommission = realizedEntryCommission.add(Money.fromString(f.fee));
  }

  // Realized exit values — aggregate across ALL exit intents for the position.
  const exitFills = await db
    .select({ size: fills.filledSize, price: fills.fillPrice, fee: fills.fee })
    .from(fills)
    .innerJoin(orderIntents, eq(fills.orderIntentId, orderIntents.id))
    .where(and(eq(orderIntents.positionId, rt.positionId), eq(orderIntents.side, 'SELL')));
  let realizedExitCommission = Money.zero();
  let realizedExitQuote = Money.zero();
  let realizedExitBase = Money.zero();
  for (const f of exitFills) {
    const s = Money.fromString(f.size);
    const p = Money.fromString(f.price);
    realizedExitBase = realizedExitBase.add(s);
    realizedExitQuote = realizedExitQuote.add(s.mul(p));
    realizedExitCommission = realizedExitCommission.add(Money.fromString(f.fee));
  }

  // Realized slippage on entry: (realizedFillPrice - previewFillPrice) * Q
  // — same formula as forecast.entryImpact, but with realized values.
  const previewEntryFill = forecast.previewEntryFillPrice
    ? Money.fromString(forecast.previewEntryFillPrice)
    : forecast.previewEstimatedAvgFillPrice
      ? Money.fromString(forecast.previewEstimatedAvgFillPrice)
      : Money.zero();
  const realizedEntryFill = realizedEntryBase.isZero()
    ? Money.zero()
    : realizedEntryQuote.div(realizedEntryBase);
  const realizedSlippage = realizedEntryFill.sub(previewEntryFill).mul(realizedEntryBase);
  const forecastSlippage = forecast.entryImpact
    ? Money.fromString(forecast.entryImpact)
    : Money.zero();

  // Forecast cost breakdown.
  const forecastEntryCost = forecast.entryCommission
    ? Money.fromString(forecast.entryCommission)
    : Money.zero();
  // Forecast exit cost: pick the branch that matches the outcome taken.
  const forecastExitCost = forecast[costFieldForOutcome(input.outcomeTaken)]
    ? Money.fromString(forecast[costFieldForOutcome(input.outcomeTaken)]!)
    : Money.zero();
  const forecastTotalCost = forecast.totalForecastCost
    ? Money.fromString(forecast.totalForecastCost)
    : Money.zero();

  const realizedEntryCost = realizedEntryCommission;
  const realizedExitCost = realizedExitCommission;
  const realizedTotalCost = realizedEntryCommission.add(realizedExitCommission);

  const forecastCommission = forecastEntryCost.add(forecastExitCost);
  const realizedCommission = realizedEntryCommission.add(realizedExitCommission);

  // Forecast net per path.
  const forecastNetTargetPnl = forecast.netTargetPnl ? Money.fromString(forecast.netTargetPnl) : null;
  const forecastNetStopPnl = forecast.netStopPnl ? Money.fromString(forecast.netStopPnl) : null;
  const forecastNetTimeoutPnl = forecast.netTimeoutPnl ? Money.fromString(forecast.netTimeoutPnl) : null;

  const realizedNetPnl = Money.fromString(rt.realizedNetPnl);

  // Absolute error against the forecast for the path taken.
  const forecastForPathTaken =
    input.outcomeTaken === 'target' ? forecastNetTargetPnl :
    input.outcomeTaken === 'stop' ? forecastNetStopPnl :
    input.outcomeTaken === 'timeout' ? forecastNetTimeoutPnl :
    null;
  const absoluteForecastError = forecastForPathTaken
    ? realizedNetPnl.sub(forecastForPathTaken).abs()
    : Money.zero();

  const entryValueGross = Money.fromString(rt.entryValueGross);
  const forecastErrorBps = entryValueGross.isZero()
    ? null
    : absoluteForecastError.div(entryValueGross).mul(Money.fromString('10000'));

  await db
    .insert(forecastVsRealizedAttributions)
    .values({
      roundTripId: input.roundTripId,
      decisionChainId,
      costForecastId,
      forecastEntryCost: forecastEntryCost.toDecimalString(8),
      realizedEntryCost: realizedEntryCost.toDecimalString(8),
      forecastExitCost: forecastExitCost.toDecimalString(8),
      realizedExitCost: realizedExitCost.toDecimalString(8),
      forecastTotalCost: forecastTotalCost.toDecimalString(8),
      realizedTotalCost: realizedTotalCost.toDecimalString(8),
      forecastSlippage: forecastSlippage.toDecimalString(8),
      realizedSlippage: realizedSlippage.toDecimalString(8),
      forecastCommission: forecastCommission.toDecimalString(8),
      realizedCommission: realizedCommission.toDecimalString(8),
      forecastNetTargetPnl: forecastNetTargetPnl?.toDecimalString(8),
      forecastNetStopPnl: forecastNetStopPnl?.toDecimalString(8),
      forecastNetTimeoutPnl: forecastNetTimeoutPnl?.toDecimalString(8),
      realizedNetPnl: realizedNetPnl.toDecimalString(8),
      absoluteForecastError: absoluteForecastError.toDecimalString(8),
      forecastErrorBps: forecastErrorBps?.toDecimalString(4),
      outcomeTaken: input.outcomeTaken,
      attributionVersion: CASH_FLOW_ATTRIBUTION_VERSION,
    })
    .execute();

  const [row] = await db
    .select()
    .from(forecastVsRealizedAttributions)
    .where(eq(forecastVsRealizedAttributions.roundTripId, input.roundTripId))
    .limit(1);
  return row!;
}

function costFieldForOutcome(
  outcome: ForecastVsRealizedAttributionRow['outcomeTaken'],
): 'targetExitCommission' | 'stopExitCommission' | 'timeoutExitCommission' | 'entryCommission' {
  switch (outcome) {
    case 'target':
      return 'targetExitCommission';
    case 'stop':
      return 'stopExitCommission';
    case 'timeout':
      return 'timeoutExitCommission';
    default:
      return 'entryCommission';
  }
}
