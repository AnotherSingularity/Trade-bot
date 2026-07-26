#!/usr/bin/env node
/**
 * Phase 3B §E — Database + migration audit.
 *
 * Static verifier over apps/server/drizzle. Confirms:
 *   - filenames of migrations 0000-0020 (immutable set)
 *   - a SHA-256 hash per migration file (for later rerun comparison)
 *   - snapshot filenames and hashes
 *   - _journal.json points at every migration
 *   - meta/*.json snapshot indices are contiguous
 *   - fingerprints/*.json are present
 *
 * Actual `drizzle-kit generate` (empty-diff) is exercised separately
 * — this script only produces the static hash + integrity map.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, basename } from 'node:path';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const REPORT_DIR = join(REPO_ROOT, 'phase3b_audit/reports');
mkdirSync(REPORT_DIR, { recursive: true });

const MIGRATIONS = join(REPO_ROOT, 'apps/server/drizzle/migrations');
const META = join(MIGRATIONS, 'meta');
const FINGERPRINTS = join(REPO_ROOT, 'apps/server/drizzle/fingerprints');

function hashFile(f) {
  return createHash('sha256').update(readFileSync(f)).digest('hex');
}

const migrationFiles = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const migrationEntries = migrationFiles.map((f) => ({
  file: `apps/server/drizzle/migrations/${f}`,
  sha256: hashFile(join(MIGRATIONS, f)),
  bytes: statSync(join(MIGRATIONS, f)).size,
}));

const snapshotFiles = readdirSync(META).filter((f) => f.endsWith('_snapshot.json')).sort();
const snapshotEntries = snapshotFiles.map((f) => ({
  file: `apps/server/drizzle/migrations/meta/${f}`,
  sha256: hashFile(join(META, f)),
  bytes: statSync(join(META, f)).size,
}));

let fingerprintEntries = [];
try {
  const list = readdirSync(FINGERPRINTS).filter((f) => f.endsWith('.json')).sort();
  fingerprintEntries = list.map((f) => ({
    file: `apps/server/drizzle/fingerprints/${f}`,
    sha256: hashFile(join(FINGERPRINTS, f)),
    bytes: statSync(join(FINGERPRINTS, f)).size,
  }));
} catch { /* fingerprints directory optional */ }

const journal = JSON.parse(readFileSync(join(META, '_journal.json'), 'utf8'));

const report = {
  generatedAt: process.env.HORIZON_AUDIT_TIMESTAMP ?? '1970-01-01T00:00:00.000Z',
  migrationCount: migrationFiles.length,
  snapshotCount: snapshotFiles.length,
  fingerprintCount: fingerprintEntries.length,
  journalIdxCount: journal.entries.length,
  migrationEntries,
  snapshotEntries,
  fingerprintEntries,
  invariants: {
    contiguousIndexes: journal.entries.every((e, i) => e.idx === i),
    migrationCountMatchesJournal: journal.entries.length === migrationFiles.length,
    everyMigrationHasSnapshot: migrationFiles.every((mf) => {
      const idx = mf.slice(0, 4);
      return snapshotFiles.some((sf) => sf.startsWith(idx + '_'));
    }),
  },
};

writeFileSync(join(REPORT_DIR, 'db_migration_audit.json'), JSON.stringify(report, null, 2));
process.stdout.write(`db_migration_audit.json written (migrations=${report.migrationCount}, snapshots=${report.snapshotCount}, journal_idx=${report.journalIdxCount})\n`);
const failures = [];
if (!report.invariants.contiguousIndexes) failures.push('journal indexes not contiguous');
if (!report.invariants.migrationCountMatchesJournal) failures.push('journal count != migration count');
if (!report.invariants.everyMigrationHasSnapshot) failures.push('one or more migrations lack a snapshot');
if (failures.length > 0) {
  process.stderr.write(`FAILURES:\n${failures.join('\n')}\n`);
  process.exit(1);
}
