import { Money } from '@horizon/shared';
import type { ProtectedConfig } from './configBuilder';
import type { CapabilityState, ProtectionType } from './policy';
import { capabilityStateRank } from './policy';
import type { ProtectionCapabilityRow, ProtectionPolicyVersionRow } from '../../db/schema';

/**
 * Phase 1.1 Gate 3C — capability gate + gap-risk buffers.
 *
 * `evaluateProtectionCapability` is the ONE place that decides whether
 * a specific (product, configuration, operating mode) combination is
 * eligible to run. It NEVER reads env acknowledgement or feature flags:
 * environment cannot override an unsupported or unverified capability.
 *
 * Live-capital eligibility additionally requires:
 *   - `live_canary_validated` capability state
 *   - the configuration's hash matches the validated hash
 *   - required quantity is authoritatively confirmed by the caller
 *   - the caller has run restart-reconstruction + partial-fill handling
 *     + degradation policy (asserted via `preconditionsPassed`)
 *   - a gap-risk policy exists for the product
 *
 * Polling-only protection can authorize simulation and (optionally,
 * with an explicit shadow-mode policy) shadow-live — but NEVER live
 * capital.
 */

export type OperatingMode = 'research' | 'simulation' | 'shadow_live' | 'live_capital';

export type CapabilityDecision = 'authorized' | 'rejected' | 'degraded' | 'unknown';

export interface EvaluateCapabilityInput {
  product: { productId: string };
  configuration: ProtectedConfig;
  operatingMode: OperatingMode;
  policyVersion: ProtectionPolicyVersionRow;
  capability: ProtectionCapabilityRow | null;
  /** Live capital requires the fixture matrix + reconciler flags to have run. */
  preconditionsPassed?: {
    restartReconstruction: boolean;
    partialFillHandling: boolean;
    degradationBehavior: boolean;
  };
  /** Live capital requires an explicit gap-risk policy. */
  gapRiskPolicy?: GapRiskPolicy | null;
  /** True when the configuration's live protected quantity is authoritatively confirmed. */
  requiredQuantityConfirmed?: boolean;
  now?: Date;
}

export interface CapabilityVerdict {
  decision: CapabilityDecision;
  reason: string;
  detail: Record<string, string | number | boolean | null>;
}

/**
 * Configured gap / stop-limit / latency / book-depth buffers.
 * These remain `bufferSource='configured'` until Gate 3D's shadow
 * observations replace them with an empirical distribution.
 *
 * Stop-loss pct is NEVER labeled as a maximum guaranteed loss.
 */
export interface GapRiskPolicy {
  version: string;
  triggerLatencyMs: number;
  stopLimitNonFillProbability: number;
  gapThroughTriggerBps: number;
  partialStopExecutionProbability: number;
  spreadExpansionBps: number;
  bookDepthCollapseProbability: number;
}

export const CONFIGURED_GAP_RISK_POLICY: GapRiskPolicy = {
  version: 'p1g3c-gap-configured-1',
  triggerLatencyMs: 250,
  stopLimitNonFillProbability: 0.05,
  gapThroughTriggerBps: 25,
  partialStopExecutionProbability: 0.02,
  spreadExpansionBps: 15,
  bookDepthCollapseProbability: 0.01,
};

/**
 * The minimum capability state required for each operating mode.
 * Live capital defaults to `live_canary_validated` here; a future
 * gate may lower this once shadow evidence justifies it — but never
 * below `shadow_validated`.
 */
const LIVE_CAPITAL_MIN_STATE: CapabilityState = 'live_canary_validated';
const SHADOW_LIVE_MIN_STATE: CapabilityState = 'shadow_validated';

const NEVER_LIVE_TYPES = new Set<ProtectionType>(['application_polling', 'none']);

export function evaluateProtectionCapability(input: EvaluateCapabilityInput): CapabilityVerdict {
  const config = input.configuration;
  const policy = input.policyVersion;
  const cap = input.capability;

  if (policy.status !== 'active') {
    return verdict('rejected', 'policy_not_active', {
      policyStatus: policy.status,
      policyVersion: policy.version,
    });
  }

  if (!cap) {
    return verdict('unknown', 'no_capability_row', {
      productId: config.productId,
      protectionType: config.protectionType,
    });
  }

  // Stale capability — expiresAt in the past ⇒ fail closed.
  const now = input.now ?? new Date();
  if (cap.expiresAt && cap.expiresAt.getTime() < now.getTime()) {
    return verdict('rejected', 'capability_stale', {
      expiresAt: cap.expiresAt.toISOString(),
    });
  }

  if (cap.capabilityState === 'unsupported' || cap.capabilityState === 'preview_rejected') {
    return verdict('rejected', `capability_${cap.capabilityState}`, {
      capabilityState: cap.capabilityState,
    });
  }
  if (cap.capabilityState === 'temporarily_degraded') {
    return verdict('degraded', 'capability_temporarily_degraded', {
      capabilityState: cap.capabilityState,
    });
  }

  // Live-capital rejection MUST come before the polling-only check
  // (otherwise polling would silently fall through to authorized when
  // mode = shadow_live).
  if (input.operatingMode === 'live_capital') {
    if (NEVER_LIVE_TYPES.has(config.protectionType)) {
      return verdict('rejected', 'live_forbidden_for_protection_type', {
        protectionType: config.protectionType,
      });
    }
    if (capabilityStateRank(cap.capabilityState) < capabilityStateRank(LIVE_CAPITAL_MIN_STATE)) {
      return verdict('rejected', 'insufficient_capability_for_live_capital', {
        required: LIVE_CAPITAL_MIN_STATE,
        actual: cap.capabilityState,
      });
    }
    if (!input.requiredQuantityConfirmed) {
      return verdict('rejected', 'required_quantity_not_confirmed', {});
    }
    const pre = input.preconditionsPassed;
    if (!pre || !pre.restartReconstruction || !pre.partialFillHandling || !pre.degradationBehavior) {
      return verdict('rejected', 'live_preconditions_not_passed', {
        restartReconstruction: pre?.restartReconstruction ?? false,
        partialFillHandling: pre?.partialFillHandling ?? false,
        degradationBehavior: pre?.degradationBehavior ?? false,
      });
    }
    if (!input.gapRiskPolicy) {
      return verdict('rejected', 'gap_risk_policy_required', {});
    }
    return verdict('authorized', 'live_authorized', {
      capabilityState: cap.capabilityState,
    });
  }

  if (input.operatingMode === 'shadow_live') {
    // Polling is allowed under an EXPLICIT shadow policy; the caller
    // signals that policy via `gapRiskPolicy` presence.
    if (config.protectionType === 'application_polling') {
      if (!input.gapRiskPolicy) {
        return verdict('rejected', 'polling_requires_explicit_shadow_policy', {});
      }
      return verdict('authorized', 'polling_shadow_ok', {});
    }
    if (capabilityStateRank(cap.capabilityState) < capabilityStateRank(SHADOW_LIVE_MIN_STATE)) {
      return verdict('rejected', 'insufficient_capability_for_shadow_live', {
        required: SHADOW_LIVE_MIN_STATE,
        actual: cap.capabilityState,
      });
    }
    return verdict('authorized', 'shadow_live_authorized', {
      capabilityState: cap.capabilityState,
    });
  }

  // Simulation / research: accept polling, shadow-validated
  // exchange-native, or explicitly modeled `none` fixtures.
  if (input.operatingMode === 'simulation' || input.operatingMode === 'research') {
    return verdict('authorized', `${input.operatingMode}_authorized`, {
      capabilityState: cap.capabilityState,
    });
  }

  return verdict('unknown', 'unknown_operating_mode', {
    operatingMode: input.operatingMode,
  });
}

function verdict(
  decision: CapabilityDecision,
  reason: string,
  detail: Record<string, string | number | boolean | null>,
): CapabilityVerdict {
  return { decision, reason, detail };
}

/**
 * Compute an adverse-execution estimate for a stop being triggered.
 * Under the configured gap-risk policy, the executed price is the stop
 * trigger price shifted by `gapThroughTriggerBps`. Returned Money is
 * strictly worse than the trigger for the position side.
 *
 * `stop-loss %` is NEVER a maximum guaranteed loss; this estimate makes
 * that explicit — a real gap can be arbitrarily larger and the model
 * DOES NOT claim otherwise.
 */
export function adverseStopExecutionPrice(
  side: 'BUY' | 'SELL',
  stopTriggerPrice: Money,
  policy: GapRiskPolicy = CONFIGURED_GAP_RISK_POLICY,
): Money {
  const shift = Money.fromNumber(policy.gapThroughTriggerBps).div(Money.fromString('10000'));
  const factor = side === 'BUY'
    ? Money.fromString('1').sub(shift) // long stops sell at a WORSE (lower) price
    : Money.fromString('1').add(shift); // short stops buy back at a WORSE (higher) price
  return stopTriggerPrice.mul(factor);
}
