import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  shadowExecutionPlans,
  type ShadowExecutionPlanRow,
} from '../../db/schema';
import { appendLineageEvent } from '../../db/lineage';
import { hashConfiguration, type ProtectedConfig } from '../protection/configBuilder';
import { SHADOW_STRATEGY_VERSION } from './authorization';

/**
 * Phase 1.1 Gate 3D §C — immutable shadow execution plan.
 *
 * A plan is created by `authorizeShadowEntry` and consumed by the
 * simulator. The executor MUST call `consumePlan(planId, config)` before
 * creating any shadow paper intent — it:
 *
 *   1. Verifies the plan is still `approved` (not consumed / invalidated
 *      / superseded / expired).
 *   2. Recomputes the config hash from the caller-provided config and
 *      rejects if it differs from the persisted plan.
 *   3. Marks the plan `consumed` atomically (WHERE status='approved')
 *      so a second consume for the same plan cannot succeed.
 *
 * `invalidatePlan(planId, reason)` marks a plan `invalidated` — used by
 * post-fill revalidation when material change is detected.
 *
 * `supersedePlan(oldPlanId, newPlanFields)` inserts a new plan version
 * pointing back via `supersedesPlanId` and marks the old one
 * `superseded`. The old row is NEVER edited beyond that status flip.
 */

export interface ConsumePlanInput {
  planId: number;
  callerConfigHash: string;
  now?: Date;
}

export type ConsumePlanResult =
  | { ok: true; plan: ShadowExecutionPlanRow }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'not_approved'
        | 'expired'
        | 'hash_mismatch'
        | 'already_consumed';
      plan: ShadowExecutionPlanRow | null;
    };

export async function consumePlan(input: ConsumePlanInput): Promise<ConsumePlanResult> {
  const now = input.now ?? new Date();
  const [plan] = await db
    .select()
    .from(shadowExecutionPlans)
    .where(eq(shadowExecutionPlans.id, input.planId))
    .limit(1);
  if (!plan) return { ok: false, reason: 'not_found', plan: null };
  if (plan.status === 'consumed') return { ok: false, reason: 'already_consumed', plan };
  if (plan.status !== 'approved') return { ok: false, reason: 'not_approved', plan };
  if (plan.expiresAt.getTime() < now.getTime()) {
    return { ok: false, reason: 'expired', plan };
  }
  if (plan.configurationHash !== input.callerConfigHash) {
    return { ok: false, reason: 'hash_mismatch', plan };
  }
  // Atomic status flip — a second consume loses the WHERE.
  const result = await db
    .update(shadowExecutionPlans)
    .set({ status: 'consumed' })
    .where(
      and(
        eq(shadowExecutionPlans.id, plan.id),
        eq(shadowExecutionPlans.status, 'approved'),
      ),
    );
  const affected = (result as unknown as { affectedRows: number }[])[0]?.affectedRows ?? 0;
  if (affected === 0) {
    return { ok: false, reason: 'already_consumed', plan };
  }
  await appendLineageEvent({
    decisionChainId: plan.decisionChainId,
    eventType: 'shadow.plan_consumed',
    sourceEntityType: 'shadow_execution_plan',
    sourceRecordId: plan.id,
    eventTime: now,
    actor: 'shadow_executor',
    componentVersion: SHADOW_STRATEGY_VERSION,
    metadata: null,
  });
  const [after] = await db
    .select()
    .from(shadowExecutionPlans)
    .where(eq(shadowExecutionPlans.id, plan.id))
    .limit(1);
  return { ok: true, plan: after! };
}

export async function invalidatePlan(
  planId: number,
  reason: string,
  now: Date = new Date(),
): Promise<ShadowExecutionPlanRow | null> {
  const [plan] = await db
    .select()
    .from(shadowExecutionPlans)
    .where(eq(shadowExecutionPlans.id, planId))
    .limit(1);
  if (!plan) return null;
  if (plan.status === 'invalidated') return plan;
  await db
    .update(shadowExecutionPlans)
    .set({ status: 'invalidated', invalidationReason: reason })
    .where(eq(shadowExecutionPlans.id, planId));
  await appendLineageEvent({
    decisionChainId: plan.decisionChainId,
    eventType: 'shadow.plan_invalidated',
    sourceEntityType: 'shadow_execution_plan',
    sourceRecordId: planId,
    eventTime: now,
    actor: 'shadow_executor',
    componentVersion: SHADOW_STRATEGY_VERSION,
    metadata: { reason },
  });
  const [after] = await db
    .select()
    .from(shadowExecutionPlans)
    .where(eq(shadowExecutionPlans.id, planId))
    .limit(1);
  return after ?? null;
}

/** Recompute the configuration hash from a supplied config. */
export function computeConfigHash(config: ProtectedConfig): string {
  return hashConfiguration(config);
}
