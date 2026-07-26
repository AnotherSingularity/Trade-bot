import { desc, eq, and } from 'drizzle-orm';
import { db } from '../../db';
import {
  challengerRoutingDecisions,
  championChallengerRoutingComparisons,
  changePointEvents,
  globalRegimeSnapshots,
  productRegimeSnapshots,
  regimeObserverRuns,
  regimeTransitions,
} from '../../db/schema';

/**
 * Phase 2B §S — Regime observer reporting.
 *
 * Aggregates observer runs into a report the audit surface can render.
 * The report NEVER claims profitability or routing improvement — it is
 * a health/agreement summary only.
 */

export interface RegimeReport {
  runsConsidered: number;
  globalStates: Array<{ state: string; count: number }>;
  productStates: Array<{ smoothedState: string; count: number }>;
  rawVsSmoothed: { equal: number; different: number };
  stateDurationsMs: { median: number; p90: number };
  transitionCount: number;
  acceptedTransitionCount: number;
  rejectedTransitionCount: number;
  changePointCount: number;
  changePointsByDetector: Array<{ detector: string; count: number }>;
  hmmRuleAgreementRate: number | null;
  unknownRate: number;
  disorderedRate: number;
  lowConfidenceRate: number;
  challengerRecommendationCounts: Array<{ recommendation: string; count: number }>;
  championChallengerAgreementRate: number | null;
  observerFailureCount: number;
  dataQualityOverrideCount: number;
  // Note: profitability is INTENTIONALLY absent per §S.
}

export interface RegimeReportInput {
  snapshotId?: number;
  runLimit?: number;
}

export async function buildRegimeReport(input: RegimeReportInput): Promise<RegimeReport> {
  const runs = input.snapshotId
    ? await db
        .select()
        .from(regimeObserverRuns)
        .where(eq(regimeObserverRuns.snapshotId, input.snapshotId))
        .orderBy(desc(regimeObserverRuns.startedAt))
        .limit(input.runLimit ?? 100)
    : await db
        .select()
        .from(regimeObserverRuns)
        .orderBy(desc(regimeObserverRuns.startedAt))
        .limit(input.runLimit ?? 100);
  const runIds = runs.map((r) => r.id);
  const globals = runIds.length
    ? await db
        .select()
        .from(globalRegimeSnapshots)
        .where(inList(globalRegimeSnapshots.observerRunId, runIds))
    : [];
  const products = runIds.length
    ? await db
        .select()
        .from(productRegimeSnapshots)
        .where(inList(productRegimeSnapshots.observerRunId, runIds))
    : [];
  const transitions = runIds.length
    ? await db
        .select()
        .from(regimeTransitions)
        .where(inList(regimeTransitions.observerRunId, runIds))
    : [];
  const changes = runIds.length
    ? await db
        .select()
        .from(changePointEvents)
        .where(inList(changePointEvents.observerRunId, runIds))
    : [];
  const routings = runIds.length
    ? await db
        .select()
        .from(challengerRoutingDecisions)
        .where(inList(challengerRoutingDecisions.observerRunId, runIds))
    : [];
  const comparisons = await db.select().from(championChallengerRoutingComparisons);

  return {
    runsConsidered: runs.length,
    globalStates: groupByKey(globals.map((g) => g.state), 'state'),
    productStates: groupByKey(products.map((p) => p.smoothedState), 'smoothedState'),
    rawVsSmoothed: {
      equal: products.filter((p) => p.rawState === p.smoothedState).length,
      different: products.filter((p) => p.rawState !== p.smoothedState).length,
    },
    stateDurationsMs: computeDurations(products),
    transitionCount: transitions.length,
    acceptedTransitionCount: transitions.filter((t) => t.transitionAccepted).length,
    rejectedTransitionCount: transitions.filter((t) => !t.transitionAccepted).length,
    changePointCount: changes.filter((c) => c.detector !== 'bocpd_deferred').length,
    changePointsByDetector: groupByKey(changes.map((c) => c.detector), 'detector'),
    hmmRuleAgreementRate: null,
    unknownRate: products.length > 0 ? products.filter((p) => p.smoothedState === 'UNKNOWN').length / products.length : 0,
    disorderedRate: products.length > 0 ? products.filter((p) => p.smoothedState === 'DISORDERED').length / products.length : 0,
    lowConfidenceRate: products.length > 0 ? products.filter((p) => p.status === 'low_confidence').length / products.length : 0,
    challengerRecommendationCounts: groupByKey(routings.map((r) => r.recommendation), 'recommendation'),
    championChallengerAgreementRate:
      comparisons.length > 0 ? comparisons.filter((c) => c.agreementState === 'agree').length / comparisons.length : null,
    observerFailureCount: [
      ...globals.filter((g) => g.status === 'numerical_failure' || g.status === 'quarantined'),
      ...products.filter((p) => p.status === 'numerical_failure' || p.status === 'quarantined'),
    ].length,
    dataQualityOverrideCount: [
      ...globals.filter((g) => g.state === 'DISORDERED' && (g.failureReason ?? '').includes('quality')),
      ...products.filter((p) => p.smoothedState === 'DISORDERED'),
    ].length,
  };
}

function groupByKey<K extends string>(xs: readonly string[], key: K): Array<Record<K, string> & { count: number }> {
  const map = new Map<string, number>();
  for (const x of xs) map.set(x, (map.get(x) ?? 0) + 1);
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, count]) => ({ [key]: k, count } as Record<K, string> & { count: number }));
}

function inList(col: any, ids: readonly number[]) {
  // Poor-man's IN using OR + eq for portability with drizzle's mysql chain.
  if (ids.length === 0) return eq(col, -1);
  return ids.slice(1).reduce((acc, id) => acc || eq(col, id), eq(col, ids[0])) || eq(col, ids[0]);
}

function computeDurations(products: Array<{ observedAt: Date; productId: string; smoothedState: string }>): {
  median: number;
  p90: number;
} {
  const byProduct = new Map<string, Array<{ observedAt: Date; smoothedState: string }>>();
  for (const p of products) {
    const bucket = byProduct.get(p.productId) ?? [];
    bucket.push({ observedAt: p.observedAt, smoothedState: p.smoothedState });
    byProduct.set(p.productId, bucket);
  }
  const durations: number[] = [];
  for (const arr of byProduct.values()) {
    arr.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
    let start = arr[0]?.observedAt;
    let cur = arr[0]?.smoothedState;
    for (let i = 1; i < arr.length; i += 1) {
      if (arr[i].smoothedState !== cur) {
        durations.push(arr[i].observedAt.getTime() - (start?.getTime() ?? arr[i].observedAt.getTime()));
        start = arr[i].observedAt;
        cur = arr[i].smoothedState;
      }
    }
  }
  durations.sort((a, b) => a - b);
  const median = durations.length > 0 ? durations[Math.floor(durations.length / 2)] : 0;
  const p90 = durations.length > 0 ? durations[Math.floor(durations.length * 0.9)] : 0;
  return { median, p90 };
}

// Silence unused
void and;
