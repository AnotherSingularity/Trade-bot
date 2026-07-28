/**
 * Stage 3C-CI-RESET Part 2 Checkpoint B — CI-time enforcement that
 * `npm run verify:test-topology` stays green.
 *
 * The verifier script lives at apps/desktop/build/verify-test-topology.ts
 * and is the single machine-readable source of truth for how test
 * files map to the three vitest configs. Running it inside vitest
 * means every portable-suite run also proves the topology has not
 * drifted — a new test file that lands unclassified fails the fast
 * CI job, not just the `npm run verify` step.
 *
 * The verifier is invoked via `execFileSync` because it uses dynamic
 * `import()` on the vitest configs, which requires the vitest process
 * NOT to be already halfway through resolving those same modules.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DESKTOP_ROOT = resolve(__dirname, '..', '..');
const MANIFEST_PATH = resolve(DESKTOP_ROOT, 'tests', 'suite-manifest.json');
const VERIFIER_PATH = resolve(DESKTOP_ROOT, 'build', 'verify-test-topology.ts');

describe('Stage 3C-CI-RESET Part 2 Checkpoint B — suite topology', () => {
  it('B1: `npm run verify:test-topology` exits 0 (manifest agrees with vitest configs + disk)', () => {
    // Run the verifier as a child. If it exits non-zero, execFileSync
    // throws with the captured stderr — vitest surfaces the whole
    // classification list in the failure output.
    try {
      const out = execFileSync('npx', ['tsx', VERIFIER_PATH], {
        cwd: DESKTOP_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(out).toMatch(/verify:test-topology OK/);
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      throw new Error(
        `verify:test-topology reported drift.\n` +
          `stdout: ${err.stdout ?? ''}\nstderr: ${err.stderr ?? ''}\nexit: ${err.status ?? '?'}`,
      );
    }
  }, 30_000);

  it('B2: manifest is valid JSON with the expected top-level shape', () => {
    const raw = readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw) as {
      $schema?: string;
      description?: string;
      suites?: Record<string, unknown>;
      assignments?: {
        portable?: unknown;
        external?: unknown;
        native?: unknown;
        unassigned?: unknown;
      };
    };
    expect(parsed.$schema, 'manifest missing $schema tag').toBe('STAGE_3C_SUITE_MANIFEST_V1');
    expect(typeof parsed.description).toBe('string');
    expect(parsed.suites).toBeDefined();
    expect(parsed.suites?.portable).toBeDefined();
    expect(parsed.suites?.external).toBeDefined();
    expect(parsed.suites?.native).toBeDefined();
    expect(parsed.suites?.unassigned).toBeDefined();
    expect(Array.isArray(parsed.assignments?.portable)).toBe(true);
    expect(Array.isArray(parsed.assignments?.external)).toBe(true);
    expect(Array.isArray(parsed.assignments?.native)).toBe(true);
    expect(Array.isArray(parsed.assignments?.unassigned)).toBe(true);
  });

  it('B3: every unassigned entry carries a non-empty reason (≥20 chars)', () => {
    // Same rule the verifier enforces, tested independently here so a
    // manifest edit that lands during a rebase surfaces on this line
    // rather than inside the verifier subprocess output.
    const parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      assignments: { unassigned: ReadonlyArray<{ file: string; reason: string }> };
    };
    for (const entry of parsed.assignments.unassigned) {
      expect(typeof entry.file, `unassigned entry missing 'file' field`).toBe('string');
      expect(typeof entry.reason, `${entry.file} unassigned entry missing 'reason' field`).toBe('string');
      expect(entry.reason.trim().length, `${entry.file} unassigned reason is too short`).toBeGreaterThanOrEqual(20);
    }
  });
});
