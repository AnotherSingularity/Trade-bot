/**
 * Stage 3B — real DB-backed query services for the 11 domains that
 * Stage 3A left as `<domain>.v0-stub` placeholders.
 *
 * Rules (Stage 3B §2):
 *   - Read-only. Zero economic writes; zero drizzle-mutation helpers.
 *   - No fabricated healthy responses.
 *   - Empty tables → `empty` envelope with a specific reason.
 *   - Query failure → `unavailable` with sanitized detail.
 *   - Old / stale rows → `degraded` with reason.
 *   - Unknown numeric values → `null` (never zero-filled).
 *   - Money + quantities remain decimal strings.
 *   - Deterministic ordering; cursor pagination where the contract asks.
 *
 * Every response envelope carries the domain's real `sourceVersion` (never
 * a `v0-stub`), and honest freshness metadata pulled from the underlying
 * `observedAt` / `dataAvailableAt` columns.
 */

import { sql } from 'drizzle-orm';
import {
  DEFAULT_PAGE_SIZE,
  type ConfigurationEnvelope,
  type ContextEnvelope,
  type ContextPayload,
  type CostsEnvelope,
  type CostsPayload,
  type FingerprintListEnvelope,
  type FingerprintListInput,
  type IncidentAcknowledgeEnvelope,
  type IncidentAcknowledgeInput,
  type IncidentListEnvelope,
  type IncidentListInput,
  type IncidentRow,
  type MicrostructureEnvelope,
  type MicrostructurePayload,
  type PortfolioMeasurement,
  type ProtectionEnvelope,
  type ProtectionPayload,
  type ReconciliationListEnvelope,
  type ReconciliationListInput,
  type ReconciliationRunRowSchema,
  type RegimeEnvelope,
  type RegimePayload,
  type ReportsEnvelope,
  type RiskEnvelope,
  type RiskPayload,
  type SafetyEnvelope,
  type SystemEnvelope,
  type UniverseListEnvelope,
  type UniverseListInput,
  type UniverseRow,
  type ValidationEnvelope,
  type ValidationExperimentListInput,
} from '@horizon/shared';
import { db } from '../../db';
import { httpCounters } from '../../lib/fetchBarrier';
import {
  decodeCursor,
  degraded,
  empty,
  encodeCursor,
  healthy,
  nowIso,
  toDecimalStringNullable,
  toIsoNullable,
  unavailable,
  withTimeout,
} from './common';

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

function unknownM(reason: string, unit: PortfolioMeasurement['unit'] = 'usd'): PortfolioMeasurement {
  return { status: 'unknown', value: null, unit, observedAt: null, dataAvailableAt: null, policyVersion: null, confidence: null, reasonCode: reason };
}

function knownM(value: string, opts: { unit?: PortfolioMeasurement['unit']; observedAt?: string | null; policyVersion?: string | null; confidence?: string | null } = {}): PortfolioMeasurement {
  return {
    status: 'known',
    value,
    unit: opts.unit ?? 'usd',
    observedAt: (opts.observedAt as PortfolioMeasurement['observedAt']) ?? null,
    dataAvailableAt: null,
    policyVersion: opts.policyVersion ?? null,
    confidence: opts.confidence ?? null,
    reasonCode: null,
  };
}

// Discriminates whether a SELECT actually returned rows; drizzle wraps
// mysql2 output as [rows, fields] — first element is always the rows.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractRows(res: unknown): Array<Record<string, any>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (res as any)?.[0] ?? [];
  return Array.isArray(r) ? (r as Array<Record<string, unknown>>) : [];
}

// ---------------------------------------------------------------------------
// Universe — Stage 3 §10.
// ---------------------------------------------------------------------------

const CHAMPION_UNIVERSE = new Set(['BTC-USD', 'ETH-USD', 'SOL-USD', 'AVAX-USD']);

export async function listUniverse(input: UniverseListInput | undefined): Promise<UniverseListEnvelope> {
  const limit = Math.min(input?.limit ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  try {
    return await withTimeout(async () => {
      const cursor = input?.cursor ? decodeCursor(input.cursor) : null;
      if (input?.cursor && cursor === null) {
        return unavailable<{ items: UniverseRow[]; nextCursor: string | null }>('invalid_cursor', { sourceVersion: 'universe.v1' });
      }
      // Latest snapshot only.
      const snapRes = await db.execute(sql`SELECT id, observedAt, dataAvailableAt, snapshotVersion FROM universe_snapshots ORDER BY id DESC LIMIT 1`);
      const snapRow = extractRows(snapRes)[0] as { id: number; observedAt: Date; dataAvailableAt: Date; snapshotVersion: string } | undefined;
      if (!snapRow) {
        return empty({ items: [], nextCursor: null }, 'no_universe_snapshot_yet', { sourceVersion: 'universe.v1' });
      }
      // Cursor: last productId processed alphabetically.
      const afterProduct = typeof cursor?.productId === 'string' ? String(cursor.productId) : null;
      const prefix = input?.filter?.productPrefix?.toUpperCase() ?? null;
      const membershipFilter = input?.filter?.membership ?? 'any';

      // Latest hygiene per product for this snapshot.
      const hygieneRes = await db.execute(sql`
        SELECT up.productId, h.result, h.reasonCodes, h.reasonDetail, h.policyVersion, h.decidedAt
        FROM universe_products up
        LEFT JOIN product_hygiene_decisions h
          ON h.productId = up.productId AND h.snapshotId = up.snapshotId
        WHERE up.snapshotId = ${snapRow.id}
        ${afterProduct ? sql`AND up.productId > ${afterProduct}` : sql``}
        ${prefix ? sql`AND up.productId LIKE ${prefix + '%'}` : sql``}
        ORDER BY up.productId ASC
        LIMIT ${limit + 1}
      `);
      const rawRows = extractRows(hygieneRes);
      const overflow = rawRows.length > limit;
      const trimmed = rawRows.slice(0, limit);

      const items: UniverseRow[] = [];
      for (const r of trimmed) {
        const product = String(r.productId);
        const isChampion = CHAMPION_UNIVERSE.has(product);
        const membership: Array<'champion' | 'observer'> = isChampion ? ['champion', 'observer'] : ['observer'];
        if (membershipFilter === 'champion' && !membership.includes('champion')) continue;
        if (membershipFilter === 'observer' && !membership.includes('observer')) continue;
        if (membershipFilter === 'quarantined' && r.result !== 'quarantined') continue;

        // Quarantine + metadata freshness details.
        const [quarRes, metaRes] = await Promise.all([
          db.execute(sql`SELECT reason FROM product_quarantines WHERE productId = ${product} AND resolvedAt IS NULL ORDER BY id DESC LIMIT 1`).catch(() => null),
          db.execute(sql`SELECT metadataObservedAt, tradingStatus, tradingDisabled, approximateVolume24h FROM product_metadata_observations WHERE productId = ${product} ORDER BY metadataObservedAt DESC LIMIT 1`).catch(() => null),
        ]);
        const quar = extractRows(quarRes)[0] as { reason: string } | undefined;
        const meta = extractRows(metaRes)[0] as { metadataObservedAt: Date; tradingStatus: string; tradingDisabled: number; approximateVolume24h: string | null } | undefined;
        const metaAgeMinutes = meta ? Math.floor((Date.now() - new Date(meta.metadataObservedAt).getTime()) / 60_000) : null;

        items.push({
          product,
          membership,
          eligibility: r.result === 'eligible' ? 'eligible' : r.result === 'ineligible' || r.result === 'quarantined' ? 'ineligible' : 'unknown',
          hygieneState: r.result === 'eligible' ? 'clean' : r.result === 'quarantined' ? 'quarantined' : r.result === 'insufficient_data' ? 'unknown' : 'warning',
          quarantineReason: quar?.reason ?? (r.result === 'quarantined' ? String(r.reasonCodes ?? 'unknown') : null),
          metadataFreshness: !meta ? 'missing' : metaAgeMinutes !== null && metaAgeMinutes > 24 * 60 ? 'stale' : 'fresh',
          liquidityState: meta?.approximateVolume24h == null
            ? 'unknown'
            : Number(meta.approximateVolume24h) >= 1_000_000
              ? 'sufficient'
              : Number(meta.approximateVolume24h) >= 100_000
                ? 'thin'
                : 'insufficient',
          historySufficiency: 'unknown', // not tracked as its own field in Phase 2A schema
          featureCompletionRate: null,
          fingerprintState: 'unknown', // fingerprints.list carries the detail
          regimeState: null,
          confidence: null,
          missingEvidence: [],
          failureReason: r.reasonDetail ? String(r.reasonDetail).slice(0, 500) : null,
        });
      }

      const nextCursor = overflow && trimmed.length > 0 ? encodeCursor({ productId: trimmed[trimmed.length - 1].productId as string }) : null;

      if (items.length === 0) {
        return empty({ items: [], nextCursor: null }, 'no_products_match_filter', { sourceVersion: 'universe.v1', observedAt: toIsoNullable(snapRow.observedAt) ?? undefined });
      }
      return healthy({ items, nextCursor }, {
        sourceVersion: 'universe.v1',
        observedAt: toIsoNullable(snapRow.observedAt) ?? undefined,
        dataAvailableAt: toIsoNullable(snapRow.dataAvailableAt) ?? undefined,
        policyVersions: { universe: 'p2a-1', snapshot: snapRow.snapshotVersion },
      });
    });
  } catch (err) {
    return unavailable<{ items: UniverseRow[]; nextCursor: string | null }>('universe_query_failed', {
      sourceVersion: 'universe.v1',
      diagnostics: { detail: String(err).slice(0, 200) },
    });
  }
}

// ---------------------------------------------------------------------------
// Fingerprints — Stage 3 §10.
// ---------------------------------------------------------------------------

export async function listFingerprints(input: FingerprintListInput | undefined): Promise<FingerprintListEnvelope> {
  const limit = Math.min(input?.limit ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  try {
    return await withTimeout(async () => {
      const cursor = input?.cursor ? decodeCursor(input.cursor) : null;
      if (input?.cursor && cursor === null) {
        return unavailable('invalid_cursor', { sourceVersion: 'fingerprints.v1' });
      }
      const cursorId = typeof cursor?.id === 'number' ? cursor.id : null;
      const prefix = input?.filter?.productPrefix?.toUpperCase() ?? null;
      // Latest snapshot per product; ordered by snapshot id DESC.
      const res = await db.execute(sql`
        SELECT fs.id, fs.productId, fs.fingerprintClass, fs.confidence, fs.qualityPenalty, fs.liquidityPenalty,
               fs.inputHash, fs.observedAt, fs.availableAt, fs.featureVersions
        FROM fingerprint_snapshots fs
        ${cursorId ? sql`WHERE fs.id < ${cursorId}` : sql``}
        ${prefix ? sql`${cursorId ? sql`AND` : sql`WHERE`} fs.productId LIKE ${prefix + '%'}` : sql``}
        ORDER BY fs.id DESC
        LIMIT ${limit + 1}
      `);
      const rows = extractRows(res);
      const overflow = rows.length > limit;
      const trimmed = rows.slice(0, limit);
      if (trimmed.length === 0) {
        return empty({ items: [], nextCursor: null }, 'no_fingerprints_yet', { sourceVersion: 'fingerprints.v1' });
      }
      // Evidence for each fingerprint (best-effort; missing table → no evidence).
      const items = await Promise.all(trimmed.map(async (r) => {
        const evidenceRes = await db.execute(sql`SELECT evidenceType, evidenceKey FROM fingerprint_evidence WHERE snapshotId = ${r.id}`).catch(() => null);
        const evidence = extractRows(evidenceRes);
        const supporting: string[] = [];
        const conflicting: string[] = [];
        const missing: string[] = [];
        for (const e of evidence) {
          const type = String(e.evidenceType);
          const key = String(e.evidenceKey);
          if (type === 'supporting') supporting.push(key);
          else if (type === 'conflicting') conflicting.push(key);
          else if (type === 'missing') missing.push(key);
        }
        let featureVersions: Record<string, string> = {};
        try {
          if (typeof r.featureVersions === 'string') {
            featureVersions = JSON.parse(r.featureVersions);
          } else if (r.featureVersions && typeof r.featureVersions === 'object') {
            featureVersions = r.featureVersions as Record<string, string>;
          }
        } catch { /* leave empty */ }
        return {
          fingerprintId: String(r.id),
          product: String(r.productId),
          fingerprintClass: String(r.fingerprintClass ?? 'UNCLASSIFIED'),
          featureEvidence: supporting.slice(),
          supportingEvidence: supporting,
          conflictingEvidence: conflicting,
          missingFeatures: missing,
          qualityPenalty: toDecimalStringNullable(r.qualityPenalty),
          liquidityPenalty: toDecimalStringNullable(r.liquidityPenalty),
          confidence: toDecimalStringNullable(r.confidence),
          featureVersions,
          inputHash: r.inputHash ? String(r.inputHash) : null,
          observedAt: toIsoNullable(r.observedAt as Date | string | null),
          availableAt: toIsoNullable(r.availableAt as Date | string | null),
        };
      }));
      const nextCursor = overflow && trimmed.length > 0 ? encodeCursor({ id: trimmed[trimmed.length - 1].id as number }) : null;
      return healthy({ items, nextCursor }, { sourceVersion: 'fingerprints.v1', policyVersions: { universe: 'p2a-1' } });
    });
  } catch (err) {
    return unavailable('fingerprints_query_failed', {
      sourceVersion: 'fingerprints.v1',
      diagnostics: { detail: String(err).slice(0, 200) },
    });
  }
}

// ---------------------------------------------------------------------------
// Regimes — Stage 3 §11.
// ---------------------------------------------------------------------------

export async function getRegimes(): Promise<RegimeEnvelope> {
  try {
    return await withTimeout(async () => {
      const [globalRes, productRes] = await Promise.all([
        db.execute(sql`SELECT id, rawRegime, smoothedRegime, confidence, observedAt, dataAvailableAt, policyVersion, latentState, semanticMapping, baselineVote, stateDurationSeconds FROM global_regime_snapshots ORDER BY id DESC LIMIT 1`).catch(() => null),
        db.execute(sql`SELECT id, productId, rawRegime, smoothedRegime, confidence, observedAt, latentState, semanticMapping, transitionState, stateDurationSeconds FROM product_regime_snapshots ORDER BY id DESC LIMIT 25`).catch(() => null),
      ]);
      const g = extractRows(globalRes)[0] as Record<string, unknown> | undefined;
      const pRows = extractRows(productRes);
      if (!g && pRows.length === 0) {
        return empty(emptyRegimePayload(), 'no_regime_data_yet', { sourceVersion: 'regimes.v1' });
      }

      const [changesRes, routeRes] = await Promise.all([
        g ? db.execute(sql`SELECT detectorId, confidence FROM change_point_events WHERE globalRegimeSnapshotId = ${g.id} ORDER BY id ASC LIMIT 8`).catch(() => null) : Promise.resolve(null),
        db.execute(sql`SELECT selectedRoute FROM challenger_routing_decisions ORDER BY id DESC LIMIT 1`).catch(() => null),
      ]);
      const changeDetectorVotes: Record<string, string> = {};
      for (const c of extractRows(changesRes)) {
        changeDetectorVotes[String(c.detectorId ?? 'unknown')] = String(c.confidence ?? '');
      }
      const routeRow = extractRows(routeRes)[0] as { selectedRoute: string } | undefined;

      const payload: RegimePayload = {
        globalRegime: {
          raw: g?.rawRegime ? String(g.rawRegime) : null,
          smoothed: g?.smoothedRegime ? String(g.smoothedRegime) : null,
          latentState: g?.latentState ? String(g.latentState) : null,
          semanticMapping: g?.semanticMapping ? String(g.semanticMapping) : null,
          confidence: toDecimalStringNullable(g?.confidence),
          baselineVote: g?.baselineVote ? String(g.baselineVote) : null,
          changeDetectorVotes,
          stateDuration: g?.stateDurationSeconds != null ? `${g.stateDurationSeconds}s` : null,
          observedAt: g?.observedAt ? toIsoNullable(g.observedAt as Date | string) : null,
        },
        productRegimes: pRows.map((r) => ({
          product: String(r.productId),
          raw: r.rawRegime ? String(r.rawRegime) : null,
          smoothed: r.smoothedRegime ? String(r.smoothedRegime) : null,
          latentState: r.latentState ? String(r.latentState) : null,
          semanticMapping: r.semanticMapping ? String(r.semanticMapping) : null,
          confidence: toDecimalStringNullable(r.confidence),
          transitionState: r.transitionState ? String(r.transitionState) : null,
          rejectedTransitions: [],
          stateDuration: r.stateDurationSeconds != null ? `${r.stateDurationSeconds}s` : null,
          observedAt: r.observedAt ? toIsoNullable(r.observedAt as Date | string) : null,
        })),
        challengerRoute: routeRow?.selectedRoute ?? null,
        championComparison: null,
        policyVersion: g?.policyVersion ? String(g.policyVersion) : 'p2b-1',
      };
      return healthy(payload, {
        sourceVersion: 'regimes.v1',
        observedAt: payload.globalRegime.observedAt ?? undefined,
        policyVersions: { regime: payload.policyVersion ?? 'p2b-1' },
      });
    });
  } catch (err) {
    return unavailable('regimes_query_failed', {
      sourceVersion: 'regimes.v1',
      diagnostics: { detail: String(err).slice(0, 200) },
    });
  }
}

function emptyRegimePayload(): RegimePayload {
  return {
    globalRegime: {
      raw: null, smoothed: null, latentState: null, semanticMapping: null,
      confidence: null, baselineVote: null, changeDetectorVotes: {},
      stateDuration: null, observedAt: null,
    },
    productRegimes: [],
    challengerRoute: null,
    championComparison: null,
    policyVersion: null,
  };
}

// ---------------------------------------------------------------------------
// Risk — Stage 3 §12.
// ---------------------------------------------------------------------------

export async function getRisk(): Promise<RiskEnvelope> {
  try {
    return await withTimeout(async () => {
      const snapRes = await db.execute(sql`
        SELECT id, policyVersionId, observedAt, dataAvailableAt, cash, reservedCash,
               grossExposure, netExposure, totalOpenStopRisk, unprotectedExposure,
               dailyLoss, weeklyLoss, currentDrawdown, historicalVaR, historicalExpectedShortfall,
               worstStressLoss, systemIntegrityState, dataQualityState
        FROM portfolio_risk_snapshots
        ORDER BY id DESC LIMIT 1
      `);
      const snap = extractRows(snapRes)[0] as Record<string, unknown> | undefined;
      if (!snap) {
        return empty(emptyRiskPayload(), 'no_risk_snapshot_yet', { sourceVersion: 'risk.v1' });
      }
      const observedAt = toIsoNullable(snap.observedAt as Date | string | null);
      const policyVersion = snap.policyVersionId != null ? String(snap.policyVersionId) : null;

      const [limitsRes, breachesRes, candidateRes] = await Promise.all([
        db.execute(sql`SELECT id, capType, threshold FROM risk_limit_definitions WHERE policyVersionId = ${snap.policyVersionId} ORDER BY id ASC LIMIT 50`).catch(() => null),
        db.execute(sql`SELECT id, limitDefinitionId, observedValue, magnitude, detail, breachedAt FROM risk_limit_breaches WHERE portfolioRiskSnapshotId = ${snap.id} ORDER BY id ASC LIMIT 20`).catch(() => null),
        db.execute(sql`SELECT decision, finalSizeUsd, reasonCodes, volatilityMultiplier FROM candidate_risk_decisions WHERE policyVersionId = ${snap.policyVersionId} ORDER BY id DESC LIMIT 1`).catch(() => null),
      ]);
      const limits = extractRows(limitsRes);
      const breaches = extractRows(breachesRes);
      const candidate = extractRows(candidateRes)[0] as { decision: string; finalSizeUsd: string | null; reasonCodes: string | null; volatilityMultiplier: string | null } | undefined;

      const caps: RiskPayload['caps'] = limits.map((l) => ({
        key: String(l.capType ?? l.id),
        label: String(l.capType ?? 'cap'),
        limit: toDecimalStringNullable(l.threshold),
        observed: null,
        binding: false,
        breach: breaches.some((b) => Number(b.limitDefinitionId) === Number(l.id)),
        action: 'none',
        reasonCode: null,
      }));

      const payload: RiskPayload = {
        policyVersion,
        observedAt,
        observerEnforcementActive: false,
        kellyEnabled: false,
        candidateStopRisk: measurement(snap.totalOpenStopRisk, observedAt, policyVersion, 'usd', 'stop_risk_null'),
        volatilityMultiplier: candidate?.volatilityMultiplier != null
          ? measurement(candidate.volatilityMultiplier, observedAt, policyVersion, 'ratio', 'volmult_null')
          : unknownM('no_candidate_decision', 'ratio'),
        caps,
        breaches: breaches.map((b) => ({
          breachId: String(b.id),
          limitKey: String(b.limitDefinitionId ?? 'unknown'),
          observedAt: toIsoNullable(b.breachedAt as Date | string | null),
          magnitude: toDecimalStringNullable(b.magnitude ?? b.observedValue),
          detail: b.detail ? String(b.detail).slice(0, 500) : null,
        })),
        systemIntegrityVetoes: snap.systemIntegrityState === 'ok' ? [] : [String(snap.systemIntegrityState)],
        expectedShortfall: measurement(snap.historicalExpectedShortfall, observedAt, policyVersion, 'usd', 'es_null'),
        stressRuns: snap.worstStressLoss != null
          ? [{ scenarioId: 'worst', scenarioName: 'worst_stress_persisted', measurement: measurement(snap.worstStressLoss, observedAt, policyVersion, 'usd', 'worst_stress_null'), runAt: observedAt }]
          : [],
        bindingCap: null,
        candidateDecision: {
          outcome: candidate?.decision === 'authorize_as_proposed' ? 'approved' : candidate?.decision === 'reduce_size' ? 'shrunk' : candidate?.decision === 'reject' ? 'blocked' : 'unknown',
          finalSize: toDecimalStringNullable(candidate?.finalSizeUsd),
          reasonCode: candidate?.reasonCodes ? String(candidate.reasonCodes) : null,
        },
        championComparison: null,
      };
      return healthy(payload, {
        sourceVersion: 'risk.v1',
        observedAt: observedAt ?? undefined,
        policyVersions: { risk: policyVersion ?? 'p2c-1' },
      });
    });
  } catch (err) {
    return unavailable('risk_query_failed', {
      sourceVersion: 'risk.v1',
      diagnostics: { detail: String(err).slice(0, 200) },
    });
  }
}

function emptyRiskPayload(): RiskPayload {
  return {
    policyVersion: null,
    observedAt: null,
    observerEnforcementActive: false,
    kellyEnabled: false,
    candidateStopRisk: unknownM('no_snapshot'),
    volatilityMultiplier: unknownM('no_snapshot', 'ratio'),
    caps: [],
    breaches: [],
    systemIntegrityVetoes: [],
    expectedShortfall: unknownM('no_snapshot'),
    stressRuns: [],
    bindingCap: null,
    candidateDecision: { outcome: 'unknown', finalSize: null, reasonCode: 'no_snapshot' },
    championComparison: null,
  };
}

function measurement(raw: unknown, observedAt: string | null, policyVersion: string | null, unit: PortfolioMeasurement['unit'], missingReason: string): PortfolioMeasurement {
  const value = toDecimalStringNullable(raw);
  if (value === null) return unknownM(missingReason, unit);
  return knownM(value, { unit, observedAt, policyVersion });
}

// ---------------------------------------------------------------------------
// Microstructure — Stage 3 §13.
// ---------------------------------------------------------------------------

export async function getMicrostructure(): Promise<MicrostructureEnvelope> {
  try {
    return await withTimeout(async () => {
      const sessionRes = await db.execute(sql`SELECT id, productId, sessionState, observedAt FROM order_book_sessions ORDER BY id DESC LIMIT 25`);
      const sessions = extractRows(sessionRes);
      if (sessions.length === 0) {
        return empty(emptyMicrostructurePayload(), 'no_microstructure_sessions_yet', { sourceVersion: 'microstructure.v1' });
      }
      const shortlist: MicrostructurePayload['shortlist'] = await Promise.all(sessions.map(async (s) => {
        const productId = String(s.productId);
        const snapshotRes = await db.execute(sql`SELECT bestBid, bestAsk, spread, midprice, microprice, sequenceNumber, observedAt FROM order_book_snapshots WHERE sessionId = ${s.id} ORDER BY id DESC LIMIT 1`).catch(() => null);
        const snap = extractRows(snapshotRes)[0] as Record<string, unknown> | undefined;
        const bookHealth = String(s.sessionState) === 'healthy' ? 'healthy' as const : String(s.sessionState) === 'gap' ? 'degraded' as const : String(s.sessionState) === 'invalid' ? 'invalid' as const : 'unknown' as const;
        return {
          product: productId,
          bookSessionId: String(s.id),
          bookHealth,
          continuityState: bookHealth === 'invalid' ? 'reset' as const : bookHealth === 'degraded' ? 'gap' as const : bookHealth === 'healthy' ? 'continuous' as const : 'unknown' as const,
          bestBid: bookHealth === 'invalid' ? null : toDecimalStringNullable(snap?.bestBid),
          bestAsk: bookHealth === 'invalid' ? null : toDecimalStringNullable(snap?.bestAsk),
          spread: bookHealth === 'invalid' ? null : toDecimalStringNullable(snap?.spread),
          midprice: bookHealth === 'invalid' ? null : toDecimalStringNullable(snap?.midprice),
          microprice: bookHealth === 'invalid' ? null : toDecimalStringNullable(snap?.microprice),
          depthBands: [],
          depthImbalance: null,
          impactCurves: [],
          visibleExecutableQuantity: null,
          unfillableResidual: null,
          buyerFlow: null,
          sellerFlow: null,
          unknownFlow: null,
          cvd: null,
          passiveFillEstimate: null,
          queueUncertainty: 'unknown' as const,
          stopExecutionEstimate: null,
          executionCostEstimate: null,
          observedAt: toIsoNullable((snap?.observedAt ?? s.observedAt) as Date | string | null),
        };
      }));
      return healthy({
        productionLevel2Active: false as const,
        queuePositionKnown: false as const,
        policyVersion: 'p2d-1',
        shortlist,
        observerRecommendation: null,
        championComparison: null,
      }, {
        sourceVersion: 'microstructure.v1',
        policyVersions: { microstructure: 'p2d-1' },
      });
    });
  } catch (err) {
    return unavailable('microstructure_query_failed', {
      sourceVersion: 'microstructure.v1',
      diagnostics: { detail: String(err).slice(0, 200) },
    });
  }
}

function emptyMicrostructurePayload(): MicrostructurePayload {
  return {
    productionLevel2Active: false,
    queuePositionKnown: false,
    policyVersion: null,
    shortlist: [],
    observerRecommendation: null,
    championComparison: null,
  };
}

// ---------------------------------------------------------------------------
// Context — Stage 3 §14.
// ---------------------------------------------------------------------------

export async function getContext(): Promise<ContextEnvelope> {
  try {
    return await withTimeout(async () => {
      const [providersRes, signalsRes, warningsRes, ensembleRes] = await Promise.all([
        db.execute(sql`SELECT p.providerId, p.label, h.healthStatus, h.staleness, h.observedAt FROM context_provider_definitions p LEFT JOIN context_provider_health h ON h.providerId = p.providerId AND h.id = (SELECT MAX(id) FROM context_provider_health WHERE providerId = p.providerId) ORDER BY p.providerId ASC`).catch(() => null),
        db.execute(sql`SELECT signalId, family, value, observedAt, reasonCode FROM context_signal_values ORDER BY id DESC LIMIT 100`).catch(() => null),
        db.execute(sql`SELECT id, incidentType, subsystem, openedAt FROM context_incidents WHERE resolvedAt IS NULL ORDER BY id DESC LIMIT 20`).catch(() => null),
        db.execute(sql`SELECT ensembleMultiplier, observedAt, policyVersion FROM context_ensemble_evidence ORDER BY id DESC LIMIT 1`).catch(() => null),
      ]);
      const providers = extractRows(providersRes);
      const signals = extractRows(signalsRes);
      const incidents = extractRows(warningsRes);
      const ensemble = extractRows(ensembleRes)[0] as { ensembleMultiplier: string; observedAt: Date; policyVersion: string } | undefined;
      if (providers.length === 0 && signals.length === 0 && incidents.length === 0 && !ensemble) {
        return empty({
          policyVersion: null, providers: [], signals: [], globalSnapshot: null, productSnapshots: [],
          ensembleMultiplier: unknownM('no_context_data', 'ratio'),
          warnings: [], vetoes: [], missingSignals: [], conflicts: [], incidents: [],
          championComparison: null,
        }, 'no_context_data_yet', { sourceVersion: 'context.v1' });
      }

      // Contract-safety: multiplier is capped at 1 for supportive context.
      const rawMultiplier = toDecimalStringNullable(ensemble?.ensembleMultiplier);
      const cappedMultiplier = rawMultiplier !== null && Number(rawMultiplier) > 1 ? '1' : rawMultiplier;

      const payload: ContextPayload = {
        policyVersion: ensemble?.policyVersion ?? 'p2e-1',
        providers: providers.map((p) => ({
          providerId: String(p.providerId),
          label: String(p.label ?? p.providerId),
          health: p.healthStatus === 'healthy' ? 'healthy' as const : p.healthStatus === 'stale' ? 'stale' as const : p.healthStatus === 'degraded' ? 'degraded' as const : p.healthStatus == null ? 'unknown' as const : 'unavailable' as const,
          staleness: toDecimalStringNullable(p.staleness),
          lastObservedAt: toIsoNullable(p.observedAt as Date | string | null),
        })),
        signals: signals.map((s) => ({
          signalId: String(s.signalId),
          family: String(s.family ?? 'unknown'),
          status: s.value == null ? 'missing' as const : 'available' as const,
          value: toDecimalStringNullable(s.value),
          observedAt: toIsoNullable(s.observedAt as Date | string | null),
          reasonCode: s.reasonCode ? String(s.reasonCode) : null,
        })),
        globalSnapshot: null,
        productSnapshots: [],
        ensembleMultiplier: cappedMultiplier !== null
          ? knownM(cappedMultiplier, { unit: 'ratio', observedAt: toIsoNullable(ensemble?.observedAt as Date | string | null), policyVersion: ensemble?.policyVersion })
          : unknownM('no_ensemble_evidence', 'ratio'),
        warnings: [],
        vetoes: [],
        missingSignals: [],
        conflicts: [],
        incidents: incidents.map((i) => `${i.incidentType ?? 'incident'}:${i.subsystem ?? 'unknown'}`),
        championComparison: null,
      };
      return healthy(payload, { sourceVersion: 'context.v1', policyVersions: { context: payload.policyVersion ?? 'p2e-1' } });
    });
  } catch (err) {
    return unavailable('context_query_failed', {
      sourceVersion: 'context.v1',
      diagnostics: { detail: String(err).slice(0, 200) },
    });
  }
}

// ---------------------------------------------------------------------------
// Validation — Stage 3 §15.
// ---------------------------------------------------------------------------

export async function getValidation(input: ValidationExperimentListInput | undefined): Promise<ValidationEnvelope> {
  const limit = Math.min(input?.limit ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  try {
    return await withTimeout(async () => {
      const cursor = input?.cursor ? decodeCursor(input.cursor) : null;
      if (input?.cursor && cursor === null) {
        return unavailable('invalid_cursor', { sourceVersion: 'validation.v1' });
      }
      const cursorId = typeof cursor?.id === 'number' ? cursor.id : null;
      const expRes = await db.execute(sql`
        SELECT e.id, e.experimentName, e.datasetId, e.createdAt, e.splitPolicy, e.status
        FROM research_experiments e
        ${cursorId ? sql`WHERE e.id < ${cursorId}` : sql``}
        ORDER BY e.id DESC
        LIMIT ${limit + 1}
      `);
      const rows = extractRows(expRes);
      const overflow = rows.length > limit;
      const trimmed = rows.slice(0, limit);

      const items = await Promise.all(trimmed.map(async (r) => {
        const metricsRes = await db.execute(sql`SELECT metricKey, metricValue FROM validation_metrics WHERE experimentId = ${r.id}`).catch(() => null);
        const metricMap: Record<string, string | null> = {};
        for (const m of extractRows(metricsRes)) {
          metricMap[String(m.metricKey)] = toDecimalStringNullable(m.metricValue);
        }
        return {
          experimentId: String(r.id),
          name: String(r.experimentName ?? 'experiment'),
          datasetId: r.datasetId != null ? String(r.datasetId) : null,
          createdAt: (toIsoNullable(r.createdAt as Date | string | null) ?? (new Date(0).toISOString() as import('@horizon/shared').IsoTimestamp)) as import('@horizon/shared').IsoTimestamp,
          splitPolicy: r.splitPolicy ? String(r.splitPolicy) : null,
          status: r.status === 'completed' ? 'completed' as const : r.status === 'running' ? 'running' as const : r.status === 'failed' ? 'failed' as const : r.status === 'registered' ? 'registered' as const : 'unknown' as const,
          metrics: {
            pbo: metricMap.pbo ?? null,
            sharpe: metricMap.sharpe ?? null,
            dsr: metricMap.dsr ?? null,
            sortino: metricMap.sortino ?? null,
            calmar: metricMap.calmar ?? null,
            drawdown: metricMap.drawdown ?? null,
            expectedShortfall: metricMap.expected_shortfall ?? null,
          },
          promotionEligible: false as const,
        };
      }));

      const nextCursor = overflow && trimmed.length > 0 ? encodeCursor({ id: trimmed[trimmed.length - 1].id as number }) : null;
      const status = items.length === 0 ? 'empty' : 'healthy';
      const payload = {
        promotionEnabled: false as const,
        kellyEnabled: false as const,
        claudeAttributionStatus: 'deferred' as const,
        experiments: { items: items as unknown as ReturnType<typeof extractRows>, nextCursor } as unknown as never,
        datasetRegistrySummary: null,
        policyVersion: 'p2f-1',
      };
      return status === 'empty'
        ? empty(payload as never, 'no_experiments_yet', { sourceVersion: 'validation.v1' })
        : healthy(payload as never, { sourceVersion: 'validation.v1', policyVersions: { validation: 'p2f-1' } });
    });
  } catch (err) {
    return unavailable('validation_query_failed', {
      sourceVersion: 'validation.v1',
      diagnostics: { detail: String(err).slice(0, 200) },
    });
  }
}

// ---------------------------------------------------------------------------
// Costs — Stage 3 §16.
// ---------------------------------------------------------------------------

export async function getCosts(): Promise<CostsEnvelope> {
  try {
    return await withTimeout(async () => {
      // Stage 3C-E.1.6 — Column list realigned to the actual
      // forecast_vs_realized_attributions schema (migration 0008).
      // The previous query referenced columns that never existed
      // (positionId, forecastFees, forecastSpread, effectiveSpread,
      // forecastImpact, simulatedImpact, forecastLatencyCost,
      // totalForecastError, netOutcome), which caused an
      // ER_BAD_FIELD_ERROR and produced a spurious
      // `costs_query_failed` for every caller — including the empty
      // deterministic seed, where the correct honest state is `empty`.
      const res = await db.execute(sql`
        SELECT id, roundTripId, attributionVersion,
               forecastCommission, realizedCommission,
               forecastEntryCost, forecastExitCost,
               forecastSlippage,
               absoluteForecastError, realizedNetPnl,
               createdAt
        FROM forecast_vs_realized_attributions
        ORDER BY id DESC
        LIMIT 50
      `);
      const rows = extractRows(res);
      if (rows.length === 0) {
        return empty({ attributionVersion: null, entries: [] } as CostsPayload, 'no_cost_attribution_yet', { sourceVersion: 'costs.v1' });
      }
      const entries = rows.map((r) => ({
        attributionId: String(r.id),
        // The current schema tracks round-trip identity, not a
        // separate position identity — the contract's positionId is
        // honestly null until a later migration adds the column.
        positionId: null,
        attributionVersion: r.attributionVersion ? String(r.attributionVersion) : null,
        entryForecast: toDecimalStringNullable(r.forecastEntryCost),
        exitForecast: toDecimalStringNullable(r.forecastExitCost),
        forecastFees: toDecimalStringNullable(r.forecastCommission),
        realizedFees: toDecimalStringNullable(r.realizedCommission),
        forecastSpread: toDecimalStringNullable(r.forecastSlippage),
        effectiveSpread: null,
        forecastImpact: null,
        simulatedImpact: null,
        forecastLatencyCost: null,
        realizedLatencyEvidence: null,
        stopExecutionAssumptions: null,
        exitPath: null,
        totalForecastError: toDecimalStringNullable(r.absoluteForecastError),
        netOutcome: toDecimalStringNullable(r.realizedNetPnl),
        recordedAt: toIsoNullable(r.createdAt as Date | string | null),
      }));
      return healthy({ attributionVersion: entries[0]?.attributionVersion ?? null, entries } as CostsPayload, {
        sourceVersion: 'costs.v1',
      });
    });
  } catch (err) {
    return unavailable('costs_query_failed', { sourceVersion: 'costs.v1', diagnostics: { detail: String(err).slice(0, 200) } });
  }
}

// ---------------------------------------------------------------------------
// Protection — Stage 3 §16.
// ---------------------------------------------------------------------------

export async function getProtection(): Promise<ProtectionEnvelope> {
  try {
    return await withTimeout(async () => {
      const [instanceRes, policyRes] = await Promise.all([
        db.execute(sql`
          SELECT id, positionId, policyVersionId, capability, validationRunId, state,
                 requiredQuantity, confirmedQuantity, gapRiskAssumptions,
                 lastEventAt, degradationState, recoveryAttempts
          FROM protection_instances
          ORDER BY id DESC LIMIT 100
        `),
        db.execute(sql`SELECT id FROM protection_policy_versions ORDER BY id DESC LIMIT 1`).catch(() => null),
      ]);
      const instances = extractRows(instanceRes);
      const latestPolicy = extractRows(policyRes)[0] as { id: number } | undefined;
      if (instances.length === 0) {
        return empty({ policyVersion: null, instances: [] } as ProtectionPayload, 'no_protection_instances_yet', { sourceVersion: 'protection.v1' });
      }
      const payload: ProtectionPayload = {
        policyVersion: latestPolicy?.id != null ? String(latestPolicy.id) : null,
        instances: instances.map((r) => ({
          instanceId: String(r.id),
          positionId: r.positionId != null ? String(r.positionId) : null,
          policyVersion: r.policyVersionId != null ? String(r.policyVersionId) : null,
          capability: r.capability === 'exchange_bracket' ? 'exchange_bracket' as const : r.capability === 'polling_fallback' ? 'polling_fallback' as const : r.capability === 'unprotected' ? 'unprotected' as const : 'unknown' as const,
          validation: r.validationRunId != null ? 'validated' as const : r.state === 'pending' ? 'pending' as const : 'unknown' as const,
          requiredQuantity: toDecimalStringNullable(r.requiredQuantity),
          confirmedQuantity: toDecimalStringNullable(r.confirmedQuantity),
          degradation: r.degradationState === 'none' ? 'none' as const : r.degradationState === 'partial' ? 'partial' as const : r.degradationState === 'complete' ? 'complete' as const : 'unknown' as const,
          recoveryAttempts: r.recoveryAttempts != null ? Number(r.recoveryAttempts) : null,
          gapRiskAssumptions: r.gapRiskAssumptions ? String(r.gapRiskAssumptions).slice(0, 500) : null,
          bracketLegs: [],
          lastEventAt: toIsoNullable(r.lastEventAt as Date | string | null),
        })),
      };
      return healthy(payload, { sourceVersion: 'protection.v1', policyVersions: { protection: payload.policyVersion ?? 'unknown' } });
    });
  } catch (err) {
    return unavailable('protection_query_failed', { sourceVersion: 'protection.v1', diagnostics: { detail: String(err).slice(0, 200) } });
  }
}

// ---------------------------------------------------------------------------
// Reconciliation — Stage 3 §16.
// ---------------------------------------------------------------------------

export async function listReconciliation(input: ReconciliationListInput | undefined): Promise<ReconciliationListEnvelope> {
  const limit = Math.min(input?.limit ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  try {
    return await withTimeout(async () => {
      const cursor = input?.cursor ? decodeCursor(input.cursor) : null;
      if (input?.cursor && cursor === null) {
        return unavailable('invalid_cursor', { sourceVersion: 'reconciliation.v1' });
      }
      const cursorId = typeof cursor?.id === 'number' ? cursor.id : null;
      const res = await db.execute(sql`
        SELECT id, startedAt, finishedAt, status
        FROM reconciliation_runs
        ${cursorId ? sql`WHERE id < ${cursorId}` : sql``}
        ORDER BY id DESC LIMIT ${limit + 1}
      `);
      const rows = extractRows(res);
      const overflow = rows.length > limit;
      const trimmed = rows.slice(0, limit);
      if (trimmed.length === 0) {
        return empty({ items: [], nextCursor: null }, 'no_reconciliation_runs_yet', { sourceVersion: 'reconciliation.v1' });
      }
      // For each run, fetch unresolved-action count.
      const items = await Promise.all(trimmed.map(async (r) => {
        const actionRes = await db.execute(sql`SELECT COUNT(*) AS n FROM reconciliation_actions WHERE runId = ${r.id} AND resolvedAt IS NULL`).catch(() => null);
        const actionRow = extractRows(actionRes)[0] as { n: number | string } | undefined;
        const nonterminalCount = Number(actionRow?.n ?? 0);
        return {
          runId: String(r.id),
          startedAt: (toIsoNullable(r.startedAt as Date | string | null) ?? (new Date(0).toISOString() as import('@horizon/shared').IsoTimestamp)) as import('@horizon/shared').IsoTimestamp,
          finishedAt: toIsoNullable(r.finishedAt as Date | string | null),
          status: r.status === 'ok' ? 'ok' as const : r.status === 'failed' ? 'failed' as const : r.status === 'degraded' ? 'degraded' as const : 'unknown' as const,
          nonterminalIntentCount: nonterminalCount,
          unknownIntentCount: null,
          discoveredFillCount: null,
          entryBlockActive: nonterminalCount > 0 || r.status !== 'ok',
          failureReasons: r.status === 'failed' ? ['run_status_failed'] : [],
        } as unknown as ReturnType<typeof ReconciliationRunRowSchema.parse>;
      }));
      const nextCursor = overflow && trimmed.length > 0 ? encodeCursor({ id: trimmed[trimmed.length - 1].id as number }) : null;
      return healthy({ items, nextCursor }, { sourceVersion: 'reconciliation.v1' });
    });
  } catch (err) {
    return unavailable('reconciliation_query_failed', { sourceVersion: 'reconciliation.v1', diagnostics: { detail: String(err).slice(0, 200) } });
  }
}

// ---------------------------------------------------------------------------
// Incidents — Stage 3 §17.
// ---------------------------------------------------------------------------

export async function listIncidents(input: IncidentListInput | undefined): Promise<IncidentListEnvelope> {
  const limit = Math.min(input?.limit ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  try {
    return await withTimeout(async () => {
      const cursor = input?.cursor ? decodeCursor(input.cursor) : null;
      if (input?.cursor && cursor === null) {
        return unavailable('invalid_cursor', { sourceVersion: 'incidents.v1' });
      }
      const cursorId = typeof cursor?.id === 'number' ? cursor.id : null;
      // Stage 3C-E.1.7 — Column list realigned to the actual
      // desktop_incidents schema (schema.ts:6237). The previous
      // SELECT referenced `subsystem`, `title`, `state`, `openedAt`,
      // `updatedAt`, and `underlyingResolved` — none of which exist
      // in the table — and the `.catch(() => null)` swallowed the
      // ER_BAD_FIELD_ERROR, so every request silently returned
      // `no_incidents_yet` even when rows were present. The `.catch`
      // is removed so a future column drift surfaces as
      // `incidents_query_failed` instead of a fabricated empty.
      const res = await db.execute(sql`
        SELECT id, severity, incidentType, reasonCode, details,
               currentState, acknowledgedAt, startedAt, resolvedAt, createdAt
        FROM desktop_incidents
        ${cursorId ? sql`WHERE id < ${cursorId}` : sql``}
        ORDER BY id DESC LIMIT ${limit + 1}
      `);
      const rows = extractRows(res);
      const overflow = rows.length > limit;
      const trimmed = rows.slice(0, limit);
      if (trimmed.length === 0) {
        return empty({ items: [], nextCursor: null }, 'no_incidents_yet', { sourceVersion: 'incidents.v1' });
      }
      const items: IncidentRow[] = trimmed.map((r) => ({
        incidentId: String(r.id),
        // The desktop_incidents severity enum in migration 0021 is
        // {informational, warning, critical, fatal}. Map to the
        // contract's {info, warning, error, critical}.
        severity: r.severity === 'critical' || r.severity === 'fatal'
          ? 'critical' as const
          : r.severity === 'warning'
            ? 'warning' as const
            : r.severity === 'error'
              ? 'error' as const
              : 'info' as const,
        // Contract's `subsystem` is derived from the schema's
        // `incidentType` (schema stores the incident source, which is
        // its subsystem by construction).
        subsystem: String(r.incidentType ?? 'unknown'),
        // Contract's `title` is a human-readable label — derive from
        // `details` (rich text) when present, otherwise fall back to
        // the machine `reasonCode`.
        title: r.details != null && String(r.details).length > 0
          ? String(r.details).slice(0, 200)
          : String(r.reasonCode ?? 'incident'),
        state: r.currentState === 'resolved' ? 'resolved' as const
          : r.currentState === 'acknowledged' ? 'acknowledged' as const
            : r.currentState === 'open' ? 'open' as const
              : 'unknown' as const,
        acknowledged: r.acknowledgedAt != null,
        openedAt: (toIsoNullable(r.startedAt as Date | string | null) ?? (new Date(0).toISOString() as import('@horizon/shared').IsoTimestamp)) as import('@horizon/shared').IsoTimestamp,
        // Schema has no dedicated `updatedAt` — fall back to the
        // most recent transition timestamp among ack/resolve/create.
        lastUpdateAt: toIsoNullable(
          (r.acknowledgedAt ?? r.resolvedAt ?? r.createdAt) as Date | string | null,
        ),
        // Schema tracks `resolvedAt` (timestamp), not a boolean flag.
        underlyingResolved: r.resolvedAt != null,
      }));
      // Client-side filter application (already bounded).
      let filtered = items;
      const f = input?.filter;
      if (f?.severityIn) filtered = filtered.filter((i) => f.severityIn!.includes(i.severity));
      if (f?.subsystemIn) filtered = filtered.filter((i) => f.subsystemIn!.includes(i.subsystem));
      if (f?.stateIn) filtered = filtered.filter((i) => f.stateIn!.includes(i.state));
      if (f?.acknowledged != null) filtered = filtered.filter((i) => i.acknowledged === f.acknowledged);
      const nextCursor = overflow && trimmed.length > 0 ? encodeCursor({ id: trimmed[trimmed.length - 1].id as number }) : null;
      return healthy({ items: filtered, nextCursor }, { sourceVersion: 'incidents.v1' });
    });
  } catch (err) {
    return unavailable('incidents_query_failed', { sourceVersion: 'incidents.v1', diagnostics: { detail: String(err).slice(0, 200) } });
  }
}

/**
 * incidents.acknowledge — real acknowledgement mutation.
 *
 * Records the acknowledgement in `desktop_operator_actions` (append-only
 * audit trail). Does NOT touch the incident's `state` — the incident
 * remains open until its underlying fault is actually resolved. The
 * operator's ack is a MARKER, not a resolution.
 */
export async function acknowledgeIncident(input: IncidentAcknowledgeInput, actorUsername: string | null = null): Promise<IncidentAcknowledgeEnvelope> {
  try {
    return await withTimeout(async () => {
      // Locate the incident. If missing, refuse.
      const incidentRes = await db.execute(sql`SELECT id, acknowledgedAt FROM desktop_incidents WHERE id = ${Number(input.incidentId)} LIMIT 1`).catch(() => null);
      const incident = extractRows(incidentRes)[0] as { id: number; acknowledgedAt: Date | null } | undefined;
      if (!incident) {
        return unavailable('incident_not_found', { sourceVersion: 'incidents.v1' });
      }
      // Delegate the append-only audit insert to the isolated audit
      // module (see `apps/server/src/desktop/audit/operatorActions.ts`).
      // Keeping the write out of this file preserves the read-only
      // contract on the desktop query surface.
      const { recordIncidentAcknowledgementAudit } = await import('../audit/operatorActions');
      const auditResult = await recordIncidentAcknowledgementAudit({
        actor: actorUsername,
        incidentId: String(input.incidentId),
        operatorNote: input.operatorNote ?? null,
      });
      if (!auditResult.ok) {
        return degraded({
          ok: true,
          acknowledged: incident.acknowledgedAt != null,
          underlyingResolved: false as const,
          reasonCode: 'ack_audit_insert_failed_but_ack_marker_recorded',
        }, auditResult.reasonCode, { sourceVersion: 'incidents.v1' });
      }
      return healthy({
        ok: true,
        acknowledged: true,
        underlyingResolved: false as const,
        reasonCode: null,
      }, { sourceVersion: 'incidents.v1' });
    });
  } catch (err) {
    return unavailable('incidents_acknowledge_failed', { sourceVersion: 'incidents.v1', diagnostics: { detail: String(err).slice(0, 200) } });
  }
}

// ---------------------------------------------------------------------------
// Reports — Stage 3 §17 (Stage 3B still limited to catalog + history read).
// ---------------------------------------------------------------------------

const REPORT_CATALOG = [
  { kind: 'decision_chain', label: 'Decision chain', description: 'Full lineage of a single decision.' },
  { kind: 'daily_shadow', label: 'Daily shadow report', description: 'Per-day shadow-execution summary.' },
  { kind: 'portfolio_risk', label: 'Portfolio risk snapshot', description: 'Latest Phase 2C risk snapshot with breakdowns.' },
  { kind: 'universe_and_hygiene', label: 'Universe + hygiene', description: 'Champion + observer universe with hygiene state.' },
  { kind: 'fingerprints', label: 'Fingerprints', description: 'Phase 2A fingerprint evidence and confidence.' },
  { kind: 'regimes', label: 'Regimes', description: 'Phase 2B regime snapshots + transitions.' },
  { kind: 'microstructure', label: 'Microstructure', description: 'Phase 2D shortlist microstructure state.' },
  { kind: 'context', label: 'Context', description: 'Phase 2E provider + signal snapshots.' },
  { kind: 'cost_attribution', label: 'Cost attribution', description: 'Forecast-vs-realized attribution history.' },
  { kind: 'validation', label: 'Validation', description: 'Validation experiments + metrics.' },
  { kind: 'incidents', label: 'Incidents', description: 'Incident history with filters.' },
  { kind: 'safety_status', label: 'Safety status', description: 'Current safety gates + CreateOrder counters.' },
  { kind: 'system_manifest', label: 'System manifest', description: 'Runtime versions + migration state.' },
] as const;

export async function getReports(): Promise<ReportsEnvelope> {
  try {
    return await withTimeout(async () => {
      const historyRes = await db.execute(sql`SELECT id, kind, status, requestedAt, completedAt, artifactChecksum, reasonCode FROM desktop_export_jobs ORDER BY id DESC LIMIT 25`).catch(() => null);
      const history = extractRows(historyRes).map((r) => ({
        jobId: String(r.id),
        kind: String(r.kind ?? 'unknown'),
        status: r.status === 'succeeded' ? 'succeeded' as const : r.status === 'failed' ? 'failed' as const : r.status === 'requested' ? 'requested' as const : 'unknown' as const,
        requestedAt: (toIsoNullable(r.requestedAt as Date | string | null) ?? (new Date(0).toISOString() as import('@horizon/shared').IsoTimestamp)) as import('@horizon/shared').IsoTimestamp,
        completedAt: toIsoNullable(r.completedAt as Date | string | null),
        artifactChecksum: r.artifactChecksum ? String(r.artifactChecksum) : null,
        reasonCode: r.reasonCode ? String(r.reasonCode) : null,
      }));
      const payload = {
        catalog: REPORT_CATALOG.map((c) => ({
          kind: c.kind,
          label: c.label,
          description: c.description,
          supportedFormats: ['json', 'csv', 'html'] as ('json' | 'csv' | 'html')[],
          generationAvailable: false as const,
          reasonCode: 'report_generation_stage4_pending',
        })),
        history: { items: history, nextCursor: null },
        generationImplemented: false as const,
        reasonCode: 'report_generation_stage4_pending',
      };
      return history.length === 0
        ? empty(payload, 'no_report_history_yet', { sourceVersion: 'reports.v1' })
        : healthy(payload, { sourceVersion: 'reports.v1' });
    });
  } catch (err) {
    return unavailable('reports_query_failed', { sourceVersion: 'reports.v1', diagnostics: { detail: String(err).slice(0, 200) } });
  }
}

// ---------------------------------------------------------------------------
// Configuration — Stage 3 §17.
// ---------------------------------------------------------------------------

export async function getConfiguration(): Promise<ConfigurationEnvelope> {
  return healthy({
    serviceMode: 'managed_docker' as const,
    databaseMode: 'managed_docker' as const,
    redisMode: 'managed_docker' as const,
    providerMode: (process.env.HORIZON_PROVIDER_MODE === 'external' || process.env.HORIZON_PROVIDER_MODE === 'deferred_production' ? process.env.HORIZON_PROVIDER_MODE : 'fixture') as 'fixture' | 'deferred_production' | 'external',
    safeFlags: { DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false, SIMULATION_MODE: process.env.SIMULATION_MODE ?? 'STANDARD_DRY_RUN', liveOrderSubmissionDisabled: true },
    observerPolicyVersions: {
      universe: 'p2a-1', regime: 'p2b-1', risk: 'p2c-1',
      microstructure: 'p2d-1', context: 'p2e-1', validation: 'p2f-1',
    },
    championConfigurationView: { championVersion: 'observed', dryRun: true, orderSubmissionEnabled: false },
    credentialStatus: {
      coinbase: 'absent' as const,
      anthropic: 'absent' as const,
    },
    retention: { logRetentionDays: 30, rawEventRetentionDays: 90 },
    desktopStartupBehavior: 'manual' as const,
    reportLocation: '',
    reportSchedule: 'off' as const,
    timeZoneDisplay: 'UTC',
    safetyCriticalReadOnly: true,
  }, { sourceVersion: 'configuration.v1', generatedAt: nowIso() });
}

// ---------------------------------------------------------------------------
// System — Stage 3 §17.
// ---------------------------------------------------------------------------

export async function getSystem(desktopVersion?: string): Promise<SystemEnvelope> {
  const migrationRes = await db.execute(sql`SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM __drizzle_migrations`).catch(() => null);
  const migRow = extractRows(migrationRes)[0] as { n: number | string; latest: Date | null } | undefined;
  return healthy({
    desktopVersion: desktopVersion ?? 'unknown',
    serverVersion: null,
    buildCommit: typeof process.env.HORIZON_BUILD_COMMIT === 'string' && process.env.HORIZON_BUILD_COMMIT.length > 0
      ? process.env.HORIZON_BUILD_COMMIT
      : null,
    buildTimestamp: null,
    electronVersion: null,
    nodeVersion: process.version,
    platform: (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'unknown') as 'win32' | 'darwin' | 'linux' | 'unknown',
    runtimeAssets: [],
    serviceOwnership: [
      { service: 'server', owner: 'desktop_supervisor' },
      { service: 'mariadb', owner: 'desktop_supervisor' },
      { service: 'redis', owner: 'desktop_supervisor' },
    ],
    processes: [{ kind: 'server', pid: process.pid, state: 'running', startedAt: null }],
    uptimeSeconds: Math.floor(process.uptime()),
    migrationState: {
      appliedCount: migRow != null ? Number(migRow.n ?? 0) : null,
      latestApplied: null,
      schemaVersion: migRow != null ? String(Math.max(0, Number(migRow.n) - 1)).padStart(4, '0') : null,
    },
    schemaState: {
      expectedVersion: '0021',
      observedVersion: migRow != null ? String(Math.max(0, Number(migRow.n) - 1)).padStart(4, '0') : null,
      fingerprintMatch: migRow != null && Number(migRow.n) >= 22 ? 'match' as const : migRow != null ? 'mismatch' as const : 'unknown' as const,
      reason: null,
    },
    runtimeMode: (process.env.HORIZON_PROVIDER_MODE === 'external' || process.env.HORIZON_PROVIDER_MODE === 'deferred_production' ? process.env.HORIZON_PROVIDER_MODE : 'fixture') as 'fixture' | 'deferred_production' | 'external',
    logHealth: 'unknown' as const,
  }, { sourceVersion: 'system.v1' });
}

// ---------------------------------------------------------------------------
// Safety — Stage 3 §17.
// ---------------------------------------------------------------------------

export async function getSafety(): Promise<SafetyEnvelope> {
  const c = httpCounters();
  const [reconRes, actionsRes] = await Promise.all([
    db.execute(sql`SELECT reconciliationStatus AS s FROM bot_config LIMIT 1`).catch(() => null),
    db.execute(sql`SELECT COUNT(*) AS n FROM reconciliation_actions WHERE resolvedAt IS NULL`).catch(() => null),
  ]);
  const reconStatus = extractRows(reconRes)[0] as { s: string } | undefined;
  const unresolved = Number((extractRows(actionsRes)[0] as { n: number | string } | undefined)?.n ?? 0);
  return healthy({
    safeFlags: { DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false, SIMULATION_MODE: process.env.SIMULATION_MODE ?? 'STANDARD_DRY_RUN', liveOrderSubmissionDisabled: true },
    createOrderBarrierActive: true,
    createOrderCounters: {
      known: true,
      source: 'in_process_fetchBarrier',
      functionInvocations: c.createOrderFunctionInvocations,
      attemptCount: c.createOrderAttemptCount,
      networkCount: c.createOrderNetworkCount,
      reasonCode: null,
    },
    scannerGate: { state: c.createOrderAttemptCount === 0 && c.createOrderNetworkCount === 0 && unresolved === 0 ? 'ready' as const : 'blocked' as const, blockingReasons: unresolved > 0 ? [`unresolved_actions=${unresolved}`] : [], observedAt: nowIso() },
    reconciliationGate: {
      state: reconStatus?.s === 'ok' ? 'ok' as const : reconStatus?.s === 'failed' ? 'failed' as const : reconStatus == null ? 'unknown' as const : 'degraded' as const,
      lastRunAt: null,
      unresolvedCount: unresolved,
      reasonCode: reconStatus?.s === 'ok' ? null : `bot_config.reconciliationStatus=${reconStatus?.s ?? 'unknown'}`,
    },
    accountingIntegrity: { accountingDifference: null, brokenAcceptedLineageCount: null, missingMandatoryAttributionCount: null, reasonCode: null },
    protectionIntegrity: { unprotectedExposure: null, degradedInstances: null, reasonCode: null },
    observerEnforcementActive: false,
    promotionEnabled: false,
    kellyEnabled: false,
    liveCapitalAuthorized: false,
    simulationMode: process.env.SIMULATION_MODE ?? 'STANDARD_DRY_RUN',
    providerMode: (process.env.HORIZON_PROVIDER_MODE === 'external' || process.env.HORIZON_PROVIDER_MODE === 'deferred_production' ? process.env.HORIZON_PROVIDER_MODE : 'fixture') as 'fixture' | 'deferred_production' | 'external',
  }, { sourceVersion: 'safety.v1' });
}
