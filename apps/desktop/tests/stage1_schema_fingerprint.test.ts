import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnection } from 'mysql2/promise';
import { SchemaFingerprintVerifier } from '../src/main/schemaFingerprint';

const CONN = { host: '127.0.0.1', port: 3306, user: 'root', password: 'password', database: 'horizon_stage1_fingerprint' };

async function ddl(sql: string): Promise<void> {
  const c = await createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: 'password', multipleStatements: true });
  try { await c.query(sql); } finally { await c.end(); }
}

describe('stage1 §8 — schema fingerprint verifier', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'stage1-fp-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  beforeAll(async () => {
    await ddl('DROP DATABASE IF EXISTS horizon_stage1_fingerprint; CREATE DATABASE horizon_stage1_fingerprint;');
    await ddl(`USE horizon_stage1_fingerprint;
      CREATE TABLE __drizzle_migrations (id INT PRIMARY KEY AUTO_INCREMENT, hash VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL);
      INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('h', 0);
      CREATE TABLE thing (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(64) NOT NULL);`);
  }, 15_000);

  it('T-S1.21a: fingerprint verified matches canonical', async () => {
    // Compute the live fingerprint once, then treat it as canonical.
    const v = new SchemaFingerprintVerifier();
    const fp1 = await v.verify({
      connection: CONN,
      expectedFingerprintPath: writeCanonical(dir, 'placeholder', 1),
    });
    expect(fp1.state).toBe('fingerprint_mismatch');
    if (fp1.actualFingerprint) {
      const good = await v.verify({
        connection: CONN,
        expectedFingerprintPath: writeCanonical(dir, fp1.actualFingerprint, 1),
      });
      expect(good.state).toBe('verified');
    }
  });

  it('T-S1.21: fingerprint mismatch blocks startup', async () => {
    const v = new SchemaFingerprintVerifier();
    const r = await v.verify({
      connection: CONN,
      expectedFingerprintPath: writeCanonical(dir, 'wrong-hash', 1),
    });
    expect(r.state).toBe('fingerprint_mismatch');
  });

  it('T-S1.21b: applied < canonical → migration_required', async () => {
    const v = new SchemaFingerprintVerifier();
    const r = await v.verify({
      connection: CONN,
      expectedFingerprintPath: writeCanonical(dir, 'x', 99),
    });
    expect(r.state).toBe('migration_required');
  });

  it('T-S1.21c: applied > canonical → unsupported_schema', async () => {
    const v = new SchemaFingerprintVerifier();
    const r = await v.verify({
      connection: CONN,
      expectedFingerprintPath: writeCanonical(dir, 'x', 0),
    });
    expect(r.state).toBe('unsupported_schema');
  });
});

function writeCanonical(dir: string, fingerprint: string, migrationJournalHead: number): string {
  const p = join(dir, `canon-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(p, JSON.stringify({ fingerprint, migrationJournalHead, schemaName: 'horizon_stage1_fingerprint' }));
  return p;
}
