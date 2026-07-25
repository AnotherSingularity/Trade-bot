import { Money } from '@horizon/shared';
import {
  insertOutcomeLabel,
  appendCorrectedOutcomeLabel,
} from '../db/lineage';
import type { OutcomeLabelRow } from '../db/schema';

/**
 * Forward-only, conservative outcome labeler (Phase 1.1 Gate 2 §I).
 *
 * Given a round-trip and the sequence of candles that occurred AFTER
 * `chain.decisionCompletedAt`, produces an OutcomeLabelInput that is safe
 * to insert. `insertOutcomeLabel` will REJECT any input whose
 * `dataAvailableAt` is earlier than the chain's completion timestamp — the
 * caller cannot bypass that guard.
 *
 * Under intrabar ambiguity (a single candle where BOTH the take-profit
 * price and stop-loss price sit inside the [low, high] range), we do NOT
 * assume favorable ordering:
 *   - `policy: 'ambiguous_flag'` — mark `ambiguous=true`, leave
 *     `tpReachedFirst`/`slReachedFirst` both null.
 *   - `policy: 'conservative_adverse'` — assume the SL was hit first (the
 *     conservative adverse-ordering policy).
 *
 * There is intentionally no `policy: 'assume_favorable'`.
 */

export interface Candle {
  timestamp: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  dataAvailableAt: Date;
}

export interface LabelInputs {
  decisionChainId: number;
  roundTripId: number;
  entryPrice: string;
  takeProfitPrice: string;
  stopLossPrice: string;
  side: 'long';
  labelWindowStart: Date;
  labelWindowEnd: Date;
  candles: Candle[];
  grossPnl?: string;
  netPnl?: string;
  totalFees?: string;
  forecastCost?: string;
  realizedCost?: string;
  intrabarPolicy: 'ambiguous_flag' | 'conservative_adverse';
}

export type LabelOutcomeResult = OutcomeLabelRow;

/**
 * Compute a label from post-decision candles.
 * The candle sequence must be sorted ascending by `dataAvailableAt`, and
 * every candle must have `dataAvailableAt` NO EARLIER than
 * chain.decisionCompletedAt (enforced downstream).
 */
export async function labelRoundTrip(input: LabelInputs): Promise<LabelOutcomeResult> {
  const entry = Money.fromString(input.entryPrice);
  const tp = Money.fromString(input.takeProfitPrice);
  const sl = Money.fromString(input.stopLossPrice);

  let tpFirst: boolean | undefined;
  let slFirst: boolean | undefined;
  let ambiguous = false;
  let timeToTp: number | null = null;
  let timeToSl: number | null = null;
  let mfe = entry; // best price seen (highest for long)
  let mae = entry; // worst price seen (lowest for long)
  let latestDataTs: Date = input.labelWindowStart;
  const startMs = input.labelWindowStart.getTime();

  for (const c of input.candles) {
    const high = Money.fromString(c.high);
    const low = Money.fromString(c.low);
    if (high.gt(mfe)) mfe = high;
    if (low.lt(mae)) mae = low;
    if (c.dataAvailableAt.getTime() > latestDataTs.getTime()) {
      latestDataTs = c.dataAvailableAt;
    }
    const tpHit = high.gte(tp);
    const slHit = low.lte(sl);
    if (tpHit && slHit) {
      // Intrabar ambiguity — both sides touched within the same candle.
      if (input.intrabarPolicy === 'ambiguous_flag') {
        ambiguous = true;
        tpFirst = undefined;
        slFirst = undefined;
      } else {
        // Conservative adverse: assume SL happened first.
        slFirst = true;
        tpFirst = false;
        timeToSl = c.timestamp.getTime() - startMs;
      }
      break;
    }
    if (tpHit) {
      tpFirst = true;
      slFirst = false;
      timeToTp = c.timestamp.getTime() - startMs;
      break;
    }
    if (slHit) {
      slFirst = true;
      tpFirst = false;
      timeToSl = c.timestamp.getTime() - startMs;
      break;
    }
  }

  const timeout = !ambiguous && tpFirst === undefined && slFirst === undefined;
  const labelType = ambiguous
    ? 'ambiguous'
    : tpFirst
      ? 'tp_first'
      : slFirst
        ? 'sl_first'
        : 'timeout';

  const dataAvailableAt = latestDataTs.getTime() > input.labelWindowStart.getTime()
    ? latestDataTs
    : input.labelWindowEnd;

  return insertOutcomeLabel({
    decisionChainId: input.decisionChainId,
    roundTripId: input.roundTripId,
    labelType,
    tpReachedFirst: tpFirst ?? undefined,
    slReachedFirst: slFirst ?? undefined,
    timeout,
    ambiguous,
    maximumFavorableExcursion: mfe.toDecimalString(8),
    maximumAdverseExcursion: mae.toDecimalString(8),
    timeToTp: timeToTp ?? undefined,
    timeToSl: timeToSl ?? undefined,
    grossPnl: input.grossPnl,
    netPnl: input.netPnl,
    totalFees: input.totalFees,
    forecastCost: input.forecastCost,
    realizedCost: input.realizedCost,
    labelWindowStart: input.labelWindowStart,
    labelWindowEnd: input.labelWindowEnd,
    dataAvailableAt,
  });
}

/** Correct a prior label by inserting a NEW version. */
export async function appendCorrection(
  supersedesId: number,
  correctionReason: string,
  input: LabelInputs,
): Promise<LabelOutcomeResult> {
  const label = await labelRoundTrip(input);
  return appendCorrectedOutcomeLabel(supersedesId, correctionReason, {
    decisionChainId: input.decisionChainId,
    roundTripId: input.roundTripId,
    labelType: label.labelType,
    tpReachedFirst: label.tpReachedFirst ?? undefined,
    slReachedFirst: label.slReachedFirst ?? undefined,
    timeout: label.timeout,
    ambiguous: label.ambiguous,
    maximumFavorableExcursion: label.maximumFavorableExcursion ?? undefined,
    maximumAdverseExcursion: label.maximumAdverseExcursion ?? undefined,
    timeToTp: label.timeToTp ?? undefined,
    timeToSl: label.timeToSl ?? undefined,
    grossPnl: label.grossPnl ?? undefined,
    netPnl: label.netPnl ?? undefined,
    totalFees: label.totalFees ?? undefined,
    forecastCost: label.forecastCost ?? undefined,
    realizedCost: label.realizedCost ?? undefined,
    labelWindowStart: input.labelWindowStart,
    labelWindowEnd: input.labelWindowEnd,
    dataAvailableAt: input.labelWindowEnd,
  });
}
