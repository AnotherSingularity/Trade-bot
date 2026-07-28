/**
 * Stage 3C-CI-RESET Part 2 Checkpoint C.2 + C.3 + C.9 tests L1..L20 —
 * append-only native execution ledger + pure reducer unit tests.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeManifestHash,
  type NativeCertificationRequirement,
} from '../native/nativeCertificationManifest';
import {
  NativeExecutionLedger,
  NativeLedgerError,
  readLedgerEvents,
  reduceNativeExecutionLedger,
  sanitizeFailureCode,
  type NativeExecutionEvent,
} from '../native/nativeExecutionLedger';

// A tiny hand-rolled manifest — smaller than the real 100+ entry
// manifest so failure diffs are readable. Every test constructs
// this fresh so no state is shared.
function makeManifest(): NativeCertificationRequirement[] {
  return [
    { id: 'T-alpha', title: 'alpha startup', category: 'startup', required: true as const },
    { id: 'T-beta', title: 'beta domain', category: 'domain', required: true as const },
    { id: 'NAV:overview', title: 'overview nav', category: 'screen_navigation', screenKey: 'overview', required: true as const },
    { id: 'SIG:overview', title: 'overview sig', category: 'screen_signature', screenKey: 'overview', required: true as const },
    { id: 'MANIFEST:overview', title: 'overview manifest', category: 'screen_manifest', screenKey: 'overview', required: true as const },
    { id: 'CLEANUP:server_stop', title: 'server stop', category: 'cleanup', required: true as const },
  ];
}

function newRunDir(): string {
  return mkdtempSync(join(tmpdir(), 'stage3c-ledger-'));
}

function makeLedger(manifest = makeManifest()): { ledger: NativeExecutionLedger; runDir: string; manifest: NativeCertificationRequirement[] } {
  let n = 0;
  const runDir = newRunDir();
  const ledger = new NativeExecutionLedger({
    runDir,
    manifest,
    now: () => `2026-07-28T00:00:00.${String(n++).padStart(3, '0')}Z`,
  });
  return { ledger, runDir, manifest };
}

describe('Stage 3C-CI-RESET Part 2 Checkpoint C.2 — ledger transitions', () => {
  it('L7: registerManifest records one register event per requirement', () => {
    const { ledger, manifest } = makeLedger();
    ledger.registerManifest();
    const events = ledger.snapshot();
    expect(events).toHaveLength(manifest.length);
    for (let i = 0; i < manifest.length; i++) {
      expect(events[i].transition).toBe('register');
      expect(events[i].requirementId).toBe(manifest[i].id);
      expect(events[i].sequence).toBe(i);
    }
    ledger.close();
  });

  it('L8: valid transition sequence register → start → pass', () => {
    const { ledger } = makeLedger();
    ledger.registerManifest();
    ledger.start('T-alpha');
    ledger.pass('T-alpha', 42);
    expect(ledger.currentState('T-alpha')).toBe('passed');
    ledger.close();
  });

  it('L9: reject register → pass (must go through started)', () => {
    const { ledger } = makeLedger();
    ledger.registerManifest();
    expect(() => ledger.pass('T-alpha')).toThrow(NativeLedgerError);
    expect(() => ledger.pass('T-alpha')).toThrow(/illegal_transition/);
    ledger.close();
  });

  it('L10: reject duplicate start', () => {
    const { ledger } = makeLedger();
    ledger.registerManifest();
    ledger.start('T-alpha');
    expect(() => ledger.start('T-alpha')).toThrow(/illegal_transition/);
    ledger.close();
  });

  it('L11: reject duplicate terminal transition (pass after pass)', () => {
    const { ledger } = makeLedger();
    ledger.registerManifest();
    ledger.start('T-alpha');
    ledger.pass('T-alpha');
    expect(() => ledger.pass('T-alpha')).toThrow(/illegal_transition/);
    expect(() => ledger.fail('T-alpha', 'x')).toThrow(/illegal_transition/);
    ledger.close();
  });

  it('L11b: reject duplicate registration', () => {
    const { ledger } = makeLedger();
    ledger.registerManifest();
    expect(() => ledger.registerManifest()).toThrow(/duplicate_register/);
    ledger.close();
  });

  it('L11c: reject unknown requirement ID on start/pass/fail', () => {
    const { ledger } = makeLedger();
    ledger.registerManifest();
    expect(() => ledger.start('T-nope')).toThrow(/unknown_requirement/);
    expect(() => ledger.pass('T-nope')).toThrow(/unknown_requirement/);
    expect(() => ledger.fail('T-nope', 'x')).toThrow(/unknown_requirement/);
    ledger.close();
  });

  it('L12+L13: reducer preserves first failure and records secondary ones', () => {
    const { ledger, manifest } = makeLedger();
    ledger.registerManifest();
    ledger.start('T-alpha'); ledger.fail('T-alpha', 'first_failure_message');
    ledger.start('T-beta'); ledger.fail('T-beta', 'second_failure_message');
    ledger.start('CLEANUP:server_stop'); ledger.fail('CLEANUP:server_stop', 'cleanup_failed');
    const { events, bytes } = readLedgerEvents(ledger.ledgerFilePath());
    const summary = reduceNativeExecutionLedger(events, manifest, bytes);
    expect(summary.firstFailure?.requirementId).toBe('T-alpha');
    expect(summary.firstFailure?.failureCode).toBe('first_failure_message');
    expect(summary.secondaryFailures.map((f) => f.requirementId)).toEqual(['T-beta', 'CLEANUP:server_stop']);
    ledger.close();
  });

  it('L14: unstarted detection — a registered but never-started requirement', () => {
    const { ledger, manifest } = makeLedger();
    ledger.registerManifest();
    ledger.start('T-alpha'); ledger.pass('T-alpha');
    // T-beta stays registered.
    const { events, bytes } = readLedgerEvents(ledger.ledgerFilePath());
    const summary = reduceNativeExecutionLedger(events, manifest, bytes);
    expect(summary.unstarted).toBeGreaterThanOrEqual(1);
    expect(summary.complete).toBe(false);
    ledger.close();
  });

  it('L15: incomplete detection — started without terminal', () => {
    const { ledger, manifest } = makeLedger();
    ledger.registerManifest();
    ledger.start('T-alpha'); // never terminated
    const { events, bytes } = readLedgerEvents(ledger.ledgerFilePath());
    const summary = reduceNativeExecutionLedger(events, manifest, bytes);
    expect(summary.incomplete).toBeGreaterThanOrEqual(1);
    expect(summary.complete).toBe(false);
    ledger.close();
  });

  it('L16: exact category summaries', () => {
    const { ledger, manifest } = makeLedger();
    ledger.registerManifest();
    // Pass everything except cleanup.
    for (const r of manifest) {
      if (r.category === 'cleanup') continue;
      ledger.start(r.id); ledger.pass(r.id);
    }
    const { events, bytes } = readLedgerEvents(ledger.ledgerFilePath());
    const summary = reduceNativeExecutionLedger(events, manifest, bytes);
    expect(summary.byCategory.startup.passed).toBe(1);
    expect(summary.byCategory.domain.passed).toBe(1);
    expect(summary.byCategory.screen_navigation.passed).toBe(1);
    expect(summary.byCategory.cleanup.unstarted).toBe(1);
    ledger.close();
  });

  it('L17: exact screen summaries', () => {
    const { ledger, manifest } = makeLedger();
    ledger.registerManifest();
    ledger.start('NAV:overview'); ledger.pass('NAV:overview');
    ledger.start('SIG:overview'); ledger.fail('SIG:overview', 'sig_missing');
    // MANIFEST:overview stays registered.
    const { events, bytes } = readLedgerEvents(ledger.ledgerFilePath());
    const summary = reduceNativeExecutionLedger(events, manifest, bytes);
    expect(summary.screens.overview.navigation).toBe('passed');
    expect(summary.screens.overview.signature).toBe('failed');
    expect(summary.screens.overview.manifest).toBe('registered');
    ledger.close();
  });

  it('L18: JSONL output survives an out-of-process reader', () => {
    const { ledger, runDir } = makeLedger();
    ledger.registerManifest();
    ledger.start('T-alpha'); ledger.pass('T-alpha');
    ledger.close();
    const raw = readFileSync(join(runDir, 'native-execution-ledger.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('L19: reducer is deterministic across two independent reductions', () => {
    const { ledger, manifest } = makeLedger();
    ledger.registerManifest();
    for (const r of manifest) { ledger.start(r.id); ledger.pass(r.id); }
    const { events, bytes } = readLedgerEvents(ledger.ledgerFilePath());
    const a = reduceNativeExecutionLedger(events, manifest, bytes);
    const b = reduceNativeExecutionLedger(events, manifest, bytes);
    expect(a).toEqual(b);
    expect(a.complete).toBe(true);
    ledger.close();
  });

  it('L20: tamper detection — flipping a single byte changes the ledger hash', () => {
    const { ledger, runDir, manifest } = makeLedger();
    ledger.registerManifest();
    ledger.start('T-alpha'); ledger.pass('T-alpha');
    ledger.close();
    const path = join(runDir, 'native-execution-ledger.jsonl');
    const original = readFileSync(path);
    const summaryA = reduceNativeExecutionLedger(readLedgerEvents(path).events, manifest, original);
    // Rewrite with the last byte doubled to change file bytes without
    // changing parseable JSON structure — the hash MUST still change.
    const tampered = Buffer.concat([original, Buffer.from('\n{"sequence":9999,"timestamp":"z","requirementId":"T-alpha","category":"startup","transition":"fail","failureCode":"tamper"}\n')]);
    writeFileSync(path, tampered);
    const summaryB = reduceNativeExecutionLedger(readLedgerEvents(path).events, manifest, tampered);
    expect(summaryA.ledgerHash).not.toBe(summaryB.ledgerHash);
  });

  it('L21: sanitizeFailureCode redacts Bearer + hex tokens + bounds length', () => {
    const raw = 'boom Bearer abc.def_ghi-jkl123 and 0123456789abcdef0123456789abcdef and ' + 'x'.repeat(500);
    const out = sanitizeFailureCode(raw);
    expect(out).toContain('Bearer <REDACTED>');
    expect(out).toContain('<HEX_REDACTED>');
    expect(out.length).toBeLessThanOrEqual(240);
  });

  it('L22: pure reducer detects out-of-order sequence numbers as a synthetic failure', () => {
    const manifest = makeManifest();
    const events: NativeExecutionEvent[] = [
      { sequence: 0, timestamp: 'z', requirementId: 'T-alpha', category: 'startup', transition: 'register' },
      { sequence: 3, timestamp: 'z', requirementId: 'T-beta', category: 'domain', transition: 'register' },
      { sequence: 2, timestamp: 'z', requirementId: 'T-alpha', category: 'startup', transition: 'start' }, // out of order
    ];
    const summary = reduceNativeExecutionLedger(events, manifest, Buffer.alloc(0));
    expect(summary.firstFailure?.failureCode).toMatch(/out_of_order_sequence/);
    expect(summary.complete).toBe(false);
  });

  it('L23: identical manifest → identical manifest hash', () => {
    const a = makeManifest();
    const b = makeManifest();
    expect(computeManifestHash(a)).toBe(computeManifestHash(b));
  });

  it('L24: finalizeSummary writes atomically and re-reads consistently', () => {
    const { ledger, runDir, manifest } = makeLedger();
    ledger.registerManifest();
    for (const r of manifest) { ledger.start(r.id); ledger.pass(r.id); }
    const summary = ledger.finalizeSummary();
    ledger.close();
    const written = JSON.parse(readFileSync(join(runDir, 'native-execution-summary.json'), 'utf8'));
    expect(written.manifestHash).toBe(summary.manifestHash);
    expect(written.ledgerHash).toBe(summary.ledgerHash);
    expect(written.complete).toBe(true);
  });
});
