import { describe, it, expect } from 'vitest';
import { Money } from '@horizon/shared';
import type { CoinbaseCreateOrderResponse } from '../src/trading/coinbase';
import {
  CoinbaseError,
  roundToIncrement,
  decimalDigitsForIncrement,
  normalizeBuyQuoteSize,
  normalizeSellBaseSize,
  validateProductForTrading,
  type CoinbaseProduct,
} from '../src/trading/coinbase';

/**
 * These tests exercise the Coinbase response parsing and product-validation
 * helpers against exact fixture payloads. They do NOT make network calls.
 */

const product: CoinbaseProduct = {
  product_id: 'AAVE-USD',
  price: '100',
  volume_24h: '1000000',
  price_percentage_change_24h: '2',
  base_increment: '0.001',
  quote_increment: '0.01',
  quote_min_size: '1',
  quote_max_size: '1000000',
  base_min_size: '0.001',
  base_max_size: '1000',
  status: 'online',
};

describe('response fixtures', () => {
  it('nested success_response.order_id is the canonical field (top-level may be absent)', () => {
    const raw: CoinbaseCreateOrderResponse = {
      success: true,
      success_response: {
        order_id: 'CBORDER-123',
        product_id: 'AAVE-USD',
        side: 'BUY',
        client_order_id: 'hzn-abc',
      },
    };
    // Simulate the reading logic used in createOrder():
    const orderId = raw.success_response?.order_id ?? raw.order_id;
    expect(orderId).toBe('CBORDER-123');
    // Confirm the OLD bug behavior: reading top-level would have returned undefined.
    expect(raw.order_id).toBeUndefined();
  });

  it('rejected order surfaces new_order_failure_reason', () => {
    const raw: CoinbaseCreateOrderResponse = {
      success: false,
      failure_reason: 'INSUFFICIENT_FUND',
      error_response: {
        error: 'INSUFFICIENT_FUND',
        message: 'Insufficient funds',
        new_order_failure_reason: 'INSUFFICIENT_FUND',
      },
    };
    const reason =
      raw.error_response?.new_order_failure_reason ??
      raw.error_response?.preview_failure_reason ??
      raw.error_response?.message ??
      raw.failure_reason ??
      'unknown';
    expect(reason).toBe('INSUFFICIENT_FUND');
  });
});

describe('roundToIncrement (Money, decimal-safe)', () => {
  it('rounds DOWN to the increment — exact, no float drift', () => {
    expect(roundToIncrement(Money.fromString('1.234'), '0.01').toDecimalString(2)).toBe('1.23');
    expect(roundToIncrement(Money.fromString('1.239'), '0.01').toDecimalString(2)).toBe('1.23');
    // The classic float trap: 0.10000001 must round DOWN to 0.10, not up.
    expect(roundToIncrement(Money.fromString('0.10000001'), '0.01').toDecimalString(2)).toBe(
      '0.10',
    );
    // 8-decimal precision preserved.
    expect(roundToIncrement(Money.fromString('0.00000567'), '0.00000001').toDecimalString(8)).toBe(
      '0.00000567',
    );
  });
  it('rounds down for negative sizes (toward zero, never magnifying)', () => {
    expect(roundToIncrement(Money.fromString('-1.237'), '0.01').toDecimalString(2)).toBe('-1.23');
  });
  it('is a no-op for invalid or zero increment', () => {
    expect(roundToIncrement(Money.fromString('5'), '0').toDecimalString(2)).toBe('5.00');
    // The empty-string case represents "no increment configured".
    expect(roundToIncrement(Money.fromString('5'), '').toDecimalString(2)).toBe('5.00');
  });
});

describe('decimalDigitsForIncrement', () => {
  it('derives digit count from the increment string', () => {
    expect(decimalDigitsForIncrement('0.01')).toBe(2);
    expect(decimalDigitsForIncrement('0.00000001')).toBe(8);
    expect(decimalDigitsForIncrement('1')).toBe(0);
    expect(decimalDigitsForIncrement('0.100')).toBe(1); // trailing zeros trimmed
  });
});

describe('validateProductForTrading', () => {
  it('accepts online products', () => {
    expect(() => validateProductForTrading(product)).not.toThrow();
  });
  it('rejects trading_disabled', () => {
    expect(() => validateProductForTrading({ ...product, trading_disabled: true })).toThrow(CoinbaseError);
  });
  it('rejects cancel_only', () => {
    expect(() => validateProductForTrading({ ...product, cancel_only: true })).toThrow(CoinbaseError);
  });
  it('rejects non-online status', () => {
    expect(() => validateProductForTrading({ ...product, status: 'offline' })).toThrow(CoinbaseError);
  });
});

describe('size validation + increment rounding (Money-native)', () => {
  it('rounds a BUY quote to the increment and returns the exchange-shaped string', () => {
    expect(normalizeBuyQuoteSize(product, Money.fromString('12.3456'))).toBe('12.34');
  });
  it('rejects a BUY quote below the min_size', () => {
    expect(() =>
      normalizeBuyQuoteSize({ ...product, quote_min_size: '10' }, Money.fromString('5')),
    ).toThrow(CoinbaseError);
  });
  it('rejects a BUY quote above the max_size', () => {
    expect(() =>
      normalizeBuyQuoteSize({ ...product, quote_max_size: '100' }, Money.fromString('1000')),
    ).toThrow(CoinbaseError);
  });
  it('rounds a SELL base to the base_increment', () => {
    expect(normalizeSellBaseSize(product, Money.fromString('1.2345'))).toBe('1.234');
  });
  it('rejects a SELL base below min_size', () => {
    expect(() =>
      normalizeSellBaseSize({ ...product, base_min_size: '1' }, Money.fromString('0.5')),
    ).toThrow(CoinbaseError);
  });
});
