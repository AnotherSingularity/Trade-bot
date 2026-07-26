import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  regimeDefinitions,
  regimeTransitionPolicies,
  type RegimeDefinitionRow,
  type RegimeTransitionPolicyRow,
} from '../../db/schema';
import type { RegimeDefinition } from './contract';

/**
 * Phase 2B §C — Regime definition registry.
 *
 * Each (regimeKey, regimeVersion) pair is immutable. Bumping any
 * behaviorally-relevant field REQUIRES bumping `version`; the DB
 * uniqueness index rejects silent changes, and the calculationHash
 * check surfaces subtle drift.
 */

export interface RegisteredRegime {
  definition: RegimeDefinition;
  row: RegimeDefinitionRow;
}

export async function registerRegimeDefinition(
  def: RegimeDefinition,
): Promise<RegisteredRegime> {
  const existing = await db
    .select()
    .from(regimeDefinitions)
    .where(
      and(
        eq(regimeDefinitions.regimeKey, def.key),
        eq(regimeDefinitions.regimeVersion, def.version),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return { definition: def, row: existing[0] };
  }
  await db.insert(regimeDefinitions).values({
    regimeKey: def.key,
    regimeVersion: def.version,
    scope: def.scope,
    description: def.description,
    requiredEvidence: JSON.stringify([...def.requiredEvidence]),
    minimumValidEvidence: def.minimumValidEvidence,
    conflictPolicy: def.conflictPolicy,
    missingDataPolicy: def.missingDataPolicy,
    transitionPolicyVersion: def.transitionPolicyVersion,
    implementationHash: hashDefinition(def),
    status: def.status,
  });
  const [row] = await db
    .select()
    .from(regimeDefinitions)
    .where(
      and(
        eq(regimeDefinitions.regimeKey, def.key),
        eq(regimeDefinitions.regimeVersion, def.version),
      ),
    )
    .limit(1);
  return { definition: def, row: row! };
}

export async function assertRegimeImmutability(def: RegimeDefinition): Promise<void> {
  const existing = await db
    .select()
    .from(regimeDefinitions)
    .where(
      and(
        eq(regimeDefinitions.regimeKey, def.key),
        eq(regimeDefinitions.regimeVersion, def.version),
      ),
    )
    .limit(1);
  if (existing.length === 0) return;
  const expected = hashDefinition(def);
  if (existing[0].implementationHash !== expected) {
    throw new Error(
      `regime definition ${def.key}@${def.version} implementationHash mismatch — bump the version`,
    );
  }
}

function hashDefinition(def: RegimeDefinition): string {
  const seed = JSON.stringify({
    key: def.key,
    version: def.version,
    scope: def.scope,
    required: [...def.requiredEvidence].sort(),
    min: def.minimumValidEvidence,
    conflict: def.conflictPolicy,
    missing: def.missingDataPolicy,
    trans: def.transitionPolicyVersion,
  });
  return `regime-${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Transition policy registry
// ---------------------------------------------------------------------------

export interface TransitionPolicy {
  policyVersion: string;
  minimumDwellObservations: number;
  candidateConfirmationCount: number;
  minimumTransitionConfidence: number;
  emergencyOverrideStates: readonly string[];
  confidenceDecay: number;
  staleStateExpiryMs: number;
  transitionMatrixPolicy: string;
  description: string;
}

export const DEFAULT_TRANSITION_POLICY: TransitionPolicy = {
  policyVersion: 'p2b-transition-1',
  minimumDwellObservations: 3,
  candidateConfirmationCount: 2,
  minimumTransitionConfidence: 0.55,
  emergencyOverrideStates: ['DISORDERED', 'UNKNOWN'],
  confidenceDecay: 0.1,
  staleStateExpiryMs: 6 * 60 * 60 * 1000,
  transitionMatrixPolicy: 'unrestricted',
  description:
    'Default hysteresis: 3-observation dwell, 2 confirming observations, confidence≥0.55, decay 0.1 per stale tick, 6h stale expiry, DISORDERED/UNKNOWN may transition immediately.',
};

export async function registerTransitionPolicy(
  policy: TransitionPolicy,
): Promise<RegimeTransitionPolicyRow> {
  const existing = await db
    .select()
    .from(regimeTransitionPolicies)
    .where(eq(regimeTransitionPolicies.policyVersion, policy.policyVersion))
    .limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(regimeTransitionPolicies).values({
    policyVersion: policy.policyVersion,
    minimumDwellObservations: policy.minimumDwellObservations,
    candidateConfirmationCount: policy.candidateConfirmationCount,
    minimumTransitionConfidence: policy.minimumTransitionConfidence.toFixed(4),
    emergencyOverrideStates: JSON.stringify([...policy.emergencyOverrideStates]),
    confidenceDecay: policy.confidenceDecay.toFixed(4),
    staleStateExpiryMs: policy.staleStateExpiryMs,
    transitionMatrixPolicy: policy.transitionMatrixPolicy,
    description: policy.description,
  });
  const [row] = await db
    .select()
    .from(regimeTransitionPolicies)
    .where(eq(regimeTransitionPolicies.policyVersion, policy.policyVersion))
    .limit(1);
  return row!;
}
