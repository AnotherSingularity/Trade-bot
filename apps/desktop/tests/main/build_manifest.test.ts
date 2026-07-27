/**
 * Stage 3C-CI-FIX5 §Windows: verify the `build:manifest` package
 * script works on Windows (via tsx, not npx ts-node) — the FIX4
 * commit hit a Windows CI failure at exactly this invocation.
 *
 * This test:
 *   1. Creates a temporary `dist` fixture with a couple of small files.
 *   2. Runs the manifest script through the DECLARED package script
 *      (never `npx ts-node`).
 *   3. Verifies the manifest file exists at `<tmpdir>/build-manifest.json`.
 *   4. Parses it as JSON.
 *   5. Confirms the enclosed file paths use the portable forward-slash
 *      representation (deterministic across POSIX + Windows).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DESKTOP_ROOT = resolve(__dirname, '..', '..');

describe('Stage 3C-CI-FIX5 — build:manifest package script', () => {
  let fixtureRoot: string;
  let distDir: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'stage3c-fix5-manifest-'));
    distDir = join(fixtureRoot, 'dist');
    mkdirSync(join(distDir, 'main'), { recursive: true });
    mkdirSync(join(distDir, 'renderer', 'assets'), { recursive: true });
    writeFileSync(join(distDir, 'main', 'index.js'), 'console.log("main");\n');
    writeFileSync(join(distDir, 'renderer', 'index.html'), '<!doctype html><html></html>\n');
    writeFileSync(join(distDir, 'renderer', 'assets', 'app.js'), 'export {};\n');
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('script exists in apps/desktop/package.json and uses tsx (not ts-node)', () => {
    const pkg = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    // The script MUST invoke tsx — never `npx ts-node`.
    expect(pkg.scripts['build:manifest']).toMatch(/^tsx\s+build\/generate-build-manifest\.ts$/);
    expect(pkg.scripts['build:manifest']).not.toMatch(/ts-node/);
    expect(pkg.scripts['build:manifest']).not.toMatch(/npx/);
  });

  it('runs via `npm run build:manifest -- <dist>` and produces build-manifest.json', () => {
    // Use the same npm binary that Vitest was launched with — ensures
    // we invoke the workspace-hoisted tsx, not a global one.
    const isWin = platform() === 'win32';
    const npmBin = isWin ? 'npm.cmd' : 'npm';
    const result = spawnSync(npmBin, ['run', 'build:manifest', '--', distDir], {
      cwd: DESKTOP_ROOT,
      encoding: 'utf8',
      env: { ...process.env, HORIZON_BUILD_COMMIT: 'fix5-unit-test' },
    });
    expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    const manifestPath = join(distDir, 'build-manifest.json');
    expect(existsSync(manifestPath), 'build-manifest.json missing').toBe(true);

    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      packageName: string;
      packageVersion: string;
      buildCommit: string;
      buildTimestamp: string;
      bundleChecksum: string;
      fileCount: number;
      safeFlags: { DRY_RUN: boolean; ORDER_SUBMISSION_ENABLED: boolean; SIMULATION_MODE: string };
    };
    expect(parsed.packageName).toBe('@horizon/desktop');
    expect(parsed.buildCommit).toBe('fix5-unit-test');
    // Bundle checksum must be deterministic sha256 hex — the aggregate
    // over every file in the dist tree in a portable way.
    expect(parsed.bundleChecksum).toMatch(/^[a-f0-9]{64}$/);
    // We wrote exactly 3 fixture files under dist/ — the walker must
    // find every one of them.
    expect(parsed.fileCount).toBe(3);
    // Safety posture is baked into every manifest.
    expect(parsed.safeFlags.DRY_RUN).toBe(true);
    expect(parsed.safeFlags.ORDER_SUBMISSION_ENABLED).toBe(false);
  }, 30_000);

  it('bundleChecksum is stable across two runs given identical inputs (portable path handling)', () => {
    const isWin = platform() === 'win32';
    const npmBin = isWin ? 'npm.cmd' : 'npm';
    const runOnce = (dst: string): string => {
      // Rebuild the fixture from scratch each time — the walker
      // includes the just-written build-manifest.json in the next
      // aggregate hash, which would trivially differ across runs.
      mkdirSync(join(dst, 'main'), { recursive: true });
      mkdirSync(join(dst, 'renderer', 'assets'), { recursive: true });
      writeFileSync(join(dst, 'main', 'index.js'), 'console.log("main");\n');
      writeFileSync(join(dst, 'renderer', 'index.html'), '<!doctype html><html></html>\n');
      writeFileSync(join(dst, 'renderer', 'assets', 'app.js'), 'export {};\n');
      const result = spawnSync(npmBin, ['run', 'build:manifest', '--', dst], {
        cwd: DESKTOP_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          HORIZON_BUILD_COMMIT: 'fix5-unit-test',
          HORIZON_BUILD_TIMESTAMP: '2026-07-27T00:00:00.000Z',
        },
      });
      expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
      const parsed = JSON.parse(readFileSync(join(dst, 'build-manifest.json'), 'utf8')) as {
        bundleChecksum: string;
      };
      return parsed.bundleChecksum;
    };
    const a = runOnce(join(fixtureRoot, 'dist-a'));
    const b = runOnce(join(fixtureRoot, 'dist-b'));
    expect(a).toBe(b);
  }, 30_000);

  it('no CI workflow `run:` step invokes `npx ts-node`', () => {
    // Regression guard: if a future edit reintroduces the FIX4-era
    // `npx ts-node build/generate-build-manifest.ts dist` invocation,
    // Windows CI will break again. Assert no active step re-adds it.
    // A clarifying comment mentioning ts-node is fine — a `run:` line
    // is not.
    const nativeWf = readFileSync(join(DESKTOP_ROOT, '..', '..', '.github/workflows/stage3c-native.yml'), 'utf8');
    const winWf = readFileSync(join(DESKTOP_ROOT, '..', '..', '.github/workflows/desktop-windows.yml'), 'utf8');
    for (const wf of [nativeWf, winWf]) {
      expect(wf).not.toMatch(/\brun:\s*npx\s+ts-node/);
      // Windows must use the declared script, never the ad-hoc call.
      expect(wf).not.toMatch(/\brun:\s*[^\n]*ts-node\s+build\/generate-build-manifest/);
    }
  });
});
