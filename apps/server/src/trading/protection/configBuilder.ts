import { createHash } from 'node:crypto';
import { Money } from '@horizon/shared';
import type { ProtectionPolicyVersionRow } from '../../db/schema';
import type { ProtectionType } from './policy';

/**
 * Phase 1.1 Gate 3C — protection configuration builder.
 *
 * Produces a typed, hashable configuration bound to:
 *   - product / side / entry order type / time-in-force
 *   - the approved preview id + decision chain id
 *   - the active policy version
 *
 * `configurationHash` is a canonical hash of every economic field.
 * Any mutation after approval produces a different hash — used by the
 * capability + validation layers to prove the configuration hasn't
 * silently changed.
 *
 * For attached bracket protection Coinbase's own contract inherits the
 * parent size — the builder deliberately omits any independent
 * `attachedBaseSize` field for this protection type so callers cannot
 * accidentally desynchronize the leg quantity.
 */

export type Side = 'BUY' | 'SELL';

export interface BuildProtectedConfigInput {
  productId: string;
  side: Side;
  entryOrderType: 'market_ioc' | 'limit' | 'stop_limit' | 'bracket_tp' | 'bracket_sl';
  timeInForce: 'IOC' | 'GTC' | 'FOK' | 'GTD';
  protectionType: ProtectionType;
  targetPrice: Money;
  stopTriggerPrice: Money;
  /** Optional stop-limit price. When null, treat as market on trigger. */
  stopLimitPrice?: Money | null;
  entryOrderIntentId: number;
  decisionChainId: number;
  previewId: number;
  policyVersion: ProtectionPolicyVersionRow;
  /** Required base quantity — only set for non-attached protection. */
  independentBaseQuantity?: Money | null;
}

export interface ProtectedConfig {
  productId: string;
  side: Side;
  entryOrderType: string;
  timeInForce: string;
  protectionType: ProtectionType;
  targetPrice: Money;
  stopTriggerPrice: Money;
  stopLimitPrice: Money | null;
  entryOrderIntentId: number;
  decisionChainId: number;
  previewId: number;
  policyVersionId: number;
  policyVersion: string;
  /** For attached protection this is ALWAYS null (inherited from parent). */
  independentBaseQuantity: Money | null;
  configurationHash: string;
}

export type BuildResult =
  | { ok: true; config: ProtectedConfig }
  | { ok: false; reason: BuildRejectReason; detail: string };

export type BuildRejectReason =
  | 'inverted_target_stop'
  | 'unsupported_side'
  | 'unsupported_product'
  | 'unsupported_time_in_force'
  | 'missing_trigger'
  | 'attached_size_forbidden'
  | 'independent_size_required'
  | 'quantity_mismatch'
  | 'stale_policy'
  | 'unverified_capability';

const SUPPORTED_TIF = new Set(['IOC', 'GTC', 'FOK', 'GTD']);

export function buildProtectedConfig(input: BuildProtectedConfigInput): BuildResult {
  if (!input.productId || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(input.productId)) {
    return { ok: false, reason: 'unsupported_product', detail: input.productId };
  }
  if (input.side !== 'BUY' && input.side !== 'SELL') {
    return { ok: false, reason: 'unsupported_side', detail: input.side };
  }
  if (!SUPPORTED_TIF.has(input.timeInForce)) {
    return { ok: false, reason: 'unsupported_time_in_force', detail: input.timeInForce };
  }
  if (!input.targetPrice || !input.stopTriggerPrice) {
    return { ok: false, reason: 'missing_trigger', detail: 'target/stop required' };
  }

  if (input.side === 'BUY') {
    if (!input.targetPrice.gt(input.stopTriggerPrice)) {
      return {
        ok: false,
        reason: 'inverted_target_stop',
        detail: `long: target ${input.targetPrice.toDecimalString(8)} must be > stop ${input.stopTriggerPrice.toDecimalString(8)}`,
      };
    }
  } else {
    if (!input.targetPrice.lt(input.stopTriggerPrice)) {
      return {
        ok: false,
        reason: 'inverted_target_stop',
        detail: `short: target ${input.targetPrice.toDecimalString(8)} must be < stop ${input.stopTriggerPrice.toDecimalString(8)}`,
      };
    }
  }

  const attached = input.protectionType === 'attached_trigger_bracket_gtc';
  if (attached && input.independentBaseQuantity != null) {
    return {
      ok: false,
      reason: 'attached_size_forbidden',
      detail: 'attached bracket inherits parent size; do not set independentBaseQuantity',
    };
  }
  if (!attached && input.protectionType !== 'application_polling' && input.protectionType !== 'none') {
    if (input.independentBaseQuantity == null) {
      return {
        ok: false,
        reason: 'independent_size_required',
        detail: `${input.protectionType} requires independentBaseQuantity`,
      };
    }
  }

  if (input.policyVersion.status !== 'active') {
    return { ok: false, reason: 'stale_policy', detail: `policy ${input.policyVersion.version} status=${input.policyVersion.status}` };
  }

  const config: ProtectedConfig = {
    productId: input.productId,
    side: input.side,
    entryOrderType: input.entryOrderType,
    timeInForce: input.timeInForce,
    protectionType: input.protectionType,
    targetPrice: input.targetPrice,
    stopTriggerPrice: input.stopTriggerPrice,
    stopLimitPrice: input.stopLimitPrice ?? null,
    entryOrderIntentId: input.entryOrderIntentId,
    decisionChainId: input.decisionChainId,
    previewId: input.previewId,
    policyVersionId: input.policyVersion.id,
    policyVersion: input.policyVersion.version,
    independentBaseQuantity: attached ? null : input.independentBaseQuantity ?? null,
    configurationHash: '',
  };
  config.configurationHash = hashConfiguration(config);
  return { ok: true, config };
}

/** Canonicalize + hash. Sorted keys, exact decimal strings. */
export function hashConfiguration(config: Omit<ProtectedConfig, 'configurationHash'>): string {
  const canonical = {
    productId: config.productId,
    side: config.side,
    entryOrderType: config.entryOrderType,
    timeInForce: config.timeInForce,
    protectionType: config.protectionType,
    targetPrice: config.targetPrice.toDecimalString(8),
    stopTriggerPrice: config.stopTriggerPrice.toDecimalString(8),
    stopLimitPrice: config.stopLimitPrice ? config.stopLimitPrice.toDecimalString(8) : null,
    entryOrderIntentId: config.entryOrderIntentId,
    decisionChainId: config.decisionChainId,
    previewId: config.previewId,
    policyVersionId: config.policyVersionId,
    policyVersion: config.policyVersion,
    independentBaseQuantity: config.independentBaseQuantity
      ? config.independentBaseQuantity.toDecimalString(8)
      : null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
