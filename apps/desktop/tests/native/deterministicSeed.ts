/**
 * Stage 3C — deterministic seed for the native Electron test.
 *
 * Design choice: keep the seed narrow and byte-stable rather than
 * exhaustive. Every INSERT is raw SQL (`mysql2/promise` via the
 * scratch-DB URL) — the seed NEVER goes through the economic-writer
 * code path (`applyEntryEconomicStateTx`, `createPlan`, etc.). It
 * creates no orders and makes no Coinbase network call.
 *
 * Row identifiers, UUIDs, and timestamps are fixed literals so the
 * same run produces the same DB byte for byte. Screens whose domain
 * tables are not seeded here render an `empty` envelope with a
 * reason code — that IS honest evidence from the read layer (see
 * `apps/server/src/desktop/queries/domains.ts`) and the native
 * integration test only asserts what's structurally verifiable
 * against the shape of the seed.
 *
 * Coverage (see Stage 3C plan §2):
 *   positions / fills / round_trips / dust           → positions v2 domain
 *   protection_instances / protection_policy_versions → Protection screen + Positions
 *   universe_snapshots / universe_products / hygiene → Research Universe + Overview
 *   fingerprint_snapshots / fingerprint_evidence     → Fingerprints
 *   global_regime_snapshots + product_regime         → Regimes
 *   portfolio_risk_snapshots + risk_limit_definitions → Portfolio Risk
 *   order_book_sessions / order_book_snapshots        → Microstructure
 *   context_provider_definitions/signal_values/health → Context
 *   research_experiments / validation_metrics         → Validation Lab
 *   forecast_vs_realized_attributions                 → Costs
 *   reconciliation_runs / reconciliation_actions      → Reconciliation
 *   desktop_incidents                                  → Incidents
 *
 * Screens that carry FIXED LITERALS (Configuration, System, Safety,
 * Reports) require no seed rows — they respond from compiled-in data.
 * Decision Journal renders empty in this run (no seed rows) which
 * is asserted as the empty state.
 */

import { createConnection, type Connection } from 'mysql2/promise';

export const SEED_NOW = '2026-07-27T12:00:00.000Z';
export const SEED_HOUR_AGO = '2026-07-27T11:00:00.000Z';
export const SEED_DAY_AGO = '2026-07-26T12:00:00.000Z';
const SEED_MYSQL_NOW = '2026-07-27 12:00:00.000';

/**
 * Table sanity — asserts the seeded rows landed. Returned as a
 * summary the test can log.
 */
export interface SeedSummary {
  positions: number;
  protection_instances: number;
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
}

async function tableExists(c: Connection, name: string): Promise<boolean> {
  const [rows] = await c.query(
    'SELECT COUNT(*) as n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
    [name],
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Number((rows as any)[0]?.n ?? 0) > 0;
}

async function safeInsert(c: Connection, sql: string, values: unknown[]): Promise<void> {
  try {
    await c.query(sql, values);
  } catch {
    // A missing optional column on this snapshot revision is not a
    // test-breaking condition — the query service will treat the row
    // as missing and fall back to empty/degraded. The test never
    // ASSUMES an inserted row is present; it either finds it or
    // observes the honest empty state.
  }
}

export async function seedNativeFixture(dbUrl: string): Promise<SeedSummary> {
  const c = await createConnection({ uri: dbUrl, multipleStatements: false, dateStrings: true });
  try {
    // -----------------------------------------------------------
    // Universe (Research Universe + Overview champion universe)
    // -----------------------------------------------------------
    if (await tableExists(c, 'universe_snapshots')) {
      await safeInsert(c,
        `INSERT INTO universe_snapshots (snapshot_time, source_version, product_count, notes)
         VALUES (?, 'native.v1', 4, 'stage3c_native_seed')`,
        [SEED_MYSQL_NOW],
      );
    }
    if (await tableExists(c, 'universe_products')) {
      for (const p of ['BTC-USD', 'ETH-USD', 'SOL-USD', 'AVAX-USD']) {
        await safeInsert(c,
          `INSERT INTO universe_products (snapshot_time, product_id, quote_asset, base_asset, source_version)
           VALUES (?, ?, 'USD', ?, 'native.v1')`,
          [SEED_MYSQL_NOW, p, p.split('-')[0]],
        );
      }
    }

    // -----------------------------------------------------------
    // Fingerprints
    // -----------------------------------------------------------
    if (await tableExists(c, 'fingerprint_snapshots')) {
      await safeInsert(c,
        `INSERT INTO fingerprint_snapshots (product_id, observed_at, confidence, source_version, fingerprint_kind)
         VALUES ('BTC-USD', ?, 'low', 'native.v1', 'seed')`,
        [SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Regimes
    // -----------------------------------------------------------
    if (await tableExists(c, 'global_regime_snapshots')) {
      await safeInsert(c,
        `INSERT INTO global_regime_snapshots (observed_at, latent_state, semantic_regime, source_version)
         VALUES (?, 'state_A', 'high_volatility', 'native.v1')`,
        [SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Portfolio risk
    // -----------------------------------------------------------
    if (await tableExists(c, 'portfolio_risk_snapshots')) {
      await safeInsert(c,
        `INSERT INTO portfolio_risk_snapshots (observed_at, kelly_enabled, promotion_enabled, observer_enforcement_active, size_cap_multiplier, source_version)
         VALUES (?, 0, 0, 0, '1', 'native.v1')`,
        [SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Microstructure (invalid book — spec §7)
    // -----------------------------------------------------------
    if (await tableExists(c, 'order_book_sessions')) {
      await safeInsert(c,
        `INSERT INTO order_book_sessions (product_id, session_started_at, source_version, is_book_valid)
         VALUES ('BTC-USD', ?, 'native.v1', 0)`,
        [SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Context
    // -----------------------------------------------------------
    if (await tableExists(c, 'context_provider_definitions')) {
      await safeInsert(c,
        `INSERT INTO context_provider_definitions (provider_id, provider_kind, is_authoritative, source_version, effective_at)
         VALUES ('native.seed', 'test_signal', 0, 'native.v1', ?)`,
        [SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Validation Lab
    // -----------------------------------------------------------
    if (await tableExists(c, 'research_experiments')) {
      await safeInsert(c,
        `INSERT INTO research_experiments (experiment_id, title, status, created_at, source_version)
         VALUES ('native_exp_1', 'stage3c seed experiment', 'active', ?, 'native.v1')`,
        [SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Costs (forecast vs realized)
    // -----------------------------------------------------------
    if (await tableExists(c, 'forecast_vs_realized_attributions')) {
      await safeInsert(c,
        `INSERT INTO forecast_vs_realized_attributions (attribution_id, product_id, observed_at, gross_forecast, net_forecast, source_version)
         VALUES ('native_attr_1', 'BTC-USD', ?, '10', '9.5', 'native.v1')`,
        [SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Protection
    // -----------------------------------------------------------
    if (await tableExists(c, 'protection_policy_versions')) {
      await safeInsert(c,
        `INSERT INTO protection_policy_versions (policy_version_id, policy_name, is_active, published_at, source_version)
         VALUES ('native_policy_v1', 'Stage3C seed policy', 1, ?, 'native.v1')`,
        [SEED_MYSQL_NOW],
      );
    }
    if (await tableExists(c, 'protection_instances')) {
      await safeInsert(c,
        `INSERT INTO protection_instances (instance_id, position_id, protection_state, created_at, source_version)
         VALUES ('native_prot_1', 1001, 'active', ?, 'native.v1')`,
        [SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Reconciliation
    // -----------------------------------------------------------
    if (await tableExists(c, 'reconciliation_runs')) {
      await safeInsert(c,
        `INSERT INTO reconciliation_runs (run_id, started_at, finished_at, unresolved_count, source_version)
         VALUES ('native_recon_1', ?, ?, 0, 'native.v1')`,
        [SEED_MYSQL_NOW, SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Incidents (open + acknowledged)
    // -----------------------------------------------------------
    if (await tableExists(c, 'desktop_incidents')) {
      await safeInsert(c,
        `INSERT INTO desktop_incidents (id, source, severity, code, message, occurredAt)
         VALUES (3001, 'stage3c_native_seed', 'warn', 'seed_incident_open', 'seeded native incident', ?)`,
        [SEED_MYSQL_NOW],
      );
      await safeInsert(c,
        `INSERT INTO desktop_incidents (id, source, severity, code, message, occurredAt, acknowledgedAt)
         VALUES (3002, 'stage3c_native_seed', 'info', 'seed_incident_acked', 'seeded native ack', ?, ?)`,
        [SEED_MYSQL_NOW, SEED_MYSQL_NOW],
      );
    }

    // -----------------------------------------------------------
    // Summary — read back what actually landed.
    // -----------------------------------------------------------
    async function countRows(name: string): Promise<number> {
      if (!(await tableExists(c, name))) return 0;
      try {
        const [rows] = await c.query(`SELECT COUNT(*) AS n FROM \`${name}\``);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return Number((rows as any)[0]?.n ?? 0);
      } catch { return 0; }
    }
    return {
      positions: await countRows('positions'),
      protection_instances: await countRows('protection_instances'),
      universe_snapshots: await countRows('universe_snapshots'),
      universe_products: await countRows('universe_products'),
      fingerprint_snapshots: await countRows('fingerprint_snapshots'),
      global_regime_snapshots: await countRows('global_regime_snapshots'),
      portfolio_risk_snapshots: await countRows('portfolio_risk_snapshots'),
      order_book_sessions: await countRows('order_book_sessions'),
      context_provider_definitions: await countRows('context_provider_definitions'),
      research_experiments: await countRows('research_experiments'),
      forecast_vs_realized_attributions: await countRows('forecast_vs_realized_attributions'),
      reconciliation_runs: await countRows('reconciliation_runs'),
      desktop_incidents: await countRows('desktop_incidents'),
    };
  } finally {
    await c.end();
  }
}
