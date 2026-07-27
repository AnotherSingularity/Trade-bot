/**
 * Stage 3C-CI-FIX4 §B/§C — CI-config integrity checks.
 *
 * These lock in the Windows-vs-Linux test-config split + the native
 * workflow's artefact/timeout policy. They run in the portable unit
 * suite (no external services) so a config regression fails BEFORE
 * a CI run burns wall-clock.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const DESKTOP_ROOT = join(REPO_ROOT, 'apps/desktop');

describe('Stage 3C-CI-FIX4 — portable vitest config excludes service-dependent tests', () => {
  const portableCfg = readFileSync(join(DESKTOP_ROOT, 'vitest.config.ts'), 'utf8');

  it('excludes tests/native/**', () => {
    expect(portableCfg).toContain("'tests/native/**'");
  });

  it('excludes MariaDB/Redis probe suites', () => {
    for (const f of [
      'tests/stage1_mariadb_probe.test.ts',
      'tests/stage1_redis_probe.test.ts',
      'tests/stage1_schema_fingerprint.test.ts',
      'tests/stage1fix_external_services_integration.test.ts',
      'tests/stage2_end_to_end_integration.test.ts',
      'tests/stage2fix_bootstrap_scope.test.ts',
      'tests/stage2fix_db_isolation.test.ts',
      'tests/stage1_supervisor_integration.test.ts',
      'tests/stage1_command_runner.test.ts',
    ]) {
      expect(portableCfg, `portable vitest.config.ts must exclude ${f}`).toContain(`'${f}'`);
    }
  });

  it('excludes any *external*.test.ts glob', () => {
    expect(portableCfg).toContain("'tests/**/*external*.test.ts'");
  });
});

describe('Stage 3C-CI-FIX4 — external vitest config includes service-dependent tests', () => {
  const externalCfg = readFileSync(join(DESKTOP_ROOT, 'vitest.external.config.ts'), 'utf8');

  it('runs in a single fork (state isolation) with pool=forks', () => {
    expect(externalCfg).toMatch(/pool\s*:\s*'forks'/);
    expect(externalCfg).toMatch(/singleFork\s*:\s*true/);
  });

  it('includes at least the mandatory external-services probes', () => {
    expect(externalCfg).toContain('stage1_mariadb_probe');
    expect(externalCfg).toContain('stage1_redis_probe');
    expect(externalCfg).toContain('stage1_schema_fingerprint');
    expect(externalCfg).toContain('stage1fix_external_services_integration');
  });
});

describe('Stage 3C-CI-FIX4 — package.json scripts partition the three suites', () => {
  const pkg = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('test → vitest run --config vitest.config.ts (portable)', () => {
    expect(pkg.scripts.test).toBe('vitest run --config vitest.config.ts');
  });

  it('test:external → vitest run --config vitest.external.config.ts', () => {
    expect(pkg.scripts['test:external']).toBe('vitest run --config vitest.external.config.ts');
  });

  it('test:native → xvfb-run vitest run --config vitest.native.config.ts', () => {
    expect(pkg.scripts['test:native']).toMatch(/xvfb-run/);
    expect(pkg.scripts['test:native']).toContain('vitest.native.config.ts');
  });
});

describe('Stage 3C-CI-FIX4 — native workflow: bounded, filtered, ordered', () => {
  const wf = readFileSync(join(REPO_ROOT, '.github/workflows/stage3c-native.yml'), 'utf8');

  it('pins MariaDB 10.11.6 (Horizon canonical target)', () => {
    expect(wf).toContain('mariadb:10.11.6');
  });

  it('pins Redis 7.4-alpine (production Compose contract)', () => {
    expect(wf).toContain('redis:7.4-alpine');
  });

  it('installs redis-tools so redis-cli is available on the runner', () => {
    expect(wf).toContain('redis-tools');
  });

  it('runs the external-services suite BEFORE the native harness', () => {
    const externalIdx = wf.indexOf('Run external-services integration suite');
    const nativeIdx = wf.indexOf('Run Stage 3C native Electron integration test');
    expect(externalIdx).toBeGreaterThan(0);
    expect(nativeIdx).toBeGreaterThan(0);
    expect(externalIdx).toBeLessThan(nativeIdx);
  });

  it('external step forces HORIZON_REQUIRE_EXTERNAL_SERVICES=true', () => {
    expect(wf).toMatch(/HORIZON_REQUIRE_EXTERNAL_SERVICES:\s*['"]?true['"]?/);
  });

  it('has an overall timeout-minutes cap (bounded run)', () => {
    expect(wf).toMatch(/timeout-minutes:\s*\d+/);
  });

  it('artefact upload uses an ALLOWLIST (only named diagnostics files) — never a bare recursive glob', () => {
    // Stage 3C-CI-FIX5 §8: the artefact block was flipped from
    // exclusion-glob (blacklist) to allowlist (inclusion-glob) so
    // Chromium cache directories under electron-userdata can never
    // accidentally ship — DawnWebGPUCache and similar were still
    // being uploaded under the blacklist approach.
    // The allowlist MUST include the diagnostic files we care about
    // and MUST NOT recursively upload the whole logs tree.
    for (const required of [
      'startup-trace.jsonl',
      'native-run-status.json',
      'failure-classification.json',
      'environment-summary.json',
      'process-tree*.txt',
      'evidence.json',
      'electron-main.stdout.log',
      'electron-main.stderr.log',
      'playwright-api.log',
      'preload.log',
      'renderer.log',
      'failure.png',
      'failure-dom.html',
      'current-url.txt',
    ]) {
      expect(wf, `native workflow must allowlist ${required}`).toContain(required);
    }
    // The bare-recursive form `apps/desktop/tests/native/logs` on its
    // own must NOT appear (that would re-introduce the FIX4 problem
    // of shipping the entire Chromium user-data tree).
    expect(wf).not.toMatch(/^\s{12}apps\/desktop\/tests\/native\/logs\s*$/m);
    // And `electron-userdata` must NEVER appear in the upload block
    // — the allowlist has no reason to reference it.
    const uploadBlockMatch = wf.match(/Upload native evidence[\s\S]*?retention-days/);
    expect(uploadBlockMatch).not.toBeNull();
    expect(uploadBlockMatch![0]).not.toContain('electron-userdata');
  });

  it('uploads on always() so failure evidence survives', () => {
    expect(wf).toMatch(/if:\s*always\(\)/);
  });

  it('emits the ci-bootstrap sentinel BEFORE the native test runs', () => {
    const bootstrapIdx = wf.indexOf('ci-bootstrap.txt');
    const nativeIdx = wf.indexOf('Run Stage 3C native Electron integration test');
    expect(bootstrapIdx).toBeGreaterThan(0);
    expect(bootstrapIdx).toBeLessThan(nativeIdx);
  });
});

describe('Stage 3C-CI-FIX4 — Windows workflow: portable-only', () => {
  const wf = readFileSync(join(REPO_ROOT, '.github/workflows/desktop-windows.yml'), 'utf8');

  it('runs on windows-latest', () => {
    expect(wf).toContain('windows-latest');
  });

  it('invokes `npm test` (portable config, NOT test:external / test:native)', () => {
    const testStepIdx = wf.indexOf('Run portable desktop unit suite');
    expect(testStepIdx).toBeGreaterThan(0);
    expect(wf).toContain('run: npm test');
    // No `run:` step may invoke test:external or test:native on Windows
    // — mention in comments is fine, but Windows must never invoke the
    // service-dependent or native suites.
    expect(wf).not.toMatch(/run:\s*npm\s+run\s+test:external/);
    expect(wf).not.toMatch(/run:\s*npm\s+run\s+test:native/);
  });

  it('enforces DRY_RUN=true + ORDER_SUBMISSION_ENABLED=false at build', () => {
    expect(wf).toMatch(/DRY_RUN:\s*['"]?true['"]?/);
    expect(wf).toMatch(/ORDER_SUBMISSION_ENABLED:\s*['"]?false['"]?/);
  });
});
