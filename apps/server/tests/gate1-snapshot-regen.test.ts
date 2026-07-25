import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Phase 1.1 Gate 1c — snapshot drift detection.
 *
 * This test regenerates every snapshot from the live MariaDB via the
 * reconstruction script and asserts the output matches the checked-in
 * `_snapshot.json` and `_mariadb_fingerprint.json` files byte-for-byte.
 * Any drift means schema.ts changed (or a migration was added) without
 * a corresponding snapshot refresh.
 *
 * Failure recovery when this test fails:
 *   1. Investigate the source of the diff.
 *   2. If the diff is legitimate (a new migration was added), re-run the
 *      reconstruction: `npx tsx scripts/reconstruct-snapshots.ts` and
 *      commit the updated snapshots.
 *   3. If the diff is spurious (drizzle-kit version change, MariaDB
 *      version quirk), stop for review. Do NOT commit falsified snapshots.
 */

const scriptPath = resolve(__dirname, '..', 'scripts', 'reconstruct-snapshots.ts');
const metaDir = resolve(__dirname, '..', 'drizzle', 'migrations', 'meta');
const fingerprintDir = resolve(__dirname, '..', 'drizzle', 'fingerprints');

// Reasonable set — must match _journal.json entries.
const CHECKPOINTS = [0, 1, 2, 3, 4, 5];

interface Snapshot {
  before: string;
  after: string;
}

const snapshotsBefore = new Map<number, Snapshot>();

beforeAll(async () => {
  // Read the checked-in files before we regenerate.
  for (const idx of CHECKPOINTS) {
    const padded = String(idx).padStart(4, '0');
    const snapPath = join(metaDir, `${padded}_snapshot.json`);
    const fpPath = join(fingerprintDir, `${padded}_mariadb_fingerprint.json`);
    snapshotsBefore.set(idx, {
      before: readFileSync(snapPath, 'utf-8'),
      after: readFileSync(fpPath, 'utf-8'),
    });
  }
  // Run the reconstruction script. It rewrites the same files.
  execSync(`npx tsx ${scriptPath}`, {
    cwd: resolve(__dirname, '..'),
    stdio: 'inherit',
    timeout: 60_000,
  });
}, 90_000);

describe('Gate 1c drift detection — reconstruction matches checked-in files', () => {
  for (const idx of CHECKPOINTS) {
    const padded = String(idx).padStart(4, '0');
    it(`checkpoint ${padded}: snapshot is byte-identical after regeneration`, () => {
      const path = join(metaDir, `${padded}_snapshot.json`);
      const after = readFileSync(path, 'utf-8');
      const before = snapshotsBefore.get(idx)!.before;
      expect(after).toBe(before);
    });
    it(`checkpoint ${padded}: fingerprint is byte-identical after regeneration`, () => {
      const path = join(fingerprintDir, `${padded}_mariadb_fingerprint.json`);
      const after = readFileSync(path, 'utf-8');
      const before = snapshotsBefore.get(idx)!.after;
      expect(after).toBe(before);
    });
  }
});
