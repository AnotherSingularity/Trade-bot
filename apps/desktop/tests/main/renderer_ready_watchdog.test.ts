/**
 * Stage 3C-CI-FIX5 §9: regression test for the exact failure the FIX4
 * native CI run exhibited — a hang immediately after
 * `renderer_dom_loaded` with no `renderer_ready` phase ever recorded.
 *
 * This test simulates that failure using the diagnostics primitives
 * directly (no Electron / no MariaDB / no Redis / no Playwright — it
 * runs in the portable unit suite) and asserts every property the
 * FIX5 native workflow must guarantee on such a failure:
 *   1. It exits within the renderer_ready timeout (not the whole
 *      workflow timeout).
 *   2. The rejected error carries the deterministic code
 *      `native_startup_timeout:renderer_ready`.
 *   3. A `failure-classification.json` file exists at the logs dir
 *      and its contract + classification are correct.
 *   4. The `native-run-status.json` file exists with
 *      `completed=false` and `startupComplete=false`.
 *   5. A `finally` cleanup block runs (bounded, deterministic).
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NativeRunStatus, StartupTrace,
  withNativeTimeout, writeFailureClassification,
} from '../native/nativeDiagnostics';

describe('Stage 3C-CI-FIX5 §9 — renderer-ready watchdog regression', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'stage3c-fix5-hang-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('post-DOM hang exits within the renderer_ready timeout (never blocks the whole workflow)', async () => {
    const trace = new StartupTrace(dir);
    const status = new NativeRunStatus(dir, 'test_hang_run');

    // Simulate reaching DOM load then hanging forever.
    trace.record('renderer_dom_loaded', 'completed');
    status.setPhase('renderer_dom_loaded');
    trace.record('renderer_ready_wait_started', 'started', { timeoutMs: 500 });
    status.setPhase('renderer_ready_wait_started');

    // A deliberately-hanging promise stand-in for a real page hang.
    // Never resolves.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const foreverHang: Promise<void> = new Promise<void>(() => {});
    const cleanupSteps: string[] = [];
    const start = Date.now();

    let capturedError: Error | null = null;
    try {
      await withNativeTimeout('renderer_ready', 500, foreverHang, { trace });
    } catch (err) {
      capturedError = err as Error;

      // Stage 3C-CI-FIX5 §5: write failure evidence BEFORE cleanup —
      // never let a hanging cleanup bury the classification.
      writeFailureClassification(dir, err, { electronPid: 1234, serverPid: 5678 });
      status.markFailed('renderer_ready');

      // Bounded cleanup runs (this mimics boundedPartialTeardown in the
      // real harness — every step is time-capped and its outcome is
      // recorded).
      cleanupSteps.push('electron_shutdown_attempted');
      cleanupSteps.push('server_shutdown_attempted');
    }

    const elapsed = Date.now() - start;

    // (1) Exited under its OWN timeout — not the outer test/workflow one.
    expect(elapsed).toBeLessThan(5_000);

    // (2) Deterministic error code names the phase.
    expect(capturedError).toBeInstanceOf(Error);
    expect(capturedError!.message).toBe('native_startup_timeout:renderer_ready');

    // (3) failure-classification.json exists with correct contract + phase.
    const fcPath = join(dir, 'failure-classification.json');
    expect(existsSync(fcPath), 'failure-classification.json missing').toBe(true);
    const fc = JSON.parse(readFileSync(fcPath, 'utf8')) as {
      contract: string; classification: string; errorCode: string; phase: string;
      electronPid: number | null; serverPid: number | null;
    };
    expect(fc.contract).toBe('stage3c-native-failure.v1');
    expect(fc.classification).toBe('renderer_ready');
    expect(fc.errorCode).toBe('native_startup_timeout:renderer_ready');
    expect(fc.phase).toBe('renderer_ready');
    expect(fc.electronPid).toBe(1234);
    expect(fc.serverPid).toBe(5678);

    // (4) native-run-status.json exists with completed:false + startupComplete:false.
    const nrsPath = join(dir, 'native-run-status.json');
    expect(existsSync(nrsPath), 'native-run-status.json missing').toBe(true);
    const nrs = JSON.parse(readFileSync(nrsPath, 'utf8')) as {
      contract: string; startupComplete: boolean; completed: boolean;
      failureClassification: string | null; currentPhase: string;
    };
    expect(nrs.contract).toBe('stage3c-native-run-status.v1');
    // Critical: the FIX4 defect was `completed:true` on a hang.
    // FIX5 must keep it false.
    expect(nrs.completed).toBe(false);
    expect(nrs.startupComplete).toBe(false);
    expect(nrs.failureClassification).toBe('renderer_ready');

    // (5) Cleanup executed after the timeout — not skipped.
    expect(cleanupSteps).toEqual(['electron_shutdown_attempted', 'server_shutdown_attempted']);

    // Also confirm the trace file recorded a `failed` line for renderer_ready.
    const traceLines = readFileSync(trace.location(), 'utf8').trim().split('\n');
    const failedLine = traceLines.find((l) => l.includes('"state":"failed"') && l.includes('"phase":"renderer_ready"'));
    expect(failedLine, 'startup-trace.jsonl missing renderer_ready failed entry').toBeDefined();
  });

  it('successful post-DOM path flips startupComplete but not completed', async () => {
    const status = new NativeRunStatus(dir, 'test_ok_run');
    // Simulate a successful renderer_ready observation.
    status.setPhase('renderer_ready');
    status.markStartupComplete();

    const nrs = JSON.parse(readFileSync(status.location(), 'utf8')) as {
      startupComplete: boolean; completed: boolean;
    };
    expect(nrs.startupComplete).toBe(true);
    expect(nrs.completed).toBe(false);

    // Stage 3C-CI-FIX7 §D1: `completed:true` now requires startup +
    // assertions + cleanup all complete AND no failure. This test
    // exercises the full happy path.
    status.markAssertionsComplete();
    status.markCleanupComplete();
    status.markCompleted();
    const nrs2 = JSON.parse(readFileSync(status.location(), 'utf8')) as {
      startupComplete: boolean; completed: boolean;
    };
    expect(nrs2.startupComplete).toBe(true);
    expect(nrs2.completed).toBe(true);
  });

  it('process-tree sanitizer preserves full output (no 4KB truncation)', async () => {
    const { sanitizeProcessTreeText } = await import('../native/nativeDiagnostics');
    // Build a 100 KB fixture that exercises redaction on multiple lines.
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(`${1000 + i} 1 1 electron --token=${'a'.repeat(64)} --port=9999`);
    }
    const raw = lines.join('\n');
    const sanitized = sanitizeProcessTreeText(raw);
    // Full length preserved (minus the redaction differences per line).
    expect(sanitized.length).toBeGreaterThan(50_000);
    // Redaction applied per line.
    expect(sanitized).not.toContain('a'.repeat(64));
    expect(sanitized).toContain('<HEX_REDACTED>');
    // Line count preserved.
    expect(sanitized.split('\n').length).toBe(2000);
  });
});
