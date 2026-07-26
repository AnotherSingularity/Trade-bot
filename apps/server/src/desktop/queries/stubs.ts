/**
 * Stage 3A stubs for domains fleshed out in Stage 3B.
 *
 * Every stub returns a valid `DesktopDataEnvelope<T>` that the renderer
 * can render in a degraded state. NO fabricated business data — every
 * measurement carries an unknown status and an explicit reason.
 */

import {
  type ConfigurationEnvelope,
  type ContextEnvelope,
  type CostsEnvelope,
  type FingerprintListEnvelope,
  type IncidentAcknowledgeEnvelope,
  type IncidentAcknowledgeInput,
  type IncidentListEnvelope,
  type IncidentListInput,
  type MicrostructureEnvelope,
  type ProtectionEnvelope,
  type ReconciliationListEnvelope,
  type ReconciliationListInput,
  type RegimeEnvelope,
  type ReportsEnvelope,
  type RiskEnvelope,
  type SafetyEnvelope,
  type SystemEnvelope,
  type UniverseListEnvelope,
  type UniverseListInput,
  type ValidationEnvelope,
  type ValidationExperimentListInput,
  type PortfolioMeasurement,
} from '@horizon/shared';
import { degraded, empty, healthy, nowIso, unavailable } from './common';

function unknownM(reason: string, unit: PortfolioMeasurement['unit'] = 'usd'): PortfolioMeasurement {
  return { status: 'unknown', value: null, unit, observedAt: null, dataAvailableAt: null, policyVersion: null, confidence: null, reasonCode: reason };
}

// ---------------------------------------------------------------------------
// Universe, Fingerprints, Regimes — Stage 3B binding.
// ---------------------------------------------------------------------------

export async function listUniverse(_input: UniverseListInput | undefined): Promise<UniverseListEnvelope> {
  return degraded({ items: [], nextCursor: null }, 'universe_query_stage3b_pending', {
    sourceVersion: 'universe.v0-stub',
  });
}

export async function listFingerprints(_input: unknown): Promise<FingerprintListEnvelope> {
  return degraded({ items: [], nextCursor: null }, 'fingerprints_query_stage3b_pending', {
    sourceVersion: 'fingerprints.v0-stub',
  });
}

export async function getRegimes(): Promise<RegimeEnvelope> {
  return degraded(
    {
      globalRegime: {
        raw: null, smoothed: null, latentState: null, semanticMapping: null,
        confidence: null, baselineVote: null, changeDetectorVotes: {},
        stateDuration: null, observedAt: null,
      },
      productRegimes: [],
      challengerRoute: null,
      championComparison: null,
      policyVersion: null,
    },
    'regimes_query_stage3b_pending',
    { sourceVersion: 'regimes.v0-stub' },
  );
}

// ---------------------------------------------------------------------------
// Risk, Microstructure, Context — Stage 3B binding.
// ---------------------------------------------------------------------------

export async function getRisk(): Promise<RiskEnvelope> {
  return degraded(
    {
      policyVersion: null,
      observedAt: null,
      observerEnforcementActive: false as const,
      kellyEnabled: false as const,
      candidateStopRisk: unknownM('risk_query_stage3b_pending'),
      volatilityMultiplier: unknownM('risk_query_stage3b_pending', 'ratio'),
      caps: [],
      breaches: [],
      systemIntegrityVetoes: [],
      expectedShortfall: unknownM('risk_query_stage3b_pending'),
      stressRuns: [],
      bindingCap: null,
      candidateDecision: { outcome: 'unknown' as const, finalSize: null, reasonCode: 'risk_query_stage3b_pending' },
      championComparison: null,
    },
    'risk_query_stage3b_pending',
    { sourceVersion: 'risk.v0-stub' },
  );
}

export async function getMicrostructure(): Promise<MicrostructureEnvelope> {
  return degraded(
    {
      productionLevel2Active: false as const,
      queuePositionKnown: false as const,
      policyVersion: null,
      shortlist: [],
      observerRecommendation: null,
      championComparison: null,
    },
    'microstructure_query_stage3b_pending',
    { sourceVersion: 'microstructure.v0-stub' },
  );
}

export async function getContext(): Promise<ContextEnvelope> {
  return degraded(
    {
      policyVersion: null,
      providers: [],
      signals: [],
      globalSnapshot: null,
      productSnapshots: [],
      ensembleMultiplier: unknownM('context_query_stage3b_pending', 'ratio'),
      warnings: [],
      vetoes: [],
      missingSignals: [],
      conflicts: [],
      incidents: [],
      championComparison: null,
    },
    'context_query_stage3b_pending',
    { sourceVersion: 'context.v0-stub' },
  );
}

// ---------------------------------------------------------------------------
// Validation, Costs, Protection, Reconciliation — Stage 3B binding.
// ---------------------------------------------------------------------------

export async function getValidation(_input: ValidationExperimentListInput | undefined): Promise<ValidationEnvelope> {
  return degraded(
    {
      promotionEnabled: false as const,
      kellyEnabled: false as const,
      claudeAttributionStatus: 'deferred' as const,
      experiments: { items: [], nextCursor: null },
      datasetRegistrySummary: null,
      policyVersion: null,
    },
    'validation_query_stage3b_pending',
    { sourceVersion: 'validation.v0-stub' },
  );
}

export async function getCosts(): Promise<CostsEnvelope> {
  return degraded(
    { attributionVersion: null, entries: [] },
    'costs_query_stage3b_pending',
    { sourceVersion: 'costs.v0-stub' },
  );
}

export async function getProtection(): Promise<ProtectionEnvelope> {
  return degraded(
    { policyVersion: null, instances: [] },
    'protection_query_stage3b_pending',
    { sourceVersion: 'protection.v0-stub' },
  );
}

export async function listReconciliation(_input: ReconciliationListInput | undefined): Promise<ReconciliationListEnvelope> {
  return degraded({ items: [], nextCursor: null }, 'reconciliation_query_stage3b_pending', {
    sourceVersion: 'reconciliation.v0-stub',
  });
}

// ---------------------------------------------------------------------------
// Incidents — Stage 3B binding. Acknowledgement is a mutation but Stage
// 3A cannot yet write to the incident store; it returns unavailable.
// ---------------------------------------------------------------------------

export async function listIncidents(_input: IncidentListInput | undefined): Promise<IncidentListEnvelope> {
  return degraded({ items: [], nextCursor: null }, 'incidents_query_stage3b_pending', {
    sourceVersion: 'incidents.v0-stub',
  });
}

export async function acknowledgeIncident(_input: IncidentAcknowledgeInput): Promise<IncidentAcknowledgeEnvelope> {
  return unavailable('incidents_acknowledge_stage3b_pending', { sourceVersion: 'incidents.v0-stub' });
}

// ---------------------------------------------------------------------------
// Reports — Stage 3 scope is limited to catalog + history. Report GENERATION
// remains Stage 4. This surface returns the fixed catalog + an empty history
// list with an explicit `generationImplemented: false`.
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
  return empty(
    {
      catalog: REPORT_CATALOG.map((c) => ({
        kind: c.kind,
        label: c.label,
        description: c.description,
        supportedFormats: ['json', 'csv', 'html'] as ('json' | 'csv' | 'html')[],
        generationAvailable: false as const,
        reasonCode: 'report_generation_stage4_pending',
      })),
      history: { items: [], nextCursor: null },
      generationImplemented: false as const,
      reasonCode: 'report_generation_stage4_pending',
    },
    'no_report_history_yet',
    { sourceVersion: 'reports.v0-stub' },
  );
}

// ---------------------------------------------------------------------------
// Configuration, System, Safety — sanitized reads.
// ---------------------------------------------------------------------------

export async function getConfiguration(): Promise<ConfigurationEnvelope> {
  return healthy(
    {
      serviceMode: 'managed_docker' as const,
      databaseMode: 'managed_docker' as const,
      redisMode: 'managed_docker' as const,
      providerMode: 'fixture' as const,
      safeFlags: { DRY_RUN: true as const, ORDER_SUBMISSION_ENABLED: false as const, SIMULATION_MODE: 'STANDARD_DRY_RUN', liveOrderSubmissionDisabled: true as const },
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
      safetyCriticalReadOnly: true as const,
    },
    { sourceVersion: 'configuration.v1', generatedAt: nowIso() },
  );
}

export async function getSystem(desktopVersion?: string): Promise<SystemEnvelope> {
  return healthy(
    {
      desktopVersion: desktopVersion ?? 'unknown',
      serverVersion: null,
      buildCommit: typeof process.env.HORIZON_BUILD_COMMIT === 'string' ? process.env.HORIZON_BUILD_COMMIT : null,
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
      migrationState: { appliedCount: null, latestApplied: null, schemaVersion: null },
      schemaState: {
        expectedVersion: '0021',
        observedVersion: null,
        fingerprintMatch: 'unknown' as const,
        reason: 'system_query_stage3b_pending',
      },
      runtimeMode: 'fixture' as const,
      logHealth: 'unknown' as const,
    },
    { sourceVersion: 'system.v0-stub' },
  );
}

export async function getSafety(): Promise<SafetyEnvelope> {
  return healthy(
    {
      safeFlags: { DRY_RUN: true as const, ORDER_SUBMISSION_ENABLED: false as const, SIMULATION_MODE: 'STANDARD_DRY_RUN', liveOrderSubmissionDisabled: true as const },
      createOrderBarrierActive: true as const,
      createOrderCounters: {
        known: true,
        source: 'in_process_fetchBarrier',
        functionInvocations: 0,
        attemptCount: 0,
        networkCount: 0,
        reasonCode: null,
      },
      scannerGate: { state: 'unknown' as const, blockingReasons: [], observedAt: null },
      reconciliationGate: { state: 'unknown' as const, lastRunAt: null, unresolvedCount: null, reasonCode: 'safety_query_stage3b_pending' },
      accountingIntegrity: { accountingDifference: null, brokenAcceptedLineageCount: null, missingMandatoryAttributionCount: null, reasonCode: 'safety_query_stage3b_pending' },
      protectionIntegrity: { unprotectedExposure: null, degradedInstances: null, reasonCode: 'safety_query_stage3b_pending' },
      observerEnforcementActive: false as const,
      promotionEnabled: false as const,
      kellyEnabled: false as const,
      liveCapitalAuthorized: false as const,
      simulationMode: 'STANDARD_DRY_RUN',
      providerMode: 'fixture' as const,
    },
    { sourceVersion: 'safety.v0-stub' },
  );
}
