import { createHash } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import {
  productHygieneDecisions,
  productQuarantines,
  type ProductHygieneDecisionRow,
  type ProductMetadataObservationRow,
  type ProductQuarantineRow,
} from '../../db/schema';
import type { ProductMetadata } from '../universe/enumerator';

/**
 * Phase 2A §C — Stage 0 hygiene gate.
 *
 * Deterministic classification with an explicit reason code. All
 * exclusions are RECORDED (never deleted) so research can always
 * explain why a product wasn't observed.
 *
 * Categories per §C:
 *   non_spot, unsupported_quote_currency, trading_disabled, cancel_only,
 *   auction_mode, invalid_increment, invalid_minimum_size,
 *   missing_metadata, stale_metadata, insufficient_history,
 *   insufficient_liquidity, abnormal_spread, data_quality_failure,
 *   recent_listing, stablecoin_or_pegged_asset,
 *   leveraged_or_synthetic, duplicate_or_alias_product, manual_quarantine
 *
 * Result: eligible | ineligible | quarantined | insufficient_data.
 */

export const HYGIENE_POLICY_VERSION = 'p2a-hygiene-1';

const SUPPORTED_QUOTE_CURRENCIES = new Set(['USD', 'USDC', 'USDT']);
const STABLECOIN_BASES = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'TUSD', 'USDP', 'GUSD', 'PYUSD']);
// Simple heuristic: leveraged tokens are typically suffixed with 3L, 3S, UP, DOWN.
const LEVERAGED_SUFFIXES = ['3L', '3S', 'UP', 'DOWN', 'BULL', 'BEAR'];
const METADATA_STALE_MS = 24 * 60 * 60 * 1000; // 24h

export interface HygieneInput {
  snapshotId: number;
  now: Date;
  productMetadata: ProductMetadata;
  metadataRow: ProductMetadataObservationRow;
  /**
   * If provided, this seenBefore timestamp is used for the "recent
   * listing" quarantine (< 30 days) — otherwise not applied.
   */
  productFirstSeenAt?: Date;
  minSeenDays?: number;
  /** Manual quarantine wins over automatic eligibility (see §D). */
  activeManualQuarantine?: ProductQuarantineRow | null;
  duplicateOfProductId?: string | null;
}

export type HygieneResult = ProductHygieneDecisionRow['result'];

export interface HygieneDecision {
  row: ProductHygieneDecisionRow;
  result: HygieneResult;
  reasonCodes: string[];
}

export async function evaluateProductHygiene(input: HygieneInput): Promise<HygieneDecision> {
  const reasons: string[] = [];
  const p = input.productMetadata;
  const minSeenDays = input.minSeenDays ?? 30;

  // Manual quarantine wins.
  if (input.activeManualQuarantine) {
    reasons.push('manual_quarantine');
    return await persist('quarantined', reasons, input);
  }

  if (p.productType !== 'SPOT') reasons.push('non_spot');
  if (!SUPPORTED_QUOTE_CURRENCIES.has(p.quoteCurrency)) reasons.push('unsupported_quote_currency');
  if (p.tradingDisabled) reasons.push('trading_disabled');
  if (p.cancelOnly) reasons.push('cancel_only');
  if (p.auctionMode) reasons.push('auction_mode');
  if (!isPositiveDecimal(p.baseIncrement) || !isPositiveDecimal(p.quoteIncrement)) {
    reasons.push('invalid_increment');
  }
  if (!isPositiveDecimal(p.baseMinimum)) reasons.push('invalid_minimum_size');
  const ageMs = input.now.getTime() - input.metadataRow.metadataObservedAt.getTime();
  if (ageMs > METADATA_STALE_MS) reasons.push('stale_metadata');

  // Recent listing quarantine.
  if (input.productFirstSeenAt) {
    const seenMs = input.now.getTime() - input.productFirstSeenAt.getTime();
    if (seenMs < minSeenDays * 24 * 60 * 60 * 1000) reasons.push('recent_listing');
  }

  // Stablecoin / pegged.
  if (STABLECOIN_BASES.has(p.baseCurrency)) reasons.push('stablecoin_or_pegged_asset');
  // Leveraged token detection.
  const base = p.baseCurrency.toUpperCase();
  if (LEVERAGED_SUFFIXES.some((suf) => base.endsWith(suf) && base !== suf)) {
    reasons.push('leveraged_or_synthetic');
  }

  if (input.duplicateOfProductId) reasons.push('duplicate_or_alias_product');

  // Ineligible (structural): non_spot, unsupported_quote_currency, trading_disabled,
  // cancel_only, auction_mode, invalid_increment, invalid_minimum_size,
  // stablecoin_or_pegged_asset, leveraged_or_synthetic.
  const ineligibleReasons = reasons.filter((r) =>
    r === 'non_spot' ||
    r === 'unsupported_quote_currency' ||
    r === 'trading_disabled' ||
    r === 'cancel_only' ||
    r === 'auction_mode' ||
    r === 'invalid_increment' ||
    r === 'invalid_minimum_size' ||
    r === 'stablecoin_or_pegged_asset' ||
    r === 'leveraged_or_synthetic' ||
    r === 'duplicate_or_alias_product',
  );
  const quarantineReasons = reasons.filter((r) =>
    r === 'recent_listing' || r === 'stale_metadata' || r === 'manual_quarantine',
  );

  if (ineligibleReasons.length > 0) return persist('ineligible', reasons, input);
  if (quarantineReasons.length > 0) return persist('quarantined', reasons, input);
  return persist('eligible', reasons, input);
}

async function persist(
  result: HygieneResult,
  reasons: string[],
  input: HygieneInput,
): Promise<HygieneDecision> {
  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        productId: input.productMetadata.productId,
        metadataId: input.metadataRow.id,
        reasons: [...reasons].sort(),
        policy: HYGIENE_POLICY_VERSION,
      }),
    )
    .digest('hex');
  const [{ insertId }] = (await db.insert(productHygieneDecisions).values({
    snapshotId: input.snapshotId,
    productId: input.productMetadata.productId,
    metadataId: input.metadataRow.id,
    result,
    reasonCodes: reasons.length > 0 ? reasons.join(',') : 'ok',
    policyVersion: HYGIENE_POLICY_VERSION,
    inputHash,
    decidedAt: input.now,
    dataAvailableAt: input.metadataRow.metadataAvailableAt,
    reEvaluateAt: result === 'quarantined' ? new Date(input.now.getTime() + 24 * 60 * 60 * 1000) : null,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(productHygieneDecisions)
    .where(eq(productHygieneDecisions.id, insertId))
    .limit(1);
  return { row: row!, result, reasonCodes: reasons };
}

function isPositiveDecimal(s: string): boolean {
  if (!/^-?\d+(\.\d+)?$/.test(s)) return false;
  return Number(s) > 0;
}

// ---------------------------------------------------------------------------
// Quarantine — append-only + manual-override lookup
// ---------------------------------------------------------------------------

export interface RecordQuarantineInput {
  productId: string;
  reasonCode: string;
  reasonDetail?: string | null;
  severity: ProductQuarantineRow['severity'];
  startedAt: Date;
  expiresAt?: Date | null;
  evidenceHash?: string | null;
  manualOverride?: boolean;
}

export async function recordQuarantine(input: RecordQuarantineInput): Promise<ProductQuarantineRow> {
  const [{ insertId }] = (await db.insert(productQuarantines).values({
    productId: input.productId,
    reasonCode: input.reasonCode,
    reasonDetail: input.reasonDetail ?? null,
    severity: input.severity,
    policyVersion: HYGIENE_POLICY_VERSION,
    startedAt: input.startedAt,
    expiresAt: input.expiresAt ?? null,
    evidenceHash: input.evidenceHash ?? null,
    manualOverride: input.manualOverride ?? false,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(productQuarantines)
    .where(eq(productQuarantines.id, insertId))
    .limit(1);
  return row!;
}

export async function clearQuarantine(
  quarantineId: number,
  clearedBy: string,
  now: Date = new Date(),
): Promise<void> {
  // Append-only: we do NOT delete; we mark cleared.
  await db
    .update(productQuarantines)
    .set({ clearedAt: now, clearedBy })
    .where(eq(productQuarantines.id, quarantineId));
}

export async function activeQuarantine(
  productId: string,
  now: Date,
): Promise<ProductQuarantineRow | null> {
  const rows = await db
    .select()
    .from(productQuarantines)
    .where(and(eq(productQuarantines.productId, productId), isNull(productQuarantines.clearedAt)))
    .orderBy(desc(productQuarantines.startedAt));
  for (const q of rows) {
    if (q.expiresAt && q.expiresAt.getTime() < now.getTime()) continue;
    return q;
  }
  return null;
}
