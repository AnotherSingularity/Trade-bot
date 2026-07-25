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
      // Phase 1.1.b additions.
      'execution_fences',
      'reconciliation_runs',
      'reconciliation_actions',
    ]) {
      await conn.query(`TRUNCATE TABLE \`${t}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS=1');
  } finally {
    await conn.end();
  }
}
