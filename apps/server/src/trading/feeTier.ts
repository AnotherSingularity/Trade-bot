import { Money } from '@horizon/shared';
import { db } from '../db';
import { feeTierSnapshots } from '../db/schema';
// NOTE: intentionally imported as a namespace so `vi.spyOn(coinbase, ...)` in
// tests can intercept `getTransactionSummary` — ES-module named imports are
// immutable references and cannot be spy-replaced.
import * as coinbase from './coinbase';
import type { CoinbaseTransactionSummary } from './coinbase';
import { ENV } from '../env';
import { logActivity } from '../db/queries';
import { eq, desc } from 'drizzle-orm';

/**
 * Coinbase fee-tier service (Phase 1 §A).
 *
 * Design:
 *   • The authenticated account is the source of truth for maker/taker rates.
 *     Coinbase's public help page is NOT authoritative — rates depend on the
 *     caller's trailing 30-day USD volume tier.
 *   • Rates are cached in-process for FEE_TIER_TTL_MS.
 *   • Every successful fetch is persisted to `fee_tier_snapshots` — cost
 *     forecasts store the snapshot id they used so alpha attribution and
 *     realized-vs-forecast reconciliation are unambiguous.
 *   • Callers that need the current tier for a real decision use
 *     `getCurrentFeeTierOrFailClosed()`. It refreshes on demand and, if it
 *     cannot obtain a fresh reading, THROWS — the whole point is to fail
 *     closed rather than silently trade against stale fees.
 *   • Under DRY_RUN with Coinbase not configured, a synthetic conservative
 *     tier is used (marked `synthetic: true` in the snapshot) so the pipeline
 *     can be exercised end-to-end in tests / demos.
 */

export const FEE_TIER_TTL_MS = 60 * 60 * 1000; // 1 hour per §A
export const FEE_TIER_MAX_STALENESS_MS = 3 * 60 * 60 * 1000; // 3h hard cap

const SYNTHETIC_PRICING_TIER = 'synthetic-conservative';
/** Conservative synthetic rates (public Advanced 1 tier upper bound at rollout). */
const SYNTHETIC_TAKER_RATE = '0.006';
const SYNTHETIC_MAKER_RATE = '0.004';

export interface FeeTierCurrent {
  snapshotId: number;
  pricingTier: string;
  makerFeeRate: Money;
  takerFeeRate: Money;
  fetchedAt: Date;
  synthetic: boolean;
}

interface CacheEntry {
  fetchedAt: number;
  current: FeeTierCurrent;
}

let cache: CacheEntry | null = null;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseRate(value: string | undefined, field: string): Money {
  if (value === undefined || value === null || value === '') {
    throw new Error(`fee tier missing required field ${field}`);
  }
  const m = Money.fromString(value);
  if (m.isNegative() || m.gt(Money.fromString('1'))) {
    throw new Error(`fee tier ${field}=${value} outside plausible range (0..1)`);
  }
  return m;
}

function parseTransactionSummary(raw: CoinbaseTransactionSummary): {
  pricingTier: string;
  makerFeeRate: Money;
  takerFeeRate: Money;
  usdVolume30d: Money | null;
  usdFees30d: Money | null;
  usdFromVolume: Money | null;
  usdToVolume: Money | null;
} {
  const tier = raw.fee_tier;
  if (!tier) throw new Error('transaction_summary missing fee_tier');
  return {
    pricingTier: tier.pricing_tier ?? 'unknown',
    makerFeeRate: parseRate(tier.maker_fee_rate, 'maker_fee_rate'),
    takerFeeRate: parseRate(tier.taker_fee_rate, 'taker_fee_rate'),
    usdVolume30d:
      raw.total_volume !== undefined ? Money.fromString(String(raw.total_volume)) : null,
    usdFees30d: raw.total_fees !== undefined ? Money.fromString(String(raw.total_fees)) : null,
    usdFromVolume: tier.usd_from ? Money.fromString(tier.usd_from) : null,
    usdToVolume: tier.usd_to ? Money.fromString(tier.usd_to) : null,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistSnapshot(
  parsed: ReturnType<typeof parseTransactionSummary>,
  raw: CoinbaseTransactionSummary | { synthetic: true },
  synthetic: boolean,
): Promise<{ id: number; fetchedAt: Date }> {
  const fetchedAt = new Date();
  const result = await db.insert(feeTierSnapshots).values({
    pricingTier: parsed.pricingTier,
    makerFeeRate: parsed.makerFeeRate.toDecimalString(),
    takerFeeRate: parsed.takerFeeRate.toDecimalString(),
    usdVolume30d: parsed.usdVolume30d?.toDecimalString() ?? null,
    usdFees30d: parsed.usdFees30d?.toDecimalString() ?? null,
    usdFromVolume: parsed.usdFromVolume?.toDecimalString() ?? null,
    usdToVolume: parsed.usdToVolume?.toDecimalString() ?? null,
    productType: 'SPOT',
    fetchedAt,
    rawResponse: synthetic ? { synthetic: true } : (raw as unknown as Record<string, unknown>),
  });
  const id = (result as unknown as { insertId: number }[])[0]?.insertId ?? 0;
  return { id, fetchedAt };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Force a fresh fetch, ignoring the cache. Under DRY_RUN + no Coinbase
 * credentials, records a synthetic conservative snapshot instead.
 */
export async function refreshFeeTier(): Promise<FeeTierCurrent> {
  let current: FeeTierCurrent;
  if (!ENV.coinbaseConfigured) {
    const parsed = parseTransactionSummary({
      fee_tier: {
        pricing_tier: SYNTHETIC_PRICING_TIER,
        maker_fee_rate: SYNTHETIC_MAKER_RATE,
        taker_fee_rate: SYNTHETIC_TAKER_RATE,
      },
    });
    const { id, fetchedAt } = await persistSnapshot(parsed, { synthetic: true }, true);
    current = {
      snapshotId: id,
      pricingTier: parsed.pricingTier,
      makerFeeRate: parsed.makerFeeRate,
      takerFeeRate: parsed.takerFeeRate,
      fetchedAt,
      synthetic: true,
    };
  } else {
    const raw = await coinbase.getTransactionSummary('SPOT');
    const parsed = parseTransactionSummary(raw);
    const { id, fetchedAt } = await persistSnapshot(parsed, raw, false);
    current = {
      snapshotId: id,
      pricingTier: parsed.pricingTier,
      makerFeeRate: parsed.makerFeeRate,
      takerFeeRate: parsed.takerFeeRate,
      fetchedAt,
      synthetic: false,
    };
  }
  cache = { fetchedAt: Date.now(), current };
  return current;
}

/**
 * Cache-aware getter. Returns the cached tier if fresh; otherwise refreshes.
 * Never fails silently — throws when neither a fresh live fetch nor a recent
 * cached value is available.
 */
export async function getCurrentFeeTierOrFailClosed(): Promise<FeeTierCurrent> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < FEE_TIER_TTL_MS) {
    return cache.current;
  }
  try {
    return await refreshFeeTier();
  } catch (err) {
    // Live fetch failed — see whether a cached value is still within the
    // hard staleness limit. If so, log and reuse. Otherwise fail closed.
    if (cache && now - cache.fetchedAt < FEE_TIER_MAX_STALENESS_MS) {
      await logActivity({
        type: 'system',
        action: 'FEE_TIER_STALE',
        severity: 'warn',
        detail: `Fee-tier refresh failed; reusing cached (${(
          (now - cache.fetchedAt) /
          60_000
        ).toFixed(1)}m old). Error: ${err instanceof Error ? err.message : String(err)}`,
      });
      return cache.current;
    }
    await logActivity({
      type: 'system',
      action: 'FEE_TIER_UNAVAILABLE',
      severity: 'critical',
      detail: `Fee tier unavailable and no fresh cache. New entries will be blocked. Error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    throw new Error(
      `Fee tier unavailable (no fresh live value, no acceptable cache): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Loads the most recently persisted snapshot from the DB. Used by the
 * reconciler / startup path to warm the cache before the first scan without
 * requiring a live call.
 */
export async function warmFeeTierCacheFromDb(): Promise<FeeTierCurrent | null> {
  const rows = await db
    .select()
    .from(feeTierSnapshots)
    .orderBy(desc(feeTierSnapshots.fetchedAt))
    .limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];
  const current: FeeTierCurrent = {
    snapshotId: r.id,
    pricingTier: r.pricingTier,
    makerFeeRate: Money.fromString(r.makerFeeRate),
    takerFeeRate: Money.fromString(r.takerFeeRate),
    fetchedAt: r.fetchedAt,
    synthetic: r.pricingTier === SYNTHETIC_PRICING_TIER,
  };
  cache = { fetchedAt: r.fetchedAt.getTime(), current };
  return current;
}

/** Test hook: clear the in-process cache. */
export function _resetFeeTierCache(): void {
  cache = null;
}

/** Diagnostic — how old is our cached value? */
export function feeTierCacheAgeMs(): number | null {
  return cache ? Date.now() - cache.fetchedAt : null;
}

/** Fetch by explicit id (for cost-forecast round-tripping). */
export async function getFeeTierSnapshotById(id: number): Promise<FeeTierCurrent | null> {
  const rows = await db
    .select()
    .from(feeTierSnapshots)
    .where(eq(feeTierSnapshots.id, id))
    .limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    snapshotId: r.id,
    pricingTier: r.pricingTier,
    makerFeeRate: Money.fromString(r.makerFeeRate),
    takerFeeRate: Money.fromString(r.takerFeeRate),
    fetchedAt: r.fetchedAt,
    synthetic: r.pricingTier === SYNTHETIC_PRICING_TIER,
  };
}
