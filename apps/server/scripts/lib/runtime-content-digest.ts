/**
 * Stage 6 — Runtime content digest.
 *
 * Shared by `soak-launch.ts` (produces the anchor) and
 * `soak-daily-cycle.ts` (verifies the checkout hasn't drifted).
 * Kept in a distinct file so importing either script doesn't
 * trigger the other's `main()` side-effect.
 *
 * The digest covers every file whose content can change the
 * behaviour observed by the seven-day soak:
 *   - shared / server / desktop sources
 *   - Drizzle migrations
 *   - three workspace `package.json` files + root lockfile
 *   - the two soak-critical GitHub Actions workflows
 *     (`operational-soak-launch.yml` + `operational-soak-daily.yml`)
 *   - the three soak orchestration TS files
 *     (`soak-launch.ts` + `soak-daily-cycle.ts` + this file)
 *
 * Docs, audit scripts, evidence files, non-soak workflows,
 * and any other file NOT in these patterns are intentionally
 * excluded — a docs commit or an unrelated CI edit during an
 * ongoing soak MUST NOT invalidate the seven-day interval.
 * Anything that CAN change how the soak is observed or
 * finalized WILL invalidate it via runtime-content-drift.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const RUNTIME_PATH_PATTERNS: readonly RegExp[] = [
  /^packages\/shared\/src\/.*\.ts$/,
  /^apps\/server\/src\/.*\.ts$/,
  /^apps\/desktop\/src\/.*\.ts$/,
  /^apps\/desktop\/src\/.*\.tsx$/,
  /^apps\/server\/drizzle\/migrations\/\d{4}_.*\.sql$/,
  /^packages\/shared\/package\.json$/,
  /^apps\/server\/package\.json$/,
  /^apps\/desktop\/package\.json$/,
  /^package-lock\.json$/,
  // Soak-critical workflow + orchestration surface. A change to
  // any of these files changes how the soak is observed or
  // finalized, so must invalidate an in-flight anchor.
  /^\.github\/workflows\/operational-soak-launch\.yml$/,
  /^\.github\/workflows\/operational-soak-daily\.yml$/,
  /^apps\/server\/scripts\/soak-launch\.ts$/,
  /^apps\/server\/scripts\/soak-daily-cycle\.ts$/,
  /^apps\/server\/scripts\/lib\/runtime-content-digest\.ts$/,
];

function walkRepo(dir: string, base: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    if (
      name === 'node_modules' ||
      name === '.git' ||
      name === 'dist' ||
      name === 'build' ||
      name === '.next' ||
      name === 'logs' ||
      name === 'release' ||
      name.startsWith('.turbo')
    ) continue;
    const p = resolve(dir, name);
    const rel = p.slice(base.length + 1);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkRepo(p, base, acc);
    else {
      const posix = rel.replace(/\\/g, '/');
      if (RUNTIME_PATH_PATTERNS.some((rx) => rx.test(posix))) acc.push(posix);
    }
  }
}

export function computeRuntimeContentDigest(repoRoot: string): { digest: string; fileCount: number; files: readonly string[] } {
  const acc: string[] = [];
  walkRepo(repoRoot, repoRoot, acc);
  acc.sort();
  const hash = createHash('sha256');
  for (const rel of acc) {
    hash.update(rel);
    hash.update('\n');
    hash.update(readFileSync(resolve(repoRoot, rel)));
    hash.update('\n');
  }
  return { digest: hash.digest('hex'), fileCount: acc.length, files: acc };
}
