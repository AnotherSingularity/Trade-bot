import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  candidateContextDecisions,
  championContextComparisons,
  contextEnsembleEvidence,
  contextIncidents,
  contextObservations,
  contextObserverRuns,
  contextPolicyVersions,
  contextProviderDefinitions,
  contextProviderHealth,
  contextSignalDefinitions,
  contextSignalValues,
  globalContextSnapshots,
  macroEventDefinitions,
  macroEventObservations,
  productContextSnapshots,
  sectorDefinitions,
  sectorMemberships,
  type CandidateContextDecisionRow,
  type ChampionContextComparisonRow,
  type ContextIncidentRow,
  type ContextObservationRow,
  type ContextObserverRunRow,
  type ContextPolicyVersionRow,
  type ContextProviderDefinitionRow,
  type ContextProviderHealthRow,
  type ContextSignalDefinitionRow,
  type ContextSignalValueRow,
  type GlobalContextSnapshotRow,
  type MacroEventDefinitionRow,
  type MacroEventObservationRow,
  type ProductContextSnapshotRow,
  type SectorDefinitionRow,
  type SectorMembershipRow,
} from '../../db/schema';
import type { ContextObservationPayload, ContextProviderFamily, ContextProviderHealthState, ContextScope } from './providers';
import type { ContextAuthority, ContextSignalResult, CtxSignalDef } from './signals';
import type { ContextEnsembleResult, EnsembleSignalVote } from './ensemble';

/**
 * Phase 2E §G, §L, §M, §N — policy registry, decision, comparison, incidents.
 */

export const CTX_POLICY_KEY = 'ctx.observer';
export const CTX_POLICY_VERSION = 'p2e-ctx-1';

export interface CtxPolicyDef {
  policyKey: string;
  policyVersion: string;
  description: string;
  maximumCombinedReduction: number;
  hardVetoFamilies: readonly ContextProviderFamily[];
  missingDataPolicy: string;
  conflictPolicy: string;
  providerPriorityPolicy: string;
  stalenessPolicy: string;
  status: 'draft' | 'observer' | 'validated_for_research' | 'deprecated' | 'disabled';
}

export const DEFAULT_CTX_POLICY: CtxPolicyDef = {
  policyKey: CTX_POLICY_KEY,
  policyVersion: CTX_POLICY_VERSION,
  description:
    'Phase 2E contextual veto observer policy. Composes signal multipliers under min(...) with a floor of 0.5 (maximumCombinedReduction=0.5). Hard-veto families: macro_calendar, cross_exchange_dislocation, token_unlocks. Missing required signals produce insufficient_evidence. Conflicting high-authority signals produce conflict.',
  maximumCombinedReduction: 0.5,
  hardVetoFamilies: ['macro_calendar', 'cross_exchange_dislocation', 'token_unlocks'],
  missingDataPolicy: 'required_signals_produce_insufficient_evidence',
  conflictPolicy: 'high_authority_conflict_produces_conflict',
  providerPriorityPolicy: 'authority_hierarchy_dominant',
  stalenessPolicy: 'expiration_and_provider_staleness_enforced',
  status: 'observer',
};

function policyHash(p: CtxPolicyDef): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        k: p.policyKey,
        v: p.policyVersion,
        mcr: p.maximumCombinedReduction,
        hvf: [...p.hardVetoFamilies].sort(),
        md: p.missingDataPolicy,
        cp: p.conflictPolicy,
        pp: p.providerPriorityPolicy,
        sp: p.stalenessPolicy,
      }),
    )
    .digest('hex');
}

export async function registerContextPolicy(def: CtxPolicyDef = DEFAULT_CTX_POLICY): Promise<ContextPolicyVersionRow> {
  const hash = policyHash(def);
  const existing = await db
    .select()
    .from(contextPolicyVersions)
    .where(and(eq(contextPolicyVersions.policyKey, def.policyKey), eq(contextPolicyVersions.policyVersion, def.policyVersion)))
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].implementationHash !== hash) {
      throw new Error(`context policy ${def.policyKey}@${def.policyVersion} implementationHash mismatch — bump policyVersion`);
    }
    return existing[0];
  }
  await db.insert(contextPolicyVersions).values({
    policyKey: def.policyKey,
    policyVersion: def.policyVersion,
    description: def.description,
    status: def.status,
    maximumCombinedReduction: def.maximumCombinedReduction.toFixed(4),
    hardVetoFamilies: def.hardVetoFamilies.join(','),
    missingDataPolicy: def.missingDataPolicy,
    conflictPolicy: def.conflictPolicy,
    providerPriorityPolicy: def.providerPriorityPolicy,
    stalenessPolicy: def.stalenessPolicy,
    implementationHash: hash,
    configurationHash: hash,
  });
  const [row] = await db
    .select()
    .from(contextPolicyVersions)
    .where(and(eq(contextPolicyVersions.policyKey, def.policyKey), eq(contextPolicyVersions.policyVersion, def.policyVersion)))
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Provider + signal registration
// ---------------------------------------------------------------------------

export interface CtxProviderDef {
  providerKey: string;
  providerVersion: string;
  providerFamily: ContextProviderFamily;
  description: string;
  expectedSchemaVersion: string;
  expectedUpdateIntervalMs: number;
  maximumStalenessMs: number;
  authorityLevel: ContextAuthority;
  supportedScopes: readonly ContextScope[];
  status?: 'draft' | 'observer' | 'validated_for_research' | 'deprecated' | 'disabled';
}

function providerHash(p: CtxProviderDef): string {
  return createHash('sha256').update(JSON.stringify({
    k: p.providerKey, v: p.providerVersion, f: p.providerFamily,
    s: p.expectedSchemaVersion, ui: p.expectedUpdateIntervalMs, ms: p.maximumStalenessMs,
    a: p.authorityLevel, sc: [...p.supportedScopes].sort(),
  })).digest('hex');
}

export async function registerContextProvider(def: CtxProviderDef): Promise<ContextProviderDefinitionRow> {
  const hash = providerHash(def);
  const existing = await db
    .select()
    .from(contextProviderDefinitions)
    .where(and(eq(contextProviderDefinitions.providerKey, def.providerKey), eq(contextProviderDefinitions.providerVersion, def.providerVersion)))
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].implementationHash !== hash) {
      throw new Error(`context provider ${def.providerKey}@${def.providerVersion} implementationHash mismatch — bump providerVersion`);
    }
    return existing[0];
  }
  await db.insert(contextProviderDefinitions).values({
    providerKey: def.providerKey,
    providerVersion: def.providerVersion,
    providerFamily: def.providerFamily,
    description: def.description,
    expectedSchemaVersion: def.expectedSchemaVersion,
    expectedUpdateIntervalMs: def.expectedUpdateIntervalMs,
    maximumStalenessMs: def.maximumStalenessMs,
    authorityLevel: def.authorityLevel,
    supportedScopes: def.supportedScopes.join(','),
    implementationHash: hash,
    status: def.status ?? 'observer',
  });
  const [row] = await db
    .select()
    .from(contextProviderDefinitions)
    .where(and(eq(contextProviderDefinitions.providerKey, def.providerKey), eq(contextProviderDefinitions.providerVersion, def.providerVersion)))
    .limit(1);
  return row;
}

export async function registerContextSignal(def: CtxSignalDef, providerDefinitionId: number): Promise<ContextSignalDefinitionRow> {
  const hash = createHash('sha256').update(JSON.stringify({
    k: def.key, v: def.version, pid: providerDefinitionId,
    s: def.scope, ot: def.outputType, u: def.unit,
    dp: def.directionPolicy, sp: def.severityPolicy, cp: def.confidencePolicy,
    stp: def.stalenessPolicy, xp: def.conflictPolicy,
  })).digest('hex');
  const existing = await db
    .select()
    .from(contextSignalDefinitions)
    .where(and(eq(contextSignalDefinitions.signalKey, def.key), eq(contextSignalDefinitions.signalVersion, def.version)))
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].implementationHash !== hash) {
      throw new Error(`context signal ${def.key}@${def.version} implementationHash drift — bump version`);
    }
    return existing[0];
  }
  await db.insert(contextSignalDefinitions).values({
    signalKey: def.key,
    signalVersion: def.version,
    providerDefinitionId,
    scope: def.scope,
    description: def.description,
    outputType: def.outputType,
    unit: def.unit,
    directionPolicy: def.directionPolicy,
    severityPolicy: def.severityPolicy,
    confidencePolicy: def.confidencePolicy,
    stalenessPolicy: def.stalenessPolicy,
    conflictPolicy: def.conflictPolicy,
    implementationHash: hash,
    status: 'observer',
  });
  const [row] = await db
    .select()
    .from(contextSignalDefinitions)
    .where(and(eq(contextSignalDefinitions.signalKey, def.key), eq(contextSignalDefinitions.signalVersion, def.version)))
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Runs + observations
// ---------------------------------------------------------------------------

export async function startContextObserverRun(policyVersionId: number, startedAt: Date, runnerVersion = 'p2e-ctx-runner-1'): Promise<ContextObserverRunRow> {
  const [{ insertId }] = (await db.insert(contextObserverRuns).values({ policyVersionId, runnerVersion, startedAt })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(contextObserverRuns).where(eq(contextObserverRuns.id, insertId)).limit(1);
  return row;
}

export async function persistContextObservation(
  providerDefinitionId: number,
  o: ContextObservationPayload,
): Promise<ContextObservationRow> {
  const existing = await db
    .select()
    .from(contextObservations)
    .where(and(
      eq(contextObservations.providerDefinitionId, providerDefinitionId),
      eq(contextObservations.sourceTimestamp, o.sourceTimestamp),
      eq(contextObservations.payloadHash, o.payloadHash),
    ))
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(contextObservations).values({
    providerDefinitionId,
    productId: o.productId ?? null,
    scope: o.scope,
    sourceTimestamp: o.sourceTimestamp,
    receivedAt: o.receivedAt,
    dataAvailableAt: o.dataAvailableAt,
    payloadHash: o.payloadHash,
    schemaVersion: o.schemaVersion,
    healthState: o.healthState,
    normalizedPayload: JSON.stringify(o.normalizedPayload),
    rawPayloadSanitized: o.rawPayloadSanitized ? JSON.stringify(o.rawPayloadSanitized) : null,
  });
  const [row] = await db
    .select()
    .from(contextObservations)
    .where(and(
      eq(contextObservations.providerDefinitionId, providerDefinitionId),
      eq(contextObservations.sourceTimestamp, o.sourceTimestamp),
      eq(contextObservations.payloadHash, o.payloadHash),
    ))
    .limit(1);
  return row;
}

export async function persistProviderHealth(
  providerDefinitionId: number,
  health: {
    healthState: ContextProviderHealthState;
    lastSuccessfulObservationAt: Date | null;
    lastFailureAt: Date | null;
    consecutiveFailures: number;
    stalenessAgeMs: number | null;
    clockSkewMs: number | null;
    observedSchemaVersion: string | null;
    expectedUpdateIntervalMs: number | null;
    observedUpdateIntervalMs: number | null;
    healthReason: string;
    observedAt: Date;
    dataAvailableAt: Date;
  },
): Promise<ContextProviderHealthRow> {
  const [{ insertId }] = (await db.insert(contextProviderHealth).values({
    providerDefinitionId,
    healthState: health.healthState,
    lastSuccessfulObservationAt: health.lastSuccessfulObservationAt,
    lastFailureAt: health.lastFailureAt,
    consecutiveFailures: health.consecutiveFailures,
    stalenessAgeMs: health.stalenessAgeMs,
    clockSkewMs: health.clockSkewMs,
    observedSchemaVersion: health.observedSchemaVersion,
    expectedUpdateIntervalMs: health.expectedUpdateIntervalMs,
    observedUpdateIntervalMs: health.observedUpdateIntervalMs,
    healthReason: health.healthReason,
    observedAt: health.observedAt,
    dataAvailableAt: health.dataAvailableAt,
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(contextProviderHealth).where(eq(contextProviderHealth.id, insertId)).limit(1);
  return row;
}

export async function persistContextSignalValue(
  signalDefinitionId: number,
  observationId: number | null,
  s: ContextSignalResult,
): Promise<ContextSignalValueRow> {
  const [{ insertId }] = (await db.insert(contextSignalValues).values({
    signalDefinitionId,
    observationId,
    productId: s.productId ?? null,
    scope: s.scope,
    status: s.status,
    value: s.value != null ? s.value.toFixed(12) : null,
    unit: s.unit,
    direction: s.direction,
    severity: Math.max(0, Math.min(1, s.severity)).toFixed(4),
    confidence: Math.max(0, Math.min(1, s.confidence)).toFixed(4),
    sampleCount: s.sampleCount,
    observedAt: s.observedAt,
    dataAvailableAt: s.dataAvailableAt,
    expiresAt: s.expiresAt,
    inputHash: s.inputHash,
    failureReason: s.failureReason,
    diagnostics: s.diagnostics ? JSON.stringify(s.diagnostics) : null,
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(contextSignalValues).where(eq(contextSignalValues.id, insertId)).limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface GlobalContextSnapshotInput {
  observerRunId: number;
  policyVersionId: number;
  ensemble: ContextEnsembleResult;
  marketRiskState: string;
  macroWindowState: string;
  fundingState: string;
  premiumState: string;
  etfFlowState: string;
  stablecoinState: string;
  sentimentState: string;
  providerHealthState: string;
}

export async function persistGlobalContextSnapshot(input: GlobalContextSnapshotInput): Promise<GlobalContextSnapshotRow> {
  const [{ insertId }] = (await db.insert(globalContextSnapshots).values({
    observerRunId: input.observerRunId,
    policyVersionId: input.policyVersionId,
    marketRiskState: input.marketRiskState,
    macroWindowState: input.macroWindowState,
    fundingState: input.fundingState,
    premiumState: input.premiumState,
    etfFlowState: input.etfFlowState,
    stablecoinState: input.stablecoinState,
    sentimentState: input.sentimentState,
    providerHealthState: input.providerHealthState,
    confidence: input.ensemble.confidence.toFixed(4),
    observedAt: input.ensemble.observedAt,
    dataAvailableAt: input.ensemble.dataAvailableAt,
    expiresAt: input.ensemble.expiresAt,
    inputHash: input.ensemble.inputHash,
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(globalContextSnapshots).where(eq(globalContextSnapshots.id, insertId)).limit(1);
  return row;
}

export interface ProductContextSnapshotInput {
  observerRunId: number;
  productId: string;
  policyVersionId: number;
  ensemble: ContextEnsembleResult;
  unlockState: string;
  exchangeFlowState: string;
  sectorState: string;
  productPremiumState: string;
  fundingState: string;
  dislocationState: string;
  providerHealthState: string;
}

export async function persistProductContextSnapshot(input: ProductContextSnapshotInput): Promise<ProductContextSnapshotRow> {
  const [{ insertId }] = (await db.insert(productContextSnapshots).values({
    observerRunId: input.observerRunId,
    productId: input.productId,
    policyVersionId: input.policyVersionId,
    unlockState: input.unlockState,
    exchangeFlowState: input.exchangeFlowState,
    sectorState: input.sectorState,
    productPremiumState: input.productPremiumState,
    fundingState: input.fundingState,
    dislocationState: input.dislocationState,
    providerHealthState: input.providerHealthState,
    confidence: input.ensemble.confidence.toFixed(4),
    observedAt: input.ensemble.observedAt,
    dataAvailableAt: input.ensemble.dataAvailableAt,
    expiresAt: input.ensemble.expiresAt,
    inputHash: input.ensemble.inputHash,
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(productContextSnapshots).where(eq(productContextSnapshots.id, insertId)).limit(1);
  return row;
}

export async function persistEnsembleEvidence(
  snapshotIds: { globalSnapshotId?: number | null; productSnapshotId?: number | null },
  votes: readonly EnsembleSignalVote[],
  signalDefinitionIdByKey: ReadonlyMap<string, number>,
  signalValueIdByKey: ReadonlyMap<string, number | null>,
): Promise<void> {
  for (const v of votes) {
    const sigDefId = signalDefinitionIdByKey.get(v.signalKey);
    if (sigDefId == null) continue; // required-but-missing rows have no signal def
    const svId = signalValueIdByKey.get(v.signalKey) ?? null;
    await db.insert(contextEnsembleEvidence).values({
      globalSnapshotId: snapshotIds.globalSnapshotId ?? null,
      productSnapshotId: snapshotIds.productSnapshotId ?? null,
      signalDefinitionId: sigDefId,
      signalValueId: svId,
      vote: v.vote,
      multiplierContribution: v.multiplierContribution.toFixed(4),
      authority: v.authority,
      weight: v.weight.toFixed(4),
      reasonCode: v.reasonCode.slice(0, 64),
      diagnostics: v.signal?.diagnostics ? JSON.stringify(v.signal.diagnostics) : null,
    });
  }
}

// ---------------------------------------------------------------------------
// Candidate decision + comparison
// ---------------------------------------------------------------------------

export type CtxDecision = 'no_op' | 'reduce' | 'reject' | 'abstain' | 'data_failure';

export interface CandidateContextDecisionInputs {
  decisionChainId: number;
  productId: string;
  contextPolicyVersionId: number;
  globalContextSnapshotId: number | null;
  productContextSnapshotId: number | null;
  phase2cRiskDecisionId?: number | null;
  phase2dExecutionDecisionId?: number | null;
  ensemble: ContextEnsembleResult;
  providerHealthState: string;
  observedAt: Date;
}

export interface EvaluateCandidateContextResult {
  decision: CtxDecision;
  contextMultiplier: number;
  reasonCodes: string[];
  warningSignals: string[];
  vetoSignals: string[];
  missingSignals: string[];
  conflictingSignals: string[];
  observedAt: Date;
  dataAvailableAt: Date;
  expiresAt: Date | null;
  confidence: number;
  inputHash: string;
}

export function evaluateCandidateContext(inputs: CandidateContextDecisionInputs): EvaluateCandidateContextResult {
  const e = inputs.ensemble;
  const reasons: string[] = [];
  let decision: CtxDecision;
  let multiplier = e.combinedMultiplier;

  if (e.outcome === 'data_failure') {
    decision = 'data_failure';
    multiplier = 0;
    reasons.push('data_failure');
  } else if (e.outcome === 'high_risk' || e.vetoSignals.length > 0) {
    decision = 'reject';
    multiplier = 0;
    reasons.push('veto');
    for (const v of e.vetoSignals) reasons.push(`veto:${v}`);
  } else if (e.outcome === 'conflict') {
    decision = 'abstain';
    multiplier = 0;
    reasons.push('conflict');
    for (const c of e.conflictingSignals) reasons.push(`conflict:${c}`);
  } else if (e.outcome === 'insufficient_evidence') {
    decision = 'abstain';
    multiplier = 0;
    reasons.push('insufficient_evidence');
    for (const m of e.missingSignals) reasons.push(`missing:${m}`);
  } else if (multiplier >= 1) {
    decision = 'no_op';
    reasons.push('no_op');
  } else if (multiplier > 0) {
    decision = 'reduce';
    reasons.push('reduce');
    for (const r of e.reductionSignals) reasons.push(`reduce:${r}`);
  } else {
    decision = 'reject';
    reasons.push('multiplier_zero');
  }

  // Invariant enforcement — supportive signals never boost.
  if (multiplier > 1) multiplier = 1;
  if (multiplier < 0) multiplier = 0;

  const inputHash = createHash('sha256').update(JSON.stringify({
    chain: inputs.decisionChainId,
    pid: inputs.productId,
    pol: inputs.contextPolicyVersionId,
    en: e.inputHash,
    d: decision,
    m: multiplier,
  })).digest('hex');

  return {
    decision,
    contextMultiplier: multiplier,
    reasonCodes: reasons,
    warningSignals: e.warningSignals,
    vetoSignals: e.vetoSignals,
    missingSignals: e.missingSignals,
    conflictingSignals: e.conflictingSignals,
    observedAt: inputs.observedAt,
    dataAvailableAt: e.dataAvailableAt,
    expiresAt: e.expiresAt,
    confidence: e.confidence,
    inputHash,
  };
}

export async function persistCandidateContextDecision(
  inputs: CandidateContextDecisionInputs,
  result: EvaluateCandidateContextResult,
): Promise<CandidateContextDecisionRow> {
  await db.insert(candidateContextDecisions).values({
    decisionChainId: inputs.decisionChainId,
    productId: inputs.productId,
    contextPolicyVersionId: inputs.contextPolicyVersionId,
    globalContextSnapshotId: inputs.globalContextSnapshotId,
    productContextSnapshotId: inputs.productContextSnapshotId,
    phase2cRiskDecisionId: inputs.phase2cRiskDecisionId ?? null,
    phase2dExecutionDecisionId: inputs.phase2dExecutionDecisionId ?? null,
    decision: result.decision,
    contextMultiplier: result.contextMultiplier.toFixed(4),
    warningSignals: result.warningSignals.join(','),
    vetoSignals: result.vetoSignals.join(','),
    missingSignals: result.missingSignals.join(','),
    conflictingSignals: result.conflictingSignals.join(','),
    providerHealthState: inputs.providerHealthState,
    confidence: result.confidence.toFixed(4),
    observedAt: result.observedAt,
    dataAvailableAt: result.dataAvailableAt,
    expiresAt: result.expiresAt,
    inputHash: result.inputHash,
    reasonCodes: result.reasonCodes.join(',').slice(0, 500),
    diagnostics: null,
  });
  const [row] = await db
    .select()
    .from(candidateContextDecisions)
    .where(eq(candidateContextDecisions.decisionChainId, inputs.decisionChainId))
    .limit(1);
  return row;
}

export type CtxAgreementState =
  | 'agree'
  | 'context_reduced'
  | 'context_rejected'
  | 'context_abstained'
  | 'context_failed'
  | 'unresolved';

export function classifyCtxAgreement(decision: CtxDecision): CtxAgreementState {
  switch (decision) {
    case 'no_op': return 'agree';
    case 'reduce': return 'context_reduced';
    case 'reject': return 'context_rejected';
    case 'abstain': return 'context_abstained';
    case 'data_failure': return 'context_failed';
  }
}

export async function persistChampionContextComparison(input: {
  decisionChainId: number;
  candidateContextDecisionId: number | null;
  productId: string;
  championDecision: string;
  championProposedSize: number;
  contextDecision: CtxDecision;
  contextMultiplier: number;
  policyVersion: string;
  observedAt: Date;
  dataAvailableAt: Date;
  reasonCodes: readonly string[];
}): Promise<ChampionContextComparisonRow> {
  const agree = classifyCtxAgreement(input.contextDecision);
  const observerMax = input.championProposedSize * Math.max(0, Math.min(1, input.contextMultiplier));
  await db.insert(championContextComparisons).values({
    decisionChainId: input.decisionChainId,
    candidateContextDecisionId: input.candidateContextDecisionId,
    productId: input.productId,
    championDecision: input.championDecision,
    championProposedSize: input.championProposedSize.toFixed(10),
    contextDecision: input.contextDecision,
    contextMultiplier: input.contextMultiplier.toFixed(4),
    observerRecommendedMaximumSize: observerMax.toFixed(10),
    agreementState: agree,
    reasonCodes: input.reasonCodes.join(',').slice(0, 500),
    policyVersion: input.policyVersion,
    observedAt: input.observedAt,
    dataAvailableAt: input.dataAvailableAt,
  });
  const [row] = await db
    .select()
    .from(championContextComparisons)
    .where(eq(championContextComparisons.decisionChainId, input.decisionChainId))
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Incidents (append-only)
// ---------------------------------------------------------------------------

export type CtxIncidentType =
  | 'provider_outage'
  | 'provider_stale'
  | 'provider_conflict'
  | 'schema_mismatch'
  | 'clock_skew'
  | 'unexpected_value'
  | 'authentication_failure'
  | 'rate_limit'
  | 'manual_disable'
  | 'signal_failure'
  | 'policy_failure';

export type CtxIncidentSeverity = 'informational' | 'degraded' | 'high' | 'blocking';

export interface RecordIncidentInput {
  providerDefinitionId?: number | null;
  signalDefinitionId?: number | null;
  policyVersionId?: number | null;
  incidentType: CtxIncidentType;
  severity: CtxIncidentSeverity;
  scope: ContextScope;
  productId?: string | null;
  detectedAt: Date;
  dataAvailableAt: Date;
  reasonCode: string;
  details?: Record<string, unknown> | string | null;
}

export async function recordContextIncident(input: RecordIncidentInput): Promise<ContextIncidentRow> {
  const [{ insertId }] = (await db.insert(contextIncidents).values({
    providerDefinitionId: input.providerDefinitionId ?? null,
    signalDefinitionId: input.signalDefinitionId ?? null,
    policyVersionId: input.policyVersionId ?? null,
    incidentType: input.incidentType,
    severity: input.severity,
    scope: input.scope,
    productId: input.productId ?? null,
    detectedAt: input.detectedAt,
    dataAvailableAt: input.dataAvailableAt,
    reasonCode: input.reasonCode,
    details:
      input.details == null
        ? null
        : typeof input.details === 'string'
          ? input.details
          : JSON.stringify(input.details),
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(contextIncidents).where(eq(contextIncidents.id, insertId)).limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Sector + macro-event definition helpers
// ---------------------------------------------------------------------------

export async function registerSectorDefinition(input: {
  sectorKey: string;
  sectorVersion: string;
  description: string;
}): Promise<SectorDefinitionRow> {
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const existing = await db
    .select()
    .from(sectorDefinitions)
    .where(and(eq(sectorDefinitions.sectorKey, input.sectorKey), eq(sectorDefinitions.sectorVersion, input.sectorVersion)))
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(sectorDefinitions).values({
    sectorKey: input.sectorKey,
    sectorVersion: input.sectorVersion,
    description: input.description,
    implementationHash: hash,
    status: 'observer',
  });
  const [row] = await db
    .select()
    .from(sectorDefinitions)
    .where(and(eq(sectorDefinitions.sectorKey, input.sectorKey), eq(sectorDefinitions.sectorVersion, input.sectorVersion)))
    .limit(1);
  return row;
}

export async function upsertSectorMembership(sectorDefinitionId: number, productId: string, weight = 1): Promise<SectorMembershipRow> {
  const existing = await db
    .select()
    .from(sectorMemberships)
    .where(and(eq(sectorMemberships.sectorDefinitionId, sectorDefinitionId), eq(sectorMemberships.productId, productId)))
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(sectorMemberships).values({
    sectorDefinitionId,
    productId,
    weight: weight.toFixed(6),
  });
  const [row] = await db
    .select()
    .from(sectorMemberships)
    .where(and(eq(sectorMemberships.sectorDefinitionId, sectorDefinitionId), eq(sectorMemberships.productId, productId)))
    .limit(1);
  return row;
}

export interface MacroEventDefInput {
  eventKey: string;
  eventVersion: string;
  eventKind: 'fomc' | 'cpi' | 'jobs_report' | 'regulatory_announcement' | 'exchange_maintenance' | 'other';
  description: string;
  timeZone: string;
  preWindowMs: number;
  postWindowMs: number;
}

export async function registerMacroEvent(input: MacroEventDefInput): Promise<MacroEventDefinitionRow> {
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const existing = await db
    .select()
    .from(macroEventDefinitions)
    .where(and(eq(macroEventDefinitions.eventKey, input.eventKey), eq(macroEventDefinitions.eventVersion, input.eventVersion)))
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(macroEventDefinitions).values({
    eventKey: input.eventKey,
    eventVersion: input.eventVersion,
    eventKind: input.eventKind,
    description: input.description,
    timeZone: input.timeZone,
    preWindowMs: input.preWindowMs,
    postWindowMs: input.postWindowMs,
    implementationHash: hash,
    status: 'observer',
  });
  const [row] = await db
    .select()
    .from(macroEventDefinitions)
    .where(and(eq(macroEventDefinitions.eventKey, input.eventKey), eq(macroEventDefinitions.eventVersion, input.eventVersion)))
    .limit(1);
  return row;
}

export async function persistMacroEventObservation(input: {
  eventDefinitionId: number;
  scheduledAt: Date;
  windowStart: Date;
  windowEnd: Date;
  state: 'outside_window' | 'pre_event_window' | 'event_window' | 'post_event_window' | 'unknown';
  observedAt: Date;
  dataAvailableAt: Date;
  supersedesObservationId?: number | null;
}): Promise<MacroEventObservationRow> {
  const [{ insertId }] = (await db.insert(macroEventObservations).values({
    eventDefinitionId: input.eventDefinitionId,
    scheduledAt: input.scheduledAt,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    state: input.state,
    observedAt: input.observedAt,
    dataAvailableAt: input.dataAvailableAt,
    supersedesObservationId: input.supersedesObservationId ?? null,
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(macroEventObservations).where(eq(macroEventObservations.id, insertId)).limit(1);
  return row;
}
