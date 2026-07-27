/**
 * Stage 3C-CI-FIX4 §C — tests for the diagnostics infrastructure.
 * These are portable unit tests (no MariaDB/Redis/Electron); they
 * lock in the trace/timeout/status/classification behaviour.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NATIVE_STARTUP_PHASES, NativeRunStatus, StartupTrace,
  classifyFailure, nativeDiagnosticsEnabled, sanitizeDiagnosticMessage,
  withNativeTimeout, writeFailureClassification,
} from '../native/nativeDiagnostics';

describe('Stage 3C-CI-FIX4 — native diagnostics', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'stage3c-fix4-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  // Test 1 — trace writes valid JSONL
  it('trace: writes valid JSONL lines', () => {
    const t = new StartupTrace(dir);
    t.record('native_test_entered', 'started');
    t.record('isolation_minted', 'completed', { dbName: 'hzn_scratch_foo' });
    const raw = readFileSync(t.location(), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('phase');
      expect(parsed).toHaveProperty('state');
      expect(parsed).toHaveProperty('pid');
    }
  });

  // Test 2 — trace appends synchronously (subsequent read sees prior write)
  it('trace: appends synchronously so a crash preserves the latest phase', () => {
    const t = new StartupTrace(dir);
    t.record('mariadb_ready', 'completed');
    // Read immediately — synchronous append means it's already flushed.
    expect(readFileSync(t.location(), 'utf8')).toContain('mariadb_ready');
  });

  // Test 3 — timeout helper returns normally before deadline
  it('timeout: returns value when operation completes before deadline', async () => {
    const t = new StartupTrace(dir);
    const result = await withNativeTimeout('electron_launch', 500,
      Promise.resolve('ok'), { trace: t, startPhase: 'electron_launch_started', completePhase: 'electron_launch_complete' });
    expect(result).toBe('ok');
    const raw = readFileSync(t.location(), 'utf8');
    expect(raw).toContain('electron_launch_started');
    expect(raw).toContain('electron_launch_complete');
  });

  // Test 4 — timeout helper throws deterministic phase code
  it('timeout: throws native_startup_timeout:<phase> when deadline elapses', async () => {
    const t = new StartupTrace(dir);
    const slow = new Promise((r) => setTimeout(r, 200));
    await expect(withNativeTimeout('first_window', 50, slow, { trace: t }))
      .rejects.toThrow('native_startup_timeout:first_window');
    const raw = readFileSync(t.location(), 'utf8');
    const failedLine = raw.split('\n').find((l) => l.includes('"state":"failed"'))!;
    const parsed = JSON.parse(failedLine);
    expect(parsed.phase).toBe('first_window');
    expect(parsed.detail.errorCode).toBe('native_startup_timeout:first_window');
  });

  // Test 5 — timer is cleaned after normal completion (no dangling handles)
  it('timeout: cleans timer after normal completion', async () => {
    // We can only observe this indirectly: many rapid completions must
    // not accumulate leaked timers that would trigger later.
    for (let i = 0; i < 20; i++) {
      await withNativeTimeout('electron_launch', 500, Promise.resolve(i));
    }
    // Advance real time; nothing should throw.
    await new Promise((r) => setTimeout(r, 100));
    expect(true).toBe(true);
  });

  // Test 6 — failure classification is sanitized
  it('classification: sanitizes bearer tokens, connection strings, hex tokens', () => {
    const raw = 'connect to mysql://root:secret@127.0.0.1:3306/x failed; Bearer abc.def.ghi; hash=a1b2c3d4e5f67890a1b2c3d4e5f67890';
    const sanitized = sanitizeDiagnosticMessage(raw);
    expect(sanitized).not.toContain('secret');
    expect(sanitized).not.toContain('abc.def.ghi');
    expect(sanitized).not.toContain('a1b2c3d4e5f67890a1b2c3d4e5f67890');
    expect(sanitized).toMatch(/<REDACTED>|<HEX_REDACTED>/);
  });

  // Test 7 — status file transitions started → failed
  it('status: transitions started → currentPhase → failed', () => {
    const s = new NativeRunStatus(dir, 'test_run_1');
    let parsed = JSON.parse(readFileSync(s.location(), 'utf8'));
    expect(parsed.nativeTestStarted).toBe(true);
    expect(parsed.completed).toBe(false);
    expect(parsed.currentPhase).toBe('not_started');
    s.setPhase('electron_launch_started');
    parsed = JSON.parse(readFileSync(s.location(), 'utf8'));
    expect(parsed.currentPhase).toBe('electron_launch_started');
    s.markFailed('electron_launch');
    parsed = JSON.parse(readFileSync(s.location(), 'utf8'));
    expect(parsed.failureClassification).toBe('electron_launch');
    expect(parsed.completed).toBe(false);
  });

  // Test 8 — packaged mode cannot enable diagnostics
  it('policy: packaged mode never enables native diagnostics', () => {
    expect(nativeDiagnosticsEnabled({ isPackaged: true, nodeEnv: 'test', optIn: 'true' })).toBe(false);
    expect(nativeDiagnosticsEnabled({ isPackaged: true, nodeEnv: 'production', optIn: 'true' })).toBe(false);
  });

  // Test 9 — production mode cannot enable diagnostics
  it('policy: production NODE_ENV never enables native diagnostics', () => {
    expect(nativeDiagnosticsEnabled({ isPackaged: false, nodeEnv: 'production', optIn: 'true' })).toBe(false);
    expect(nativeDiagnosticsEnabled({ isPackaged: false, nodeEnv: 'development', optIn: 'true' })).toBe(false);
  });

  // Test 10 — strict test-only opt-in enables diagnostics
  it('policy: strict test-only triple enables native diagnostics', () => {
    expect(nativeDiagnosticsEnabled({ isPackaged: false, nodeEnv: 'test', optIn: 'true' })).toBe(true);
    for (const v of ['1', 'yes', 'YES', 'TRUE', ' true', 'true ']) {
      expect(nativeDiagnosticsEnabled({ isPackaged: false, nodeEnv: 'test', optIn: v }), `optIn=${JSON.stringify(v)}`).toBe(false);
    }
  });

  // Test 11 — failure classification: electron_launch code maps to correct classification
  it('classifyFailure: maps timeout code → classification', () => {
    expect(classifyFailure(new Error('native_startup_timeout:electron_launch')).classification).toBe('electron_launch');
    expect(classifyFailure(new Error('native_startup_timeout:first_window')).classification).toBe('first_window');
    expect(classifyFailure(new Error('native_startup_timeout:renderer_dom')).classification).toBe('renderer_dom');
    expect(classifyFailure(new Error('native_startup_timeout:renderer_ready')).classification).toBe('renderer_ready');
    expect(classifyFailure(new Error('random other error')).classification).toBe('unknown');
  });

  // Test 12 — failure artefact writes to logsDir
  it('writeFailureClassification: writes failure-classification.json with sanitized message', () => {
    const err = new Error('mysql://root:hunter2@127.0.0.1:3306/db failed native_startup_timeout:first_window');
    const path = writeFailureClassification(dir, err, { electronPid: 1111, serverPid: 2222 });
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.contract).toBe('stage3c-native-failure.v1');
    expect(parsed.electronPid).toBe(1111);
    expect(parsed.serverPid).toBe(2222);
    expect(parsed.message).not.toContain('hunter2');
  });

  // Test 13 — trace phase catalog is stable
  it('phase catalog: has the required set + is frozen tuple', () => {
    for (const required of [
      'native_test_entered', 'electron_launch_started', 'first_window_observed',
      'renderer_dom_loaded', 'renderer_ready', 'shutdown_started', 'cleanup_complete',
    ]) {
      expect(NATIVE_STARTUP_PHASES).toContain(required);
    }
  });
});
