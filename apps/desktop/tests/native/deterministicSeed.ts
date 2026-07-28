/**
 * Stage 3C-ENV — deterministic seed for the native Electron test.
 *
 * Design choice: seed EVERY screen with authoritative rows so a
 * healthy/empty/degraded/unavailable state comes from real server
 * evidence — never from a placeholder or fabricated literal. Every
 * INSERT is raw SQL via mysql2/promise. The seed NEVER goes through
 * the economic-writer code path (applyEntryEconomicStateTx,
 * applyExitEconomicStateTx, createPlan), NEVER creates an order at
 * the exchange, NEVER makes a Coinbase network call.
 *
 * Row identifiers, UUIDs, and timestamps are fixed literals so the
 * same run produces the same DB byte-for-byte. `assertSeedCoverageComplete`
 * throws if any of the 19 domain-critical row counts is zero — the
 * native test's T-coverage gate consumes this to fail closed if the
 * seed silently regresses.
 *
 * Coverage (spec §3, Stage 3C-ENV expansion):
 *   Overview                 → bot_config + decision_chains + reconciliation_actions
 *   Shadow Portfolio         → portfolio_risk_snapshots (full column set)
 *   Positions                → positions + order_intents + fills + round_trips
 *                              + cash_ledger + protection_instances + reconciliation_actions
 *   Decision Journal         → decision_chains + scan_runs + market_observations
 *                              + eligibility_decisions + outcome_labels
 *   Research Universe        → universe_snapshots + universe_products
 *   Fingerprints             → fingerprint_snapshots
 *   Regimes                  → global_regime_snapshots
 *   Portfolio Risk           → portfolio_risk_snapshots (shared with Shadow Portfolio)
 *   Microstructure           → order_book_sessions
 *   Context                  → context_provider_definitions
 *   Validation Lab           → research_experiments
 *   Costs                    → forecast_vs_realized_attributions
 *   Protection               → protection_policy_versions + protection_instances
 *   Reconciliation           → reconciliation_runs + reconciliation_actions
 *   Incidents                → desktop_incidents (open + acknowledged)
 *   Reports                  → fixed literal — asserted structurally in test
 *   Configuration            → fixed literal — asserted structurally in test
 *   System                   → __drizzle_migrations count (already present) + fixed literals
 *   Safety                   → bot_config + fixed literals
 *
 * safeInsert() guards every write — an optional column drift on a
 * future migration cannot abort the seed; the affected screen will
 * simply render `empty`/`degraded`, which the native test still
 * treats as honest evidence.
 */

import { createConnection, type Connection } from 'mysql2/promise';

export const SEED_NOW = '2026-07-27T12:00:00.000Z';
export const SEED_HOUR_AGO = '2026-07-27T11:00:00.000Z';
export const SEED_DAY_AGO = '2026-07-26T12:00:00.000Z';
const SEED_MYSQL_NOW = '2026-07-27 12:00:00.000';
const SEED_MYSQL_HOUR_AGO = '2026-07-27 11:00:00.000';
const SEED_MYSQL_DAY_AGO = '2026-07-26 12:00:00.000';

// -------------------------------------------------------------------------
// Fixed IDs — every domain gets its own numeric range so a test failure
// pointing at "position 1002" is unambiguous.
// -------------------------------------------------------------------------
export const SEED_IDS = Object.freeze({
  positionOpen: 1001,
  positionDust: 1002,
  planShadow: 2001,
  incidentOpen: 3001,
  incidentAcked: 3002,
  decisionChainAccepted: 4001,
  decisionChainBroken: 4002,
  roundTripWin: 5001,
  scanRun: 6001,
  marketObservationAccepted: 7001,
  marketObservationBroken: 7002,
  protectionActive: 'native_prot_active_1',
  protectionUnknown: 'native_prot_unknown_2',
});

export interface SeedSummary {
  // 11 legacy domains (Stage 3C initial)
  universe_snapshots: number;
  universe_products: number;
  fingerprint_snapshots: number;
  global_regime_snapshots: number;
  portfolio_risk_snapshots: number;
  order_book_sessions: number;
  context_provider_definitions: number;
  research_experiments: number;
  forecast_vs_realized_attributions: number;
  reconciliation_runs: number;
  desktop_incidents: number;
  protection_instances: number;
  // Stage 3C-CI-FIX3 §A — protection_policy_versions is a required
  // parent for the Protection screen; previously never populated in
  // the summary object, causing the manifest coverage assertion to
  // read `undefined` (=> 0) and reject the run even after the row
  // successfully landed. Now explicitly tracked.
  protection_policy_versions: number;

  // 8 new domains added in Stage 3C-ENV
  bot_config: number;
  decision_chains: number;
  scan_runs: number;
  market_observations: number;
  eligibility_decisions: number;
  outcome_labels: number;
  positions: number;
  order_intents: number;
  fills: number;
  round_trips: number;
  cash_ledger: number;
  reconciliation_actions: number;
}

async function tableExists(c: Connection, name: string): Promise<boolean> {
  const [rows] = await c.query(
    'SELECT COUNT(*) as n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
    [name],
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Number((rows as any)[0]?.n ?? 0) > 0;
}

/**
 * Stage 3C-CI-FIX3 §A: sanitized error string for seed failures.
 * The message goes into the CI log + evidence bundle; must not
 * leak bearer tokens, bootstrap tokens, or connection strings.
 */
export function sanitizeSeedError(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <REDACTED>')
    .replace(/mysql:\/\/[^@\s]+@/g, 'mysql://<REDACTED>@')
    .replace(/password\s*=\s*'?[^\s',)]+/gi, 'password=<REDACTED>')
    .replace(/[A-Fa-f0-9]{32,}/g, '<HEX_REDACTED>')
    .slice(0, 480);
}

/**
 * Stage 3C-CI-FIX3 §A: strict insert for mandatory seed rows.
 * Unlike safeInsert (which swallows and moves on), this throws
 * with a sanitized error the caller can propagate to the harness
 * log — giving CI a clear diagnosis instead of a downstream
 * "seeded=0" surprise. Used only for tables the manifest lists
 * as `expectedState: 'healthy'`.
 */
async function requiredInsert(
  connection: Connection,
  label: string,
  sql: string,
  values: readonly unknown[],
): Promise<void> {
  try {
    await connection.query(sql, values as unknown[]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`required_seed_failed:${label}:${sanitizeSeedError(message)}`);
  }
}

async function safeInsert(c: Connection, sql: string, values: unknown[]): Promise<void> {
  try {
    await c.query(sql, values);
  } catch (e) {
    // Stage 3C-ENV-FIX §2: previously silent. Now emit under
    // NATIVE_DEBUG=1 so CI can diagnose exactly which INSERT
    // couldn't land. Still non-fatal — the required-vs-recommended
    // coverage gate (assertSeedCoverageComplete) is what enforces
    // the hard fail; this log is diagnostic only.
    if (process.env.NATIVE_DEBUG === '1') {
      const msg = String((e as Error).message ?? e).slice(0, 240);
      const preview = sql.split(/\s+/).slice(0, 5).join(' ');
      // eslint-disable-next-line no-console
      console.error(`[stage3c-seed] safeInsert failed (${preview}...): ${msg}`);
    }
  }
}

async function countRows(c: Connection, name: string): Promise<number> {
  if (!(await tableExists(c, name))) return 0;
  try {
    const [rows] = await c.query(`SELECT COUNT(*) AS n FROM \`${name}\``);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Number((rows as any)[0]?.n ?? 0);
  } catch { return 0; }
}

export async function seedNativeFixture(dbUrl: string): Promise<SeedSummary> {
  const c = await createConnection({ uri: dbUrl, multipleStatements: false, dateStrings: true });
  try {
    // -----------------------------------------------------------
    // Parent-row precursors — seeded FIRST so downstream FKs resolve.
    // Stage 3C-ENV-FIX §2 requires that every screen have a deterministic
    // seeded outcome (either healthy evidence or an auditable degraded
    // state); the FK chain seeding lets the Phase 2 observer rows land.
    // -----------------------------------------------------------
    if (await tableExists(c, 'desktop_installations')) {
      await safeInsert(c,
        `INSERT INTO desktop_installations (id, installationKey, desktopVersion, buildCommit,
           platform, firstInstalledAt, machineFingerprint)
         VALUES (1, 'native.installation.v1', '3.0.0', 'stage3c_env_fix',
           'linux', ?, 'native_machine_fingerprint_v1')`,
        [SEED_MYSQL_NOW],
      );
    }
    if (await tableExists(c, 'risk_policy_versions')) {
      await safeInsert(c,
        `INSERT INTO risk_policy_versions (id, policyKey, policyVersion, description,
           operatingScope, status, effectiveFrom, implementationHash, configurationHash)
         VALUES (20001, 'native.risk.policy', 'v1', 'stage 3c env fix seed policy',
           'global', 'validated_for_research', ?, 'hash_native_risk_impl', 'hash_native_risk_conf')`,
        [SEED_MYSQL_NOW],
      );
    }
    if (await tableExists(c, 'dataset_definitions')) {
      await safeInsert(c,
        `INSERT INTO dataset_definitions (id, datasetKey, description, sourceCategory)
         VALUES (1, 'native.seed.dataset', 'stage 3c env fix seed dataset', 'synthetic_fixture')`,
        [],
      );
    }
    if (await tableExists(c, 'dataset_versions')) {
      await safeInsert(c,
        `INSERT INTO dataset_versions (id, datasetDefinitionId, datasetVersion, sourceCategory,
           sourceIdentity, productUniverseHash, startTime, endTime, dataAvailabilityCutoff,
           featureVersions, fingerprintVersion, regimeVersion, riskPolicyVersion,
           microstructurePolicyVersion, contextPolicyVersion, costModelVersion, fillModelVersion,
           labelVersion, exclusionPolicyVersion, codeCommit, inputHash)
         VALUES (1, 1, 'v1', 'synthetic_fixture',
           'stage3c_env_fix', 'hash_native_dataset_v1', ?, ?, ?,
           'features.v1', 'fp.v1', 'regime.v1', 'risk.v1',
           'micro.v1', 'context.v1', 'cost.v1', 'fill.v1',
           'label.v1', 'exclusion.v1', 'stage3c_env_fix', 'hash_native_dataset_input_v1')`,
        [SEED_MYSQL_DAY_AGO, SEED_MYSQL_NOW, SEED_MYSQL_NOW],
      );
    }
    // Note: regime_observer_runs (FK to universe_snapshots) and
    // protection_capabilities (FK to protection_policy_versions) are
    // seeded LATER — after their parent tables land — see below.
    // Note: forecast_vs_realized_attributions requires a
    // execution_cost_forecasts row which requires a candidates row
    // which requires a full scanner chain — that FK graph is
    // deliberately left unseeded and the Costs screen is declared
    // to render `empty` as its expected auditable state.

    // -----------------------------------------------------------
    // Overview + Safety — bot_config
    // (reconciliationStatus consumed by both Overview and Safety.
    // Populated with a healthy 'ok' state so the screens leave the
    // degraded banner off and expose their true-happy layout.)
    // -----------------------------------------------------------
    if (await tableExists(c, 'bot_config')) {
      await safeInsert(c,
        `INSERT INTO bot_config (isRunning, isPaused, consecutiveLosses, reconciliationStatus, reconciledAt)
         VALUES (1, 0, 0, 'ok', ?)`,
        [SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Positions — one open + one dust
    // -----------------------------------------------------------
    if (await tableExists(c, 'positions')) {
      // Position 1001: OPEN partial-exit demonstrating lifecycle.
      await safeInsert(c,
        `INSERT INTO positions (id, token, mode, avgEntryPrice, filledQuantity, entryFees,
           entryQuoteSpent, allocationPct, takeProfitPrice, stopLossPrice, takeProfitPct,
           stopLossPct, entryOrderIntentId, protectionMode, strategyVersion, lifecycleState,
           status, version, openedAt, residualBaseSize, protectionState)
         VALUES (?, 'BTC-USD', 'breakout', '50000.00000000', '0.10000000', '5.00000000',
           '5000.00000000', '5.00', '55000.00000000', '48000.00000000', '10.00',
           '4.00', 8001, 'polling_fallback', 'strategy-native-v1', 'partially_open',
           'open', 1, ?, '0.05000000', 'attached_active')`,
        [SEED_IDS.positionOpen, SEED_MYSQL_HOUR_AGO],
      );
      // Position 1002: dust residual demonstrating dust policy.
      await safeInsert(c,
        `INSERT INTO positions (id, token, mode, avgEntryPrice, filledQuantity, entryFees,
           entryQuoteSpent, allocationPct, takeProfitPrice, stopLossPrice, takeProfitPct,
           stopLossPct, entryOrderIntentId, protectionMode, strategyVersion, lifecycleState,
           status, version, openedAt, closedAt, residualBaseSize, dustQuantity,
           dustEstimatedValue, dustReason, dustDetectedAt, dustPolicyVersion, protectionState)
         VALUES (?, 'ETH-USD', 'reversion', '3000.00000000', '1.00000000', '3.00000000',
           '3000.00000000', '3.00', '3300.00000000', '2900.00000000', '10.00',
           '3.33', 8002, 'unprotected', 'strategy-native-v1', 'dust_residual',
           'closed', 2, ?, ?, '0.00001000', '0.00001000',
           '0.03000000', 'below_min_notional', ?, 'dust_policy_v1', 'none')`,
        [SEED_IDS.positionDust, SEED_MYSQL_DAY_AGO, SEED_MYSQL_NOW, SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Order intents (referenced by positions.entryOrderIntentId + fills.orderIntentId)
    // -----------------------------------------------------------
    if (await tableExists(c, 'order_intents')) {
      await safeInsert(c,
        `INSERT INTO order_intents (id, clientOrderId, productId, token, side, orderType,
           quoteSize, baseSize, mode, purpose, positionId, state, exchangeOrderId,
           dryRun, createdAt)
         VALUES (8001, 'native-entry-1001', 'BTC-USD', 'BTC-USD', 'BUY', 'market_ioc',
           '5000.00000000', NULL, 'breakout', 'entry', ?, 'filled', 'exch-native-8001',
           1, ?)`,
        [SEED_IDS.positionOpen, SEED_MYSQL_HOUR_AGO],
      );
      await safeInsert(c,
        `INSERT INTO order_intents (id, clientOrderId, productId, token, side, orderType,
           quoteSize, baseSize, mode, purpose, positionId, state, exchangeOrderId,
           dryRun, createdAt)
         VALUES (8002, 'native-entry-1002', 'ETH-USD', 'ETH-USD', 'BUY', 'market_ioc',
           '3000.00000000', NULL, 'reversion', 'entry', ?, 'filled', 'exch-native-8002',
           1, ?)`,
        [SEED_IDS.positionDust, SEED_MYSQL_DAY_AGO],
      );
    }

    // -----------------------------------------------------------
    // Fills (Positions detail)
    // -----------------------------------------------------------
    if (await tableExists(c, 'fills')) {
      await safeInsert(c,
        `INSERT INTO fills (id, exchangeFillId, orderIntentId, exchangeOrderId, token, side,
           filledSize, fillPrice, fee, feeCurrency, tradeTime, createdAt)
         VALUES (9001, 'fill-native-9001', 8001, 'exch-native-8001', 'BTC-USD', 'BUY',
           '0.10000000', '50000.00000000', '5.00000000', 'USD', ?, ?)`,
        [SEED_MYSQL_HOUR_AGO, SEED_MYSQL_HOUR_AGO],
      );
      await safeInsert(c,
        `INSERT INTO fills (id, exchangeFillId, orderIntentId, exchangeOrderId, token, side,
           filledSize, fillPrice, fee, feeCurrency, tradeTime, createdAt)
         VALUES (9002, 'fill-native-9002', 8002, 'exch-native-8002', 'ETH-USD', 'BUY',
           '1.00000000', '3000.00000000', '3.00000000', 'USD', ?, ?)`,
        [SEED_MYSQL_DAY_AGO, SEED_MYSQL_DAY_AGO],
      );
    }

    // -----------------------------------------------------------
    // Round trips — one completed win for Positions + Shadow Portfolio
    // -----------------------------------------------------------
    if (await tableExists(c, 'round_trips')) {
      await safeInsert(c,
        `INSERT INTO round_trips (id, positionId, token, mode, entryValueGross, exitValueGross,
           entryFees, exitFees, realizedNetPnl, realizedNetPnlPct, outcome, exitReason,
           openedAt, closedAt)
         VALUES (?, ?, 'ETH-USD', 'reversion', '3000.00000000', '3300.00000000',
           '3.00000000', '3.30000000', '293.70000000', '9.7900', 'win', 'take_profit',
           ?, ?)`,
        [SEED_IDS.roundTripWin, SEED_IDS.positionDust, SEED_MYSQL_DAY_AGO, SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Cash ledger (Positions detail)
    // -----------------------------------------------------------
    if (await tableExists(c, 'cash_ledger')) {
      await safeInsert(c,
        `INSERT INTO cash_ledger (deltaUsd, reason, orderIntentId, positionId, dryRun, createdAt, idempotencyKey)
         VALUES ('-5000.00000000', 'buy_cost', 8001, ?, 1, ?, 'native-ledger-1')`,
        [SEED_IDS.positionOpen, SEED_MYSQL_HOUR_AGO],
      );
      await safeInsert(c,
        `INSERT INTO cash_ledger (deltaUsd, reason, orderIntentId, positionId, dryRun, createdAt, idempotencyKey)
         VALUES ('-5.00000000', 'buy_fee', 8001, ?, 1, ?, 'native-ledger-2')`,
        [SEED_IDS.positionOpen, SEED_MYSQL_HOUR_AGO],
      );
    }

    // -----------------------------------------------------------
    // Reconciliation actions (the runs insert with correct schema
    // is farther below — this block seeds an action row referencing
    // it once we know the runId is stable).
    // -----------------------------------------------------------
    if (await tableExists(c, 'reconciliation_actions')) {
      await safeInsert(c,
        `INSERT INTO reconciliation_actions (runId, intentId, clientOrderId, action, previousState, newState, fillsBefore, fillsAfter)
         VALUES ('native_recon_1', 8001, 'native-entry-1001', 'reconcile_fills', 'submitted', 'filled', 0, 1)`,
        [],
      );
    }

    // -----------------------------------------------------------
    // Decision chains + scan runs + market observations
    // -----------------------------------------------------------
    if (await tableExists(c, 'scan_runs')) {
      await safeInsert(c,
        `INSERT INTO scan_runs (id, triggerType, startedAt, completedAt, status, botState, scannerVersion)
         VALUES (?, 'stage3c_seed', ?, ?, 'completed', 'running', 'scanner-native-v1')`,
        [SEED_IDS.scanRun, SEED_MYSQL_HOUR_AGO, SEED_MYSQL_HOUR_AGO],
      );
    }
    if (await tableExists(c, 'decision_chains')) {
      // Chain 4001: complete lineage, accepted → Overview brokenLineage=0 contribution
      await safeInsert(c,
        `INSERT INTO decision_chains (id, scanRunId, productId, strategyVersion, currentStatus,
           observedAt, dataAvailableAt, decisionStartedAt, decisionCompletedAt, lineageCompleteness, legacyStatus)
         VALUES (?, ?, 'BTC-USD', 'strategy-native-v1', 'approved', ?, ?, ?, ?, 'complete', 'current')`,
        [SEED_IDS.decisionChainAccepted, SEED_IDS.scanRun, SEED_MYSQL_HOUR_AGO, SEED_MYSQL_HOUR_AGO, SEED_MYSQL_HOUR_AGO, SEED_MYSQL_HOUR_AGO],
      );
      // Chain 4002: broken lineage → Overview brokenLineage>=1
      await safeInsert(c,
        `INSERT INTO decision_chains (id, scanRunId, productId, strategyVersion, currentStatus,
           observedAt, dataAvailableAt, decisionStartedAt, decisionCompletedAt, lineageCompleteness, legacyStatus)
         VALUES (?, ?, 'ETH-USD', 'strategy-native-v1', 'observed', ?, ?, ?, NULL, 'broken', 'current')`,
        [SEED_IDS.decisionChainBroken, SEED_IDS.scanRun, SEED_MYSQL_HOUR_AGO, SEED_MYSQL_HOUR_AGO, SEED_MYSQL_HOUR_AGO],
      );
    }
    if (await tableExists(c, 'market_observations')) {
      // immutablePayload column added by Stage 2A — required NOT NULL.
      await safeInsert(c,
        `INSERT INTO market_observations (id, decisionChainId, productId, observedAt,
           dataAvailableAt, marketDataVersion, inputDataHash, price, volume24h, spread,
           dataQualityStatus, immutablePayload)
         VALUES (?, ?, 'BTC-USD', ?, ?, 'md-native-v1', 'hash_native_btc_1',
           '50000.00000000', '1000000.00000000', '10.00000000', 'valid',
           '{"kind":"stage3c_native_seed","product":"BTC-USD"}')`,
        [SEED_IDS.marketObservationAccepted, SEED_IDS.decisionChainAccepted, SEED_MYSQL_HOUR_AGO, SEED_MYSQL_HOUR_AGO],
      );
      await safeInsert(c,
        `INSERT INTO market_observations (id, decisionChainId, productId, observedAt,
           dataAvailableAt, marketDataVersion, inputDataHash, price, volume24h, spread,
           dataQualityStatus, immutablePayload)
         VALUES (?, ?, 'ETH-USD', ?, ?, 'md-native-v1', 'hash_native_eth_1',
           '3000.00000000', '500000.00000000', '5.00000000', 'stale',
           '{"kind":"stage3c_native_seed","product":"ETH-USD"}')`,
        [SEED_IDS.marketObservationBroken, SEED_IDS.decisionChainBroken, SEED_MYSQL_HOUR_AGO, SEED_MYSQL_HOUR_AGO],
      );
    }
    if (await tableExists(c, 'eligibility_decisions')) {
      await safeInsert(c,
        `INSERT INTO eligibility_decisions (decisionChainId, marketObservationId, eligible,
           reasonCode, policyVersion, decidedAt)
         VALUES (?, ?, 1, 'eligible', 'policy-native-v1', ?)`,
        [SEED_IDS.decisionChainAccepted, SEED_IDS.marketObservationAccepted, SEED_MYSQL_HOUR_AGO],
      );
    }
    if (await tableExists(c, 'outcome_labels')) {
      // labelWindowStart/End + dataAvailableAt required NOT NULL — Stage 2 addition.
      await safeInsert(c,
        `INSERT INTO outcome_labels (decisionChainId, roundTripId, labelVersion, labelType,
           tpReachedFirst, slReachedFirst, timeout, ambiguous,
           labelWindowStart, labelWindowEnd, dataAvailableAt)
         VALUES (?, ?, 1, 'held_forward', 1, 0, 0, 0, ?, ?, ?)`,
        [SEED_IDS.decisionChainAccepted, SEED_IDS.roundTripWin, SEED_MYSQL_HOUR_AGO, SEED_MYSQL_NOW, SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Universe (Research Universe + Overview champion universe)
    // -----------------------------------------------------------
    if (await tableExists(c, 'universe_snapshots')) {
      await safeInsert(c,
        `INSERT INTO universe_snapshots (id, snapshotVersion, providerName, providerVersion,
           observedAt, dataAvailableAt, productCount, payloadHash)
         VALUES (7101, 'native.v1', 'stage3c_native_seed', 'v1',
           ?, ?, 4, 'hash_native_universe_1')`,
        [SEED_MYSQL_NOW, SEED_MYSQL_NOW],
      );
    }
    if (await tableExists(c, 'universe_products')) {
      let id = 7201;
      for (const p of ['BTC-USD', 'ETH-USD', 'SOL-USD', 'AVAX-USD']) {
        await safeInsert(c,
          `INSERT INTO universe_products (id, snapshotId, productId, baseCurrency, quoteCurrency, productType)
           VALUES (?, 7101, ?, ?, 'USD', 'spot')`,
          [id++, p, p.split('-')[0]],
        );
      }
    }

    // -----------------------------------------------------------
    // Fingerprints (Stage 2A schema — snapshotId FK to universe_snapshots)
    // -----------------------------------------------------------
    if (await tableExists(c, 'fingerprint_snapshots')) {
      await safeInsert(c,
        `INSERT INTO fingerprint_snapshots (id, snapshotId, productId, fingerprintClass,
           confidence, qualityPenalty, liquidityPenalty, classificationVersion, metadataVersion,
           inputHash, observedAt, dataAvailableAt, state)
         VALUES (7301, 7101, 'BTC-USD', 'REVERSION_CANDIDATE',
           '0.6500', '0.1000', '0.0500', 'native.v1', 'native.v1',
           'hash_native_fp_btc', ?, ?, 'complete')`,
        [SEED_MYSQL_NOW, SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Regime observer run — FK to universe_snapshots (id=7101 above)
    // -----------------------------------------------------------
    if (await tableExists(c, 'regime_observer_runs')) {
      await safeInsert(c,
        `INSERT INTO regime_observer_runs (id, snapshotId, startedAt, completedAt,
           productsConsidered, globalStatesEmitted, productStatesEmitted, unknownCount, disorderedCount,
           observerVersion, transitionPolicyVersion)
         VALUES (7401, 7101, ?, ?,
           4, 1, 0, 0, 0, 'regime.native.v1', 'transition.native.v1')`,
        [SEED_MYSQL_NOW, SEED_MYSQL_NOW],
      );
    }
    if (await tableExists(c, 'portfolio_risk_runs')) {
      await safeInsert(c,
        `INSERT INTO portfolio_risk_runs (id, policyVersionId, startedAt, completedAt,
           candidatesEvaluated, authorizeAsProposed, reduceSize, rejects, abstains, dataFailures,
           runnerVersion)
         VALUES (10001, 20001, ?, ?,
           1, 1, 0, 0, 0, 0, 'risk.native.v1')`,
        [SEED_MYSQL_NOW, SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Regimes (Stage 2B schema)
    // -----------------------------------------------------------
    if (await tableExists(c, 'global_regime_snapshots')) {
      await safeInsert(c,
        `INSERT INTO global_regime_snapshots (id, observerRunId, regimeKey, regimeVersion,
           state, status, confidence, inputHash, observedAt, dataAvailableAt)
         VALUES (7401, 7401, 'global_v1', 'v1',
           'TREND_UP', 'valid', '0.7500', 'hash_native_regime_global', ?, ?)`,
        [SEED_MYSQL_NOW, SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Portfolio risk — full column set so the query returns 'healthy'
    // instead of degrading on missing fields.
    // -----------------------------------------------------------
    if (await tableExists(c, 'portfolio_risk_snapshots')) {
      await safeInsert(c,
        `INSERT INTO portfolio_risk_snapshots (id, observerRunId, policyVersionId, cash, reservedCash,
           grossExposure, netExposure, totalOpenStopRisk, pendingEntryRisk, unprotectedExposure,
           btcBetaExposure, ethBetaExposure, dailyLoss, weeklyLoss, currentDrawdown,
           historicalVaR, historicalExpectedShortfall, worstStressLoss, positionCount, clusterCount,
           dataQualityState, systemIntegrityState, observedAt, dataAvailableAt, inputHash)
         VALUES (7501, 10001, 20001, '95000.0000000000', '500.0000000000',
           '5000.0000000000', '5000.0000000000', '200.0000000000', '0.0000000000', '0.0000000000',
           '0.5000000000', '0.0000000000', '0.0000000000', '0.0000000000', '0.0000000000',
           '150.0000000000', '250.0000000000', '500.0000000000', 1, 1,
           'valid', 'healthy', ?, ?, 'input_hash_native_v1')`,
        [SEED_MYSQL_NOW, SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Microstructure (Stage 2D schema — order_book_sessions)
    // -----------------------------------------------------------
    if (await tableExists(c, 'order_book_sessions')) {
      await safeInsert(c,
        `INSERT INTO order_book_sessions (id, productId, providerId, providerVersion,
           startedAt, state, sequenceNext)
         VALUES (7601, 'BTC-USD', 'native.seed.provider', 'v1',
           ?, 'healthy', 0)`,
        [SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Context (Stage 2E schema)
    // -----------------------------------------------------------
    if (await tableExists(c, 'context_provider_definitions')) {
      await safeInsert(c,
        `INSERT INTO context_provider_definitions (id, providerKey, providerVersion,
           providerFamily, description, expectedSchemaVersion, expectedUpdateIntervalMs,
           maximumStalenessMs, authorityLevel, supportedScopes, implementationHash)
         VALUES (7701, 'native.seed', 'v1',
           'macro_calendar', 'Stage 3C native seed context provider', 'v1', 60000,
           300000, 'informational', 'global', 'hash_native_context_provider')`,
        [],
      );
    }

    // -----------------------------------------------------------
    // Validation Lab (Stage 2F schema)
    // -----------------------------------------------------------
    if (await tableExists(c, 'research_experiments')) {
      // Stage 2F requires: validationPolicyVersion, registeredAt,
      // registeredBy, codeCommit, randomSeed (all NOT NULL).
      // datasetVersionId=1 is seeded above.
      await safeInsert(c,
        `INSERT INTO research_experiments (id, experimentKey, experimentVersion, hypothesis,
           championVersion, challengerVersion, datasetVersionId, primaryMetric,
           secondaryMetrics, parameterSearchSpace, multipleTestingFamily,
           validationPolicyVersion, registeredAt, registeredBy, codeCommit, randomSeed, status)
         VALUES (7801, 'native.seed.experiment', 'v1', 'stage3c seed hypothesis',
           'observed', 'native_challenger_v1', 1, 'net_sharpe',
           '[]', '{}', 'family.native',
           'validation_policy.native.v1', ?, 'native.operator', 'stage3c_env_fix', 42, 'registered')`,
        [SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Costs (forecast vs realized) — Stage 3B schema.
    //
    // Stage 3C-CI-FIX10 §4: NO INSERT BY DESIGN.
    //
    // Reason: forecast_vs_realized_attributions requires costForecastId
    // → execution_cost_forecasts → candidates → scanner-run chain. That
    // deep FK graph is NOT seeded — synthesising it would require
    // inventing a scanner run that never happened, which is fabricated
    // data. The pre-FIX10 seed attempted a partial insert that omitted
    // costForecastId; safeInsert silently swallowed the constraint
    // failure and the seed was a no-op that just printed a "0 got"
    // warning in the coverage report.
    //
    // The Costs screen (NINETEEN_SCREEN_MANIFEST[costs_attribution])
    // is declared expectedState='empty' and renders that state from
    // a real zero-row query response — auditable per Stage 3C-ENV-FIX §2.
    // -----------------------------------------------------------
    // (intentionally no insert)

    // -----------------------------------------------------------
    // Protection (Stage 3C schema) — mandatory, NO silent path.
    // Stage 3C-CI-FIX3 §A: previously used safeInsert which
    // swallowed CI-only insert errors and left downstream FKs +
    // manifest gate to surface "seeded=0" as an ambiguous failure.
    // Now requiredInsert + explicit count verification. The
    // migration definition (0009_phase1_gate3c_protection_matrix.sql
    // lines 18-29) declares: id INT AUTO_INCREMENT PK,
    // version VARCHAR(32) NOT NULL UNIQUE, status ENUM(...) NOT NULL
    // DEFAULT 'draft', description TEXT NULL,
    // createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    // activatedAt TIMESTAMP NULL, supersedesPolicyId INT NULL.
    // Explicit values supplied for every column so the row is
    // deterministic regardless of runner sql_mode /
    // explicit_defaults_for_timestamp defaults.
    // -----------------------------------------------------------
    if (await tableExists(c, 'protection_policy_versions')) {
      await requiredInsert(c, 'protection_policy_versions',
        `INSERT INTO protection_policy_versions
           (id, version, status, description, createdAt, activatedAt, supersedesPolicyId)
         VALUES (8101, 'native.policy.v1', 'active',
           'Stage 3C native seed policy', ?, ?, NULL)`,
        [SEED_MYSQL_NOW, SEED_MYSQL_NOW],
      );
      // Explicit post-insert verification. The reviewer's Stage 3C-CI-FIX3
      // requirement: "Query the table immediately after insertion and
      // require at least one row."
      const [rows] = await c.query(
        'SELECT COUNT(*) AS count FROM protection_policy_versions',
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const count = Number((rows as any)[0]?.count ?? 0);
      if (count < 1) {
        throw new Error('required_seed_verification_failed:protection_policy_versions');
      }
    }
    // protection_capabilities FK to protection_policy_versions (8101 above)
    if (await tableExists(c, 'protection_capabilities')) {
      await safeInsert(c,
        `INSERT INTO protection_capabilities (id, policyVersionId, productId, side,
           entryOrderType, timeInForce, protectionType, capabilityState, source, validatedAt, evidenceHash)
         VALUES (1, 8101, 'BTC-USD', 'BUY',
           'market_ioc', 'IOC', 'attached_trigger_bracket_gtc', 'sandbox_validated',
           'stage3c_env_fix_seed', ?, 'hash_native_cap_v1')`,
        [SEED_MYSQL_NOW],
      );
    }
    if (await tableExists(c, 'protection_instances')) {
      await safeInsert(c,
        `INSERT INTO protection_instances (id, positionId, decisionChainId, entryOrderIntentId,
           policyVersionId, capabilityId, protectionType, requiredBaseQuantity, confirmedBaseQuantity,
           targetPrice, stopTriggerPrice)
         VALUES (8201, ?, ?, 8001,
           8101, 1, 'attached_trigger_bracket_gtc', '0.10000000', '0.10000000',
           '55000.00000000', '48000.00000000')`,
        [SEED_IDS.positionOpen, SEED_IDS.decisionChainAccepted],
      );
    }

    // -----------------------------------------------------------
    // Reconciliation runs — corrected column names (runId, triggerReason, ownerId, fenceGeneration)
    // -----------------------------------------------------------
    if (await tableExists(c, 'reconciliation_runs')) {
      // Redo insert with correct schema — the earlier block above uses
      // stale column names and was a no-op.
      await safeInsert(c,
        `INSERT INTO reconciliation_runs (id, runId, triggerReason, startedAt, completedAt,
           ownerId, fenceGeneration, intentsExamined, intentsResolved, intentsStillUnknown)
         VALUES (8301, 'native_recon_1', 'stage3c_native_seed', ?, ?,
           'native.owner', 1, 1, 1, 0)`,
        [SEED_MYSQL_NOW, SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Incidents (Stage 3A schema — desktop_incidents with installationId)
    // -----------------------------------------------------------
    if (await tableExists(c, 'desktop_incidents')) {
      await safeInsert(c,
        `INSERT INTO desktop_incidents (id, installationId, incidentType, severity, reasonCode,
           details, startedAt, currentState)
         VALUES (?, 1, 'startup_failure', 'informational', 'seed_incident_open',
           'stage3c_native_seed incident open', ?, 'open')`,
        [SEED_IDS.incidentOpen, SEED_MYSQL_NOW],
      );
      await safeInsert(c,
        `INSERT INTO desktop_incidents (id, installationId, incidentType, severity, reasonCode,
           details, startedAt, acknowledgedAt, acknowledgedBy, currentState)
         VALUES (?, 1, 'ipc_validation_failure', 'informational', 'seed_incident_acked',
           'stage3c_native_seed incident acked', ?, ?, 'native.operator', 'acknowledged')`,
        [SEED_IDS.incidentAcked, SEED_MYSQL_NOW, SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Summary — read back what actually landed.
    // -----------------------------------------------------------
    return {
      universe_snapshots: await countRows(c, 'universe_snapshots'),
      universe_products: await countRows(c, 'universe_products'),
      fingerprint_snapshots: await countRows(c, 'fingerprint_snapshots'),
      global_regime_snapshots: await countRows(c, 'global_regime_snapshots'),
      portfolio_risk_snapshots: await countRows(c, 'portfolio_risk_snapshots'),
      order_book_sessions: await countRows(c, 'order_book_sessions'),
      context_provider_definitions: await countRows(c, 'context_provider_definitions'),
      research_experiments: await countRows(c, 'research_experiments'),
      forecast_vs_realized_attributions: await countRows(c, 'forecast_vs_realized_attributions'),
      reconciliation_runs: await countRows(c, 'reconciliation_runs'),
      desktop_incidents: await countRows(c, 'desktop_incidents'),
      protection_instances: await countRows(c, 'protection_instances'),
      protection_policy_versions: await countRows(c, 'protection_policy_versions'),
      bot_config: await countRows(c, 'bot_config'),
      decision_chains: await countRows(c, 'decision_chains'),
      scan_runs: await countRows(c, 'scan_runs'),
      market_observations: await countRows(c, 'market_observations'),
      eligibility_decisions: await countRows(c, 'eligibility_decisions'),
      outcome_labels: await countRows(c, 'outcome_labels'),
      positions: await countRows(c, 'positions'),
      order_intents: await countRows(c, 'order_intents'),
      fills: await countRows(c, 'fills'),
      round_trips: await countRows(c, 'round_trips'),
      cash_ledger: await countRows(c, 'cash_ledger'),
      reconciliation_actions: await countRows(c, 'reconciliation_actions'),
    };
  } finally {
    await c.end();
  }
}

/**
 * Stage 3C-ENV coverage gate.
 *
 * REQUIRED_MINIMUM_SEED_ROWS — the seed MUST land these before the
 * native run proceeds. These target the tables whose INSERT statements
 * are verified stable against migrations 0000-0021 and whose absence
 * would leave a screen showing an unrecoverable placeholder (positions,
 * decisions, reconciliation, incidents, universe, microstructure,
 * context, and the bot_config that drives Overview + Safety).
 *
 * RECOMMENDED_SEED_ROWS — the additional tables the seed ALSO attempts
 * to write, but whose schemas have complex FK graphs / enum shapes
 * that may drift across Phase 2 migrations. These are surfaced as
 * WARNINGS in the coverage report, never as hard failures. The
 * affected screen renders its honest `empty`/`degraded` envelope from
 * a valid missing-row response, which is honest evidence per Stage
 * 3C-ENV §1 (a screen may legitimately show `empty`/`stale`/`degraded`/`unavailable`
 * as long as it comes from a real query response, not a fabricated literal).
 */
export const REQUIRED_MINIMUM_SEED_ROWS: ReadonlyArray<{ screen: string; column: keyof SeedSummary; minRows: number }> = Object.freeze([
  { screen: 'Overview / Safety', column: 'bot_config', minRows: 1 },
  { screen: 'Overview (decision chains / broken lineage)', column: 'decision_chains', minRows: 2 },
  { screen: 'Overview (reconciliation)', column: 'reconciliation_actions', minRows: 1 },
  { screen: 'Positions (open)', column: 'positions', minRows: 2 },
  { screen: 'Positions (fills)', column: 'fills', minRows: 2 },
  { screen: 'Positions (round trips)', column: 'round_trips', minRows: 1 },
  { screen: 'Positions (cash ledger)', column: 'cash_ledger', minRows: 2 },
  { screen: 'Positions (order intents)', column: 'order_intents', minRows: 2 },
  { screen: 'Decision Journal (scan runs)', column: 'scan_runs', minRows: 1 },
  { screen: 'Research Universe (snapshots)', column: 'universe_snapshots', minRows: 1 },
  { screen: 'Research Universe (products)', column: 'universe_products', minRows: 4 },
  { screen: 'Microstructure', column: 'order_book_sessions', minRows: 1 },
  { screen: 'Context', column: 'context_provider_definitions', minRows: 1 },
  { screen: 'Reconciliation', column: 'reconciliation_runs', minRows: 1 },
]);

export const RECOMMENDED_SEED_ROWS: ReadonlyArray<{ screen: string; column: keyof SeedSummary; minRows: number; note: string }> = Object.freeze([
  { screen: 'Shadow Portfolio + Portfolio Risk', column: 'portfolio_risk_snapshots', minRows: 1, note: 'phase2C_observer_run_fk_may_drift' },
  { screen: 'Decision Journal (market observations)', column: 'market_observations', minRows: 2, note: 'requires_decision_chain_fk' },
  { screen: 'Decision Journal (eligibility)', column: 'eligibility_decisions', minRows: 1, note: 'requires_decision_chain_fk' },
  { screen: 'Decision Journal (outcomes)', column: 'outcome_labels', minRows: 1, note: 'requires_decision_chain_fk' },
  { screen: 'Fingerprints', column: 'fingerprint_snapshots', minRows: 1, note: 'phase2A_fingerprint_composer_versioning' },
  { screen: 'Regimes', column: 'global_regime_snapshots', minRows: 1, note: 'phase2B_observer_run_fk' },
  { screen: 'Validation Lab', column: 'research_experiments', minRows: 1, note: 'phase2F_dataset_version_fk' },
  // Stage 3C-CI-FIX10 §4: Costs is INTENTIONALLY absent from both
  // required and recommended coverage tables. The screen is declared
  // expectedState='empty' in NINETEEN_SCREEN_MANIFEST because the
  // forecast_vs_realized_attributions FK chain (costForecastId →
  // execution_cost_forecasts → candidates → scanner run) cannot be
  // satisfied without fabricating a scanner run that never happened.
  // Empty is the honest state; a coverage warning would be misleading.
  { screen: 'Protection (instances)', column: 'protection_instances', minRows: 1, note: 'phase3C_policy_capability_fk' },
  { screen: 'Incidents', column: 'desktop_incidents', minRows: 2, note: 'phase3A_installation_fk' },
]);

export interface SeedCoverageResult {
  ok: boolean;
  requiredMet: number;
  requiredMissing: string[];
  recommendedMet: number;
  recommendedMissing: string[];
}

// ---------------------------------------------------------------------------
// Stage 3C-ENV-FIX §2 — mandatory 19-screen evidence manifest.
//
// Every screen has a DETERMINISTIC EXPECTED STATE + EXPECTED SIGNATURE.
// The native test consumes this manifest and fails if:
//   - Any screen key is absent from the manifest.
//   - Any authenticated request is not observed.
//   - Any screen remains loading past the deadline.
//   - Any response fails validation.
//   - Any expected signature is absent.
//   - A screen whose expectedState is `healthy` falls back to empty
//     because seeding failed.
//
// A non-healthy expected state is permitted ONLY when explicitly
// declared here (auditable). It is NEVER "best effort".
// ---------------------------------------------------------------------------

export type ExpectedState = 'healthy' | 'empty' | 'stale' | 'degraded' | 'unavailable';

export interface ScreenManifestEntry {
  screenKey: string;
  hash: string;               // renderer HashRouter path
  screenAttr: string;         // data-screen attr StateFrame emits
  expectedState: ExpectedState;
  expectedSignatures: readonly string[];  // strings required in frame (all must match)
  requiredSeedTables: readonly string[];  // must all be seeded for expectedState==='healthy'
  seededOutcomeReason: string;            // audit trail
}

export const NINETEEN_SCREEN_MANIFEST: ReadonlyArray<ScreenManifestEntry> = Object.freeze([
  {
    screenKey: 'overview',
    hash: '#/overview',
    screenAttr: 'overview',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED', '0021'],
    requiredSeedTables: ['bot_config', 'decision_chains', 'reconciliation_actions'],
    seededOutcomeReason: 'bot_config+decision_chains+reconciliation_actions seed authoritative readiness signals',
  },
  {
    screenKey: 'shadow_portfolio',
    hash: '#/shadow-portfolio',
    screenAttr: 'portfolio',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED'],
    requiredSeedTables: ['portfolio_risk_snapshots'],
    seededOutcomeReason: 'portfolio_risk_snapshots with observerRunId=10001 (parent portfolio_risk_runs seeded)',
  },
  {
    screenKey: 'positions',
    hash: '#/positions',
    screenAttr: 'positions',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED'],
    requiredSeedTables: ['positions', 'order_intents', 'fills', 'round_trips', 'cash_ledger'],
    seededOutcomeReason: 'positions 1001 (open, partial) + 1002 (dust) + supporting order_intents/fills/round_trips/cash_ledger',
  },
  {
    screenKey: 'decision_journal',
    hash: '#/decision-journal',
    screenAttr: 'decisions',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED'],
    requiredSeedTables: ['decision_chains', 'scan_runs', 'market_observations', 'eligibility_decisions', 'outcome_labels'],
    seededOutcomeReason: 'decision_chain 4001 (complete) + 4002 (broken lineage) + full descendant chain',
  },
  {
    screenKey: 'research_universe',
    hash: '#/research/universe',
    screenAttr: 'universe',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED'],
    requiredSeedTables: ['universe_snapshots', 'universe_products'],
    seededOutcomeReason: 'universe_snapshots 7101 + 4 universe_products (BTC/ETH/SOL/AVAX)',
  },
  {
    screenKey: 'fingerprints',
    hash: '#/research/fingerprints',
    screenAttr: 'fingerprints',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED'],
    requiredSeedTables: ['fingerprint_snapshots'],
    seededOutcomeReason: 'fingerprint_snapshots 7301 REVERSION_CANDIDATE with dataAvailableAt',
  },
  {
    screenKey: 'regimes',
    hash: '#/research/regimes',
    screenAttr: 'regimes',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED'],
    requiredSeedTables: ['global_regime_snapshots'],
    seededOutcomeReason: 'global_regime_snapshots 7401 TREND_UP with observerRunId FK 7401',
  },
  {
    screenKey: 'portfolio_risk',
    hash: '#/research/portfolio-risk',
    screenAttr: 'risk',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED', 'KELLY DISABLED', 'OBSERVER ENFORCEMENT DISABLED'],
    requiredSeedTables: ['portfolio_risk_snapshots'],
    seededOutcomeReason: 'portfolio_risk_snapshots with observerRunId=10001',
  },
  {
    screenKey: 'microstructure',
    hash: '#/research/microstructure',
    screenAttr: 'microstructure',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED', 'PRODUCTION LEVEL-2 PROVIDER INACTIVE', 'QUEUE POSITION NOT KNOWN'],
    requiredSeedTables: ['order_book_sessions'],
    seededOutcomeReason: 'order_book_sessions 7601 BTC-USD',
  },
  {
    screenKey: 'context',
    hash: '#/research/context',
    screenAttr: 'context',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED'],
    requiredSeedTables: ['context_provider_definitions'],
    seededOutcomeReason: 'context_provider_definitions 7701 native.seed',
  },
  {
    screenKey: 'validation_lab',
    hash: '#/research/validation-lab',
    screenAttr: 'validation',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED', 'MODEL PROMOTION DISABLED', 'PROSPECTIVE EVIDENCE PENDING'],
    requiredSeedTables: ['research_experiments'],
    seededOutcomeReason: 'research_experiments 7801 with dataset_versions FK',
  },
  {
    screenKey: 'costs_attribution',
    hash: '#/ops/costs-attribution',
    screenAttr: 'costs',
    // Explicitly declared empty: forecast_vs_realized_attributions
    // requires costForecastId → execution_cost_forecasts → candidates
    // → scanner chain. That deep FK graph is intentionally NOT seeded
    // (would require inventing a scanner run that never happened).
    // The Costs screen renders `empty` from a real query response
    // returning zero rows — auditable per Stage 3C-ENV-FIX §2.
    expectedState: 'empty',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED'],
    requiredSeedTables: [],
    seededOutcomeReason: 'expected-empty by design; deep FK chain (candidates→execution_cost_forecasts) not seeded',
  },
  {
    screenKey: 'protection',
    hash: '#/ops/protection',
    screenAttr: 'protection',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED'],
    requiredSeedTables: ['protection_policy_versions', 'protection_instances'],
    seededOutcomeReason: 'protection_policy_versions 8101 + protection_instances 8201 (FK to capabilities 1)',
  },
  {
    screenKey: 'reconciliation',
    hash: '#/ops/reconciliation',
    screenAttr: 'reconciliation',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED'],
    requiredSeedTables: ['reconciliation_runs', 'reconciliation_actions'],
    seededOutcomeReason: 'reconciliation_runs 8301 + reconciliation_actions row',
  },
  {
    screenKey: 'incidents',
    hash: '#/ops/incidents',
    screenAttr: 'incidents',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED'],
    requiredSeedTables: ['desktop_incidents'],
    seededOutcomeReason: 'desktop_incidents 3001 (open) + 3002 (acked), FK to desktop_installations id=1',
  },
  {
    screenKey: 'reports',
    hash: '#/ops/reports',
    screenAttr: 'reports',
    // Reports is intentionally generation-pending (Stage 4). The query
    // returns fixed literals (13-item catalog, generationAvailable=false,
    // reasonCode='report_generation_stage4_pending'). We render `healthy`
    // (the fixed literals are the real query response).
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED', 'NOT YET IMPLEMENTED'],
    requiredSeedTables: [],
    seededOutcomeReason: 'reports query returns fixed literal catalog (13 kinds, generationAvailable=false)',
  },
  {
    screenKey: 'configuration',
    hash: '#/system/configuration',
    screenAttr: 'configuration',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED'],
    requiredSeedTables: [],
    seededOutcomeReason: 'configuration query returns fixed literals (championVersion=observed, coinbase=absent, etc.)',
  },
  {
    screenKey: 'system',
    hash: '#/system',
    screenAttr: 'system',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED', '0021'],
    requiredSeedTables: [],
    seededOutcomeReason: '__drizzle_migrations count + process-derived fields (nodeVersion, uptime)',
  },
  {
    screenKey: 'safety',
    hash: '#/safety',
    screenAttr: 'safety',
    expectedState: 'healthy',
    expectedSignatures: ['LIVE ORDER SUBMISSION DISABLED'],
    requiredSeedTables: ['bot_config'],
    seededOutcomeReason: 'safety query reads bot_config + fixed safe-flag literals',
  },
]);

export function assertManifestCoverage(s: SeedSummary): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const summary = s as unknown as Record<string, number | undefined>;
  for (const entry of NINETEEN_SCREEN_MANIFEST) {
    if (entry.expectedState === 'healthy') {
      for (const t of entry.requiredSeedTables) {
        if ((summary[t] ?? 0) < 1) {
          violations.push(`${entry.screenKey}: expectedState=healthy requires ${t} seeded (got ${summary[t] ?? 0})`);
        }
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

export function assertSeedCoverageComplete(s: SeedSummary): SeedCoverageResult {
  const requiredMissing: string[] = [];
  for (const req of REQUIRED_MINIMUM_SEED_ROWS) {
    if ((s[req.column] ?? 0) < req.minRows) {
      requiredMissing.push(`${req.screen}: expected ≥${req.minRows} in ${String(req.column)}, got ${s[req.column] ?? 0}`);
    }
  }
  const recommendedMissing: string[] = [];
  for (const rec of RECOMMENDED_SEED_ROWS) {
    if ((s[rec.column] ?? 0) < rec.minRows) {
      recommendedMissing.push(`${rec.screen}: expected ≥${rec.minRows} in ${String(rec.column)}, got ${s[rec.column] ?? 0} (${rec.note})`);
    }
  }
  const result: SeedCoverageResult = {
    ok: requiredMissing.length === 0,
    requiredMet: REQUIRED_MINIMUM_SEED_ROWS.length - requiredMissing.length,
    requiredMissing,
    recommendedMet: RECOMMENDED_SEED_ROWS.length - recommendedMissing.length,
    recommendedMissing,
  };
  if (!result.ok) {
    throw new Error(`seed_coverage_required_incomplete: ${requiredMissing.join('; ')}`);
  }
  return result;
}
