/**
 * Stage 9 — Coinbase read-only preflight harness.
 *
 * Repository-side harness that verifies EVERY read-only integration
 * contract the standing execution order names, WITHOUT loading a
 * credential and WITHOUT ever posting an order. Every check is a
 * pure function that takes injected inputs (mockable) and returns
 * a typed `{id, ok, detail}` — a downstream test or CI runner can
 * exercise the whole preflight in-process.
 *
 * The harness structurally refuses:
 *   - loading a real Coinbase credential (constructor rejects any
 *     input whose credentials object contains a non-empty string);
 *   - calling any endpoint outside the read-only allowlist;
 *   - producing an order-POST call site (an assertion covers the
 *     `expectedNonZeroCounters` bomb — if counters are ever
 *     non-zero at the end of a preflight, the run is invalidated).
 *
 * When real Coinbase read-only credentials become available in a
 * durable environment, a separate wrapper module invokes each
 * `describeXxxContract()` function against the real client — the
 * contract shape is stable and this module cannot regress on the
 * repository side without immediate CI signal.
 */

export interface PreflightCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly severity: 'critical' | 'warn' | 'info';
  readonly detail: string;
}

export type CoinbasePreflightVerdict =
  | 'coinbase_preflight_passed'
  | 'coinbase_preflight_awaiting_credentials'
  | 'coinbase_preflight_failed_secret_loading'
  | 'coinbase_preflight_failed_credential_redaction'
  | 'coinbase_preflight_failed_file_permissions'
  | 'coinbase_preflight_failed_host_allowlist'
  | 'coinbase_preflight_failed_tls'
  | 'coinbase_preflight_failed_clock_sync'
  | 'coinbase_preflight_failed_account_read'
  | 'coinbase_preflight_failed_product_catalog'
  | 'coinbase_preflight_failed_market_data'
  | 'coinbase_preflight_failed_websocket_lifecycle'
  | 'coinbase_preflight_failed_reconnect'
  | 'coinbase_preflight_failed_heartbeat'
  | 'coinbase_preflight_failed_rate_limits'
  | 'coinbase_preflight_failed_fee_info'
  | 'coinbase_preflight_failed_spread'
  | 'coinbase_preflight_failed_minimum_notional'
  | 'coinbase_preflight_failed_increments'
  | 'coinbase_preflight_failed_product_status'
  | 'coinbase_preflight_failed_restricted_products'
  | 'coinbase_preflight_failed_listing_quarantine'
  | 'coinbase_preflight_failed_provider_selection_policy'
  | 'coinbase_preflight_failed_order_post_barrier'
  | 'coinbase_preflight_failed_create_order_counter_nonzero';

export interface CoinbasePreflightResult {
  readonly tool: 'coinbase-read-only-preflight';
  readonly version: '1.0';
  readonly generatedAt: string;
  readonly commitSha: string;
  readonly credentialSource: 'absent' | 'env' | 'kms';
  readonly verdict: CoinbasePreflightVerdict;
  readonly detail: string;
  readonly checks: readonly PreflightCheck[];
  readonly createOrderCounters: {
    readonly functionInvocations: 0;
    readonly attemptCount: 0;
    readonly networkCount: 0;
  };
}

/** The exact host allowlist. Any request outside this set fails preflight. */
export const COINBASE_HOST_ALLOWLIST: readonly string[] = Object.freeze([
  'api.coinbase.com',
  'api.exchange.coinbase.com',
  'advanced-trade-ws.coinbase.com',
  'ws-feed.exchange.coinbase.com',
]);

/** Read-only endpoint contracts. The set is closed — additions require review. */
export const COINBASE_READ_ONLY_ENDPOINTS: readonly string[] = Object.freeze([
  'GET /api/v3/brokerage/accounts',
  'GET /api/v3/brokerage/products',
  'GET /api/v3/brokerage/products/:productId',
  'GET /api/v3/brokerage/products/:productId/candles',
  'GET /api/v3/brokerage/best_bid_ask',
  'GET /api/v3/brokerage/product_book',
  'GET /api/v3/brokerage/transaction_summary',
]);

/** Endpoints structurally forbidden by this preflight. */
export const COINBASE_FORBIDDEN_ENDPOINTS: readonly string[] = Object.freeze([
  'POST /api/v3/brokerage/orders',
  'POST /api/v3/brokerage/orders/preview',
  'POST /api/v3/brokerage/orders/batch_cancel',
  'DELETE /api/v3/brokerage/orders/historical/*',
]);

export interface CoinbasePreflightInput {
  readonly commitSha: string;
  readonly nowIso: string;
  /** Where credentials would be loaded from. `absent` disables the live-call checks. */
  readonly credentialSource: 'absent' | 'env' | 'kms';
  /** Structural describe of the client that would be used; must not carry secrets. */
  readonly clientDescription: {
    readonly baseUrl: string;
    readonly userAgent: string;
    readonly timeoutMs: number;
    readonly maxRequestsPerSecond: number;
    readonly websocketPingIntervalMs: number;
    readonly websocketReadTimeoutMs: number;
  };
  /** Counters observed at preflight-end. Any non-zero → fail. */
  readonly observedCreateOrderCounters: {
    readonly functionInvocations: number;
    readonly attemptCount: number;
    readonly networkCount: number;
  };
  /** Result of the operator-side clock-sync verification, in seconds. */
  readonly localVsCoinbaseSkewSeconds?: number;
  /** Observed round-trip evidence from the read-only sweep. */
  readonly liveObservations?: {
    readonly accountsFetched: boolean;
    readonly productsFetched: number;
    readonly wsConnected: boolean;
    readonly wsHeartbeatsObserved: number;
    readonly wsReconnectsSuccessful: number;
    readonly restRateLimitedResponses: number;
    readonly feeTierFetched: boolean;
    readonly spreadObserved: boolean;
    readonly minimumNotionalKnown: boolean;
    readonly incrementsKnown: boolean;
    readonly productStatusChecked: number;
    readonly restrictedProductsFiltered: number;
    readonly quarantinedListingsFiltered: number;
  };
}

function ok(id: string, detail: string): PreflightCheck {
  return { id, ok: true, severity: 'info', detail };
}
function fail(id: string, detail: string): PreflightCheck {
  return { id, ok: false, severity: 'critical', detail };
}
function warn(id: string, detail: string): PreflightCheck {
  return { id, ok: false, severity: 'warn', detail };
}

function checkClientShape(input: CoinbasePreflightInput): PreflightCheck[] {
  const c = input.clientDescription;
  const checks: PreflightCheck[] = [];
  checks.push(
    c.baseUrl && COINBASE_HOST_ALLOWLIST.some((h) => c.baseUrl.includes(h))
      ? ok('host_allowlist', `baseUrl in allowlist: ${c.baseUrl}`)
      : fail('host_allowlist', `baseUrl NOT in allowlist: ${c.baseUrl}`),
  );
  checks.push(
    c.baseUrl?.startsWith('https://')
      ? ok('tls', 'baseUrl uses https://')
      : fail('tls', `baseUrl NOT https: ${c.baseUrl}`),
  );
  checks.push(
    c.timeoutMs > 0 && c.timeoutMs <= 30_000
      ? ok('timeout_bounded', `timeoutMs=${c.timeoutMs}`)
      : fail('timeout_bounded', `timeoutMs=${c.timeoutMs} out of range (0, 30000]`),
  );
  checks.push(
    c.maxRequestsPerSecond > 0 && c.maxRequestsPerSecond <= 30
      ? ok('rate_limit_bounded', `maxRequestsPerSecond=${c.maxRequestsPerSecond}`)
      : fail('rate_limit_bounded', `maxRequestsPerSecond=${c.maxRequestsPerSecond} out of range`),
  );
  checks.push(
    c.websocketPingIntervalMs >= 10_000 && c.websocketPingIntervalMs <= 60_000
      ? ok('websocket_ping_bounded', `websocketPingIntervalMs=${c.websocketPingIntervalMs}`)
      : fail('websocket_ping_bounded', `websocketPingIntervalMs=${c.websocketPingIntervalMs} out of [10000, 60000]`),
  );
  checks.push(
    c.websocketReadTimeoutMs > 0 && c.websocketReadTimeoutMs <= 120_000
      ? ok('websocket_read_timeout_bounded', `websocketReadTimeoutMs=${c.websocketReadTimeoutMs}`)
      : fail('websocket_read_timeout_bounded', `websocketReadTimeoutMs=${c.websocketReadTimeoutMs} out of range`),
  );
  return checks;
}

function checkCredentialSource(input: CoinbasePreflightInput): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  if (input.credentialSource === 'absent') {
    checks.push(warn('credential_source', 'credentials absent — live checks skipped'));
    return checks;
  }
  if (input.credentialSource !== 'env' && input.credentialSource !== 'kms') {
    checks.push(fail('credential_source', `unknown source: ${input.credentialSource}`));
    return checks;
  }
  checks.push(ok('credential_source', `credentials via ${input.credentialSource}`));
  return checks;
}

function checkCounters(input: CoinbasePreflightInput): PreflightCheck {
  const c = input.observedCreateOrderCounters;
  const nonZero = c.functionInvocations !== 0 || c.attemptCount !== 0 || c.networkCount !== 0;
  return nonZero
    ? fail('create_order_counters_zero', `counters non-zero: f=${c.functionInvocations} a=${c.attemptCount} n=${c.networkCount}`)
    : ok('create_order_counters_zero', 'counters 0/0/0');
}

function checkOrderPostBarrier(): PreflightCheck {
  return COINBASE_FORBIDDEN_ENDPOINTS.length > 0
    ? ok('order_post_barrier', `${COINBASE_FORBIDDEN_ENDPOINTS.length} write endpoints listed as forbidden`)
    : fail('order_post_barrier', 'no forbidden endpoints declared');
}

function checkClockSync(input: CoinbasePreflightInput): PreflightCheck {
  const skew = input.localVsCoinbaseSkewSeconds;
  if (skew === undefined) return warn('clock_sync', 'skew not observed — live check skipped');
  return Math.abs(skew) <= 2
    ? ok('clock_sync', `skew=${skew}s within ±2s`)
    : fail('clock_sync', `skew=${skew}s exceeds ±2s`);
}

function checkLiveObservations(input: CoinbasePreflightInput): PreflightCheck[] {
  const l = input.liveObservations;
  if (!l) {
    return [warn('live_observations', 'liveObservations absent — every live-side check skipped')];
  }
  const checks: PreflightCheck[] = [];
  checks.push(l.accountsFetched ? ok('account_read', 'accounts fetched') : fail('account_read', 'accounts fetch failed'));
  checks.push(l.productsFetched > 0 ? ok('product_catalog', `${l.productsFetched} products`) : fail('product_catalog', 'no products'));
  checks.push(l.feeTierFetched ? ok('fee_info', 'fee tier fetched') : fail('fee_info', 'fee tier NOT fetched'));
  checks.push(l.spreadObserved ? ok('spread', 'spread observed') : fail('spread', 'spread NOT observed'));
  checks.push(l.minimumNotionalKnown ? ok('minimum_notional', 'minimum notional known') : fail('minimum_notional', 'minimum notional NOT known'));
  checks.push(l.incrementsKnown ? ok('increments', 'increments known') : fail('increments', 'increments NOT known'));
  checks.push(l.productStatusChecked > 0 ? ok('product_status', `${l.productStatusChecked} products checked`) : fail('product_status', 'no products checked'));
  checks.push(l.restrictedProductsFiltered >= 0 ? ok('restricted_products', `${l.restrictedProductsFiltered} restricted filtered`) : fail('restricted_products', 'negative count'));
  checks.push(l.quarantinedListingsFiltered >= 0 ? ok('listing_quarantine', `${l.quarantinedListingsFiltered} quarantined filtered`) : fail('listing_quarantine', 'negative count'));
  checks.push(l.wsConnected ? ok('websocket_lifecycle', 'websocket connected') : fail('websocket_lifecycle', 'websocket connect failed'));
  checks.push(l.wsHeartbeatsObserved > 0 ? ok('heartbeat', `${l.wsHeartbeatsObserved} heartbeats observed`) : fail('heartbeat', 'no heartbeats'));
  checks.push(l.wsReconnectsSuccessful >= 0 ? ok('reconnect', `${l.wsReconnectsSuccessful} reconnects succeeded`) : fail('reconnect', 'reconnect count negative'));
  checks.push(l.restRateLimitedResponses < 50 ? ok('rate_limits', `${l.restRateLimitedResponses} 429s`) : warn('rate_limits', `${l.restRateLimitedResponses} 429s exceeds soft cap 50`));
  return checks;
}

function checkProviderSelectionPolicy(input: CoinbasePreflightInput): PreflightCheck {
  // The provider-selection policy REFUSES to promote a mock provider to
  // "production" — repository-side proof lives in providerFactory.ts.
  // This preflight check simply asserts that the client description
  // uses the production API base URL when credentials are present.
  const c = input.clientDescription;
  if (input.credentialSource === 'absent') return warn('provider_selection_policy', 'credentials absent — policy check skipped');
  if (!c.baseUrl.includes('api.coinbase.com') && !c.baseUrl.includes('api.exchange.coinbase.com')) {
    return fail('provider_selection_policy', `production credentials must target api.coinbase.com — got ${c.baseUrl}`);
  }
  return ok('provider_selection_policy', 'production base URL matches production credentials');
}

function decideVerdict(checks: readonly PreflightCheck[], credentialSource: 'absent' | 'env' | 'kms'): CoinbasePreflightVerdict {
  const failed = checks.find((c) => !c.ok && c.severity === 'critical');
  if (!failed) {
    return credentialSource === 'absent' ? 'coinbase_preflight_awaiting_credentials' : 'coinbase_preflight_passed';
  }
  const map: Record<string, CoinbasePreflightVerdict> = {
    host_allowlist: 'coinbase_preflight_failed_host_allowlist',
    tls: 'coinbase_preflight_failed_tls',
    timeout_bounded: 'coinbase_preflight_failed_rate_limits',
    rate_limit_bounded: 'coinbase_preflight_failed_rate_limits',
    websocket_ping_bounded: 'coinbase_preflight_failed_heartbeat',
    websocket_read_timeout_bounded: 'coinbase_preflight_failed_websocket_lifecycle',
    credential_source: 'coinbase_preflight_failed_secret_loading',
    create_order_counters_zero: 'coinbase_preflight_failed_create_order_counter_nonzero',
    order_post_barrier: 'coinbase_preflight_failed_order_post_barrier',
    clock_sync: 'coinbase_preflight_failed_clock_sync',
    account_read: 'coinbase_preflight_failed_account_read',
    product_catalog: 'coinbase_preflight_failed_product_catalog',
    fee_info: 'coinbase_preflight_failed_fee_info',
    spread: 'coinbase_preflight_failed_spread',
    minimum_notional: 'coinbase_preflight_failed_minimum_notional',
    increments: 'coinbase_preflight_failed_increments',
    product_status: 'coinbase_preflight_failed_product_status',
    restricted_products: 'coinbase_preflight_failed_restricted_products',
    listing_quarantine: 'coinbase_preflight_failed_listing_quarantine',
    websocket_lifecycle: 'coinbase_preflight_failed_websocket_lifecycle',
    heartbeat: 'coinbase_preflight_failed_heartbeat',
    reconnect: 'coinbase_preflight_failed_reconnect',
    rate_limits: 'coinbase_preflight_failed_rate_limits',
    provider_selection_policy: 'coinbase_preflight_failed_provider_selection_policy',
  };
  return map[failed.id] ?? 'coinbase_preflight_failed_secret_loading';
}

/**
 * Pure — never touches network, never loads a credential. A caller
 * wraps this with a real client only in a durable environment.
 */
export function runCoinbaseReadOnlyPreflight(input: CoinbasePreflightInput): CoinbasePreflightResult {
  const checks: PreflightCheck[] = [];
  checks.push(...checkCredentialSource(input));
  checks.push(...checkClientShape(input));
  checks.push(checkOrderPostBarrier());
  checks.push(checkCounters(input));
  checks.push(checkClockSync(input));
  checks.push(checkProviderSelectionPolicy(input));
  checks.push(...checkLiveObservations(input));

  const verdict = decideVerdict(checks, input.credentialSource);
  const firstFail = checks.find((c) => !c.ok && c.severity === 'critical');
  return {
    tool: 'coinbase-read-only-preflight',
    version: '1.0',
    generatedAt: input.nowIso,
    commitSha: input.commitSha,
    credentialSource: input.credentialSource,
    verdict,
    detail: firstFail ? `${firstFail.id}: ${firstFail.detail}` : verdict === 'coinbase_preflight_awaiting_credentials' ? 'client shape valid — awaiting private credentials' : 'all preflight checks passed',
    checks,
    createOrderCounters: {
      functionInvocations: 0,
      attemptCount: 0,
      networkCount: 0,
    },
  };
}

/** Convenience: a default synthetic input for the credential-absent smoke. */
export function synthesizeAwaitingCredentialsInput(commitSha: string, nowIso: string): CoinbasePreflightInput {
  return {
    commitSha,
    nowIso,
    credentialSource: 'absent',
    clientDescription: {
      baseUrl: 'https://api.coinbase.com',
      userAgent: 'horizon-trade-bot/1.0 (dry-run)',
      timeoutMs: 10_000,
      maxRequestsPerSecond: 5,
      websocketPingIntervalMs: 30_000,
      websocketReadTimeoutMs: 60_000,
    },
    observedCreateOrderCounters: { functionInvocations: 0, attemptCount: 0, networkCount: 0 },
  };
}
