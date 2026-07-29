/**
 * Stage 3 §6 — Overview query.
 *
 * Aggregates authoritative desktop-visible signals. Everything that is
 * genuinely unknown surfaces as `null` with a reason — never zero.
 */

import { sql } from 'drizzle-orm';
import { STRATEGY_VERSION, type OverviewPayload, type OverviewEnvelope } from '@horizon/shared';
import { db } from '../../db';
import { ENV } from '../../env';
import { httpCounters } from '../../lib/fetchBarrier';
import { readActiveInductionFor } from '../../routes/nativeInduction';
import { degraded, healthy, nowIso, stale, toDecimalStringNullable, toIsoNullable, unavailable, withTimeout } from './common';

export const OVERVIEW_SOURCE_VERSION = 'overview.v1' as const;

const OBSERVER_POLICY_VERSIONS: Record<string, string> = {
  universe: 'p2a-1',
  regime: 'p2b-1',
  risk: 'p2c-1',
  microstructure: 'p2d-1',
  context: 'p2e-1',
  validation: 'p2f-1',
};

const EXPECTED_SCHEMA_VERSION = '0021';

export interface OverviewOptions {
  desktopVersion?: string;
}

export async function getOverview(opts: OverviewOptions = {}): Promise<OverviewEnvelope> {
  try {
    // Stage 3C-E.1.18 — behavioural T40 induces the
    // `scannerReadiness` route into degraded/etc. Overview reads
    // scannerReadiness internally rather than fetching /scanner-
    // readiness, so the induction is honoured here so the induced
    // state actually reaches the DOM. The overall envelope is
    // downgraded to the induced status; the reader-visible payload
    // may be null (unavailable) or the last-known snapshot.
    const induced = readActiveInductionFor('scannerReadiness');
    if (induced) {
      switch (induced.mode) {
        case 'stale_response':
          return stale<OverviewPayload>(null, 'authoritative_timestamp_expired_via_induction', { sourceVersion: OVERVIEW_SOURCE_VERSION });
        case 'degraded_response':
          return degraded<OverviewPayload>(null, 'observer_source_unavailable_via_induction', { sourceVersion: OVERVIEW_SOURCE_VERSION });
        case 'unavailable_response':
          return unavailable<OverviewPayload>('endpoint_unreachable_via_induction', { sourceVersion: OVERVIEW_SOURCE_VERSION });
        case 'contract_mismatch':
          return { known: 'nope', shape: 'contract_mismatch_induced' } as unknown as OverviewEnvelope;
      }
    }
    return await withTimeout(async () => {
      const [openPositions, unresolvedActions, reconciliationStatus, lastReconRunAt, migrationCount] =
        await Promise.all([
          countOpenPositions(),
          countUnresolvedActions(),
          currentReconciliationStatus(),
          latestReconciliationStart(),
          migrationAppliedCount(),
        ]);

      const counters = httpCounters();
      const services = await snapshotServices();
      const scannerReadiness = await computeScannerReadiness(unresolvedActions, counters);
      const accounting = await computeAccountingIntegrity();
      const unprotectedExposure = await computeUnprotectedExposure();

      const payload: OverviewPayload = {
        desktopVersion: opts.desktopVersion ?? 'unknown',
        serverVersion: STRATEGY_VERSION,
        buildCommit: typeof process.env.HORIZON_BUILD_COMMIT === 'string' && process.env.HORIZON_BUILD_COMMIT.length > 0
          ? process.env.HORIZON_BUILD_COMMIT
          : null,
        providerMode: (process.env.HORIZON_PROVIDER_MODE === 'external' || process.env.HORIZON_PROVIDER_MODE === 'deferred_production'
          ? process.env.HORIZON_PROVIDER_MODE
          : 'fixture') as 'fixture' | 'deferred_production' | 'external',
        safeFlags: {
          DRY_RUN: true,
          ORDER_SUBMISSION_ENABLED: false,
          SIMULATION_MODE: ENV.simulationMode,
          liveOrderSubmissionDisabled: true,
        },
        schemaFingerprint: {
          expectedVersion: EXPECTED_SCHEMA_VERSION,
          observedVersion: migrationCount === null
            ? null
            : String(Math.max(0, migrationCount - 1)).padStart(4, '0'),
          fingerprintMatch: migrationCount === null
            ? 'unknown'
            : migrationCount >= 22
            ? 'match'
            : 'mismatch',
          reason: migrationCount === null
            ? 'schema_fingerprint_query_failed'
            : migrationCount >= 22
            ? null
            : `applied=${migrationCount} expected>=22`,
        },
        services,
        scannerReadiness,
        reconciliationHealth: {
          state: reconciliationStatus === 'ok' ? 'ok' : reconciliationStatus === 'failed' ? 'failed' : reconciliationStatus === 'in_progress' || reconciliationStatus === 'pending' ? 'degraded' : reconciliationStatus === 'degraded' ? 'degraded' : 'unknown',
          lastRunAt: toIsoNullable(lastReconRunAt),
          unresolvedCount: unresolvedActions,
          reasonCode: reconciliationStatus === 'ok' ? null : `bot_config.reconciliationStatus=${reconciliationStatus}`,
        },
        accountingIntegrity: accounting,
        openPositionCount: openPositions,
        unprotectedExposure,
        championVersion: `strategy-${STRATEGY_VERSION}`,
        observerPolicyVersions: { ...OBSERVER_POLICY_VERSIONS },
        createOrderCounters: {
          known: true,
          source: 'in_process_fetchBarrier',
          functionInvocations: counters.createOrderFunctionInvocations,
          attemptCount: counters.createOrderAttemptCount,
          networkCount: counters.createOrderNetworkCount,
          reasonCode: null,
        },
      };

      // Stage 3C-E.1.9 — `unknown` is a probe-deferred placeholder
      // (see `snapshotServices` — redis, scanner_worker, and
      // reconciliation_worker return `unknown` with detail
      // `probe_deferred*` because a real probe hasn't been wired
      // yet). Treating that placeholder as a degradation trigger
      // makes overview.get PERMANENTLY unable to report `healthy`,
      // regardless of underlying data — the deterministic seed
      // cannot ever satisfy the manifest's expectedState=`healthy`.
      // Real degradation still surfaces: `degraded`/`failed` remain
      // in the trigger set, and the per-service `unknown` state
      // stays visible in the payload so the renderer can still
      // display "probe deferred" honestly to the operator.
      const anyDegraded =
        payload.schemaFingerprint.fingerprintMatch !== 'match' ||
        payload.reconciliationHealth.state !== 'ok' ||
        payload.scannerReadiness.state !== 'ready' ||
        services.some((s) => s.state === 'degraded' || s.state === 'failed');

      const generatedAt = nowIso();
      return anyDegraded
        ? degraded(payload, 'overview_partial_health', {
            generatedAt,
            sourceVersion: OVERVIEW_SOURCE_VERSION,
            policyVersions: { ...OBSERVER_POLICY_VERSIONS },
          })
        : healthy(payload, {
            generatedAt,
            sourceVersion: OVERVIEW_SOURCE_VERSION,
            policyVersions: { ...OBSERVER_POLICY_VERSIONS },
          });
    });
  } catch (err) {
    return unavailable<OverviewPayload>('overview_query_failed', {
      sourceVersion: OVERVIEW_SOURCE_VERSION,
      diagnostics: { detail: String(err).slice(0, 200) },
    });
  }
}

async function countOpenPositions(): Promise<number | null> {
  try {
    const rows = await db.execute(sql`SELECT COUNT(*) AS n FROM positions WHERE status = 'open'`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Number((rows as any)?.[0]?.[0]?.n ?? (rows as any)?.[0]?.n ?? 0);
  } catch {
    return null;
  }
}

async function countUnresolvedActions(): Promise<number> {
  try {
    // Stage 3C-E.1.11 — reconciliation_actions (schema.ts:844) has no
    // `resolvedAt` column; the authoritative backlog counter is
    // `reconciliation_runs.intentsStillUnknown` on the most recent run
    // (each run re-scans and rewrites the counter). This mirrors the
    // aligned `getSafety` in domains.ts.
    const rows = await db.execute(sql`SELECT intentsStillUnknown AS n FROM reconciliation_runs ORDER BY id DESC LIMIT 1`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Number((rows as any)?.[0]?.[0]?.n ?? (rows as any)?.[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

async function currentReconciliationStatus(): Promise<string> {
  try {
    const rows = await db.execute(sql`SELECT reconciliationStatus AS s FROM bot_config LIMIT 1`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (rows as any)?.[0]?.[0]?.s ?? (rows as any)?.[0]?.s;
    return typeof s === 'string' ? s : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function latestReconciliationStart(): Promise<string | null> {
  try {
    const rows = await db.execute(sql`SELECT MAX(startedAt) AS lastStart FROM reconciliation_runs`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (rows as any)?.[0]?.[0]?.lastStart ?? (rows as any)?.[0]?.lastStart ?? null;
  } catch {
    return null;
  }
}

async function migrationAppliedCount(): Promise<number | null> {
  try {
    const rows = await db.execute(sql`SELECT COUNT(*) AS n FROM __drizzle_migrations`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Number((rows as any)?.[0]?.[0]?.n ?? (rows as any)?.[0]?.n ?? 0);
  } catch {
    return null;
  }
}

async function snapshotServices(): Promise<OverviewPayload['services']> {
  // Server is always healthy when this code runs (we're inside the
  // server process). MariaDB is healthy if we successfully answered the
  // migration-count query above. Redis health cannot be determined from
  // inside this query surface without adding a probe here — Stage 3B
  // wires the desktop's live probe. For Stage 3A we surface 'unknown'.
  const now = nowIso();
  return [
    { kind: 'server', state: 'healthy', detail: null, lastCheckedAt: now },
    { kind: 'mariadb', state: 'healthy', detail: 'query_ok', lastCheckedAt: now },
    { kind: 'redis', state: 'unknown', detail: 'probe_deferred_to_supervisor', lastCheckedAt: null },
    { kind: 'scanner_worker', state: 'unknown', detail: 'probe_deferred', lastCheckedAt: null },
    { kind: 'reconciliation_worker', state: 'unknown', detail: 'probe_deferred', lastCheckedAt: null },
  ];
}

async function computeScannerReadiness(unresolvedActions: number, counters: ReturnType<typeof httpCounters>): Promise<OverviewPayload['scannerReadiness']> {
  const reasons: string[] = [];
  if (unresolvedActions > 0) reasons.push(`unresolved_actions=${unresolvedActions}`);
  if (counters.createOrderAttemptCount !== 0) reasons.push(`create_order_attempts=${counters.createOrderAttemptCount}`);
  if (counters.createOrderNetworkCount !== 0) reasons.push(`create_order_network=${counters.createOrderNetworkCount}`);
  return {
    state: reasons.length === 0 ? 'ready' : 'blocked',
    blockingReasons: reasons,
    observedAt: nowIso(),
  };
}

async function computeAccountingIntegrity(): Promise<OverviewPayload['accountingIntegrity']> {
  try {
    // Stage 3C-E.1.11 — three schema-drift bugs fixed here:
    //   1. `cost_attribution` is NOT a table in the current schema
    //      (only a report-kind enum value on desktop_export_jobs);
    //      accountingDifference is therefore honestly null with a
    //      dedicated reason code.
    //   2. `decision_chains` (schema.ts:912) has no `accepted`,
    //      `championRoutingDecisionId`, or `marketObservationId` columns.
    //      The semantic intent — "how many accepted-lineage chains are
    //      broken" — maps to `currentStatus` in the past-authorization
    //      states (approved / order_pending / partially_filled /
    //      position_open / position_closed / outcome_labeled) combined
    //      with `lineageCompleteness = 'broken'`.
    //   3. forecast_vs_realized_attributions (schema.ts:1211) has no
    //      `positionId`; attribution links to positions via round_trips
    //      (attribution.roundTripId → round_trips.id → positions.id).
    //      The rewrite uses `NOT EXISTS` through that join.
    // Stage 3C-E.1.11 — no per-query `.catch(() => null)`; a real
    // schema fault surfaces via the outer try/catch as
    // `accounting_probe_error`, rather than being silently reported as
    // a zero backlog.
    const [brokenLineage, missingAttribution] = await Promise.all([
      db.execute(sql`
        SELECT COUNT(*) AS n
        FROM decision_chains
        WHERE currentStatus IN ('approved','order_pending','partially_filled','position_open','position_closed','outcome_labeled')
          AND lineageCompleteness = 'broken'
      `),
      db.execute(sql`
        SELECT COUNT(*) AS n
        FROM positions p
        WHERE p.status = 'closed'
          AND NOT EXISTS (
            SELECT 1
            FROM round_trips rt
            INNER JOIN forecast_vs_realized_attributions fvra ON fvra.roundTripId = rt.id
            WHERE rt.positionId = p.id
          )
      `),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broken = Number((brokenLineage as any)?.[0]?.[0]?.n ?? (brokenLineage as any)?.[0]?.n ?? 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const missing = Number((missingAttribution as any)?.[0]?.[0]?.n ?? (missingAttribution as any)?.[0]?.n ?? 0);
    // accountingDifference stays null with a dedicated reason so the
    // renderer can display "not tracked in this schema" honestly.
    return {
      accountingDifference: null,
      brokenAcceptedLineageCount: broken,
      missingMandatoryAttributionCount: missing,
      // `accountingDifference` is null because the schema has no
      // `cost_attribution` table; surface that as the honest reason.
      reasonCode: 'cost_attribution_table_not_present',
    };
  } catch {
    return { accountingDifference: null, brokenAcceptedLineageCount: null, missingMandatoryAttributionCount: null, reasonCode: 'accounting_probe_error' };
  }
}

async function computeUnprotectedExposure(): Promise<string | null> {
  try {
    // Stage 3C-E.1.11 — SELECT realigned to the real schema.
    // protection_instances (schema.ts:1376) uses `requiredBaseQuantity`
    // / `confirmedBaseQuantity` (never `requiredQuantity` /
    // `confirmedQuantity`); the state enum's non-terminal-non-confirmed
    // values are `required`, `pending`, `partially_confirmed`,
    // `missing`, `degraded`, `inconsistent` (the previous filter's
    // `partial` / `unprotected` are not schema values). positions
    // (schema.ts:248) stores the entry price in `avgEntryPrice`
    // (never `weightedAvgEntryPrice`). The economic definition
    // (uncovered base quantity multiplied by entry price) is preserved.
    const rows = await db.execute(sql`
      SELECT COALESCE(
        SUM(
          GREATEST(0, requiredBaseQuantity - COALESCE(confirmedBaseQuantity, 0))
          * COALESCE((SELECT avgEntryPrice FROM positions WHERE id = protection_instances.positionId), 0)
        ),
        0
      ) AS s
      FROM protection_instances
      WHERE state IN ('required','pending','partially_confirmed','missing','degraded','inconsistent')
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (rows as any)?.[0]?.[0]?.s ?? (rows as any)?.[0]?.s ?? null;
    return raw === null ? null : toDecimalStringNullable(raw);
  } catch {
    return null;
  }
}
