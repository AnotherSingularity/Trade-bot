/**
 * Phase 2D §B — Abstract market-depth provider.
 *
 * The provider interface is deliberately generic so:
 *   - Deterministic fixtures can drive tests.
 *   - Recorded replay can drive research.
 *   - A future production Coinbase Level 2 stream can plug in later.
 *
 * Every event carries observation, receipt and availability timestamps
 * plus provider identity so consumers can enforce the honesty barrier.
 *
 * Phase 2D DOES NOT connect a real production provider.
 */

export type MarketDepthEventKind = 'snapshot' | 'delta' | 'trade' | 'heartbeat' | 'gap';

export interface MarketDepthLevel {
  side: 'bid' | 'ask';
  price: string;
  size: string;
}

export interface MarketDepthEvent {
  kind: MarketDepthEventKind;
  sequence: number;
  productId: string;
  sourceTimestamp: Date;
  receivedAt: Date;
  dataAvailableAt: Date;
  levels?: MarketDepthLevel[];
  trade?: {
    price: string;
    size: string;
    side: 'buyer_initiated' | 'seller_initiated' | 'unknown';
  };
  payloadHash: string;
}

export interface MarketDepthProvider {
  providerId: string;
  providerVersion: string;
  productId: string;
  events(): Iterable<MarketDepthEvent>;
}

/**
 * Test-only fixture provider — returns a static list of pre-computed
 * events. Callers pass a canonical, deterministic list; the provider
 * does not derive timestamps from the wall clock.
 */
export class FixtureMarketDepthProvider implements MarketDepthProvider {
  readonly providerId = 'FixtureMarketDepthProvider';
  readonly providerVersion = 'p2d-fixture-1';
  constructor(
    readonly productId: string,
    private readonly items: readonly MarketDepthEvent[],
  ) {}
  events(): Iterable<MarketDepthEvent> {
    return this.items;
  }
}

/**
 * Deferred production provider placeholder. This exists so operators
 * can see it in the audit surface — it MUST NOT be constructed or
 * used until the operational track authorizes it (post-freeze).
 */
export class DeferredProductionMarketDepthProvider implements MarketDepthProvider {
  readonly providerId = 'DeferredProductionMarketDepthProvider';
  readonly providerVersion = 'deferred-until-operator-approval';
  constructor(readonly productId: string) {
    throw new Error(
      'DeferredProductionMarketDepthProvider is intentionally not implemented in Phase 2D. Enabling it requires operator approval and the post-freeze operational sequence.',
    );
  }
  events(): Iterable<MarketDepthEvent> {
    throw new Error('unreachable');
  }
}
