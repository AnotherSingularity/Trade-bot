import { migrate } from 'drizzle-orm/mysql2/migrator';
import { getDb, closeDb } from './index';

/** Applies pending SQL migrations from drizzle/migrations. */
async function main() {
  console.log('[migrate] applying migrations…');
  await migrate(getDb(), { migrationsFolder: './drizzle/migrations' });
  console.log('[migrate] done');
  await closeDb();
}

main().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
