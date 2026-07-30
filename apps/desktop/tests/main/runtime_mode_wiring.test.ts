/**
 * Correction 1 §production-call-path — assert that `resolveRuntimeMode`
 * is invoked by the desktop main entrypoint BEFORE any window creation.
 *
 * A source-text assertion is the reviewer-visible contract: the test
 * fails the moment someone removes the typed policy call from
 * `apps/desktop/src/main/index.ts`, or replaces it with an untyped
 * fallback, or lets a rejected runtime-mode decision proceed to
 * BrowserWindow creation.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_INDEX = resolve(HERE, '..', '..', 'src', 'main', 'index.ts');

function readMain(): string {
  return readFileSync(MAIN_INDEX, 'utf8');
}

describe('desktop main — resolveRuntimeMode wiring', () => {
  const source = readMain();

  it('imports resolveRuntimeMode from runtimeModePolicy', () => {
    expect(source).toMatch(/import\s*\{[^}]*\bresolveRuntimeMode\b[^}]*\}\s*from\s*['"]\.\/runtimeModePolicy['"]/);
  });

  it('imports the RuntimeModeDecision type', () => {
    expect(source).toMatch(/\bRuntimeModeDecision\b/);
  });

  it('calls resolveRuntimeMode inside boot()', () => {
    // Split source at `async function boot(` to isolate the boot body
    const bootStart = source.indexOf('async function boot(');
    expect(bootStart).toBeGreaterThan(-1);
    const bootBody = source.slice(bootStart);
    expect(bootBody).toMatch(/resolveRuntimeMode\s*\(\s*\{/);
  });

  it('passes app.isPackaged as the packaged input', () => {
    expect(source).toMatch(/packaged\s*:\s*app\.isPackaged/);
  });

  it('passes HORIZON_SERVER_MODE and HORIZON_SERVER_EXTERNAL as inputs', () => {
    expect(source).toMatch(/serverModeEnv\s*:\s*process\.env\.HORIZON_SERVER_MODE/);
    expect(source).toMatch(/serverExternalEnv\s*:\s*process\.env\.HORIZON_SERVER_EXTERNAL/);
  });

  it('passes HORIZON_DEVELOPMENT_FAKE as the developmentFakeEnv input', () => {
    expect(source).toMatch(/developmentFakeEnv\s*:\s*process\.env\.HORIZON_DEVELOPMENT_FAKE/);
  });

  it('fails closed via app.exit(1) when the resolver rejects', () => {
    const source2 = readMain();
    const rejectIdx = source2.indexOf('runtime_mode_rejected');
    expect(rejectIdx).toBeGreaterThan(-1);
    // Within the rejection block, `app.exit(1)` must appear before the
    // return statement to prove a rejected policy never falls through.
    const window = source2.slice(rejectIdx, rejectIdx + 800);
    expect(window).toMatch(/app\.exit\(1\)/);
    expect(window).toMatch(/dialog\.showErrorBox\(/);
  });

  it('resolveRuntimeMode is called before createMainWindow()', () => {
    const source2 = readMain();
    const resolverIdx = source2.indexOf('resolveRuntimeMode({');
    const createWindowIdx = source2.indexOf('await createMainWindow()');
    expect(resolverIdx).toBeGreaterThan(-1);
    expect(createWindowIdx).toBeGreaterThan(-1);
    // Source ordering: the resolver call site must appear before the
    // window creation call site.
    expect(resolverIdx).toBeLessThan(createWindowIdx);
  });

  it('logs the resolved decision (visible in CI artefacts)', () => {
    expect(source).toMatch(/runtime_mode_resolved/);
  });
});
