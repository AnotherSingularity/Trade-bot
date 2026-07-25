import { Money } from '@horizon/shared';

/**
 * Dust policy classifier (Phase 1.1 Gate 3A §F).
 *
 * A residual quantity is "dust" ONLY when it is:
 *   - Below the product's `base_min_size` (Coinbase won't accept a further
 *     sell order for it), or
 *   - Below a documented exchange-actionable threshold expressed as N ×
 *     `base_increment`.
 *
 * Never fabricate a sale at the last market price. Dust is RECORDED
 * (dustQuantity + estimated value + reason + policyVersion) and either
 * retained on the position row (dust_residual state) or marked for a
 * future consolidation pass — the policy dictates which.
 */

export const DUST_POLICY_VERSION = 'v1';

/** Reasons a residual is classified as dust — machine-readable + immutable. */
export type DustReason =
  | 'below_base_min_size'
  | 'below_increment_multiplier'
  | 'zero_residual';

/** What we DO with the dust (documented — not silent). */
export type DustPolicyKind =
  | 'retain_unpriced' // dust stays on the position row; not sold, not valued
  | 'mark_for_consolidation' // future batch/consolidation exit path may sweep
  | 'include_as_residual_asset'; // dust is counted as unrealized residual at last-known price

export interface DustClassification {
  isDust: boolean;
  dustReason: DustReason | null;
  policyKind: DustPolicyKind;
  policyVersion: string;
  quantity: Money; // the residual base quantity
  estimatedValue: Money | null; // null when policyKind='retain_unpriced'
}

export interface ClassifyDustInput {
  residualBase: Money;
  baseIncrement: string;
  baseMinSize?: string;
  /** Multiplier of base_increment below which a residual is considered dust. */
  incrementMultiplier?: number;
  /**
   * Last-known price per base unit (Money). Only used to POPULATE the
   * `estimatedValue` field under `include_as_residual_asset` — never to
   * fabricate a synthetic sale.
   */
  lastKnownPrice?: Money;
  policyKind?: DustPolicyKind;
  policyVersion?: string;
}

/**
 * Classify a residual quantity. Pure function.
 */
export function classifyDust(input: ClassifyDustInput): DustClassification {
  const policyKind = input.policyKind ?? 'retain_unpriced';
  const policyVersion = input.policyVersion ?? DUST_POLICY_VERSION;
  const residual = input.residualBase;

  if (!residual.isPositive()) {
    return {
      isDust: true,
      dustReason: 'zero_residual',
      policyKind,
      policyVersion,
      quantity: Money.zero(),
      estimatedValue: Money.zero(),
    };
  }

  const baseIncrement = Money.fromString(input.baseIncrement);
  const multiplier = input.incrementMultiplier ?? 1;
  const incrementCeiling = baseIncrement.mul(Money.fromNumber(multiplier));

  const baseMinSize = input.baseMinSize && input.baseMinSize.length > 0
    ? Money.fromString(input.baseMinSize)
    : null;

  let isDust = false;
  let dustReason: DustReason | null = null;
  if (baseMinSize && !baseMinSize.isZero() && residual.lt(baseMinSize)) {
    isDust = true;
    dustReason = 'below_base_min_size';
  } else if (residual.lte(incrementCeiling)) {
    isDust = true;
    dustReason = 'below_increment_multiplier';
  }

  const estimatedValue =
    policyKind === 'include_as_residual_asset' && input.lastKnownPrice
      ? residual.mul(input.lastKnownPrice)
      : null;

  return {
    isDust,
    dustReason,
    policyKind,
    policyVersion,
    quantity: residual,
    estimatedValue,
  };
}
