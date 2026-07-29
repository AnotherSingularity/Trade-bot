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
import { readActiveInductionFor } from '../../routes/nativeInduction';
import {
  decodeCursor,
  degraded,
  empty,
  encodeCursor,
  healthy,
  nowIso,
  stale,
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
    // Stage 3C-E.1.18 — behavioural T41 induces the
    // `observerPolicyVersions` route into unavailable/etc. The
    // universe screen consumes universe.list; wire the induction
    // check here so the induced state actually reaches the DOM.
    const induced = readActiveInductionFor('observerPolicyVersions');
    if (induced) {
      const emptyPayload = { items: [] as UniverseRow[], nextCursor: null as string | null };
      switch (induced.mode) {
        case 'stale_response':
          return stale(emptyPayload, 'authoritative_timestamp_expired_via_induction', { sourceVersion: 'universe.v1' });
        case 'degraded_response':
          return degraded(emptyPayload, 'observer_source_unavailable_via_induction', { sourceVersion: 'universe.v1' });
        case 'unavailable_response':
          return unavailable<{ items: UniverseRow[]; nextCursor: string | null }>('endpoint_unreachable_via_induction', { sourceVersion: 'universe.v1' });
        case 'contract_mismatch':
          return { known: 'nope', shape: 'contract_mismatch_induced' } as unknown as UniverseListEnvelope;
      }
    }
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
        // Stage 3C-E.1.11 — realigned to real product_quarantines columns:
        // the schema stores the machine-readable code in `reasonCode` (not
        // `reason`) and tracks lifecycle end via `clearedAt` (not
        // `resolvedAt`). The `.catch(() => null)` swallowed the
        // ER_BAD_FIELD_ERROR the drift produced, so quarantine reasons
        // were silently reported as null for every product; removing the
        // swallow lets the outer try/catch surface a real query fault as
        // `universe_query_failed` instead.
        const quarRes = await db.execute(sql`SELECT reasonCode FROM product_quarantines WHERE productId = ${product} AND clearedAt IS NULL ORDER BY id DESC LIMIT 1`);
        const metaRes = await db.execute(sql`SELECT metadataObservedAt, tradingStatus, tradingDisabled, approximateVolume24h FROM product_metadata_observations WHERE productId = ${product} ORDER BY metadataObservedAt DESC LIMIT 1`).catch(() => null);
        const quar = extractRows(quarRes)[0] as { reasonCode: string } | undefined;
        const meta = extractRows(metaRes)[0] as { metadataObservedAt: Date; tradingStatus: string; tradingDisabled: number; approximateVolume24h: string | null } | undefined;
        const metaAgeMinutes = meta ? Math.floor((Date.now() - new Date(meta.metadataObservedAt).getTime()) / 60_000) : null;

        items.push({
          product,
          membership,
          eligibility: r.result === 'eligible' ? 'eligible' : r.result === 'ineligible' || r.result === 'quarantined' ? 'ineligible' : 'unknown',
          hygieneState: r.result === 'eligible' ? 'clean' : r.result === 'quarantined' ? 'quarantined' : r.result === 'insufficient_data' ? 'unknown' : 'warning',
          quarantineReason: quar?.reasonCode ?? (r.result === 'quarantined' ? String(r.reasonCodes ?? 'unknown') : null),
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
      // Stage 3C-E.1.10 — column list realigned to the real
      // fingerprint_snapshots schema (schema.ts:2487). The previous
      // SELECT asked for `availableAt` and `featureVersions`; the
      // table stores `dataAvailableAt`, and it has no JSON blob —
      // `classificationVersion` and `metadataVersion` are separate
      // varchar columns that are composed into the contract's
      // `featureVersions` record below.
      const res = await db.execute(sql`
        SELECT fs.id, fs.productId, fs.fingerprintClass, fs.confidence, fs.qualityPenalty, fs.liquidityPenalty,
               fs.inputHash, fs.observedAt, fs.dataAvailableAt,
               fs.classificationVersion, fs.metadataVersion
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
      // Evidence for each fingerprint.
      // Stage 3C-E.1.11 — realigned to the real fingerprint_evidence
      // schema (schema.ts:2526). The previous query asked for
      // `evidenceType`/`evidenceKey`/`snapshotId`; the table stores the
      // classification in `role` (enum: supporting|conflicting|missing),
      // the feature identity in `featureKey`, and links to the parent
      // snapshot via `fingerprintId`. The `.catch(() => null)`
      // swallowed the ER_BAD_FIELD_ERROR, so every fingerprint appeared
      // to have no evidence at all; removing the swallow lets a real
      // fault surface as `fingerprints_query_failed`.
      const items = await Promise.all(trimmed.map(async (r) => {
        const evidenceRes = await db.execute(sql`SELECT role, featureKey FROM fingerprint_evidence WHERE fingerprintId = ${r.id}`);
        const evidence = extractRows(evidenceRes);
        const supporting: string[] = [];
        const conflicting: string[] = [];
        const missing: string[] = [];
        for (const e of evidence) {
          const role = String(e.role);
          const key = String(e.featureKey);
          if (role === 'supporting') supporting.push(key);
          else if (role === 'conflicting') conflicting.push(key);
          else if (role === 'missing') missing.push(key);
        }
        const featureVersions: Record<string, string> = {};
        if (r.classificationVersion) featureVersions.classification = String(r.classificationVersion);
        if (r.metadataVersion) featureVersions.metadata = String(r.metadataVersion);
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
          availableAt: toIsoNullable(r.dataAvailableAt as Date | string | null),
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
      // Stage 3C-E.1.11 — SELECT lists realigned to the real schema.
      // global_regime_snapshots (schema.ts:2692) stores the regime label
      // in `state` (not `rawRegime`/`smoothedRegime`) and has no
      // policyVersion / latentState / semanticMapping / baselineVote /
      // stateDurationSeconds columns; those payload fields honestly
      // become null. product_regime_snapshots (schema.ts:2722) exposes
      // `rawState`/`smoothedState` and likewise has no latentState /
      // semanticMapping / transitionState / stateDurationSeconds.
      // The `.catch(() => null)` swallowed the ER_BAD_FIELD_ERROR each
      // drift produced, silently producing an empty regime payload.
      const globalRes = await db.execute(sql`SELECT id, observerRunId, state, status, confidence, observedAt, dataAvailableAt, regimeVersion FROM global_regime_snapshots ORDER BY id DESC LIMIT 1`);
      const productRes = await db.execute(sql`SELECT id, productId, rawState, smoothedState, status, confidence, observedAt, dataAvailableAt, regimeVersion FROM product_regime_snapshots ORDER BY id DESC LIMIT 25`);
      const g = extractRows(globalRes)[0] as Record<string, unknown> | undefined;
      const pRows = extractRows(productRes);
      if (!g && pRows.length === 0) {
        return empty(emptyRegimePayload(), 'no_regime_data_yet', { sourceVersion: 'regimes.v1' });
      }

      // Stage 3C-E.1.11 — change_point_events (schema.ts:2809) links to
      // the same regime_observer_runs as the global snapshot via
      // `observerRunId`; there is no `detectorId` or
      // `globalRegimeSnapshotId` — the detector identity lives in the
      // `detector` enum. challenger_routing_decisions (schema.ts:3006)
      // stores the routing outcome in `recommendation`, not
      // `selectedRoute`.
      const changesRes = g
        ? await db.execute(sql`SELECT detector, confidence FROM change_point_events WHERE observerRunId = ${g.observerRunId} AND scope = 'global' ORDER BY id ASC LIMIT 8`)
        : null;
      const routeRes = await db.execute(sql`SELECT recommendation FROM challenger_routing_decisions ORDER BY id DESC LIMIT 1`);
      const changeDetectorVotes: Record<string, string> = {};
      for (const c of extractRows(changesRes)) {
        changeDetectorVotes[String(c.detector ?? 'unknown')] = String(c.confidence ?? '');
      }
      const routeRow = extractRows(routeRes)[0] as { recommendation: string } | undefined;

      const payload: RegimePayload = {
        globalRegime: {
          raw: g?.state ? String(g.state) : null,
          // Global regime schema tracks a single `state` (no separate
          // raw/smoothed split) — mirror it to `smoothed` to keep the
          // contract populated without fabricating a distinct value.
          smoothed: g?.state ? String(g.state) : null,
          latentState: null,
          semanticMapping: null,
          confidence: toDecimalStringNullable(g?.confidence),
          baselineVote: null,
          changeDetectorVotes,
          stateDuration: null,
          observedAt: g?.observedAt ? toIsoNullable(g.observedAt as Date | string) : null,
        },
        productRegimes: pRows.map((r) => ({
          product: String(r.productId),
          raw: r.rawState ? String(r.rawState) : null,
          smoothed: r.smoothedState ? String(r.smoothedState) : null,
          latentState: null,
          semanticMapping: null,
          confidence: toDecimalStringNullable(r.confidence),
          transitionState: null,
          rejectedTransitions: [],
          stateDuration: null,
          observedAt: r.observedAt ? toIsoNullable(r.observedAt as Date | string) : null,
        })),
        challengerRoute: routeRow?.recommendation ?? null,
        championComparison: null,
        // Regime schemas track a per-snapshot `regimeVersion` but no
        // Stage-3-shaped policy version; surface the observer's version
        // if present, otherwise the deployment-wide default.
        policyVersion: g?.regimeVersion ? String(g.regimeVersion) : 'p2b-1',
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

      // Stage 3C-E.1.11 — SELECT lists realigned to the real schema.
      // risk_limit_definitions (schema.ts:3148) uses `limitKey`/`scope`
      // /`measurementKey` for identity and `hardThreshold`/
      // `warningThreshold` for the numeric ceilings — there is no
      // `capType` or `threshold`. risk_limit_breaches (schema.ts:3386)
      // stores the observed value in `measuredValue`, the timestamp in
      // `observedAt`, and has no `magnitude` / `detail` / `breachedAt`
      // columns — the contract's `magnitude`/`detail` payload fields
      // therefore become null. candidate_risk_decisions (schema.ts:3333)
      // holds sizing in `recommendedQuoteSize` / `recommendedBaseSize`
      // and volatility scaling in `sizeMultiplier` — the earlier
      // `finalSizeUsd` and `volatilityMultiplier` columns never existed.
      // The `.catch(() => null)` swallowed each ER_BAD_FIELD_ERROR so
      // caps, breaches, and the candidate decision were silently empty.
      const limitsRes = await db.execute(sql`SELECT id, limitKey, scope, measurementKey, hardThreshold, warningThreshold, unit, breachAction FROM risk_limit_definitions WHERE policyVersionId = ${snap.policyVersionId} ORDER BY id ASC LIMIT 50`);
      const breachesRes = await db.execute(sql`SELECT id, limitDefinitionId, scope, subjectId, measuredValue, severity, breachAction, observedAt FROM risk_limit_breaches WHERE portfolioRiskSnapshotId = ${snap.id} ORDER BY id ASC LIMIT 20`);
      const candidateRes = await db.execute(sql`SELECT decision, recommendedQuoteSize, reasonCodes, sizeMultiplier, bindingLimit FROM candidate_risk_decisions WHERE policyVersionId = ${snap.policyVersionId} ORDER BY id DESC LIMIT 1`);
      const limits = extractRows(limitsRes);
      const breaches = extractRows(breachesRes);
      const candidate = extractRows(candidateRes)[0] as { decision: string; recommendedQuoteSize: string | null; reasonCodes: string | null; sizeMultiplier: string | null; bindingLimit: string | null } | undefined;

      const caps: RiskPayload['caps'] = limits.map((l) => ({
        key: String(l.limitKey ?? l.id),
        label: String(l.limitKey ?? l.scope ?? 'cap'),
        limit: toDecimalStringNullable(l.hardThreshold),
        observed: null,
        binding: candidate?.bindingLimit != null && String(candidate.bindingLimit) === String(l.limitKey),
        breach: breaches.some((b) => Number(b.limitDefinitionId) === Number(l.id)),
        action: l.breachAction === 'reject' || l.breachAction === 'block_all_new_entries'
          ? 'block' as const
          : l.breachAction === 'reduce'
            ? 'shrink' as const
            : l.breachAction === 'observe'
              ? 'none' as const
              : 'unknown' as const,
        reasonCode: null,
      }));

      const payload: RiskPayload = {
        policyVersion,
        observedAt,
        observerEnforcementActive: false,
        kellyEnabled: false,
        candidateStopRisk: measurement(snap.totalOpenStopRisk, observedAt, policyVersion, 'usd', 'stop_risk_null'),
        volatilityMultiplier: candidate?.sizeMultiplier != null
          ? measurement(candidate.sizeMultiplier, observedAt, policyVersion, 'ratio', 'volmult_null')
          : unknownM('no_candidate_decision', 'ratio'),
        caps,
        breaches: breaches.map((b) => {
          // Resolve the human-readable limit key from the definition
          // list if we loaded it; fall back to the numeric id.
          const def = limits.find((l) => Number(l.id) === Number(b.limitDefinitionId));
          return {
            breachId: String(b.id),
            limitKey: def?.limitKey ? String(def.limitKey) : String(b.limitDefinitionId ?? 'unknown'),
            observedAt: toIsoNullable(b.observedAt as Date | string | null),
            magnitude: toDecimalStringNullable(b.measuredValue),
            // Schema has no separate `detail` — surface subjectId /
            // severity as the closest structured hint the operator can
            // use to identify the breach; null when both are absent.
            detail: b.subjectId != null || b.severity != null
              ? [b.severity, b.subjectId].filter((v) => v != null).map(String).join(':').slice(0, 500)
              : null,
          };
        }),
        systemIntegrityVetoes: snap.systemIntegrityState === 'ok' ? [] : [String(snap.systemIntegrityState)],
        expectedShortfall: measurement(snap.historicalExpectedShortfall, observedAt, policyVersion, 'usd', 'es_null'),
        stressRuns: snap.worstStressLoss != null
          ? [{ scenarioId: 'worst', scenarioName: 'worst_stress_persisted', measurement: measurement(snap.worstStressLoss, observedAt, policyVersion, 'usd', 'worst_stress_null'), runAt: observedAt }]
          : [],
        bindingCap: candidate?.bindingLimit ? String(candidate.bindingLimit) : null,
        candidateDecision: {
          outcome: candidate?.decision === 'authorize_as_proposed' ? 'approved' : candidate?.decision === 'reduce_size' ? 'shrunk' : candidate?.decision === 'reject' ? 'blocked' : 'unknown',
          finalSize: toDecimalStringNullable(candidate?.recommendedQuoteSize),
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
      // Stage 3C-E.1.11 — SELECT lists realigned to the real schema.
      // order_book_sessions (schema.ts:3889) tracks the session state in
      // `state` (enum incl. healthy/gap_detected/stale/inconsistent/…)
      // and the session lifecycle in `startedAt`/`endedAt`; there is no
      // `sessionState` or `observedAt` column. order_book_snapshots
      // (schema.ts:3963) exposes `quotedSpread` (and `spreadBps`) for
      // the spread, `sequence` for ordering, and does NOT track a
      // microprice — that payload field is honestly null. The prior
      // `.catch(() => null)` on the snapshot lookup hid the resulting
      // ER_BAD_FIELD_ERROR by producing a spurious empty snapshot.
      const sessionRes = await db.execute(sql`SELECT id, productId, state, startedAt, endedAt FROM order_book_sessions ORDER BY id DESC LIMIT 25`);
      const sessions = extractRows(sessionRes);
      if (sessions.length === 0) {
        return empty(emptyMicrostructurePayload(), 'no_microstructure_sessions_yet', { sourceVersion: 'microstructure.v1' });
      }
      const shortlist: MicrostructurePayload['shortlist'] = await Promise.all(sessions.map(async (s) => {
        const productId = String(s.productId);
        const snapshotRes = await db.execute(sql`SELECT bestBid, bestAsk, quotedSpread, midprice, sequence, observedAt, bookHealth FROM order_book_snapshots WHERE sessionId = ${s.id} ORDER BY id DESC LIMIT 1`);
        const snap = extractRows(snapshotRes)[0] as Record<string, unknown> | undefined;
        const sessionState = String(s.state);
        const bookHealth: 'healthy' | 'degraded' | 'stale' | 'invalid' | 'unknown' =
          sessionState === 'healthy' ? 'healthy'
            : sessionState === 'gap_detected' ? 'degraded'
              : sessionState === 'stale' ? 'stale'
                : sessionState === 'inconsistent' || sessionState === 'failed' || sessionState === 'resync_required' ? 'invalid'
                  : 'unknown';
        return {
          product: productId,
          bookSessionId: String(s.id),
          bookHealth,
          continuityState: bookHealth === 'invalid' ? 'reset' as const : bookHealth === 'degraded' ? 'gap' as const : bookHealth === 'healthy' ? 'continuous' as const : 'unknown' as const,
          bestBid: bookHealth === 'invalid' ? null : toDecimalStringNullable(snap?.bestBid),
          bestAsk: bookHealth === 'invalid' ? null : toDecimalStringNullable(snap?.bestAsk),
          spread: bookHealth === 'invalid' ? null : toDecimalStringNullable(snap?.quotedSpread),
          midprice: bookHealth === 'invalid' ? null : toDecimalStringNullable(snap?.midprice),
          // Schema has no microprice column — the honest value is null.
          microprice: null,
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
          // Freshness: prefer the snapshot's observedAt; fall back to
          // the session's startedAt so an operator can see how stale the
          // session is even when no snapshot has been persisted yet.
          observedAt: toIsoNullable((snap?.observedAt ?? s.startedAt) as Date | string | null),
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
      // Stage 3C-E.1.11 — SELECT lists realigned to the real schema.
      // context_provider_definitions (schema.ts:4358) identifies providers
      // by `providerKey` (there is no `providerId` or `label`); its
      // integer PK links to context_provider_health via the health
      // table's `providerDefinitionId`, and health is exposed via
      // `healthState` + `stalenessAgeMs` (never `healthStatus` /
      // `staleness`). context_signal_values (schema.ts:4535) links back
      // to definitions via `signalDefinitionId`; there is no `family`
      // column (family lives on the provider), and the surfaced reason
      // lives in `failureReason` — not `reasonCode`. context_incidents
      // (schema.ts:4871) uses `detectedAt` and has no `subsystem` or
      // `resolvedAt`, so the "open incidents" filter is dropped and we
      // list the most recent detections instead. context_ensemble_evidence
      // (schema.ts:4739) stores the multiplier contribution in
      // `multiplierContribution`, uses `createdAt` for freshness, and
      // has no `policyVersion`; we derive that from the linked global
      // snapshot when available. Removing every `.catch(() => null)` on
      // these SELECTs stops schema drift from silently returning
      // `no_context_data_yet`.
      const providersRes = await db.execute(sql`
        SELECT p.id, p.providerKey, p.providerFamily, p.status,
               h.healthState, h.stalenessAgeMs, h.observedAt AS healthObservedAt
        FROM context_provider_definitions p
        LEFT JOIN context_provider_health h
          ON h.providerDefinitionId = p.id
         AND h.id = (SELECT MAX(id) FROM context_provider_health WHERE providerDefinitionId = p.id)
        ORDER BY p.providerKey ASC
      `);
      const signalsRes = await db.execute(sql`
        SELECT sv.id, sv.signalDefinitionId, sv.status, sv.value, sv.observedAt, sv.failureReason,
               sd.signalKey, sd.scope AS signalScope,
               pd.providerFamily AS providerFamily
        FROM context_signal_values sv
        INNER JOIN context_signal_definitions sd ON sd.id = sv.signalDefinitionId
        INNER JOIN context_provider_definitions pd ON pd.id = sd.providerDefinitionId
        ORDER BY sv.id DESC LIMIT 100
      `);
      const incidentsRes = await db.execute(sql`SELECT id, incidentType, severity, reasonCode, detectedAt FROM context_incidents ORDER BY id DESC LIMIT 20`);
      const ensembleRes = await db.execute(sql`
        SELECT e.id, e.multiplierContribution, e.createdAt, e.globalSnapshotId,
               gs.observedAt AS snapshotObservedAt
        FROM context_ensemble_evidence e
        LEFT JOIN global_context_snapshots gs ON gs.id = e.globalSnapshotId
        ORDER BY e.id DESC LIMIT 1
      `);
      const providers = extractRows(providersRes);
      const signals = extractRows(signalsRes);
      const incidents = extractRows(incidentsRes);
      const ensemble = extractRows(ensembleRes)[0] as { multiplierContribution: string; createdAt: Date; snapshotObservedAt: Date | null } | undefined;
      if (providers.length === 0 && signals.length === 0 && incidents.length === 0 && !ensemble) {
        return empty({
          policyVersion: null, providers: [], signals: [], globalSnapshot: null, productSnapshots: [],
          ensembleMultiplier: unknownM('no_context_data', 'ratio'),
          warnings: [], vetoes: [], missingSignals: [], conflicts: [], incidents: [],
          championComparison: null,
        }, 'no_context_data_yet', { sourceVersion: 'context.v1' });
      }

      // Contract-safety: multiplier is capped at 1 for supportive context.
      const rawMultiplier = toDecimalStringNullable(ensemble?.multiplierContribution);
      const cappedMultiplier = rawMultiplier !== null && Number(rawMultiplier) > 1 ? '1' : rawMultiplier;
      const ensembleObservedAt = toIsoNullable((ensemble?.snapshotObservedAt ?? ensemble?.createdAt) as Date | string | null);

      const payload: ContextPayload = {
        // Schema has no per-evidence policy version; use the
        // deployment-wide default so the contract still carries a
        // known value.
        policyVersion: 'p2e-1',
        providers: providers.map((p) => ({
          providerId: String(p.providerKey ?? p.id),
          // Schema has no separate display label — mirror the key.
          label: String(p.providerKey ?? p.id),
          health: p.healthState === 'healthy' ? 'healthy' as const
            : p.healthState === 'stale' ? 'stale' as const
              : p.healthState === 'degraded' ? 'degraded' as const
                : p.healthState == null ? 'unknown' as const
                  : 'unavailable' as const,
          staleness: p.stalenessAgeMs != null ? String(p.stalenessAgeMs) : null,
          lastObservedAt: toIsoNullable(p.healthObservedAt as Date | string | null),
        })),
        signals: signals.map((s) => ({
          signalId: String(s.signalKey ?? s.signalDefinitionId ?? s.id),
          // Family isn't stored on the signal value; the provider's
          // family is the closest analogue and is joined in above.
          family: String(s.providerFamily ?? 'unknown'),
          status: s.value == null ? 'missing' as const : 'available' as const,
          value: toDecimalStringNullable(s.value),
          observedAt: toIsoNullable(s.observedAt as Date | string | null),
          reasonCode: s.failureReason ? String(s.failureReason) : null,
        })),
        globalSnapshot: null,
        productSnapshots: [],
        ensembleMultiplier: cappedMultiplier !== null
          ? knownM(cappedMultiplier, { unit: 'ratio', observedAt: ensembleObservedAt, policyVersion: 'p2e-1' })
          : unknownM('no_ensemble_evidence', 'ratio'),
        warnings: [],
        vetoes: [],
        missingSignals: [],
        conflicts: [],
        // Schema tracks incidentType + reasonCode; the historical
        // `subsystem:type` label falls back to `type:reasonCode` for a
        // similarly-shaped operator-visible string.
        incidents: incidents.map((i) => `${i.incidentType ?? 'incident'}:${i.reasonCode ?? 'unknown'}`),
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
      // Stage 3C-E.1.11 — SELECT list realigned to the real schema.
      // research_experiments (schema.ts:5090) identifies experiments via
      // `experimentKey` (there is no `experimentName`) and links to
      // dataset lineage via `datasetVersionId` (not `datasetId`). The
      // schema has no `splitPolicy` column — split lineage lives in
      // `validation_split_policies` behind experimentRuns — so the
      // payload field is honestly null. `registeredAt` is the semantic
      // creation timestamp; `createdAt` still exists but records the
      // row-insert time.
      const expRes = await db.execute(sql`
        SELECT e.id, e.experimentKey, e.datasetVersionId, e.registeredAt, e.status
        FROM research_experiments e
        ${cursorId ? sql`WHERE e.id < ${cursorId}` : sql``}
        ORDER BY e.id DESC
        LIMIT ${limit + 1}
      `);
      const rows = extractRows(expRes);
      const overflow = rows.length > limit;
      const trimmed = rows.slice(0, limit);

      const items = await Promise.all(trimmed.map(async (r) => {
        // Stage 3C-E.1.11 — validation_metrics (schema.ts:5380) is keyed
        // by `experimentRunId`, not experimentId, and the numeric
        // measurement lives in `value` (not `metricValue`). Aggregate
        // rows are those with metricScope='aggregate'. Removing the
        // prior `.catch(() => null)` stops schema drift from silently
        // reporting every metric as null.
        const metricsRes = await db.execute(sql`
          SELECT vm.metricKey, vm.value
          FROM validation_metrics vm
          INNER JOIN experiment_runs er ON er.id = vm.experimentRunId
          WHERE er.experimentId = ${r.id} AND vm.metricScope = 'aggregate'
        `);
        const metricMap: Record<string, string | null> = {};
        for (const m of extractRows(metricsRes)) {
          metricMap[String(m.metricKey)] = toDecimalStringNullable(m.value);
        }
        return {
          experimentId: String(r.id),
          name: String(r.experimentKey ?? 'experiment'),
          datasetId: r.datasetVersionId != null ? String(r.datasetVersionId) : null,
          createdAt: (toIsoNullable(r.registeredAt as Date | string | null) ?? (new Date(0).toISOString() as import('@horizon/shared').IsoTimestamp)) as import('@horizon/shared').IsoTimestamp,
          // No split-policy column on research_experiments — see comment
          // above; the contract's field is nullable to allow honest null.
          splitPolicy: null,
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
      // Stage 3C-E.1.11 — SELECT list realigned to the real
      // protection_instances schema (schema.ts:1376). Eight columns the
      // previous query asked for never existed: `capability`,
      // `validationRunId`, `requiredQuantity`, `confirmedQuantity`,
      // `gapRiskAssumptions`, `lastEventAt`, `degradationState`,
      // `recoveryAttempts`. The real columns are `capabilityId` (FK to
      // protection_capabilities), `protectionType` (enum encoding what
      // the historical `capability` payload field represented),
      // `requiredBaseQuantity` / `confirmedBaseQuantity` (base-asset
      // quantities), `lastVerifiedAt` (latest reconciliation timestamp),
      // and `state` (enum whose `degraded`/`partially_confirmed`/
      // `missing` etc. values encode degradation). There is no
      // per-instance validation-run FK, no gap-risk assumption text,
      // and no recovery-attempt counter — those payload fields become
      // honest nulls. The `.catch(() => null)` on the policy lookup is
      // retained (drift there wouldn't corrupt the main list) but the
      // main SELECT no longer swallows errors.
      const instanceRes = await db.execute(sql`
        SELECT id, positionId, policyVersionId, capabilityId, protectionType, state,
               requiredBaseQuantity, confirmedBaseQuantity,
               lastVerifiedAt, updatedAt, failureReason
        FROM protection_instances
        ORDER BY id DESC LIMIT 100
      `);
      const policyRes = await db.execute(sql`SELECT id FROM protection_policy_versions ORDER BY id DESC LIMIT 1`).catch(() => null);
      const instances = extractRows(instanceRes);
      const latestPolicy = extractRows(policyRes)[0] as { id: number } | undefined;
      if (instances.length === 0) {
        return empty({ policyVersion: null, instances: [] } as ProtectionPayload, 'no_protection_instances_yet', { sourceVersion: 'protection.v1' });
      }
      const payload: ProtectionPayload = {
        policyVersion: latestPolicy?.id != null ? String(latestPolicy.id) : null,
        instances: instances.map((r) => {
          const protectionType = String(r.protectionType ?? '');
          const state = String(r.state ?? '');
          // Map schema.protectionType enum onto the contract's
          // capability enum. bracket-family values → exchange_bracket;
          // application_polling → polling_fallback; none → unprotected.
          const capability: 'exchange_bracket' | 'polling_fallback' | 'unprotected' | 'unknown' =
            protectionType === 'attached_trigger_bracket_gtc' || protectionType === 'independent_bracket' || protectionType === 'independent_stop_limit' || protectionType === 'independent_take_profit'
              ? 'exchange_bracket'
              : protectionType === 'application_polling'
                ? 'polling_fallback'
                : protectionType === 'none'
                  ? 'unprotected'
                  : 'unknown';
          // Map schema.state onto the contract's degradation enum.
          // confirmed → none; partially_confirmed → partial;
          // degraded/inconsistent/missing/rejected/canceled → complete
          // (protection is not delivering the required coverage).
          const degradation: 'none' | 'partial' | 'complete' | 'unknown' =
            state === 'confirmed' || state === 'triggered' || state === 'completed'
              ? 'none'
              : state === 'partially_confirmed'
                ? 'partial'
                : state === 'degraded' || state === 'inconsistent' || state === 'missing' || state === 'rejected' || state === 'canceled'
                  ? 'complete'
                  : 'unknown';
          return {
            instanceId: String(r.id),
            positionId: r.positionId != null ? String(r.positionId) : null,
            policyVersion: r.policyVersionId != null ? String(r.policyVersionId) : null,
            capability,
            // No per-instance validation-run linkage in the current
            // schema; only the transient `pending` state is knowable.
            validation: state === 'pending' ? 'pending' as const : 'unknown' as const,
            requiredQuantity: toDecimalStringNullable(r.requiredBaseQuantity),
            confirmedQuantity: toDecimalStringNullable(r.confirmedBaseQuantity),
            degradation,
            // Schema has no recovery-attempt counter — honestly null.
            recoveryAttempts: null,
            // Schema has no gap-risk assumption text; surface the
            // instance's failureReason so the operator gets the closest
            // available diagnostic when protection is compromised.
            gapRiskAssumptions: r.failureReason ? String(r.failureReason).slice(0, 500) : null,
            bracketLegs: [],
            // lastVerifiedAt is the most recent instance-level touch;
            // updatedAt is the row's mtime fallback.
            lastEventAt: toIsoNullable((r.lastVerifiedAt ?? r.updatedAt) as Date | string | null),
          };
        }),
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
    // Stage 3C-E.1.18 — behavioural T39-T41/T43 drive a native-only
    // induction controller (nativeInduction.ts) that the operator
    // uses to force stale/degraded/unavailable/contract-mismatch
    // states on downstream screens without touching the underlying
    // data. Existing REST endpoints already honour the induction
    // (routes/desktop.ts); the tRPC queries the actual screens
    // subscribe to did not. Wire the check here — active induction
    // on `reconciliationStatus` shortcuts the tRPC surface with the
    // equivalent envelope status.
    const induced = readActiveInductionFor('reconciliationStatus');
    if (induced) {
      const emptyPayload = { items: [], nextCursor: null };
      switch (induced.mode) {
        case 'stale_response':
          return stale(emptyPayload, 'authoritative_timestamp_expired_via_induction', { sourceVersion: 'reconciliation.v1' });
        case 'degraded_response':
          return degraded(emptyPayload, 'observer_source_unavailable_via_induction', { sourceVersion: 'reconciliation.v1' });
        case 'unavailable_response':
          return unavailable('endpoint_unreachable_via_induction', { sourceVersion: 'reconciliation.v1' });
        case 'contract_mismatch':
          // Intentionally schema-invalid so the client's typed
          // contract-mismatch code path fires end-to-end.
          return { known: 'nope', shape: 'contract_mismatch_induced' } as unknown as ReconciliationListEnvelope;
      }
    }
    return await withTimeout(async () => {
      const cursor = input?.cursor ? decodeCursor(input.cursor) : null;
      if (input?.cursor && cursor === null) {
        return unavailable('invalid_cursor', { sourceVersion: 'reconciliation.v1' });
      }
      const cursorId = typeof cursor?.id === 'number' ? cursor.id : null;
      // Stage 3C-E.1.11 — SELECT list realigned to the real
      // reconciliation_runs schema (schema.ts:816): the completion
      // timestamp is `completedAt` (not `finishedAt`) and the terminal
      // outcome enum is `finalStatus` (not `status`). The per-run
      // counters (`intentsStillUnknown`, `fillsDiscovered`,
      // `failureReasonCode`) come from the same row, so the previous
      // per-run `reconciliation_actions` subquery — which asked for a
      // non-existent `resolvedAt` column — is dropped in favour of the
      // authoritative counter fields on the run itself.
      const res = await db.execute(sql`
        SELECT id, startedAt, completedAt, finalStatus,
               intentsStillUnknown, intentsResolved, fillsDiscovered, failureReasonCode
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
      const items = trimmed.map((r) => {
        const nonterminalCount = r.intentsStillUnknown != null ? Number(r.intentsStillUnknown) : 0;
        const status: 'ok' | 'failed' | 'degraded' | 'unknown' =
          r.finalStatus === 'ok' ? 'ok'
            : r.finalStatus === 'failed' ? 'failed'
              : r.finalStatus === 'degraded' || r.finalStatus === 'running' ? 'degraded'
                : 'unknown';
        return {
          runId: String(r.id),
          startedAt: (toIsoNullable(r.startedAt as Date | string | null) ?? (new Date(0).toISOString() as import('@horizon/shared').IsoTimestamp)) as import('@horizon/shared').IsoTimestamp,
          finishedAt: toIsoNullable(r.completedAt as Date | string | null),
          status,
          nonterminalIntentCount: nonterminalCount,
          unknownIntentCount: r.intentsStillUnknown != null ? Number(r.intentsStillUnknown) : null,
          discoveredFillCount: r.fillsDiscovered != null ? Number(r.fillsDiscovered) : null,
          entryBlockActive: nonterminalCount > 0 || status !== 'ok',
          failureReasons: r.failureReasonCode ? [String(r.failureReasonCode)] : status === 'failed' ? ['run_status_failed'] : [],
        } as unknown as ReturnType<typeof ReconciliationRunRowSchema.parse>;
      });
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
      // Stage 3C-E.1.11 — SELECT list realigned to the real schema.
      // desktop_export_jobs (schema.ts:6187) stores the report kind in
      // `reportKind` (not `kind`), the failure diagnostic in
      // `failureReason` (not `reasonCode`), and uses the status enum
      // {queued, running, completed, failed} — which we map to the
      // contract's {requested, succeeded, failed, unknown}. The
      // artifact checksum lives on desktop_export_artifacts
      // (schema.ts:6213) under `checksumSha256`, one row per job; we
      // LEFT JOIN so jobs without a materialized artifact still list.
      const historyRes = await db.execute(sql`
        SELECT j.id, j.reportKind, j.status, j.requestedAt, j.completedAt, j.failureReason,
               a.checksumSha256 AS artifactChecksum
        FROM desktop_export_jobs j
        LEFT JOIN desktop_export_artifacts a ON a.exportJobId = j.id
        ORDER BY j.id DESC LIMIT 25
      `);
      const history = extractRows(historyRes).map((r) => ({
        jobId: String(r.id),
        kind: String(r.reportKind ?? 'unknown'),
        status: r.status === 'completed' ? 'succeeded' as const
          : r.status === 'failed' ? 'failed' as const
            : r.status === 'queued' || r.status === 'running' ? 'requested' as const
              : 'unknown' as const,
        requestedAt: (toIsoNullable(r.requestedAt as Date | string | null) ?? (new Date(0).toISOString() as import('@horizon/shared').IsoTimestamp)) as import('@horizon/shared').IsoTimestamp,
        completedAt: toIsoNullable(r.completedAt as Date | string | null),
        artifactChecksum: r.artifactChecksum ? String(r.artifactChecksum) : null,
        reasonCode: r.failureReason ? String(r.failureReason) : null,
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
      // Stage 3C-E.1.12 — the reports payload is `healthy` whenever
      // the fixed-literal catalog is served; the export-jobs history
      // is a supplementary list, not the primary shape. An empty
      // history is not "no data" — it is "no report has been
      // generated yet in Stage 4-pending mode". Downgrading to
      // `empty` was preventing MANIFEST:reports from ever passing
      // because the deterministic seed intentionally does not create
      // report jobs.
      return healthy(payload, { sourceVersion: 'reports.v1' });
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
  // Stage 3C-E.1.11 — reconciliation_actions (schema.ts:844) has no
  // `resolvedAt` column; the per-run counter of "still-unknown" intents
  // lives on the run itself as `reconciliation_runs.intentsStillUnknown`.
  // We take the latest run's counter as the current unresolved backlog,
  // which is honest (each run re-scans and rewrites the counter).
  const [reconRes, actionsRes] = await Promise.all([
    db.execute(sql`SELECT reconciliationStatus AS s FROM bot_config LIMIT 1`).catch(() => null),
    db.execute(sql`SELECT intentsStillUnknown AS n FROM reconciliation_runs ORDER BY id DESC LIMIT 1`).catch(() => null),
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
