import { vi } from 'vitest';
import type {
  CoinbaseCreateOrderResponse,
  CoinbaseFill,
  CoinbaseOrder,
  CoinbaseProduct,
  CreateOrderResult,
} from '../../src/trading/coinbase';

/**
 * Configurable in-memory Coinbase mock. Tests set the desired outcomes via
 * `mockState`; the exchange module functions read from it.
 */

interface MockOrderRecord {
  order: CoinbaseOrder;
  fills: CoinbaseFill[];
}

export const mockState = {
  ordersByClientId: new Map<string, MockOrderRecord>(),
  ordersByExchangeId: new Map<string, MockOrderRecord>(),
  product: {
    product_id: 'AAVE-USD',
    price: '100',
    volume_24h: '1000000',
    price_percentage_change_24h: '2',
    base_increment: '0.00000001',
    quote_increment: '0.01',
    quote_min_size: '1',
    base_min_size: '0.00000001',
    status: 'online',
  } as CoinbaseProduct,
  // When set to non-null, createOrder throws or returns this instead.
  createOrderBehavior: null as
    | null
    | { type: 'throw_unknown' }
    | { type: 'throw_transport' }
    | { type: 'reject'; reason: string }
    | { type: 'success'; overrideOrderId?: string; fills?: Partial<CoinbaseFill>[] },
  reset() {
    this.ordersByClientId.clear();
    this.ordersByExchangeId.clear();
    this.createOrderBehavior = null;
  },
};

let nextExchangeId = 1000;
function newExchangeId(): string {
  return `cb-${nextExchangeId++}`;
}

// The mocked module — vi.mock at the test-file top wires this up.
export const coinbaseMock = {
  getProduct: vi.fn(async () => mockState.product),

  previewOrder: vi.fn(async () => ({
    order_total: '10',
    commission_total: '0.06',
    errs: [] as string[],
    warning: [] as string[],
  })),

  createOrder: vi.fn(async (intent: { clientOrderId: string; token: string; side: 'BUY' | 'SELL'; quoteSize?: string; baseSize?: string }): Promise<CreateOrderResult> => {
    const behavior = mockState.createOrderBehavior;
    if (behavior?.type === 'throw_unknown') {
      const { CoinbaseError } = await import('../../src/trading/coinbase');
      throw new CoinbaseError({ class: 'unknown', code: 'timeout', message: 'timed out' });
    }
    if (behavior?.type === 'throw_transport') {
      const { CoinbaseError } = await import('../../src/trading/coinbase');
      throw new CoinbaseError({ class: 'retryable_transport', code: 'http_429', message: 'rate limited' });
    }
    if (behavior?.type === 'reject') {
      const raw: CoinbaseCreateOrderResponse = {
        success: false,
        failure_reason: behavior.reason,
        error_response: { new_order_failure_reason: behavior.reason, message: behavior.reason },
      };
      return {
        success: false,
        clientOrderId: intent.clientOrderId,
        failureReason: behavior.reason,
        raw,
      };
    }
    // success
    const exchangeOrderId = behavior?.type === 'success' ? behavior.overrideOrderId ?? newExchangeId() : newExchangeId();
    const raw: CoinbaseCreateOrderResponse = {
      success: true,
      success_response: {
        order_id: exchangeOrderId,
        product_id: `${intent.token}-USD`,
        side: intent.side,
        client_order_id: intent.clientOrderId,
      },
    };
    // Build a default fill matching the intended size.
    const midPrice = Number(mockState.product.price);
    let size: number;
    let commission: number;
    if (intent.side === 'BUY') {
      const quote = Number(intent.quoteSize ?? '0');
      commission = quote * 0.006;
      size = (quote - commission) / midPrice;
    } else {
      size = Number(intent.baseSize ?? '0');
      commission = size * midPrice * 0.006;
    }
    const defaultFills: CoinbaseFill[] = [
      {
        entry_id: `entry-${exchangeOrderId}`,
        trade_id: `trade-${exchangeOrderId}`,
        order_id: exchangeOrderId,
        product_id: `${intent.token}-USD`,
        price: midPrice.toString(),
        size: size.toString(),
        commission: commission.toString(),
        side: intent.side,
        trade_time: new Date().toISOString(),
      },
    ];
    const fillsOverride = behavior?.type === 'success' && behavior.fills
      ? behavior.fills.map((f, i) => ({
          entry_id: f.entry_id ?? `entry-${exchangeOrderId}-${i}`,
          trade_id: f.trade_id ?? `trade-${exchangeOrderId}-${i}`,
          order_id: f.order_id ?? exchangeOrderId,
          product_id: f.product_id ?? `${intent.token}-USD`,
          price: f.price ?? midPrice.toString(),
          size: f.size ?? '0',
          commission: f.commission ?? '0',
          side: f.side ?? intent.side,
          trade_time: f.trade_time ?? new Date().toISOString(),
        }))
      : defaultFills;
    const order: CoinbaseOrder = {
      order_id: exchangeOrderId,
      client_order_id: intent.clientOrderId,
      product_id: `${intent.token}-USD`,
      side: intent.side,
      status: 'FILLED',
      filled_size: fillsOverride.reduce((s, f) => s + Number(f.size), 0).toString(),
      average_filled_price: midPrice.toString(),
      total_fees: fillsOverride.reduce((s, f) => s + Number(f.commission), 0).toString(),
    };
    const record = { order, fills: fillsOverride };
    mockState.ordersByClientId.set(intent.clientOrderId, record);
    mockState.ordersByExchangeId.set(exchangeOrderId, record);
    return {
      success: true,
      exchangeOrderId,
      clientOrderId: intent.clientOrderId,
      raw,
    };
  }),

  getOrder: vi.fn(async (exchangeOrderId: string): Promise<CoinbaseOrder> => {
    const r = mockState.ordersByExchangeId.get(exchangeOrderId);
    if (!r) throw new Error(`getOrder: no record for ${exchangeOrderId}`);
    return r.order;
  }),

  findOrderByClientId: vi.fn(async (clientOrderId: string): Promise<CoinbaseOrder | null> => {
    const r = mockState.ordersByClientId.get(clientOrderId);
    return r ? r.order : null;
  }),

  listFillsForOrder: vi.fn(async (exchangeOrderId: string): Promise<CoinbaseFill[]> => {
    const r = mockState.ordersByExchangeId.get(exchangeOrderId);
    return r ? r.fills : [];
  }),

  getAccounts: vi.fn(async () => []),
  getCashBalance: vi.fn(async () => 10_000),
  cancelOrder: vi.fn(async () => true),
  testConnection: vi.fn(async () => ({ connected: true, message: 'mock' })),

  // Passthroughs — no mocking needed.
  roundToIncrement: (value: number, increment: string): number => {
    const n = Number(increment);
    if (!Number.isFinite(n) || n <= 0) return value;
    const dp = Math.max(0, -Math.floor(Math.log10(n)));
    return Number((Math.floor(value / n) * n).toFixed(dp));
  },
  validateProductForTrading: (p: CoinbaseProduct) => {
    if (p.trading_disabled) throw new Error('trading_disabled');
  },
  normalizeBuyQuoteSize: (p: CoinbaseProduct, v: number) => {
    const rounded = coinbaseMock.roundToIncrement(v, p.quote_increment);
    if (p.quote_min_size && rounded < Number(p.quote_min_size)) {
      const { CoinbaseError } = require('../../src/trading/coinbase');
      throw new CoinbaseError({
        class: 'non_retryable_validation',
        code: 'below_min_quote_size',
        message: `below min ${p.quote_min_size}`,
      });
    }
    return rounded.toString();
  },
  normalizeSellBaseSize: (p: CoinbaseProduct, v: number) => {
    const rounded = coinbaseMock.roundToIncrement(v, p.base_increment);
    if (p.base_min_size && rounded < Number(p.base_min_size)) {
      const { CoinbaseError } = require('../../src/trading/coinbase');
      throw new CoinbaseError({
        class: 'non_retryable_validation',
        code: 'below_min_base_size',
        message: `below min ${p.base_min_size}`,
      });
    }
    return rounded.toString();
  },
};

/** Convenience: reset mocks + call counts + database in one call. */
export async function fullReset(): Promise<void> {
  const { resetDatabase } = await import('./db');
  await resetDatabase();
  mockState.reset();
  for (const fn of Object.values(coinbaseMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as any).mockClear();
  }
}
