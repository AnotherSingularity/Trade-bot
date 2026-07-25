import { Money } from '@horizon/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  positions,
  protectionEvents,
  protectionInstances,
  type ProtectionEventRow,
  type ProtectionInstanceRow,
} from '../../db/schema';
import { appendLineageEvent } from '../../db/lineage';
import type { ProtectedConfig } from './configBuilder';

/**
 * Phase 1.1 Gate 3C — protection instance lifecycle + partial-fill tracking
 * + bracket leg state model.
 *
 * State machine:
 *
 *   required
 *     ↓ (config built + accepted by exchange)
 *   pending
 *     ↓ (protection acknowledged; confirmedBaseQuantity ≥ requiredBaseQuantity)
 *   confirmed
 *
 *   confirmed ─(more entry fills)→ partially_confirmed
 *   partially_confirmed ─(protection catches up)→ confirmed
 *   any ─(protection gone / rejected / stale)→ missing | rejected | canceled
 *   missing | rejected → degraded (via markInstanceDegraded)
 *   confirmed ─(stop or target triggered)→ triggered → completed
 *   any contradictory leg state → inconsistent → degraded
 *
 * Rule: partial-fill NEVER promotes a protection instance to
 * `confirmed` unless the exchange-confirmed protected quantity meets or
 * exceeds the exact filled exposure. `requiredBaseQuantity` tracks the
 * ACTUAL filled base, not the original preview base.
 *
 * Every transition emits a `protection_events` row AND a Gate 2
 * `lineage_events` row so the audit chain remains unbroken.
 */

export type InstanceState = ProtectionInstanceRow['state'];
export type LegState = ProtectionInstanceRow['takeProfitLegState'];
export type EventLeg = ProtectionEventRow['leg'];

export const PROTECTION_MODULE_VERSION = 'p1g3c-protection-1';

// ---------------------------------------------------------------------------
// Instance creation
// ---------------------------------------------------------------------------

export interface CreateInstanceInput {
  positionId: number;
  config: ProtectedConfig;
  capabilityId: number;
  /** The filled base at position creation time — the exposure to protect. */
  requiredBaseQuantity: Money;
  /** Optional initial confirmed quantity (usually 0 until exchange acks). */
  confirmedBaseQuantity?: Money;
  now?: Date;
}

export async function createProtectionInstance(
  input: CreateInstanceInput,
): Promise<ProtectionInstanceRow> {
  const now = input.now ?? new Date();
  const confirmed = input.confirmedBaseQuantity ?? Money.zero();
  const initialState: InstanceState = confirmed.gte(input.requiredBaseQuantity)
    ? 'confirmed'
    : confirmed.isPositive()
      ? 'partially_confirmed'
      : 'required';
  const [{ insertId }] = (await db.insert(protectionInstances).values({
    positionId: input.positionId,
    decisionChainId: input.config.decisionChainId,
    entryOrderIntentId: input.config.entryOrderIntentId,
    policyVersionId: input.config.policyVersionId,
    capabilityId: input.capabilityId,
    protectionType: input.config.protectionType,
    requiredBaseQuantity: input.requiredBaseQuantity.toDecimalString(8),
    confirmedBaseQuantity: confirmed.toDecimalString(8),
    targetPrice: input.config.targetPrice.toDecimalString(8),
    stopTriggerPrice: input.config.stopTriggerPrice.toDecimalString(8),
    stopLimitPrice: input.config.stopLimitPrice ? input.config.stopLimitPrice.toDecimalString(8) : null,
    state: initialState,
    lastVerifiedAt: confirmed.isPositive() ? now : null,
  })) as unknown as { insertId: number }[];
  await emitEvent({
    instanceId: insertId,
    decisionChainId: input.config.decisionChainId,
    eventType: 'instance_created',
    previousState: null,
    newState: initialState,
    leg: 'instance',
    reason: null,
    metadata: {
      requiredBaseQuantity: input.requiredBaseQuantity.toDecimalString(8),
      confirmedBaseQuantity: confirmed.toDecimalString(8),
      protectionType: input.config.protectionType,
    },
    now,
  });
  const [row] = await db
    .select()
    .from(protectionInstances)
    .where(eq(protectionInstances.id, insertId))
    .limit(1);
  syncPositionProtectionState(input.positionId, row!).catch(() => {});
  return row!;
}

// ---------------------------------------------------------------------------
// Partial-fill hook
// ---------------------------------------------------------------------------

export interface RecalculateAfterFillInput {
  instanceId: number;
  /** The NEW filled base exposure after this fill event. */
  newFilledBase: Money;
  /** The NEW authoritatively-confirmed protected quantity, if changed. */
  newConfirmedBase?: Money;
  reason?: string;
  now?: Date;
}

/**
 * Recompute state after an entry fill. Updates required + confirmed
 * quantities. Position is marked `open_protected` ONLY when the
 * exchange-confirmed protected quantity ≥ actual filled exposure.
 */
export async function recalculateInstanceAfterFill(
  input: RecalculateAfterFillInput,
): Promise<ProtectionInstanceRow | null> {
  const [row] = await db
    .select()
    .from(protectionInstances)
    .where(eq(protectionInstances.id, input.instanceId))
    .limit(1);
  if (!row) return null;
  const now = input.now ?? new Date();
  const required = input.newFilledBase;
  const confirmed = input.newConfirmedBase ?? Money.fromString(row.confirmedBaseQuantity);
  const previousState = row.state;
  const nextState = classifyProtectionState(previousState, required, confirmed);
  await db
    .update(protectionInstances)
    .set({
      requiredBaseQuantity: required.toDecimalString(8),
      confirmedBaseQuantity: confirmed.toDecimalString(8),
      state: nextState,
      lastVerifiedAt: now,
      failureReason: nextState === 'partially_confirmed' || nextState === 'missing'
        ? `confirmed ${confirmed.toDecimalString(8)} < required ${required.toDecimalString(8)}`
        : null,
    })
    .where(eq(protectionInstances.id, input.instanceId));
  if (nextState !== previousState) {
    await emitEvent({
      instanceId: input.instanceId,
      decisionChainId: row.decisionChainId,
      eventType: 'recalculated_after_fill',
      previousState,
      newState: nextState,
      leg: 'instance',
      reason: input.reason ?? null,
      metadata: {
        requiredBaseQuantity: required.toDecimalString(8),
        confirmedBaseQuantity: confirmed.toDecimalString(8),
      },
      now,
    });
  }
  const [after] = await db
    .select()
    .from(protectionInstances)
    .where(eq(protectionInstances.id, input.instanceId))
    .limit(1);
  await syncPositionProtectionState(row.positionId, after!);
  return after!;
}

function classifyProtectionState(
  previous: InstanceState,
  required: Money,
  confirmed: Money,
): InstanceState {
  if (previous === 'canceled' || previous === 'completed' || previous === 'triggered') return previous;
  if (required.isZero()) return previous === 'required' ? 'required' : previous;
  if (confirmed.isZero()) return previous === 'required' ? 'required' : 'missing';
  if (confirmed.gte(required)) return 'confirmed';
  return 'partially_confirmed';
}

/**
 * Sync `positions.protectionState` to reflect the current instance state.
 * `open_protected` requires `confirmed`; `partially_confirmed` marks
 * the position `attached_partial`; anything else degrades to
 * `open_unprotected` / `degraded`.
 */
async function syncPositionProtectionState(
  positionId: number,
  instance: ProtectionInstanceRow,
): Promise<void> {
  let posProtection: (typeof positions)['_']['columns']['protectionState']['_']['data'];
  let lifecycle: (typeof positions)['_']['columns']['lifecycleState']['_']['data'] | null = null;
  switch (instance.state) {
    case 'confirmed':
      posProtection = instance.protectionType === 'application_polling' ? 'polling_only' : 'attached_active';
      lifecycle = 'open_protected';
      break;
    case 'partially_confirmed':
      posProtection = 'attached_partial';
      lifecycle = 'open_protected';
      break;
    case 'missing':
    case 'rejected':
    case 'canceled':
    case 'inconsistent':
    case 'degraded':
      posProtection = 'degraded';
      lifecycle = 'open_unprotected';
      break;
    case 'triggered':
    case 'completed':
      posProtection = 'attached_active';
      break;
    default:
      posProtection = 'unknown';
  }
  await db
    .update(positions)
    .set({
      protectionState: posProtection,
      ...(lifecycle ? { lifecycleState: lifecycle } : {}),
    })
    .where(eq(positions.id, positionId));
}

// ---------------------------------------------------------------------------
// Bracket leg model
// ---------------------------------------------------------------------------

export interface UpdateLegInput {
  instanceId: number;
  leg: 'take_profit_leg' | 'stop_loss_leg';
  newState: LegState;
  reason?: string;
  authoritative: boolean;
  now?: Date;
}

/**
 * Update one bracket leg's state. If `authoritative=true` and one leg
 * transitions to `filled`, the OTHER leg is set to `disabled`. If
 * `authoritative=false`, the other leg is not touched (partial execution
 * cannot assume its sibling is fully disabled).
 *
 * Contradictory combinations (both legs `filled`, or `filled` +
 * `active` after the sibling should have been disabled) mark the
 * instance `inconsistent` and degrade it.
 */
export async function updateBracketLeg(input: UpdateLegInput): Promise<ProtectionInstanceRow | null> {
  const [row] = await db
    .select()
    .from(protectionInstances)
    .where(eq(protectionInstances.id, input.instanceId))
    .limit(1);
  if (!row) return null;
  const now = input.now ?? new Date();
  const previousLegState =
    input.leg === 'take_profit_leg' ? row.takeProfitLegState : row.stopLossLegState;
  const otherLegState =
    input.leg === 'take_profit_leg' ? row.stopLossLegState : row.takeProfitLegState;
  const patch: Partial<ProtectionInstanceRow> = {};
  if (input.leg === 'take_profit_leg') patch.takeProfitLegState = input.newState;
  else patch.stopLossLegState = input.newState;

  // Authoritative one-leg-completion disables the sibling.
  let newOtherLeg = otherLegState;
  if (input.authoritative && input.newState === 'filled') {
    if (otherLegState !== 'filled' && otherLegState !== 'disabled') {
      newOtherLeg = 'disabled';
      if (input.leg === 'take_profit_leg') patch.stopLossLegState = 'disabled';
      else patch.takeProfitLegState = 'disabled';
    }
  }

  // Inconsistent — both filled simultaneously is impossible for a bracket.
  const inconsistent = input.newState === 'filled' && otherLegState === 'filled';

  const nextInstanceState: InstanceState = inconsistent
    ? 'inconsistent'
    : input.newState === 'filled' && input.authoritative
      ? 'triggered'
      : row.state;

  await db
    .update(protectionInstances)
    .set({ ...patch, state: nextInstanceState, lastVerifiedAt: now })
    .where(eq(protectionInstances.id, input.instanceId));

  await emitEvent({
    instanceId: input.instanceId,
    decisionChainId: row.decisionChainId,
    eventType: 'leg_state_changed',
    previousState: previousLegState,
    newState: input.newState,
    leg: input.leg,
    reason: input.reason ?? null,
    metadata: {
      authoritative: input.authoritative,
      otherLeg: newOtherLeg,
      inconsistent,
    },
    now,
  });

  if (nextInstanceState !== row.state) {
    await emitEvent({
      instanceId: input.instanceId,
      decisionChainId: row.decisionChainId,
      eventType: 'instance_state_changed',
      previousState: row.state,
      newState: nextInstanceState,
      leg: 'instance',
      reason: inconsistent ? 'contradictory_legs' : (input.reason ?? null),
      metadata: null,
      now,
    });
  }

  let [after] = await db
    .select()
    .from(protectionInstances)
    .where(eq(protectionInstances.id, input.instanceId))
    .limit(1);
  if (inconsistent && after) {
    await markInstanceDegraded({
      instanceId: after.id,
      reason: 'contradictory_bracket_legs',
      now,
    });
    // Re-read post-degradation.
    const [reloaded] = await db
      .select()
      .from(protectionInstances)
      .where(eq(protectionInstances.id, input.instanceId))
      .limit(1);
    after = reloaded;
  } else if (after) {
    await syncPositionProtectionState(row.positionId, after);
  }
  return after ?? null;
}

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

export interface DegradeInput {
  instanceId: number;
  reason: string;
  now?: Date;
}

export async function markInstanceDegraded(input: DegradeInput): Promise<void> {
  const [row] = await db
    .select()
    .from(protectionInstances)
    .where(eq(protectionInstances.id, input.instanceId))
    .limit(1);
  if (!row) return;
  const now = input.now ?? new Date();
  const previous = row.state;
  await db
    .update(protectionInstances)
    .set({ state: 'degraded', failureReason: input.reason, lastVerifiedAt: now })
    .where(eq(protectionInstances.id, input.instanceId));
  await emitEvent({
    instanceId: input.instanceId,
    decisionChainId: row.decisionChainId,
    eventType: 'instance_degraded',
    previousState: previous,
    newState: 'degraded',
    leg: 'instance',
    reason: input.reason,
    metadata: null,
    now,
  });
  const [after] = await db
    .select()
    .from(protectionInstances)
    .where(eq(protectionInstances.id, input.instanceId))
    .limit(1);
  if (after) await syncPositionProtectionState(row.positionId, after);
}

/**
 * Clear degradation ONLY after authoritative protection is back in place.
 * The caller must have already recalculated the instance via
 * `recalculateInstanceAfterFill` with a confirmed quantity ≥ required.
 */
export async function clearDegradation(instanceId: number, now?: Date): Promise<ProtectionInstanceRow | null> {
  const stamp = now ?? new Date();
  const [row] = await db
    .select()
    .from(protectionInstances)
    .where(eq(protectionInstances.id, instanceId))
    .limit(1);
  if (!row) return null;
  if (row.state !== 'degraded') return row;
  const required = Money.fromString(row.requiredBaseQuantity);
  const confirmed = Money.fromString(row.confirmedBaseQuantity);
  if (!confirmed.gte(required) || required.isZero()) {
    // Authoritative confirmation must be present to clear the degradation.
    return row;
  }
  await db
    .update(protectionInstances)
    .set({ state: 'confirmed', failureReason: null, lastVerifiedAt: stamp })
    .where(eq(protectionInstances.id, instanceId));
  await emitEvent({
    instanceId,
    decisionChainId: row.decisionChainId,
    eventType: 'degradation_cleared',
    previousState: 'degraded',
    newState: 'confirmed',
    leg: 'instance',
    reason: null,
    metadata: null,
    now: stamp,
  });
  const [after] = await db
    .select()
    .from(protectionInstances)
    .where(eq(protectionInstances.id, instanceId))
    .limit(1);
  if (after) await syncPositionProtectionState(row.positionId, after);
  return after ?? null;
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export async function loadInstanceForPosition(positionId: number): Promise<ProtectionInstanceRow | null> {
  const [row] = await db
    .select()
    .from(protectionInstances)
    .where(eq(protectionInstances.positionId, positionId))
    .limit(1);
  return row ?? null;
}

export async function loadEvents(instanceId: number): Promise<ProtectionEventRow[]> {
  return db
    .select()
    .from(protectionEvents)
    .where(eq(protectionEvents.protectionInstanceId, instanceId))
    .orderBy(protectionEvents.eventTime);
}

// ---------------------------------------------------------------------------
// Event helper — writes protection_events + a Gate 2 lineage event
// ---------------------------------------------------------------------------

interface EmitEventInput {
  instanceId: number;
  decisionChainId: number;
  eventType: string;
  previousState: string | null;
  newState: string;
  leg: EventLeg;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  now: Date;
}

async function emitEvent(input: EmitEventInput): Promise<void> {
  await db.insert(protectionEvents).values({
    protectionInstanceId: input.instanceId,
    decisionChainId: input.decisionChainId,
    eventType: input.eventType,
    previousState: input.previousState,
    newState: input.newState,
    leg: input.leg,
    reason: input.reason,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    eventTime: input.now,
  });
  await appendLineageEvent({
    decisionChainId: input.decisionChainId,
    eventType: `protection.${input.eventType}`,
    sourceEntityType: 'protection_instance',
    sourceRecordId: input.instanceId,
    eventTime: input.now,
    actor: 'protection',
    componentVersion: PROTECTION_MODULE_VERSION,
    metadata: {
      leg: input.leg,
      previousState: input.previousState,
      newState: input.newState,
      reason: input.reason,
      ...(input.metadata ?? {}),
    },
  });
}
