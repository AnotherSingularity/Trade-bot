import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _testOverride } from '../src/env';
import { CoinbaseError, createOrder } from '../src/trading/coinbase';

/**
 * Phase 1 §Q — killswitch is enforced INSIDE the Coinbase client.
 *
 * These tests intentionally do NOT vi.mock the coinbase module — we want the
 * real createOrder to run so we can prove:
 *   1. When ORDER_SUBMISSION_ENABLED=false, no HTTP call to POST /orders occurs
 *      (fetch is spied on to assert this).
 *   2. The thrown error is a CoinbaseError classified `non_retryable_validation`
 *      with code `order_submission_disabled`, so the executor's state machine
 *      never blindly retries it into a real order.
 */

describe('ORDER_SUBMISSION_ENABLED killswitch', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    fetchSpy.mockReset();
    // If any test slips past the killswitch, at least don't hit real Coinbase —
    // reject any accidental fetch with a distinctive error so it's obvious.
    fetchSpy.mockRejectedValue(
      new Error('KILLSWITCH-BYPASSED: real fetch invoked — this must never happen'),
    );
  });
  afterEach(() => {
    fetchSpy.mockReset();
  });

  it('createOrder throws before HTTP when ORDER_SUBMISSION_ENABLED=false', async () => {
    const restore = _testOverride({
      orderSubmissionEnabled: false,
      coinbaseConfigured: true,
      coinbaseKeyName: 'organizations/test/apiKeys/test',
      coinbasePrivateKey: 'unused-in-killswitch-path',
    });
    try {
      const err = await createOrder({
        side: 'BUY',
        token: 'AAVE',
        clientOrderId: 'kill-1',
        quoteSize: '10',
      }).catch((e) => e);
      expect(err).toBeInstanceOf(CoinbaseError);
      expect((err as CoinbaseError).class).toBe('non_retryable_validation');
      expect((err as CoinbaseError).code).toBe('order_submission_disabled');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('killswitch fires even when Coinbase credentials look valid', async () => {
    const restore = _testOverride({
      orderSubmissionEnabled: false,
      coinbaseConfigured: true,
      coinbaseKeyName: 'organizations/test/apiKeys/test',
      coinbasePrivateKey: 'unused-in-killswitch-path',
    });
    try {
      const err = await createOrder({
        side: 'SELL',
        token: 'AAVE',
        clientOrderId: 'kill-2',
        baseSize: '0.001',
      }).catch((e) => e);
      expect(err).toBeInstanceOf(CoinbaseError);
      expect((err as CoinbaseError).code).toBe('order_submission_disabled');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('error message references the flag name so operators can find it', async () => {
    const restore = _testOverride({ orderSubmissionEnabled: false, coinbaseConfigured: true });
    try {
      const err = (await createOrder({
        side: 'BUY',
        token: 'AAVE',
        clientOrderId: 'kill-3',
        quoteSize: '10',
      }).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/ORDER_SUBMISSION_ENABLED/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
