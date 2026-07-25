import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db';
import { feeTierSnapshots } from '../src/db/schema';
import { _testOverride } from '../src/env';
import {
  _resetFeeTierCache,
  FEE_TIER_TTL_MS,
  feeTierCacheAgeMs,
  getCurrentFeeTierOrFailClosed,
  getFeeTierSnapshotById,
  refreshFeeTier,
  warmFeeTierCacheFromDb,
} from '../src/trading/feeTier';
import * as coinbase from '../src/trading/coinbase';

/**
 * These tests exercise the fee-tier service against a real DB, but mock the
 * `getTransactionSummary` HTTP call. `_testOverride` flips
 * `coinbaseConfigured=true` so the service takes the live branch even though
 * no real credentials are set.
 */

async function clearFeeTierTable() {
  await db.delete(feeTierSnapshots);
}

describe('feeTier service', () => {
  beforeEach(async () => {
    _resetFeeTierCache();
    await clearFeeTierTable();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    _resetFeeTierCache();
  });

  it('parses a live transaction_summary response into Money-typed rates', async () => {
    const restore = _testOverride({ coinbaseConfigured: true });
    try {
      vi.spyOn(coinbase, 'getTransactionSummary').mockResolvedValue({
        total_volume: 12345.67,
        total_fees: 89.01,
        fee_tier: {
          pricing_tier: 'Advanced 2',
          usd_from: '10000',
          usd_to: '50000',
          maker_fee_rate: '0.0035',
          taker_fee_rate: '0.0055',
        },
      });
      const tier = await refreshFeeTier();
      expect(tier.pricingTier).toBe('Advanced 2');
      expect(tier.makerFeeRate.toDecimalString(4)).toBe('0.0035');
      expect(tier.takerFeeRate.toDecimalString(4)).toBe('0.0055');
      expect(tier.synthetic).toBe(false);

      const persisted = await getFeeTierSnapshotById(tier.snapshotId);
      expect(persisted).not.toBeNull();
      expect(persisted!.pricingTier).toBe('Advanced 2');
    } finally {
      restore();
    }
  });

  it('uses the synthetic conservative tier when Coinbase is not configured', async () => {
    // Explicit override — makes the test robust to test-order leakage from
    // suites that flip `coinbaseConfigured=true`.
    const restore = _testOverride({
      coinbaseConfigured: false,
      coinbaseKeyName: undefined,
      coinbasePrivateKey: undefined,
    });
    try {
      const tier = await refreshFeeTier();
      expect(tier.synthetic).toBe(true);
      expect(tier.takerFeeRate.toDecimalString(4)).toBe('0.0060');
      expect(tier.makerFeeRate.toDecimalString(4)).toBe('0.0040');
    } finally {
      restore();
    }
  });

  it('serves the cached tier without a network call while fresh', async () => {
    const restore = _testOverride({ coinbaseConfigured: true });
    try {
      const spy = vi.spyOn(coinbase, 'getTransactionSummary').mockResolvedValue({
        total_volume: 0,
        total_fees: 0,
        fee_tier: {
          pricing_tier: 'Advanced 1',
          maker_fee_rate: '0.004',
          taker_fee_rate: '0.006',
        },
      });
      await refreshFeeTier(); // populates cache
      expect(spy).toHaveBeenCalledTimes(1);
      // Immediately request again — should hit cache, not network.
      const age = feeTierCacheAgeMs();
      expect(age !== null && age < FEE_TIER_TTL_MS).toBe(true);
      await getCurrentFeeTierOrFailClosed();
      expect(spy).toHaveBeenCalledTimes(1); // still one
    } finally {
      restore();
    }
  });

  it('fails closed when the live fetch errors AND no cache is present', async () => {
    const restore = _testOverride({ coinbaseConfigured: true });
    try {
      vi.spyOn(coinbase, 'getTransactionSummary').mockRejectedValue(
        new Error('coinbase 503'),
      );
      await expect(getCurrentFeeTierOrFailClosed()).rejects.toThrow(
        /Fee tier unavailable/,
      );
    } finally {
      restore();
    }
  });

  it('warms the cache from the most recent DB snapshot', async () => {
    // Seed a row directly.
    await db.insert(feeTierSnapshots).values({
      pricingTier: 'Advanced 3',
      makerFeeRate: '0.00250000',
      takerFeeRate: '0.00450000',
      productType: 'SPOT',
    });
    const warmed = await warmFeeTierCacheFromDb();
    expect(warmed).not.toBeNull();
    expect(warmed!.pricingTier).toBe('Advanced 3');
    expect(warmed!.takerFeeRate.toDecimalString(4)).toBe('0.0045');
  });

  it('rejects a response that is missing fee_tier', async () => {
    const restore = _testOverride({ coinbaseConfigured: true });
    try {
      vi.spyOn(coinbase, 'getTransactionSummary').mockResolvedValue({
        total_volume: 0,
        total_fees: 0,
      });
      await expect(refreshFeeTier()).rejects.toThrow(/missing fee_tier/);
    } finally {
      restore();
    }
  });

  it('rejects an implausible rate (>1)', async () => {
    const restore = _testOverride({ coinbaseConfigured: true });
    try {
      vi.spyOn(coinbase, 'getTransactionSummary').mockResolvedValue({
        fee_tier: {
          pricing_tier: 'Bad',
          maker_fee_rate: '0.004',
          taker_fee_rate: '2.0',
        },
      });
      await expect(refreshFeeTier()).rejects.toThrow(/outside plausible range/);
    } finally {
      restore();
    }
  });
});
