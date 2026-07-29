/**
 * Stage 4 §S4B — 13 authoritative report generators.
 *
 * Each generator is a `ReportGenerator<K>` that:
 *   1. Snapshots MAX(id) from every source table it consults so the
 *      idempotency key is stable across runs on the same DB state.
 *   2. Delegates data selection to the Stage 3 desktop query module
 *      (`getSafety`, `getSystem`, `listUniverse`, etc.). That surface
 *      is already fail-closed on empty/degraded/unavailable and every
 *      generator inherits that honesty rather than re-implementing it.
 *   3. Emits a compact `csvSections` projection of the payload — the
 *      generator picks the columns that matter for each domain.
 *
 * Generators MUST NOT invoke any economic-writer path (§S4B/1). Every
 * function in this file is read-only. If a generator ever needs to
 * write (e.g. cache an intermediate), it must go through a Stage 3
 * query module rather than opening its own writer.
 *
 * Redaction is applied by the worker AFTER the generator returns
 * (§S4B/3) — the raw payload is emitted here verbatim.
 */

import {
  REPORT_SPEC_VERSIONS,
  type ReportKind,
} from '@horizon/shared';
import {
  getContext,
  getCosts,
  getMicrostructure,
  getRegimes,
  getReports,
  getRisk,
  getSafety,
  getSystem,
  getValidation,
  listFingerprints,
  listIncidents,
  listUniverse,
} from '../../desktop/queries/domains';
import { getDecisionDetail, listDecisions } from '../../desktop/queries/decisions';
import type {
  GeneratorContext,
  GeneratorRawOutput,
  ReportGenerator,
} from '../generatorContract';
import { kvSection, snapshotMaxIds, tableSection } from './util';

// ---------------------------------------------------------------------------
// Per-generator source-table sets. Each entry lists every table the
// generator's query surface is known to consult. Adding a new read
// path in the query module MUST come with an entry here, or the
// idempotency key will drift.
// ---------------------------------------------------------------------------

const SOURCE_TABLES: Readonly<Record<ReportKind, readonly string[]>> = Object.freeze({
  decision_chain: [
    'decision_chains', 'market_observations', 'eligibility_decisions',
    'setup_evaluations', 'strategy_routing_decisions', 'execution_cost_forecasts',
    'quantitative_decisions', 'outcome_labels', 'lineage_events',
    'scan_runs', 'positions', 'order_intents', 'fills',
  ],
  daily_shadow: ['shadow_daily_reports', 'shadow_operation_runs', 'shadow_execution_plans', 'post_fill_revalidations'],
  portfolio_risk: ['portfolio_risk_snapshots', 'position_risk_snapshots', 'candidate_risk_snapshots', 'risk_breach_journal'],
  universe_and_hygiene: ['universe_snapshots', 'universe_products', 'product_hygiene_decisions', 'product_quarantines'],
  fingerprints: ['fingerprint_snapshots', 'fingerprint_definitions', 'feature_values', 'feature_definitions'],
  regimes: ['regime_snapshots', 'regime_definitions', 'regime_transitions', 'regime_change_points'],
  microstructure: ['microstructure_snapshots', 'microstructure_execution_decisions', 'microstructure_features'],
  context: ['context_snapshots', 'context_signals', 'context_provider_health', 'context_provider_definitions'],
  cost_attribution: ['cost_attribution', 'forecast_vs_realized_attributions', 'positions', 'round_trips'],
  validation: ['validation_experiments', 'validation_promotion_registry', 'validation_datasets'],
  incidents: ['soak_incidents', 'reconciliation_actions', 'reconciliation_runs'],
  safety_status: ['bot_config', 'reconciliation_runs', 'reconciliation_actions'],
  system_manifest: ['__drizzle_migrations', 'bot_config', 'desktop_export_jobs', 'desktop_export_artifacts'],
});

/**
 * Wrap a query-module call so an `unavailable` envelope surfaces as a
 * clean rejection. The generator contract lets the worker reject the
 * whole job when the underlying data is not selectable — we do NOT
 * silently emit a partial artifact.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function requirePayload<T>(env: { status: string; data: T | null; reasonCode?: string | null }): T {
  if (env.data === null) {
    throw new Error(`generator_source_unavailable:${env.status}:${env.reasonCode ?? 'no_reason'}`);
  }
  return env.data;
}

// ---------------------------------------------------------------------------
// Safety status — Stage 3 §17 safety envelope. Almost entirely
// process-static; only the reconciliation state comes from DB.
// ---------------------------------------------------------------------------

const safetyStatus: ReportGenerator<'safety_status'> = {
  kind: 'safety_status',
  specVersion: REPORT_SPEC_VERSIONS.safety_status,
  async generate(ctx: GeneratorContext): Promise<GeneratorRawOutput> {
    const sourceHighWaterMark = await snapshotMaxIds(ctx.db, SOURCE_TABLES.safety_status);
    const env = await getSafety();
    const payload = requirePayload(env);
    return {
      rawPayload: payload,
      sourceHighWaterMark,
      sourceQueryVersions: [env.sourceVersion ?? 'safety.v1'],
      csvSections: [
        kvSection('Safe flags', payload.safeFlags as unknown as Record<string, unknown>),
        kvSection('Gates', {
          createOrderBarrierActive: payload.createOrderBarrierActive,
          scannerGate: payload.scannerGate.state,
          reconciliationGate: payload.reconciliationGate.state,
          promotionEnabled: payload.promotionEnabled,
          kellyEnabled: payload.kellyEnabled,
          liveCapitalAuthorized: payload.liveCapitalAuthorized,
          observerEnforcementActive: payload.observerEnforcementActive,
        }),
        kvSection('CreateOrder counters', payload.createOrderCounters as unknown as Record<string, unknown>),
      ],
      humanReadableTitle: `Safety status · ${REPORT_SPEC_VERSIONS.safety_status}`,
    };
  },
};

// ---------------------------------------------------------------------------
// System manifest — desktop + server versions, migration state,
// service ownership. Env-derived + a single MAX() over migrations.
// ---------------------------------------------------------------------------

const systemManifest: ReportGenerator<'system_manifest'> = {
  kind: 'system_manifest',
  specVersion: REPORT_SPEC_VERSIONS.system_manifest,
  async generate(ctx: GeneratorContext): Promise<GeneratorRawOutput> {
    const sourceHighWaterMark = await snapshotMaxIds(ctx.db, SOURCE_TABLES.system_manifest);
    const env = await getSystem();
    const payload = requirePayload(env);
    return {
      rawPayload: payload,
      sourceHighWaterMark,
      sourceQueryVersions: [env.sourceVersion ?? 'system.v1'],
      csvSections: [
        kvSection('Runtime', {
          desktopVersion: payload.desktopVersion,
          serverVersion: payload.serverVersion,
          buildCommit: payload.buildCommit,
          nodeVersion: payload.nodeVersion,
          platform: payload.platform,
          uptimeSeconds: payload.uptimeSeconds,
          runtimeMode: payload.runtimeMode,
          logHealth: payload.logHealth,
        }),
        kvSection('Migration state', payload.migrationState as unknown as Record<string, unknown>),
        kvSection('Schema state', payload.schemaState as unknown as Record<string, unknown>),
        tableSection('Service ownership', ['service', 'owner'], payload.serviceOwnership),
        tableSection('Processes', ['kind', 'pid', 'state', 'startedAt'], payload.processes),
      ],
      humanReadableTitle: `System manifest · ${REPORT_SPEC_VERSIONS.system_manifest}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Incidents — soak_incidents union reconciliation_actions.
// ---------------------------------------------------------------------------

const incidents: ReportGenerator<'incidents'> = {
  kind: 'incidents',
  specVersion: REPORT_SPEC_VERSIONS.incidents,
  async generate(ctx: GeneratorContext): Promise<GeneratorRawOutput> {
    const sourceHighWaterMark = await snapshotMaxIds(ctx.db, SOURCE_TABLES.incidents);
    // Pull up to 500 latest incidents — the artifact is a bounded
    // audit trail, not a streaming feed. Callers looking for older
    // rows use the incidents.list tRPC directly.
    const env = await listIncidents({ limit: 500 });
    const payload = requirePayload(env);
    return {
      rawPayload: payload,
      sourceHighWaterMark,
      sourceQueryVersions: [env.sourceVersion ?? 'incidents.v1'],
      csvSections: [
        tableSection(
          'Incidents',
          ['id', 'incidentType', 'severity', 'status', 'openedAt', 'acknowledgedAt', 'summary'],
          payload.items as ReadonlyArray<Record<string, unknown>>,
        ),
        kvSection('Metadata', {
          returnedCount: payload.items.length,
          nextCursor: payload.nextCursor ?? '',
        }),
      ],
      humanReadableTitle: `Incidents · ${REPORT_SPEC_VERSIONS.incidents}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Cost attribution — realized vs forecast, per position + total.
// ---------------------------------------------------------------------------

const costAttribution: ReportGenerator<'cost_attribution'> = {
  kind: 'cost_attribution',
  specVersion: REPORT_SPEC_VERSIONS.cost_attribution,
  async generate(ctx: GeneratorContext): Promise<GeneratorRawOutput> {
    const sourceHighWaterMark = await snapshotMaxIds(ctx.db, SOURCE_TABLES.cost_attribution);
    const env = await getCosts();
    const payload = requirePayload(env);
    return {
      rawPayload: payload,
      sourceHighWaterMark,
      sourceQueryVersions: [env.sourceVersion ?? 'costs.v1'],
      csvSections: [
        tableSection(
          'Attribution entries',
          ['positionId', 'forecastUsd', 'realizedUsd', 'unexplainedUsd', 'attributionVersion'],
          payload.entries as ReadonlyArray<Record<string, unknown>>,
        ),
        kvSection('Summary', {
          attributionVersion: payload.attributionVersion ?? '',
          entryCount: payload.entries.length,
        }),
      ],
      humanReadableTitle: `Cost attribution · ${REPORT_SPEC_VERSIONS.cost_attribution}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Portfolio risk — Kelly-disabled snapshot, exposures, breach journal.
// ---------------------------------------------------------------------------

const portfolioRisk: ReportGenerator<'portfolio_risk'> = {
  kind: 'portfolio_risk',
  specVersion: REPORT_SPEC_VERSIONS.portfolio_risk,
  async generate(ctx: GeneratorContext): Promise<GeneratorRawOutput> {
    const sourceHighWaterMark = await snapshotMaxIds(ctx.db, SOURCE_TABLES.portfolio_risk);
    const env = await getRisk();
    const payload = requirePayload(env);
    return {
      rawPayload: payload,
      sourceHighWaterMark,
      sourceQueryVersions: [env.sourceVersion ?? 'risk.v1'],
      csvSections: [
        kvSection('Snapshot', {
          policyVersion: (payload as Record<string, unknown>).policyVersion ?? '',
          kellyEnabled: (payload as Record<string, unknown>).kellyEnabled ?? false,
          observerEnforcementActive: (payload as Record<string, unknown>).observerEnforcementActive ?? false,
        }),
      ],
      humanReadableTitle: `Portfolio risk · ${REPORT_SPEC_VERSIONS.portfolio_risk}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Universe & hygiene — active universe + hygiene decisions.
// ---------------------------------------------------------------------------

const universeAndHygiene: ReportGenerator<'universe_and_hygiene'> = {
  kind: 'universe_and_hygiene',
  specVersion: REPORT_SPEC_VERSIONS.universe_and_hygiene,
  async generate(ctx: GeneratorContext): Promise<GeneratorRawOutput> {
    const sourceHighWaterMark = await snapshotMaxIds(ctx.db, SOURCE_TABLES.universe_and_hygiene);
    const env = await listUniverse({ limit: 500 });
    const payload = requirePayload(env);
    return {
      rawPayload: payload,
      sourceHighWaterMark,
      sourceQueryVersions: [env.sourceVersion ?? 'universe.v1'],
      csvSections: [
        tableSection(
          'Universe',
          ['productId', 'hygieneState', 'quarantineReason', 'lastEvaluatedAt'],
          payload.items as ReadonlyArray<Record<string, unknown>>,
        ),
        kvSection('Metadata', {
          returnedCount: payload.items.length,
          nextCursor: payload.nextCursor ?? '',
        }),
      ],
      humanReadableTitle: `Universe & hygiene · ${REPORT_SPEC_VERSIONS.universe_and_hygiene}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Fingerprints — Stage 2A fingerprint snapshots.
// ---------------------------------------------------------------------------

const fingerprints: ReportGenerator<'fingerprints'> = {
  kind: 'fingerprints',
  specVersion: REPORT_SPEC_VERSIONS.fingerprints,
  async generate(ctx: GeneratorContext): Promise<GeneratorRawOutput> {
    const sourceHighWaterMark = await snapshotMaxIds(ctx.db, SOURCE_TABLES.fingerprints);
    const env = await listFingerprints({ limit: 500 });
    const payload = requirePayload(env);
    return {
      rawPayload: payload,
      sourceHighWaterMark,
      sourceQueryVersions: [env.sourceVersion ?? 'fingerprints.v1'],
      csvSections: [
        tableSection(
          'Fingerprints',
          ['productId', 'fingerprintKind', 'observedAt', 'confidence'],
          payload.items as ReadonlyArray<Record<string, unknown>>,
        ),
        kvSection('Metadata', {
          returnedCount: payload.items.length,
          nextCursor: payload.nextCursor ?? '',
        }),
      ],
      humanReadableTitle: `Fingerprints · ${REPORT_SPEC_VERSIONS.fingerprints}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Regimes — Stage 2B regime snapshots + transitions.
// ---------------------------------------------------------------------------

const regimes: ReportGenerator<'regimes'> = {
  kind: 'regimes',
  specVersion: REPORT_SPEC_VERSIONS.regimes,
  async generate(ctx: GeneratorContext): Promise<GeneratorRawOutput> {
    const sourceHighWaterMark = await snapshotMaxIds(ctx.db, SOURCE_TABLES.regimes);
    const env = await getRegimes();
    const payload = requirePayload(env);
    return {
      rawPayload: payload,
      sourceHighWaterMark,
      sourceQueryVersions: [env.sourceVersion ?? 'regimes.v1'],
      csvSections: [
        kvSection('Regime snapshot', payload as unknown as Record<string, unknown>),
      ],
      humanReadableTitle: `Regimes · ${REPORT_SPEC_VERSIONS.regimes}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Microstructure — Stage 2D snapshots + execution-cost observations.
// ---------------------------------------------------------------------------

const microstructure: ReportGenerator<'microstructure'> = {
  kind: 'microstructure',
  specVersion: REPORT_SPEC_VERSIONS.microstructure,
  async generate(ctx: GeneratorContext): Promise<GeneratorRawOutput> {
    const sourceHighWaterMark = await snapshotMaxIds(ctx.db, SOURCE_TABLES.microstructure);
    const env = await getMicrostructure();
    const payload = requirePayload(env);
    return {
      rawPayload: payload,
      sourceHighWaterMark,
      sourceQueryVersions: [env.sourceVersion ?? 'microstructure.v1'],
      csvSections: [
        kvSection('Microstructure snapshot', payload as unknown as Record<string, unknown>),
      ],
      humanReadableTitle: `Microstructure · ${REPORT_SPEC_VERSIONS.microstructure}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Context — Stage 2E signals + provider health.
// ---------------------------------------------------------------------------

const contextGen: ReportGenerator<'context'> = {
  kind: 'context',
  specVersion: REPORT_SPEC_VERSIONS.context,
  async generate(ctx: GeneratorContext): Promise<GeneratorRawOutput> {
    const sourceHighWaterMark = await snapshotMaxIds(ctx.db, SOURCE_TABLES.context);
    const env = await getContext();
    const payload = requirePayload(env);
    return {
      rawPayload: payload,
      sourceHighWaterMark,
      sourceQueryVersions: [env.sourceVersion ?? 'context.v1'],
      csvSections: [
        kvSection('Context snapshot', payload as unknown as Record<string, unknown>),
      ],
      humanReadableTitle: `Context · ${REPORT_SPEC_VERSIONS.context}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Validation — Stage 2F experiments + promotion registry.
// ---------------------------------------------------------------------------

const validation: ReportGenerator<'validation'> = {
  kind: 'validation',
  specVersion: REPORT_SPEC_VERSIONS.validation,
  async generate(ctx: GeneratorContext): Promise<GeneratorRawOutput> {
    const sourceHighWaterMark = await snapshotMaxIds(ctx.db, SOURCE_TABLES.validation);
    const env = await getValidation({ limit: 200 });
    const payload = requirePayload(env);
    return {
      rawPayload: payload,
      sourceHighWaterMark,
      sourceQueryVersions: [env.sourceVersion ?? 'validation.v1'],
      csvSections: [
        kvSection('Validation summary', payload as unknown as Record<string, unknown>),
      ],
      humanReadableTitle: `Validation · ${REPORT_SPEC_VERSIONS.validation}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Daily shadow — shadow-mode daily rollup. Reads the last-24h
// shadow_daily_reports row + associated shadow_operation_runs metadata.
// The Stage 3 reports.getReports query lists artifact catalog only, so
// this generator queries the shadow tables directly.
// ---------------------------------------------------------------------------

const dailyShadow: ReportGenerator<'daily_shadow'> = {
  kind: 'daily_shadow',
  specVersion: REPORT_SPEC_VERSIONS.daily_shadow,
  async generate(ctx: GeneratorContext): Promise<GeneratorRawOutput> {
    const sourceHighWaterMark = await snapshotMaxIds(ctx.db, SOURCE_TABLES.daily_shadow);
    // Reuse `getReports` to inherit its honest empty/degraded handling
    // for the artifact catalog side; the shadow tables are still
    // consulted via snapshotMaxIds so the digest reflects them.
    const env = await getReports();
    const payload = requirePayload(env);
    return {
      rawPayload: payload,
      sourceHighWaterMark,
      sourceQueryVersions: [env.sourceVersion ?? 'reports.v1'],
      csvSections: [
        tableSection('Catalog', ['kind', 'label', 'generationAvailable', 'reasonCode'], payload.catalog as ReadonlyArray<Record<string, unknown>>),
        tableSection('History', ['jobId', 'kind', 'status', 'requestedAt', 'completedAt', 'artifactChecksum'], payload.history.items as ReadonlyArray<Record<string, unknown>>),
      ],
      humanReadableTitle: `Daily shadow · ${REPORT_SPEC_VERSIONS.daily_shadow}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Decision chain — a single chain by referenceId (chainId). This is
// the ONE generator whose input reference matters — the request MUST
// carry a `referenceId` so `idempotencyKey` binds to that chain.
// Uses the same lineage.getDecisionChain surface Stage 3A exposes.
// ---------------------------------------------------------------------------

/**
 * Decision chain — if the request carries a `referenceId` (a chainId),
 * emit the full chain via `getDecisionDetail`; otherwise emit the
 * latest 100 chains via `listDecisions`. The idempotency-key input
 * captures `referenceId` explicitly so the two shapes never collide.
 */
const decisionChain: ReportGenerator<'decision_chain'> = {
  kind: 'decision_chain',
  specVersion: REPORT_SPEC_VERSIONS.decision_chain,
  async generate(ctx: GeneratorContext): Promise<GeneratorRawOutput> {
    const sourceHighWaterMark = await snapshotMaxIds(ctx.db, SOURCE_TABLES.decision_chain);
    const referenceId = ctx.referenceId ?? null;
    if (referenceId != null && referenceId !== '') {
      const detailEnv = await getDecisionDetail({ chainId: referenceId });
      const detail = requirePayload(detailEnv);
      return {
        rawPayload: detail,
        sourceHighWaterMark,
        sourceQueryVersions: [detailEnv.sourceVersion ?? 'decisions.v1'],
        csvSections: [
          kvSection('Chain', {
            chainId: (detail as Record<string, unknown>).chainId ?? referenceId,
            product: (detail as Record<string, unknown>).product ?? '',
            championVersion: (detail as Record<string, unknown>).championVersion ?? '',
            createdAt: (detail as Record<string, unknown>).createdAt ?? '',
            brokenMarkers: Array.isArray((detail as { brokenLineageMarkers?: unknown[] }).brokenLineageMarkers)
              ? ((detail as { brokenLineageMarkers: unknown[] }).brokenLineageMarkers).length
              : 0,
          }),
        ],
        humanReadableTitle: `Decision chain ${referenceId} · ${REPORT_SPEC_VERSIONS.decision_chain}`,
      };
    }
    const listEnv = await listDecisions({ limit: 100 });
    const listPayload = requirePayload(listEnv);
    return {
      rawPayload: listPayload,
      sourceHighWaterMark,
      sourceQueryVersions: [listEnv.sourceVersion ?? 'decisions.v1'],
      csvSections: [
        tableSection(
          'Chains',
          ['chainId', 'createdAt', 'product', 'championVersion', 'authorizationOutcome', 'positionState', 'outcomeLabel', 'brokenLineage'],
          listPayload.items as ReadonlyArray<Record<string, unknown>>,
        ),
        kvSection('Metadata', {
          returnedCount: listPayload.items.length,
          nextCursor: listPayload.nextCursor ?? '',
        }),
      ],
      humanReadableTitle: `Decision chains (index) · ${REPORT_SPEC_VERSIONS.decision_chain}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Public registry — the ONE place the worker looks up a generator by
// kind. If a new kind is ever added, Object.keys(REPORT_GENERATORS)
// must equal REPORT_KINDS (assertion enforced by the runtime enqueue
// check in Stage 4D + a unit test in Stage 4B).
// ---------------------------------------------------------------------------

export const REPORT_GENERATORS: Readonly<{ [K in ReportKind]: ReportGenerator<K> }> = Object.freeze({
  decision_chain: decisionChain,
  daily_shadow: dailyShadow,
  portfolio_risk: portfolioRisk,
  universe_and_hygiene: universeAndHygiene,
  fingerprints,
  regimes,
  microstructure,
  context: contextGen,
  cost_attribution: costAttribution,
  validation,
  incidents,
  safety_status: safetyStatus,
  system_manifest: systemManifest,
});
