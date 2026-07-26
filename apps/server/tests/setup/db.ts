import mysql from 'mysql2/promise';

/**
 * Test-only DB helper. Uses the same MariaDB the dev environment runs — tests
 * TRUNCATE all Phase-0 tables between runs so they are hermetic. Migrations are
 * applied once (idempotent).
 */

export async function resetDatabase(): Promise<void> {
  const conn = await mysql.createConnection({
    uri: process.env.DATABASE_URL ?? 'mysql://root:password@127.0.0.1:3306/horizon_trade',
  });
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS=0');
    for (const t of [
      'round_trips',
      'fills',
      'order_intents',
      'positions',
      'cash_ledger',
      'activity_log',
      'token_stats',
      'trades',
      'bot_config',
      // Phase 1 immutable decision tables.
      'quantitative_decisions',
      'execution_cost_forecasts',
      'signal_candidates',
      'fee_tier_snapshots',
      // Phase 1.1 Gate 3B addition.
      'forecast_vs_realized_attributions',
      // Phase 1.1 Gate 3C additions — child tables first (FK order).
      'protection_events',
      'protection_instances',
      'protection_validation_runs',
      'protection_capabilities',
      'protection_policy_versions',
      // Phase 1.1 Gate 3D additions — child first.
      'shadow_certification_runs',
      'post_fill_revalidations',
      'shadow_execution_plans',
      // Phase 1.2 additions — child first.
      'shadow_daily_reports',
      'shadow_operation_runs',
      'forward_outcome_labels',
      'market_trade_observations',
      'ticker_observations',
      'candle_observations',
      'product_market_states',
      'market_data_gaps',
      'market_data_events',
      'market_stream_subscriptions',
      'market_stream_sessions',
      // Phase 1.1.b additions.
      'execution_fences',
      'reconciliation_runs',
      'reconciliation_actions',
      // Phase 1.1 Gate 2 additions.
      'lineage_events',
      'outcome_labels',
      'strategy_routing_decisions',
      'setup_evaluations',
      'eligibility_decisions',
      'market_observations',
      'decision_chains',
      'scan_runs',
    ]) {
      await conn.query(`TRUNCATE TABLE \`${t}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS=1');
  } finally {
    await conn.end();
  }
}
