import { createHash, randomUUID } from 'node:crypto';
import { Money } from '@horizon/shared';
import type { PreviewOk } from './preview';

/**
 * Preview → order-intent lineage + config hash (Phase 1.1.b §G).
 *
 * The audit required that the executor consume the EXACT configuration the
 * cost forecast and quantitative-decision layer approved, rather than
 * recomputing sizes from a re-read ticker. This module owns:
 *
 *   1. `NormalizedOrderConfig` — a canonical, dot-quoted-string
 *      representation of every economically material field. Field order is
 *      deterministic; fields are Money-serialised at fixed precision;
 *      whitespace is normalised.
 *   2. `hashOrderConfig(config)` — SHA-256 hex of the JSON-stringified
 *      canonical form. Any change in a material field flips the hash.
 *   3. `deriveApprovedIntent(input)` — assembles the fields the executor
 *      persists on `order_intents` (previewId, decisionId, forecastId,
 *      configHash, normalizedConfig, previewedAt, previewExpiresAt).
 *   4. `verifyApprovedIntent(intent, snapshot)` — re-verifies at submit
 *      time that nothing material changed (product still tradable, hash
 *      matches, preview still fresh, fee tier still valid). Returns a
 *      structured verdict.
 *
 * Preview freshness policy: previews expire after PREVIEW_FRESHNESS_MS.
 * The default (30 seconds) tolerates a single scan cycle's latency but
 * refuses stale approvals from prior cycles.
 */

export const PREVIEW_FRESHNESS_MS = 30_000;
const MONEY_PRECISION = 8;

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'market_ioc' | 'limit' | 'stop_limit' | 'bracket_tp' | 'bracket_sl';
export type TimeInForce = 'IOC' | 'GTC' | 'GTD' | 'FOK';

/**
 * Every field that materially defines the order. Any change here is a
 * material change — the hash MUST flip, and re-preview is required.
 */
export interface NormalizedOrderConfig {
  productId: string;
  side: OrderSide;
  orderType: OrderType;
  timeInForce: TimeInForce;
  // Exactly one of quoteSize / baseSize is populated per side.
  quoteSize: string | null;
  baseSize: string | null;
  limitPrice: string | null;
  stopPrice: string | null;
  estimatedAvgFillPrice: string;
  estimatedCommission: string;
  feeTierPricingTier: string;
  strategyVersion: string;
  costModelVersion: string;
}

/**
 * Serialise the canonical order config to a deterministic JSON string.
 * The field ORDER is fixed by the interface (spread would allow drift).
 */
export function serializeOrderConfig(cfg: NormalizedOrderConfig): string {
  return JSON.stringify({
    productId: cfg.productId,
    side: cfg.side,
    orderType: cfg.orderType,
    timeInForce: cfg.timeInForce,
    quoteSize: cfg.quoteSize,
    baseSize: cfg.baseSize,
    limitPrice: cfg.limitPrice,
    stopPrice: cfg.stopPrice,
    estimatedAvgFillPrice: cfg.estimatedAvgFillPrice,
    estimatedCommission: cfg.estimatedCommission,
    feeTierPricingTier: cfg.feeTierPricingTier,
    strategyVersion: cfg.strategyVersion,
    costModelVersion: cfg.costModelVersion,
  });
}

/** SHA-256 hex of the canonical serialisation. */
export function hashOrderConfig(cfg: NormalizedOrderConfig): string {
  return createHash('sha256').update(serializeOrderConfig(cfg)).digest('hex');
}

/** Generate an opaque previewId (used as the persisted preview identity). */
export function newPreviewId(): string {
  return `prv-${randomUUID()}`;
}

export interface ApprovedIntentInput {
  productId: string;
  side: OrderSide;
  orderType: OrderType;
  timeInForce: TimeInForce;
  requestedQuote: Money | null;
  requestedBase: Money | null;
  limitPrice: Money | null;
  stopPrice: Money | null;
  preview: PreviewOk;
  feeTierPricingTier: string;
  feeTierSnapshotId: number;
  strategyVersion: string;
  costModelVersion: string;
  decisionId: number;
  costForecastId: number;
  now?: Date;
}

export interface ApprovedIntentFields {
  previewId: string;
  decisionId: number;
  costForecastId: number;
  feeTierSnapshotId: number;
  configHash: string;
  previewedAt: Date;
  previewExpiresAt: Date;
  normalizedConfig: string;
  normalized: NormalizedOrderConfig;
}

export function deriveApprovedIntent(input: ApprovedIntentInput): ApprovedIntentFields {
  const now = input.now ?? new Date();
  const normalized: NormalizedOrderConfig = {
    productId: input.productId,
    side: input.side,
    orderType: input.orderType,
    timeInForce: input.timeInForce,
    quoteSize: input.requestedQuote ? input.requestedQuote.toDecimalString(MONEY_PRECISION) : null,
    baseSize: input.requestedBase ? input.requestedBase.toDecimalString(MONEY_PRECISION) : null,
    limitPrice: input.limitPrice ? input.limitPrice.toDecimalString(MONEY_PRECISION) : null,
    stopPrice: input.stopPrice ? input.stopPrice.toDecimalString(MONEY_PRECISION) : null,
    estimatedAvgFillPrice: input.preview.estimatedAvgFillPrice.toDecimalString(MONEY_PRECISION),
    estimatedCommission: input.preview.commissionTotal.toDecimalString(MONEY_PRECISION),
    feeTierPricingTier: input.feeTierPricingTier,
    strategyVersion: input.strategyVersion,
    costModelVersion: input.costModelVersion,
  };
  const configHash = hashOrderConfig(normalized);
  return {
    previewId: newPreviewId(),
    decisionId: input.decisionId,
    costForecastId: input.costForecastId,
    feeTierSnapshotId: input.feeTierSnapshotId,
    configHash,
    previewedAt: now,
    previewExpiresAt: new Date(now.getTime() + PREVIEW_FRESHNESS_MS),
    normalizedConfig: serializeOrderConfig(normalized),
    normalized,
  };
}

// ---------------------------------------------------------------------------
// Re-verification at submit time
// ---------------------------------------------------------------------------

export interface VerifyApprovalSnapshot {
  productTradable: boolean;
  now: Date;
  currentFeeTierPricingTier: string;
  currentMidPrice: Money;
  // Tolerance in basis points on estimatedAvgFillPrice → currentMidPrice drift.
  priceMoveToleranceBps: number;
}

export type VerifyApprovalVerdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'config_hash_mismatch'
        | 'product_not_tradable'
        | 'preview_stale'
        | 'fee_tier_changed'
        | 'price_moved_beyond_tolerance';
      detail: string;
    };

/**
 * Re-verify at hypothetical-submit time that the approved config still
 * describes the current market. ANY failure invalidates the approval and
 * the caller must request a fresh preview + re-decision.
 */
export function verifyApprovedIntent(
  approved: ApprovedIntentFields,
  snapshot: VerifyApprovalSnapshot,
): VerifyApprovalVerdict {
  // 1. Hash — the caller re-hashes what it's about to submit and compares.
  //    If anything about the normalized config was mutated in flight the
  //    hash won't match.
  const rehash = hashOrderConfig(approved.normalized);
  if (rehash !== approved.configHash) {
    return {
      ok: false,
      reason: 'config_hash_mismatch',
      detail: `stored=${approved.configHash.slice(0, 12)}… computed=${rehash.slice(0, 12)}…`,
    };
  }

  if (!snapshot.productTradable) {
    return {
      ok: false,
      reason: 'product_not_tradable',
      detail: `product ${approved.normalized.productId} is not currently tradable`,
    };
  }

  if (snapshot.now.getTime() > approved.previewExpiresAt.getTime()) {
    return {
      ok: false,
      reason: 'preview_stale',
      detail: `previewedAt ${approved.previewedAt.toISOString()} expired at ${approved.previewExpiresAt.toISOString()}, now=${snapshot.now.toISOString()}`,
    };
  }

  if (snapshot.currentFeeTierPricingTier !== approved.normalized.feeTierPricingTier) {
    return {
      ok: false,
      reason: 'fee_tier_changed',
      detail: `approved=${approved.normalized.feeTierPricingTier} current=${snapshot.currentFeeTierPricingTier}`,
    };
  }

  const est = Money.fromString(approved.normalized.estimatedAvgFillPrice);
  if (!est.isZero()) {
    const diffBps = snapshot.currentMidPrice.sub(est).div(est).mul(Money.fromString('10000')).abs();
    if (Number(diffBps.toDecimalString(4)) > snapshot.priceMoveToleranceBps) {
      return {
        ok: false,
        reason: 'price_moved_beyond_tolerance',
        detail: `est=${est.toDecimalString(8)} current=${snapshot.currentMidPrice.toDecimalString(
          8,
        )} drift=${diffBps.toDecimalString(2)}bps > ${snapshot.priceMoveToleranceBps}bps`,
      };
    }
  }

  return { ok: true };
}
