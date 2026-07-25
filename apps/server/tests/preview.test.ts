import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Money } from '@horizon/shared';
import { _testOverride } from '../src/env';
import { previewCandidate } from '../src/trading/preview';
import * as coinbase from '../src/trading/coinbase';
import type { MarketOrderIntent } from '../src/trading/coinbase';

const INTENT: MarketOrderIntent = {
  side: 'BUY',
  token: 'AAVE',
  clientOrderId: 'p-1',
  quoteSize: '500',
};

const OK_RESPONSE = {
  order_total: '500.00',
  commission_total: '3.00',
  best_bid: '99.90',
  best_ask: '100.10',
  average_filled_price: '100.05',
  base_size: '4.997',
  quote_size: '500',
} as const;

describe('previewCandidate', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('happy path — returns typed PreviewOk with Money fields', async () => {
    const restore = _testOverride({ coinbaseConfigured: true });
    try {
      vi.spyOn(coinbase, 'previewOrder').mockResolvedValue(OK_RESPONSE);
      const r = await previewCandidate({
        intent: INTENT,
        arrivalMid: Money.fromString('100'),
        takerRate: Money.fromString('0.006'),
      });
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') throw new Error();
      expect(r.synthetic).toBe(false);
      expect(r.commissionTotal.toDecimalString(2)).toBe('3.00');
      expect(r.estimatedAvgFillPrice.toDecimalString(2)).toBe('100.05');
      expect(r.bestBid?.toDecimalString(2)).toBe('99.90');
      expect(r.bestAsk?.toDecimalString(2)).toBe('100.10');
    } finally {
      restore();
    }
  });

  it('rejects when Coinbase populates errs[]', async () => {
    const restore = _testOverride({ coinbaseConfigured: true });
    try {
      vi.spyOn(coinbase, 'previewOrder').mockResolvedValue({
        ...OK_RESPONSE,
        errs: ['insufficient_funds'],
      });
      const r = await previewCandidate({
        intent: INTENT,
        arrivalMid: Money.fromString('100'),
        takerRate: Money.fromString('0.006'),
      });
      expect(r.status).toBe('rejected');
      if (r.status !== 'rejected') throw new Error();
      expect(r.reason).toBe('preview_failure');
      expect(r.detail).toMatch(/insufficient_funds/);
    } finally {
      restore();
    }
  });

  it('rejects when preview_failure_reason is set', async () => {
    const restore = _testOverride({ coinbaseConfigured: true });
    try {
      vi.spyOn(coinbase, 'previewOrder').mockResolvedValue({
        ...OK_RESPONSE,
        preview_failure_reason: 'preview_missing_commission',
      });
      const r = await previewCandidate({
        intent: INTENT,
        arrivalMid: Money.fromString('100'),
        takerRate: Money.fromString('0.006'),
      });
      expect(r.status).toBe('rejected');
    } finally {
      restore();
    }
  });

  it('rejects on any populated warning[] (strict by default)', async () => {
    const restore = _testOverride({ coinbaseConfigured: true });
    try {
      vi.spyOn(coinbase, 'previewOrder').mockResolvedValue({
        ...OK_RESPONSE,
        warning: ['This trade is likely to affect market price'],
      });
      const r = await previewCandidate({
        intent: INTENT,
        arrivalMid: Money.fromString('100'),
        takerRate: Money.fromString('0.006'),
      });
      expect(r.status).toBe('rejected');
      if (r.status !== 'rejected') throw new Error();
      expect(r.reason).toBe('preview_warning');
    } finally {
      restore();
    }
  });

  it('rejects when commission_total is missing', async () => {
    const restore = _testOverride({ coinbaseConfigured: true });
    try {
      vi.spyOn(coinbase, 'previewOrder').mockResolvedValue({
        ...OK_RESPONSE,
        commission_total: undefined,
      });
      const r = await previewCandidate({
        intent: INTENT,
        arrivalMid: Money.fromString('100'),
        takerRate: Money.fromString('0.006'),
      });
      expect(r.status).toBe('rejected');
      if (r.status !== 'rejected') throw new Error();
      expect(r.reason).toBe('missing_commission');
    } finally {
      restore();
    }
  });

  it('falls back to bid/ask midpoint when average_filled_price is missing', async () => {
    const restore = _testOverride({ coinbaseConfigured: true });
    try {
      vi.spyOn(coinbase, 'previewOrder').mockResolvedValue({
        ...OK_RESPONSE,
        average_filled_price: undefined,
      });
      const r = await previewCandidate({
        intent: INTENT,
        arrivalMid: Money.fromString('100'),
        takerRate: Money.fromString('0.006'),
      });
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') throw new Error();
      // Mid of 99.90 / 100.10 = 100.00
      expect(r.estimatedAvgFillPrice.toDecimalString(2)).toBe('100.00');
    } finally {
      restore();
    }
  });

  it('classifies a raised network error as preview_error', async () => {
    const restore = _testOverride({ coinbaseConfigured: true });
    try {
      vi.spyOn(coinbase, 'previewOrder').mockRejectedValue(new Error('network 504'));
      const r = await previewCandidate({
        intent: INTENT,
        arrivalMid: Money.fromString('100'),
        takerRate: Money.fromString('0.006'),
      });
      expect(r.status).toBe('rejected');
      if (r.status !== 'rejected') throw new Error();
      expect(r.reason).toBe('preview_error');
      expect(r.detail).toMatch(/network 504/);
    } finally {
      restore();
    }
  });

  it('synthetic path when Coinbase not configured', async () => {
    const restore = _testOverride({
      coinbaseConfigured: false,
      coinbaseKeyName: undefined,
      coinbasePrivateKey: undefined,
    });
    try {
      const r = await previewCandidate({
        intent: { ...INTENT, quoteSize: '1000' },
        arrivalMid: Money.fromString('50'),
        takerRate: Money.fromString('0.006'),
      });
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') throw new Error();
      expect(r.synthetic).toBe(true);
      // Synthetic commission = 1000 * 0.006 = 6.00
      expect(r.commissionTotal.toDecimalString(2)).toBe('6.00');
      // Synthetic est-fill = arrival mid
      expect(r.estimatedAvgFillPrice.toDecimalString(2)).toBe('50.00');
    } finally {
      restore();
    }
  });
});
