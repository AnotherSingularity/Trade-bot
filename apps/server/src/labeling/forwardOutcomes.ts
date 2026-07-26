import { Money } from '@horizon/shared';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db';
import {
  forwardOutcomeLabels,
  marketTradeObservations,
  type ForwardOutcomeLabelRow,
} from '../db/schema';

/**
 * Phase 1.2 §L — forward observation and labeling.
 *
 * For every candidate — ACCEPTED and REJECTED alike — record the
 * prospective outcome we would have realized had the trade taken
 * place. The labeler runs independently from strategy execution so
 * rejected candidates get measured without changing trading behavior.
 *
 * Labeling uses ONLY post-decision events (`sourceTimestamp >
 * decisionCompletedAt`). Ambiguity (both TP and SL crossed in the same
 * observed sample) is conservatively labeled as `ambiguous`.
 *
 * This dataset is the ground truth for future probability calibration
 * (Phase 2A+). Nothing here feeds back into current strategy behavior.
 */

export const LABELER_VERSION = 'p1_2-labeler-1';

export interface RecordCandidateInput {
  decisionChainId: number;
  productId: string;
  mode: 'reversion' | 'breakout' | 'macro';
  decisionOutcome: 'accepted' | 'rejected';
  decisionCompletedAt: Date;
  targetPrice: Money;
  stopPrice: Money;
  hypotheticalBase: Money;
  entryReference: Money;
  forecastCost?: Money;
  realizedSimulatedCost?: Money;
}

export async function recordCandidateForLabeling(
  input: RecordCandidateInput,
): Promise<ForwardOutcomeLabelRow> {
  const [{ insertId }] = (await db.insert(forwardOutcomeLabels).values({
    decisionChainId: input.decisionChainId,
    productId: input.productId,
    mode: input.mode,
    decisionOutcome: input.decisionOutcome,
    decisionCompletedAt: input.decisionCompletedAt,
    targetPrice: input.targetPrice.toDecimalString(8),
    stopPrice: input.stopPrice.toDecimalString(8),
    hypotheticalBase: input.hypotheticalBase.toDecimalString(8),
    entryReference: input.entryReference.toDecimalString(8),
    forecastCost: input.forecastCost ? input.forecastCost.toDecimalString(8) : null,
    realizedSimulatedCost: input.realizedSimulatedCost ? input.realizedSimulatedCost.toDecimalString(8) : null,
    labelStatus: 'pending',
    labelerVersion: LABELER_VERSION,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(forwardOutcomeLabels)
    .where(eq(forwardOutcomeLabels.id, insertId))
    .limit(1);
  return row!;
}

export interface LabelInput {
  labelId: number;
  now: Date;
  timeoutMs: number;
}

/**
 * Walk market_trades after decisionCompletedAt to determine TP-first,
 * SL-first, timeout, or ambiguous. Also compute MFE/MAE.
 */
export async function labelForwardOutcome(input: LabelInput): Promise<ForwardOutcomeLabelRow | null> {
  const [label] = await db
    .select()
    .from(forwardOutcomeLabels)
    .where(eq(forwardOutcomeLabels.id, input.labelId))
    .limit(1);
  if (!label) return null;
  if (label.labelStatus !== 'pending') return label;

  const target = Money.fromString(label.targetPrice);
  const stop = Money.fromString(label.stopPrice);
  const entry = Money.fromString(label.entryReference);
  const isLong = target.gt(stop);
  const timeoutAt = new Date(label.decisionCompletedAt.getTime() + input.timeoutMs);

  const trades = await db
    .select()
    .from(marketTradeObservations)
    .where(
      and(
        eq(marketTradeObservations.productId, label.productId),
        gt(marketTradeObservations.sourceTimestamp, label.decisionCompletedAt),
      ),
    )
    .orderBy(marketTradeObservations.sourceTimestamp);

  let firstEventAt: Date | null = null;
  let lastEventAt: Date | null = null;
  let mfe = Money.zero();
  let mae = Money.zero();
  let tpFirstAt: Date | null = null;
  let slFirstAt: Date | null = null;
  let ambiguous = false;

  for (const t of trades) {
    if (t.sourceTimestamp.getTime() > timeoutAt.getTime()) break;
    if (!firstEventAt) firstEventAt = t.sourceTimestamp;
    lastEventAt = t.sourceTimestamp;
    const p = Money.fromString(t.price);
    const fav = isLong ? p.sub(entry) : entry.sub(p);
    const adv = isLong ? entry.sub(p) : p.sub(entry);
    if (fav.gt(mfe)) mfe = fav;
    if (adv.gt(mae)) mae = adv;
    const hitTp = isLong ? p.gte(target) : p.lte(target);
    const hitSl = isLong ? p.lte(stop) : p.gte(stop);
    if (hitTp && hitSl) {
      ambiguous = true; // both in the same observation — conservative label
      break;
    }
    if (hitTp && !tpFirstAt) tpFirstAt = t.sourceTimestamp;
    if (hitSl && !slFirstAt) slFirstAt = t.sourceTimestamp;
    if (tpFirstAt || slFirstAt) break;
  }

  let labelStatus: ForwardOutcomeLabelRow['labelStatus'] = 'pending';
  let tpFirst: boolean | null = null;
  let slFirst: boolean | null = null;
  let timeout: boolean | null = null;
  let timeToTpMs: number | null = null;
  let timeToSlMs: number | null = null;
  if (ambiguous) {
    labelStatus = 'ambiguous';
    tpFirst = null; slFirst = null;
  } else if (tpFirstAt) {
    labelStatus = 'labeled';
    tpFirst = true; slFirst = false;
    timeToTpMs = tpFirstAt.getTime() - label.decisionCompletedAt.getTime();
  } else if (slFirstAt) {
    labelStatus = 'labeled';
    tpFirst = false; slFirst = true;
    timeToSlMs = slFirstAt.getTime() - label.decisionCompletedAt.getTime();
  } else if (input.now.getTime() > timeoutAt.getTime()) {
    labelStatus = 'timeout';
    timeout = true;
  } else {
    return label; // still pending — not enough elapsed time
  }

  const hypBase = Money.fromString(label.hypotheticalBase);
  const grossHypothetical = tpFirst
    ? target.sub(entry).mul(hypBase).mul(isLong ? Money.fromString('1') : Money.fromString('-1'))
    : slFirst
      ? stop.sub(entry).mul(hypBase).mul(isLong ? Money.fromString('1') : Money.fromString('-1'))
      : Money.zero();
  const netHypothetical = label.forecastCost
    ? grossHypothetical.sub(Money.fromString(label.forecastCost))
    : grossHypothetical;

  await db
    .update(forwardOutcomeLabels)
    .set({
      labelStatus,
      tpFirst,
      slFirst,
      timeout,
      ambiguous,
      maxFavorableExcursion: mfe.toDecimalString(8),
      maxAdverseExcursion: mae.toDecimalString(8),
      timeToTpMs,
      timeToSlMs,
      grossHypotheticalResult: grossHypothetical.toDecimalString(8),
      netHypotheticalResult: netHypothetical.toDecimalString(8),
      firstEventAt,
      lastEventAt,
    })
    .where(eq(forwardOutcomeLabels.id, input.labelId));

  const [row] = await db
    .select()
    .from(forwardOutcomeLabels)
    .where(eq(forwardOutcomeLabels.id, input.labelId))
    .limit(1);
  return row!;
}

/** Load all labels for a chain — used by the audit route. */
export async function labelsForChain(chainId: number): Promise<ForwardOutcomeLabelRow[]> {
  return db
    .select()
    .from(forwardOutcomeLabels)
    .where(eq(forwardOutcomeLabels.decisionChainId, chainId));
}
