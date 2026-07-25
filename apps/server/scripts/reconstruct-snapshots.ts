import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { canonicalStringify } from './lib/canonical-json';
import { introspectMariadb } from './lib/mariadb-introspect';
import { buildDrizzleSnapshot, deterministicSnapshotId } from './lib/to-drizzle-snapshot';
import {
  FINGERPRINT_VERSION,
  buildSchemaFingerprint,
  diffFingerprints,
} from './lib/schema-fingerprint';

/**
 * Reconstruct drizzle-kit v0.31.10 snapshots from real MariaDB
 * checkpoints (Phase 1.1 Gate 1 §Option 1).
 *
 * Usage:
 *   npx tsx scripts/reconstruct-snapshots.ts \
 *     --url mysql://root:password@127.0.0.1:3306 \
 *     --scratch-db-prefix hzn_snap_ \
 *     [--only 3]              only regenerate checkpoint N
 *     [--dry-run]             don't write files
 *     [--verify]              also validate: no fingerprint drift on re-run
 *
 * Reads migrations from `drizzle/migrations/000N_*.sql` and the
 * matching `_journal.json`. For each checkpoint N:
 *   1. Drop + create scratch DB `<prefix>N`.
 *   2. Apply migrations 0000..N in order (strip drizzle's
 *      `--> statement-breakpoint` markers before feeding to mysql2).
 *   3. Introspect via `information_schema` — bypasses drizzle-kit's
 *      broken check-constraint fetch entirely.
 *   4. Convert to drizzle-kit v0.31.10 snapshot format.
 *   5. Write `drizzle/migrations/meta/NNNN_snapshot.json`
 *      (deterministic key ordering, byte-stable).
 *   6. Build + write `drizzle/migrations/meta/NNNN_mariadb_fingerprint.json`
 *      preserving MariaDB-only details drizzle can't represent.
 *   7. Drop scratch DB.
 *
 * Existing migration SQL files are NEVER edited. Only the snapshot +
 * fingerprint files are (re)written.
 */

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Args {
  url: string;
  scratchPrefix: string;
  only: number | null;
  dryRun: boolean;
  verify: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: 'mysql://root:password@127.0.0.1:3306',
    scratchPrefix: 'hzn_snap_',
    only: null,
    dryRun: false,
    verify: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i]!;
    else if (a === '--scratch-db-prefix') args.scratchPrefix = argv[++i]!;
    else if (a === '--only') args.only = parseInt(argv[++i]!, 10);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verify') args.verify = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const __dirname = (globalThis as any).__dirname
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__dirname as string
  : fileURLToPath(new URL('.', import.meta.url));
const migrationsDir = resolve(__dirname, '..', 'drizzle', 'migrations');
const metaDir = join(migrationsDir, 'meta');
const fingerprintDir = resolve(__dirname, '..', 'drizzle', 'fingerprints');

function readJournal(): JournalEntry[] {
  const raw = JSON.parse(readFileSync(join(metaDir, '_journal.json'), 'utf-8'));
  return raw.entries as JournalEntry[];
}

function readMigrationSql(tag: string): string {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  const match = files.find((f) => f.startsWith(tag) || f.startsWith(tag.split('_')[0] + '_'));
  if (!match) throw new Error(`no migration SQL for tag ${tag}`);
  return readFileSync(join(migrationsDir, match), 'utf-8');
}

async function runSqlAgainst(conn: mysql.Connection, sql: string): Promise<void> {
  // Strip drizzle's statement-breakpoint markers; split on `;` at top level.
  const stripped = sql
    .replace(/-->\s*statement-breakpoint/g, '')
    .split(/\n/)
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');
  // MariaDB accepts multi-statement queries via the multipleStatements flag,
  // but drizzle's migrations are already split by breakpoint. Split manually
  // on `;` at line-ends to be safe.
  const statements: string[] = [];
  let buf = '';
  for (const ch of stripped) {
    buf += ch;
    if (ch === ';') {
      const trimmed = buf.trim();
      if (trimmed.length > 1) statements.push(trimmed);
      buf = '';
    }
  }
  if (buf.trim().length > 0) statements.push(buf.trim());
  for (const stmt of statements) {
    await conn.query(stmt);
  }
}

async function withScratchDb<T>(
  args: Args,
  suffix: string,
  fn: (conn: mysql.Connection, dbName: string) => Promise<T>,
): Promise<T> {
  const dbName = args.scratchPrefix + suffix;
  const rootConn = await mysql.createConnection({
    uri: args.url,
    multipleStatements: true,
  });
  try {
    await rootConn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await rootConn.query(`CREATE DATABASE \`${dbName}\``);
  } finally {
    await rootConn.end();
  }
  const conn = await mysql.createConnection({
    uri: `${args.url}/${dbName}`,
    multipleStatements: true,
  });
  try {
    const result = await fn(conn, dbName);
    return result;
  } finally {
    await conn.end();
    const cleanupConn = await mysql.createConnection({ uri: args.url });
    try {
      await cleanupConn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    } finally {
      await cleanupConn.end();
    }
  }
}

function drizzleKitVersion(): string {
  try {
    const raw = execSync('npm ls drizzle-kit --json', { cwd: resolve(__dirname, '..') });
    const parsed = JSON.parse(raw.toString());
    // Find drizzle-kit anywhere in the tree.
    const walk = (node: unknown): string | null => {
      if (!node || typeof node !== 'object') return null;
      const n = node as Record<string, unknown>;
      if (n.dependencies && typeof n.dependencies === 'object') {
        for (const [name, dep] of Object.entries(n.dependencies as Record<string, unknown>)) {
          if (name === 'drizzle-kit') return (dep as Record<string, string>).version;
          const nested = walk(dep);
          if (nested) return nested;
        }
      }
      return null;
    };
    return walk(parsed) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function reconstructOne(
  args: Args,
  journal: JournalEntry[],
  idx: number,
  drizzleVersion: string,
): Promise<{ snapshotPath: string; fingerprintPath: string; changed: boolean }> {
  const entry = journal[idx];
  if (!entry) throw new Error(`no journal entry at index ${idx}`);
  const previousTag = idx > 0 ? journal[idx - 1].tag : '';
  const suffix = `cp${idx}_${Date.now()}`;
  const result = await withScratchDb(args, suffix, async (conn, dbName) => {
    for (let i = 0; i <= idx; i++) {
      const sql = readMigrationSql(journal[i].tag);
      await runSqlAgainst(conn, sql);
    }
    const schema = await introspectMariadb(
      `${args.url}/${dbName}?multipleStatements=true`,
      dbName,
    );
    const snapshot = buildDrizzleSnapshot(schema, entry.tag, previousTag);
    const fingerprint = buildSchemaFingerprint(schema, drizzleVersion);
    return { snapshot, fingerprint };
  });

  const paddedIdx = String(idx).padStart(4, '0');
  const snapshotPath = join(metaDir, `${paddedIdx}_snapshot.json`);
  const fingerprintPath = join(fingerprintDir, `${paddedIdx}_mariadb_fingerprint.json`);
  const newSnapshotText = canonicalStringify(result.snapshot);
  const newFingerprintText = canonicalStringify(result.fingerprint);

  let changed = false;
  try {
    const existing = readFileSync(snapshotPath, 'utf-8');
    if (existing !== newSnapshotText) changed = true;
  } catch {
    changed = true;
  }
  try {
    const existing = readFileSync(fingerprintPath, 'utf-8');
    if (existing !== newFingerprintText) changed = true;
  } catch {
    changed = true;
  }

  if (!args.dryRun) {
    writeFileSync(snapshotPath, newSnapshotText, 'utf-8');
    writeFileSync(fingerprintPath, newFingerprintText, 'utf-8');
  }
  return { snapshotPath, fingerprintPath, changed };
}

async function main() {
  const args = parseArgs(process.argv);
  const journal = readJournal();
  const drizzleVersion = drizzleKitVersion();
  console.log(`[gate1] drizzle-kit@${drizzleVersion}`);
  console.log(`[gate1] fingerprint schema version = ${FINGERPRINT_VERSION}`);
  console.log(`[gate1] reconstructing ${journal.length} checkpoints from real MariaDB`);

  const indices = args.only !== null ? [args.only] : journal.map((_, i) => i);
  let anyChanged = false;
  for (const idx of indices) {
    const { snapshotPath, fingerprintPath, changed } = await reconstructOne(
      args,
      journal,
      idx,
      drizzleVersion,
    );
    console.log(
      `[gate1] checkpoint ${idx} (${journal[idx].tag}): ${
        changed ? 'CHANGED' : 'unchanged'
      } → ${snapshotPath.replace(migrationsDir, 'drizzle/migrations')}`,
    );
    if (changed) anyChanged = true;
    if (args.verify && changed) {
      throw new Error(
        `--verify mode: checkpoint ${idx} produced different output than the checked-in file. Re-run without --verify to update, then investigate the source of the difference (schema.ts drift?).`,
      );
    }
    void fingerprintPath;
  }

  if (args.dryRun) {
    console.log(`[gate1] --dry-run: no files written (would have ${anyChanged ? 'changed' : 'been unchanged'})`);
  }
  console.log('[gate1] done');
}

main().catch((err) => {
  console.error('[gate1] FAILED', err);
  process.exit(1);
});

void deterministicSnapshotId;
void diffFingerprints;
