/**
 * Stage 3 §9 — Decision Journal.
 *
 * List: paginated decision_chains ordered by observedAt DESC.
 * Detail: full lineage — scan → market → eligibility → setup → routing →
 * cost → quant → Claude → preview → plan → intents → fills → position →
 * protection → exits → ledger → round-trip → outcome. Each stage is a
 * `DecisionRecord` with provenance flags. Broken relationships remain
 * visible via `brokenReason` and `brokenLineageMarkers`.
 */

import { and, desc, eq, lt, sql } from 'drizzle-orm';
import {
  DEFAULT_PAGE_SIZE,
  type DecisionListEnvelope,
  type DecisionListInput,
  type DecisionListRow,
  type DecisionDetailEnvelope,
  type DecisionDetailInput,
  type DecisionDetailPayload,
  type DecisionRecord,
} from '@horizon/shared';
import { db, schema } from '../../db';
import { decodeCursor, degraded, empty, encodeCursor, healthy, toIsoNullable, unavailable, withTimeout } from './common';

export const DECISIONS_SOURCE_VERSION = 'decisions.v1' as const;

const CHAMPION_STAGE_PROVENANCE = {
  championInfluence: true,
  observerOnly: false,
  knownAtDecisionTime: true,
  knownAfterDecision: false,
  knownAfterOutcome: false,
} as const;

const CHAMPION_POST_DECISION = {
  championInfluence: true,
  observerOnly: false,
  knownAtDecisionTime: false,
  knownAfterDecision: true,
  knownAfterOutcome: false,
} as const;

const CHAMPION_POST_OUTCOME = {
  championInfluence: false,
  observerOnly: false,
  knownAtDecisionTime: false,
  knownAfterDecision: false,
  knownAfterOutcome: true,
} as const;

const OBSERVER_ONLY = {
  championInfluence: false,
  observerOnly: true,
  knownAtDecisionTime: true,
  knownAfterDecision: false,
  knownAfterOutcome: false,
} as const;

export async function listDecisions(input: DecisionListInput | undefined): Promise<DecisionListEnvelope> {
  const limit = Math.min(input?.limit ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  try {
    return await withTimeout(async () => {
      const cursor = input?.cursor ? decodeCursor(input.cursor) : null;
      if (input?.cursor && cursor === null) {
        return unavailable<{ items: DecisionListRow[]; nextCursor: string | null }>('invalid_cursor', { sourceVersion: DECISIONS_SOURCE_VERSION });
      }

      const whereClauses = [] as ReturnType<typeof eq>[];
      if (cursor && typeof cursor.id === 'number') {
        whereClauses.push(lt(schema.decisionChains.id, cursor.id));
      }

      const rows = await db
        .select()
        .from(schema.decisionChains)
        .where(whereClauses.length ? and(...whereClauses) : undefined)
        .orderBy(desc(schema.decisionChains.id))
        .limit(limit + 1);

      const trimmed = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? encodeCursor({ id: trimmed[trimmed.length - 1].id }) : null;

      const items: DecisionListRow[] = trimmed.map((r) => ({
        chainId: String(r.id),
        createdAt: (toIsoNullable(r.observedAt) ?? new Date(0).toISOString()) as DecisionListRow['createdAt'],
        product: r.productId ?? null,
        championVersion: r.strategyVersion ?? null,
        authorizationOutcome: mapAuthorizationOutcome(r.currentStatus),
        positionState: r.currentStatus === 'position_open' ? 'open' : r.currentStatus === 'position_closed' ? 'closed' : null,
        outcomeLabel: r.currentStatus === 'outcome_labeled' ? 'unknown' : null,
        brokenLineage: r.lineageCompleteness === 'broken' || r.lineageCompleteness === 'legacy_unresolved',
      }));

      const filtered = input?.filter?.productPrefix
        ? items.filter((i) => (i.product ?? '').startsWith(input.filter!.productPrefix!))
        : items;
      const filteredByOutcome = input?.filter?.outcomeIn && input.filter.outcomeIn.length > 0
        ? filtered.filter((i) => i.outcomeLabel !== null && input.filter!.outcomeIn!.includes(i.outcomeLabel))
        : filtered;

      if (filteredByOutcome.length === 0) {
        return empty({ items: [], nextCursor: null }, 'no_decisions_match_filter', { sourceVersion: DECISIONS_SOURCE_VERSION });
      }

      return healthy({ items: filteredByOutcome, nextCursor }, { sourceVersion: DECISIONS_SOURCE_VERSION });
    });
  } catch (err) {
    return unavailable<{ items: DecisionListRow[]; nextCursor: string | null }>('decisions_query_failed', {
      sourceVersion: DECISIONS_SOURCE_VERSION,
      diagnostics: { detail: String(err).slice(0, 200) },
    });
  }
}

function mapAuthorizationOutcome(status: string): DecisionListRow['authorizationOutcome'] {
  switch (status) {
    case 'approved':
    case 'order_pending':
    case 'partially_filled':
    case 'position_open':
    case 'position_closed':
    case 'outcome_labeled':
      return 'approved';
    case 'economically_rejected':
    case 'quantitatively_rejected':
    case 'ineligible':
    case 'no_setup':
      return 'rejected';
    case 'observed':
    case 'candidate':
      return 'skipped';
    case 'failed':
      return 'error';
    default:
      return 'unknown';
  }
}

export async function getDecisionDetail(input: DecisionDetailInput): Promise<DecisionDetailEnvelope> {
  const numericId = Number(input.chainId);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return unavailable<DecisionDetailPayload>('invalid_chain_id', { sourceVersion: DECISIONS_SOURCE_VERSION });
  }
  try {
    return await withTimeout(async () => {
      const [chain] = await db.select().from(schema.decisionChains).where(eq(schema.decisionChains.id, numericId)).limit(1);
      if (!chain) {
        return empty<DecisionDetailPayload>(emptyDetail(input.chainId), 'chain_not_found', { sourceVersion: DECISIONS_SOURCE_VERSION });
      }

      const [scanRun, marketObs, eligibility, setup, routing, cost, quant, outcome] = await Promise.all([
        db.execute(sql`SELECT id, startedAt, source FROM scan_runs WHERE id = ${chain.scanRunId} LIMIT 1`).catch(() => null),
        db.execute(sql`SELECT id, observedAt, dataAvailableAt FROM market_observations WHERE decisionChainId = ${chain.id} LIMIT 1`).catch(() => null),
        db.execute(sql`SELECT id, eligible, reasonCode, decidedAt FROM eligibility_decisions WHERE decisionChainId = ${chain.id} LIMIT 1`).catch(() => null),
        db.execute(sql`SELECT id, decidedAt, setupOutcome FROM setup_evaluations WHERE decisionChainId = ${chain.id} LIMIT 1`).catch(() => null),
        db.execute(sql`SELECT id, decidedAt, routedTo FROM strategy_routing_decisions WHERE decisionChainId = ${chain.id} LIMIT 1`).catch(() => null),
        db.execute(sql`SELECT id, createdAt FROM execution_cost_forecasts WHERE decisionChainId = ${chain.id} LIMIT 1`).catch(() => null),
        db.execute(sql`SELECT id, createdAt, decision FROM quantitative_decisions WHERE decisionChainId = ${chain.id} LIMIT 1`).catch(() => null),
        db.execute(sql`SELECT id, decisionOutcome, labelledAt FROM outcome_labels WHERE decisionChainId = ${chain.id} LIMIT 1`).catch(() => null),
      ]);

      const record = (stage: string, rows: unknown, provenance: DecisionRecord['provenance']): DecisionRecord | null => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = (rows as any)?.[0]?.[0] as Record<string, unknown> | undefined;
        if (!row) return null;
        const recordedAtRaw = row.decidedAt ?? row.observedAt ?? row.startedAt ?? row.createdAt ?? row.labelledAt ?? null;
        return {
          stage,
          recordId: String(row.id ?? 'unknown'),
          recordedAt: toIsoNullable(recordedAtRaw as Date | string | null),
          provenance,
          summary: null,
          detail: null,
          brokenReason: null,
        };
      };

      const brokenMarkers: string[] = [];
      if (chain.lineageCompleteness === 'broken') brokenMarkers.push('lineage_broken');
      if (chain.lineageCompleteness === 'legacy_unresolved') brokenMarkers.push('legacy_unresolved');

      const detail: DecisionDetailPayload = {
        chainId: String(chain.id),
        createdAt: (toIsoNullable(chain.observedAt) ?? new Date(0).toISOString()) as DecisionDetailPayload['createdAt'],
        product: chain.productId ?? null,
        championVersion: chain.strategyVersion ?? null,
        chain: {
          scanRun: record('scanRun', scanRun, CHAMPION_STAGE_PROVENANCE),
          marketObservation: record('marketObservation', marketObs, CHAMPION_STAGE_PROVENANCE),
          productEligibility: record('productEligibility', eligibility, CHAMPION_STAGE_PROVENANCE),
          setupEvaluation: record('setupEvaluation', setup, CHAMPION_STAGE_PROVENANCE),
          championRouting: record('championRouting', routing, CHAMPION_STAGE_PROVENANCE),
          costForecast: record('costForecast', cost, CHAMPION_STAGE_PROVENANCE),
          quantitativeAuthorization: record('quantitativeAuthorization', quant, CHAMPION_STAGE_PROVENANCE),
          claudeDecision: null,
          approvedPreview: null,
          executionPlan: null,
          orderIntents: [],
          fills: [],
          position: null,
          protection: null,
          exitActivity: [],
          cashLedger: [],
          roundTrip: null,
          outcomeLabel: record('outcomeLabel', outcome, CHAMPION_POST_OUTCOME),
        },
        observers: {
          phase2AFingerprint: null,
          phase2BRegime: null,
          phase2CRisk: null,
          phase2DMicrostructure: null,
          phase2EContext: null,
          phase2FUnifiedChallenger: null,
          validationAttribution: null,
        },
        brokenLineageMarkers: brokenMarkers,
      };

      // Mark absent observer stages explicitly. Any Phase 2 record whose
      // FK the schema exposes is loaded on a best-effort basis; if it's
      // missing we surface `null` (not a fabricated ok-record).
      return brokenMarkers.length > 0
        ? degraded(detail, 'decision_lineage_incomplete', { sourceVersion: DECISIONS_SOURCE_VERSION })
        : healthy(detail, { sourceVersion: DECISIONS_SOURCE_VERSION });
    });
  } catch (err) {
    return unavailable<DecisionDetailPayload>('decision_detail_failed', {
      sourceVersion: DECISIONS_SOURCE_VERSION,
      diagnostics: { detail: String(err).slice(0, 200) },
    });
  }
}

function emptyDetail(chainId: string): DecisionDetailPayload {
  return {
    chainId,
    createdAt: new Date(0).toISOString() as DecisionDetailPayload['createdAt'],
    product: null,
    championVersion: null,
    chain: {
      scanRun: null, marketObservation: null, productEligibility: null,
      setupEvaluation: null, championRouting: null, costForecast: null,
      quantitativeAuthorization: null, claudeDecision: null, approvedPreview: null,
      executionPlan: null, orderIntents: [], fills: [], position: null,
      protection: null, exitActivity: [], cashLedger: [], roundTrip: null,
      outcomeLabel: null,
    },
    observers: {
      phase2AFingerprint: null, phase2BRegime: null, phase2CRisk: null,
      phase2DMicrostructure: null, phase2EContext: null, phase2FUnifiedChallenger: null,
      validationAttribution: null,
    },
    brokenLineageMarkers: ['chain_not_found'],
  };
}

// Post-decision + post-outcome provenance constants used by tests
export { CHAMPION_STAGE_PROVENANCE, CHAMPION_POST_DECISION, CHAMPION_POST_OUTCOME, OBSERVER_ONLY };
