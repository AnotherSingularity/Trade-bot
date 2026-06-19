import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { ENV } from '../env';
import * as schema from './schema';

/**
 * Lazily-created MySQL connection pool + Drizzle instance.
 *
 * A single shared pool is used across the Express server and the BullMQ worker.
 */
let pool: mysql.Pool | null = null;
let dbInstance: MySql2Database<typeof schema> | null = null;

export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      uri: ENV.databaseUrl,
      connectionLimit: 10,
      waitForConnections: true,
    });
  }
  return pool;
}

export function getDb(): MySql2Database<typeof schema> {
  if (!dbInstance) {
    dbInstance = drizzle(getPool(), { schema, mode: 'default' });
  }
  return dbInstance;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    dbInstance = null;
  }
}

export const db = getDb();
export { schema };
