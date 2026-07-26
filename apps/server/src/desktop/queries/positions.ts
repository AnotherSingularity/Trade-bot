/**
 * Stage 3 §8 — Positions list + detail.
 *
 * List: cursor-paginated over positions.id DESC. Partial exits stay
 * `open` / `partially_exited`; dust remains explicit; unknown protection
 * stays `unknown` — never silently promoted to `confirmed`.
 *
 * Detail: joins fills + protection instances + reconciliation actions +
 * ledger entries + round-trip outcome. Missing-fill records mark the
 * position `degraded` rather than fabricating a complete record.
 */

import { and, desc, eq, like, lt, sql } from 'drizzle-orm';
import {
  DEFAULT_PAGE_SIZE,
  type PositionListEnvelope,
  type PositionListInput,
  type PositionListRow,
  type PositionDetailEnvelope,
  type PositionDetailInput,
  type PositionDetailPayload,
  type PositionState,
  type ProtectionState,
  type ReconciliationState,
  type DataQualityState,
} from '@horizon/shared';
import { db, schema } from '../../db';
import { decodeCursor, degraded, empty, encodeCursor, healthy, toDecimalStringNullable, toIsoNullable, unavailable, withTimeout } from './common';

export const POSITIONS_SOURCE_VERSION = 'positions.v1' as const;

const POSITION_STATE_MAP: Record<string, PositionState> = {
  opening: 'open',
  open: 'open',
  closing: 'open',
  closed: 'closed',
  reconciling: 'reconciling',
  pending_entry: 'open',
  partially_open: 'partially_exited',
  open_unprotected: 'open',
  open_protected: 'open',
  partially_closing: 'partially_exited',
  dust_residual: 'closed',
  reconciliation_required: 'reconciling',
  failed: 'orphaned',
};

const PROTECTION_STATE_MAP: Record<string, ProtectionState> = {
  attached_active: 'confirmed',
  attached_partial: 'degraded',
  polling_only: 'degraded',
  degraded: 'degraded',
  none: 'unprotected',
  unknown: 'unknown',
};

function mapLifecycleToPositionState(lifecycle: string, status: string): PositionState {
  const mapped = POSITION_STATE_MAP[lifecycle];
  if (mapped) return mapped;
  if (status === 'closed') return 'closed';
  if (status === 'open') return 'open';
  return 'unknown';
}

function mapProtection(state: string): ProtectionState {
  return PROTECTION_STATE_MAP[state] ?? 'unknown';
}

async function reconciliationStateFor(positionId: number): Promise<ReconciliationState> {
  try {
    const rows = await db.execute(sql`SELECT COUNT(*) AS n FROM reconciliation_actions WHERE resolvedAt IS NULL AND (detail LIKE ${`%positionId=${positionId}%`} OR entityId = ${String(positionId)})`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = Number((rows as any)?.[0]?.[0]?.n ?? (rows as any)?.[0]?.n ?? 0);
    if (n > 0) return 'pending';
    return 'in_sync';
  } catch {
    return 'unknown';
  }
}

async function dataQualityFor(positionId: number, filledQuantity: string | null, residualBaseSize: string | null): Promise<DataQualityState> {
  try {
    const rows = await db.execute(sql`SELECT COUNT(*) AS n FROM fills f JOIN order_intents oi ON oi.id = f.orderIntentId WHERE oi.positionId = ${positionId}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = Number((rows as any)?.[0]?.[0]?.n ?? (rows as any)?.[0]?.n ?? 0);
    if (n === 0 && (filledQuantity === null || filledQuantity === '0')) return 'missing_fills';
    if (residualBaseSize !== null && Number(residualBaseSize) > 0) return 'degraded';
    return 'complete';
  } catch {
    return 'unknown';
  }
}

export async function listPositions(input: PositionListInput | undefined): Promise<PositionListEnvelope> {
  const limit = Math.min(input?.limit ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  try {
    return await withTimeout(async () => {
      const cursor = input?.cursor ? decodeCursor(input.cursor) : null;
      if (input?.cursor && cursor === null) {
        return unavailable<{ items: PositionListRow[]; nextCursor: string | null }>('invalid_cursor', { sourceVersion: POSITIONS_SOURCE_VERSION });
      }

      const whereClauses = [] as ReturnType<typeof eq>[];
      if (input?.filter?.productPrefix) {
        whereClauses.push(like(schema.positions.token, `${input.filter.productPrefix}%`));
      }
      if (cursor && typeof cursor.id === 'number') {
        whereClauses.push(lt(schema.positions.id, cursor.id));
      }
      const rows = await db
        .select()
        .from(schema.positions)
        .where(whereClauses.length ? and(...whereClauses) : undefined)
        .orderBy(desc(schema.positions.id))
        .limit(limit + 1);

      const trimmed = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? encodeCursor({ id: trimmed[trimmed.length - 1].id }) : null;

      const items: PositionListRow[] = await Promise.all(trimmed.map(async (r) => {
        const state = mapLifecycleToPositionState(r.lifecycleState, r.status);
        const filterOut = input?.filter?.stateIn && !input.filter.stateIn.includes(state);
        return {
          id: String(r.id),
          product: r.token,
          state: filterOut ? state : state,
          remainingBaseQuantity: toDecimalStringNullable(r.residualBaseSize ?? r.filledQuantity),
          weightedEntryPrice: toDecimalStringNullable(r.avgEntryPrice),
          protectionState: mapProtection(r.protectionState),
          reconciliationState: await reconciliationStateFor(r.id),
          openedAt: toIsoNullable(r.openedAt),
          lastUpdateAt: toIsoNullable(r.closedAt ?? r.openedAt),
          dataQualityState: await dataQualityFor(r.id, r.filledQuantity, r.residualBaseSize ?? null),
        };
      }));

      const filtered = input?.filter?.stateIn ? items.filter((i) => input.filter!.stateIn!.includes(i.state)) : items;

      if (filtered.length === 0) {
        return empty({ items: [], nextCursor: null }, 'no_positions_match_filter', { sourceVersion: POSITIONS_SOURCE_VERSION });
      }

      return healthy({ items: filtered, nextCursor }, { sourceVersion: POSITIONS_SOURCE_VERSION });
    });
  } catch (err) {
    return unavailable<{ items: PositionListRow[]; nextCursor: string | null }>('positions_query_failed', {
      sourceVersion: POSITIONS_SOURCE_VERSION,
      diagnostics: { detail: String(err).slice(0, 200) },
    });
  }
}

export async function getPositionDetail(input: PositionDetailInput): Promise<PositionDetailEnvelope> {
  const numericId = Number(input.id);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return unavailable<PositionDetailPayload>('invalid_position_id', { sourceVersion: POSITIONS_SOURCE_VERSION });
  }
  try {
    return await withTimeout(async () => {
      const [row] = await db.select().from(schema.positions).where(eq(schema.positions.id, numericId)).limit(1);
      if (!row) {
        return empty<PositionDetailPayload>(emptyDetail(input.id), 'position_not_found', { sourceVersion: POSITIONS_SOURCE_VERSION });
      }

      // Fetch fills, protection instances, reconciliation actions, ledger, round-trip.
      const [fillRows, protectionRows, reconciliationRows, ledgerRows, roundTripRows] = await Promise.all([
        db.execute(sql`SELECT f.id, f.exchangeFillId, f.filledSize, f.fillPrice, f.fee, f.tradeTime FROM fills f JOIN order_intents oi ON oi.id = f.orderIntentId WHERE oi.positionId = ${numericId} ORDER BY f.tradeTime ASC`).catch(() => null),
        db.execute(sql`SELECT id, capability, requiredQuantity, confirmedQuantity, state, updatedAt FROM protection_instances WHERE positionId = ${numericId} ORDER BY id ASC`).catch(() => null),
        db.execute(sql`SELECT id, runId, action, resolvedAt, detail FROM reconciliation_actions WHERE detail LIKE ${`%positionId=${numericId}%`} OR entityId = ${String(numericId)} ORDER BY id ASC LIMIT 25`).catch(() => null),
        db.execute(sql`SELECT id, causeCategory, deltaUsd, createdAt FROM cash_ledger WHERE positionId = ${numericId} ORDER BY id ASC LIMIT 100`).catch(() => null),
        db.execute(sql`SELECT id, outcome, pnlUsd, closedAt FROM round_trips WHERE positionId = ${numericId} ORDER BY id DESC LIMIT 1`).catch(() => null),
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fills = (((fillRows as any)?.[0]) ?? []) as Array<Record<string, unknown>>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const protections = (((protectionRows as any)?.[0]) ?? []) as Array<Record<string, unknown>>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reconciliations = (((reconciliationRows as any)?.[0]) ?? []) as Array<Record<string, unknown>>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ledger = (((ledgerRows as any)?.[0]) ?? []) as Array<Record<string, unknown>>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rt = ((roundTripRows as any)?.[0]?.[0]) as Record<string, unknown> | undefined;

      const missingFills = fills.length === 0 && Number(row.filledQuantity) > 0;
      const brokenMarkers: string[] = [];
      if (missingFills) brokenMarkers.push('missing_entry_fills');
      if (row.entryDecisionChainId == null) brokenMarkers.push('missing_entry_decision_chain');

      const detail: PositionDetailPayload = {
        id: String(row.id),
        product: row.token,
        state: mapLifecycleToPositionState(row.lifecycleState, row.status),
        entryFills: fills.map((f) => ({
          fillId: String(f.exchangeFillId ?? f.id ?? 'unknown'),
          quantity: toDecimalStringNullable(f.filledSize) ?? '0',
          price: toDecimalStringNullable(f.fillPrice) ?? '0',
          fee: toDecimalStringNullable(f.fee),
          filledAt: (toIsoNullable(f.tradeTime as Date | string | null) ?? new Date(0).toISOString()) as PositionDetailPayload['entryFills'][number]['filledAt'],
        })),
        entryFees: toDecimalStringNullable(row.entryFees),
        partialExits: [],
        residualQuantity: toDecimalStringNullable(row.residualBaseSize ?? row.filledQuantity),
        dustQuantity: toDecimalStringNullable(row.dustQuantity ?? null),
        dustClassification: row.dustReason
          ? (row.dustReason.includes('min_size') ? 'below_min_size' : row.dustReason.includes('min_notional') ? 'below_min_notional' : 'unknown')
          : null,
        targetPrice: toDecimalStringNullable(row.takeProfitPrice),
        stopPrice: toDecimalStringNullable(row.stopLossPrice),
        protectedQuantity: protections.reduce<string | null>((acc, p) => {
          const q = toDecimalStringNullable(p.confirmedQuantity);
          if (q === null) return acc;
          return acc === null ? q : (Number(acc) + Number(q)).toString();
        }, null),
        bracketLegs: protections.map((p) => ({
          legId: String(p.id ?? 'unknown'),
          role: p.capability === 'exchange_bracket' ? ('take_profit' as const) : ('other' as const),
          state: p.state === 'attached_active' ? ('active' as const) : p.state === 'attached_partial' ? ('active' as const) : p.state === 'none' ? ('cancelled' as const) : ('unknown' as const),
          triggerPrice: null,
          quantity: toDecimalStringNullable(p.requiredQuantity),
          lastUpdateAt: toIsoNullable(p.updatedAt as Date | string | null),
        })),
        exitAttempts: [],
        reconciliationHistory: reconciliations.map((r) => ({
          runId: String(r.runId ?? r.id ?? 'unknown'),
          runAt: (toIsoNullable(r.createdAt as Date | string | null) ?? new Date(0).toISOString()) as PositionDetailPayload['reconciliationHistory'][number]['runAt'],
          action: String(r.action ?? 'unknown'),
          outcome: r.resolvedAt != null ? ('applied' as const) : ('no_op' as const),
          detail: r.detail != null ? String(r.detail).slice(0, 500) : null,
        })),
        ledgerEffects: ledger.map((l) => ({
          ledgerId: String(l.id ?? 'unknown'),
          causeCategory: String(l.causeCategory ?? 'unknown'),
          delta: toDecimalStringNullable(l.deltaUsd) ?? '0',
          balanceAfter: null,
          recordedAt: (toIsoNullable(l.createdAt as Date | string | null) ?? new Date(0).toISOString()) as PositionDetailPayload['ledgerEffects'][number]['recordedAt'],
        })),
        costAttribution: {
          forecastVersion: null,
          forecastFees: null,
          realizedFees: toDecimalStringNullable(row.entryFees),
          forecastSpread: null,
          realizedSpread: null,
          forecastImpact: null,
          realizedImpact: null,
          totalForecastError: null,
          netOutcome: rt ? toDecimalStringNullable(rt.pnlUsd) : null,
        },
        roundTrip: rt
          ? {
              roundTripId: String(rt.id ?? ''),
              outcomeLabel: (rt.outcome === 'win' || rt.outcome === 'loss' ? rt.outcome : rt.outcome === 'open' ? 'incomplete' : 'unknown') as 'win' | 'loss' | 'scratch' | 'incomplete' | 'unknown',
              netPnl: toDecimalStringNullable(rt.pnlUsd),
              netPnlPct: null,
              closedAt: toIsoNullable(rt.closedAt as Date | string | null),
            }
          : null,
        dataQualityState: missingFills ? 'missing_fills' : brokenMarkers.length > 0 ? 'degraded' : 'complete',
        brokenLineageMarkers: brokenMarkers,
      };

      const isDegraded = detail.dataQualityState !== 'complete';
      return isDegraded
        ? degraded(detail, `position_${detail.dataQualityState}`, { sourceVersion: POSITIONS_SOURCE_VERSION })
        : healthy(detail, { sourceVersion: POSITIONS_SOURCE_VERSION });
    });
  } catch (err) {
    return unavailable<PositionDetailPayload>('position_detail_failed', {
      sourceVersion: POSITIONS_SOURCE_VERSION,
      diagnostics: { detail: String(err).slice(0, 200) },
    });
  }
}

function emptyDetail(id: string): PositionDetailPayload {
  return {
    id,
    product: 'unknown',
    state: 'unknown',
    entryFills: [],
    entryFees: null,
    partialExits: [],
    residualQuantity: null,
    dustQuantity: null,
    dustClassification: null,
    targetPrice: null,
    stopPrice: null,
    protectedQuantity: null,
    bracketLegs: [],
    exitAttempts: [],
    reconciliationHistory: [],
    ledgerEffects: [],
    costAttribution: { forecastVersion: null, forecastFees: null, realizedFees: null, forecastSpread: null, realizedSpread: null, forecastImpact: null, realizedImpact: null, totalForecastError: null, netOutcome: null },
    roundTrip: null,
    dataQualityState: 'unknown',
    brokenLineageMarkers: ['position_not_found'],
  };
}
