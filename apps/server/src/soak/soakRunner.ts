import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import {
  soakRuns,
  type SoakRunRow,
} from '../db/schema';
import type { SelectedProviders } from '../market_data/providerFactory';
import { SHADOW_STRATEGY_VERSION } from '../trading/shadow/authorization';
import { CASH_FLOW_MODEL_VERSION } from '../trading/cashFlowForecast';
import { PROTECTION_MODULE_VERSION } from '../trading/protection/instance';
import { FILL_MODEL_VERSION } from '../trading/shadow/fillModel';
import { MARKET_ENVELOPE_SCHEMA_VERSION } from '../market_data/envelope';
import { httpCounters } from '../lib/fetchBarrier';
import { recordIncident } from './incidents';
import type { SoakPreflightRunRow } from '../db/schema';

/**
 * Phase 1.2-OPS §C — immutable soak-run lifecycle.
 *
 * Status transitions:
 *   preflight → running        (requires passed preflight + production providers)
 *   running   → failed         (any soak_invalidating incident)
 *   running   → reset_required (undocumented deployment during soak)
 *   running   → completed      (requiredEndAt reached AND no invalidating incidents)
 *
 * The row is immutable except for status/verdict/completedAt.
 */

export const SOAK_RUNNER_VERSION = 'p1_2-ops-runner-1';

export const SOAK_REQUIRED_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 calendar days

export interface StartSoakInput {
  soakRunId: string;
  commitHash: string;
  deploymentId: string;
  startedAt: Date;
  productUniverse: readonly string[];
  schemaFingerprint: string;
  safeFlagsSnapshot: Record<string, unknown>;
  preflight: SoakPreflightRunRow;
  providers: SelectedProviders;
}

export type StartSoakResult =
  | { ok: true; row: SoakRunRow }
  | { ok: false; reason: string };

export async function startSoak(input: StartSoakInput): Promise<StartSoakResult> {
  if (!input.preflight.passed) {
    return { ok: false, reason: 'preflight_not_passed' };
  }
  if (!input.providers.isProduction) {
    // Also record an incident for auditability.
    await recordIncident({
      soakRunId: input.soakRunId,
      incidentKind: 'mock_provider_active',
      detectedAt: input.startedAt,
      detail: `providers not production: ${input.providers.webSocketProviderName}, ${input.providers.restClientName}`,
    });
    return { ok: false, reason: 'mock_provider_active' };
  }
  if (!input.providers.soakEligible) {
    return { ok: false, reason: input.providers.refusedReason ?? 'not_soak_eligible' };
  }
  // Safe-flag check.
  const dryRun = input.safeFlagsSnapshot.DRY_RUN === true || input.safeFlagsSnapshot.DRY_RUN === 'true';
  const killswitch =
    input.safeFlagsSnapshot.ORDER_SUBMISSION_ENABLED === false ||
    input.safeFlagsSnapshot.ORDER_SUBMISSION_ENABLED === 'false';
  const shadowMode = input.safeFlagsSnapshot.SIMULATION_MODE === 'SHADOW_LIVE';
  if (!dryRun || !killswitch || !shadowMode) {
    return { ok: false, reason: 'safe_flags_incorrect' };
  }
  const universeHash = createHash('sha256')
    .update([...input.productUniverse].sort().join(','))
    .digest('hex');
  const requiredEndAt = new Date(input.startedAt.getTime() + SOAK_REQUIRED_DURATION_MS);

  const [{ insertId }] = (await db.insert(soakRuns).values({
    soakRunId: input.soakRunId,
    commitHash: input.commitHash,
    deploymentId: input.deploymentId,
    startedAt: input.startedAt,
    requiredEndAt,
    strategyVersion: SHADOW_STRATEGY_VERSION,
    marketDataVersion: MARKET_ENVELOPE_SCHEMA_VERSION,
    fillModelVersion: FILL_MODEL_VERSION,
    costModelVersion: CASH_FLOW_MODEL_VERSION,
    protectionPolicyVersion: PROTECTION_MODULE_VERSION,
    schemaFingerprint: input.schemaFingerprint,
    safeFlagsSnapshot: JSON.stringify(input.safeFlagsSnapshot),
    productUniverseHash: universeHash,
    status: 'preflight',
    verdict: 'pending',
    preflightRunId: input.preflight.id,
  })) as unknown as { insertId: number }[];

  // Atomically promote to running.
  const update = await db
    .update(soakRuns)
    .set({ status: 'running' })
    .where(and(eq(soakRuns.id, insertId), eq(soakRuns.status, 'preflight')));
  const affected = (update as unknown as { affectedRows: number }[])[0]?.affectedRows ?? 0;
  if (affected === 0) {
    return { ok: false, reason: 'concurrent_status_change' };
  }
  const [row] = await db.select().from(soakRuns).where(eq(soakRuns.id, insertId)).limit(1);
  return { ok: true, row: row! };
}

/** Mark a soak_run failed. */
export async function failSoak(soakRunId: string, reason: string, now: Date = new Date()): Promise<void> {
  await db
    .update(soakRuns)
    .set({ status: 'failed', completedAt: now, verdict: 'soak_failed', verdictReason: reason })
    .where(eq(soakRuns.soakRunId, soakRunId));
}

/** Force a `reset_required` transition — used by the undocumented-deployment guardrail. */
export async function resetRequired(
  soakRunId: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(soakRuns)
    .set({ status: 'reset_required', completedAt: now, verdict: 'soak_failed', verdictReason: reason })
    .where(eq(soakRuns.soakRunId, soakRunId));
  await recordIncident({
    soakRunId,
    incidentKind: 'undocumented_deployment',
    detectedAt: now,
    detail: reason,
  });
}

export async function loadSoakRun(soakRunId: string): Promise<SoakRunRow | null> {
  const [row] = await db.select().from(soakRuns).where(eq(soakRuns.soakRunId, soakRunId)).limit(1);
  return row ?? null;
}

/** Snapshot of the fetch counters for the operator to attach to a soak row. */
export function counterSnapshot() {
  const c = httpCounters();
  return {
    createOrderFunctionInvocations: c.createOrderFunctionInvocations,
    createOrderAttemptCount: c.createOrderAttemptCount,
    createOrderNetworkCount: c.createOrderNetworkCount,
  };
}
