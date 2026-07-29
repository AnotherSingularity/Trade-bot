/**
 * Stage 6 — Runtime content digest.
 *
 * Shared by `soak-launch.ts` (produces the anchor) and
 * `soak-daily-cycle.ts` (verifies the checkout hasn't drifted).
 * Kept in a distinct file so importing either script doesn't
 * trigger the other's `main()` side-effect.
 *
 * The digest covers exactly the files whose content defines
 * runtime behaviour: shared library sources, server sources,
 * desktop sources (main + preload + renderer), migrations, and
 * the three workspace `package.json` files + the root lockfile.
 * Docs, audit scripts, workflow YAML, and evidence files are
 * intentionally NOT covered — a docs commit during an ongoing
 * soak MUST NOT invalidate the seven-day interval.
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
