import { db } from '../db';
import { adapterSelections, type AdapterSelectionRow } from '../db/schema';
import { CoinbaseAdvancedTradeStreamProvider } from './coinbaseAdapter';
import { CoinbasePublicRestClient } from './coinbaseRest';
import type { MarketDataRestClient } from './bootstrap';
import type { WebSocketProvider } from './streams';
import { InMemoryRestClient } from './bootstrap';
import { MockWebSocketProvider } from './streams';

/**
 * Phase 1.2-OPS §A — provider-selection factory + audit.
 *
 * The soak runner MUST call `selectProviders({intent: 'soak'})` — this
 * factory:
 *   1. Constructs the concrete providers per env.
 *   2. Writes an `adapter_selections` audit row.
 *   3. REFUSES to return providers with `isProduction=true` if a mock
 *      was chosen. The runner rejects a `preflight → running`
 *      transition based on that flag.
 *
 * A mock provider is chosen ONLY when the caller passes `intent:'test'`.
 */

export const PROVIDER_FACTORY_VERSION = 'p1_2-ops-factory-1';

export interface SelectedProviders {
  webSocket: WebSocketProvider;
  rest: MarketDataRestClient;
  webSocketProviderName: string;
  restClientName: string;
  authClientName: string;
  redisClientName: string;
  dbDriverName: string;
  isProduction: boolean;
  soakEligible: boolean;
  refusedReason: string | null;
}

export interface SelectProvidersInput {
  intent: 'soak' | 'test' | 'diagnostic';
  soakRunId?: string | null;
  now?: Date;
  /** For tests: override the underlying providers. */
  testOverride?: {
    webSocket?: WebSocketProvider;
    rest?: MarketDataRestClient;
  };
}

export async function selectProviders(input: SelectProvidersInput): Promise<SelectedProviders> {
  const now = input.now ?? new Date();
  let webSocket: WebSocketProvider;
  let rest: MarketDataRestClient;
  let webSocketProviderName: string;
  let restClientName: string;
  let isProduction: boolean;

  if (input.intent === 'test' && input.testOverride) {
    webSocket = input.testOverride.webSocket ?? new MockWebSocketProvider();
    rest = input.testOverride.rest ?? new InMemoryRestClient(new Map(), new Map());
    webSocketProviderName = webSocket instanceof MockWebSocketProvider ? 'MockWebSocketProvider' : 'test-override';
    restClientName = rest instanceof InMemoryRestClient ? 'InMemoryRestClient' : 'test-override';
    isProduction = false;
  } else if (input.intent === 'soak') {
    webSocket = new CoinbaseAdvancedTradeStreamProvider();
    rest = new CoinbasePublicRestClient();
    webSocketProviderName = 'CoinbaseAdvancedTradeStreamProvider';
    restClientName = 'CoinbasePublicRestClient';
    isProduction = true;
  } else {
    // diagnostic — used by preflight harness where the operator
    // wants to prove production wiring works end-to-end.
    webSocket = new CoinbaseAdvancedTradeStreamProvider();
    rest = new CoinbasePublicRestClient();
    webSocketProviderName = 'CoinbaseAdvancedTradeStreamProvider';
    restClientName = 'CoinbasePublicRestClient';
    isProduction = true;
  }

  const usingMock =
    webSocket instanceof MockWebSocketProvider || rest instanceof InMemoryRestClient;
  const soakEligible = input.intent === 'soak' && !usingMock;
  const refusedReason =
    input.intent === 'soak' && usingMock
      ? 'mock provider selected during soak — refused'
      : null;

  await db.insert(adapterSelections).values({
    soakRunId: input.soakRunId ?? null,
    boundAt: now,
    webSocketProvider: webSocketProviderName,
    restClient: restClientName,
    authClient: 'CoinbasePublicAuthenticatedRestClient(placeholder)',
    redisClient: 'ioredis',
    dbDriver: 'mysql2/promise',
    isProduction,
    refusedReason,
  });

  return {
    webSocket,
    rest,
    webSocketProviderName,
    restClientName,
    authClientName: 'CoinbasePublicAuthenticatedRestClient(placeholder)',
    redisClientName: 'ioredis',
    dbDriverName: 'mysql2/promise',
    isProduction,
    soakEligible,
    refusedReason,
  };
}

/** Read the most recent adapter-selection audit row. */
export async function lastAdapterSelection(): Promise<AdapterSelectionRow | null> {
  const rows = await db.select().from(adapterSelections).orderBy(adapterSelections.boundAt);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}
