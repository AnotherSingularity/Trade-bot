/**
 * Stage 3C-CI-RESET Part 2 Checkpoint E.6 — every decision branch of
 * the pure external-server-mode policy resolver. These tests are the
 * sole proof that `HORIZON_SERVER_EXTERNAL` cannot cause a packaged
 * installer to attach to a foreign server process, and that a typo
 * cannot silently disable the supervisor.
 */

import { describe, expect, it } from 'vitest';
import { resolveExternalServerMode } from '../../src/main/externalServerPolicy';

describe('resolveExternalServerMode', () => {
  // -------------------------------------------------------------------
  // Absent / empty → supervised (default hardened path).
  // -------------------------------------------------------------------

  it('undefined env → supervised', () => {
    const d = resolveExternalServerMode({ isPackaged: false, serverExternalEnv: undefined });
    expect(d.mode).toBe('supervised');
    if (d.mode === 'supervised') expect(d.reason).toBe('supervised_no_env_override');
  });

  it('undefined env + packaged → supervised', () => {
    const d = resolveExternalServerMode({ isPackaged: true, serverExternalEnv: undefined });
    expect(d.mode).toBe('supervised');
  });

  it('empty string env → supervised', () => {
    const d = resolveExternalServerMode({ isPackaged: false, serverExternalEnv: '' });
    expect(d.mode).toBe('supervised');
    if (d.mode === 'supervised') expect(d.reason).toBe('supervised_env_empty');
  });

  // -------------------------------------------------------------------
  // Canonical 'true' + unpackaged → external accepted.
  // -------------------------------------------------------------------

  it("env='true' + unpackaged → external", () => {
    const d = resolveExternalServerMode({ isPackaged: false, serverExternalEnv: 'true' });
    expect(d.mode).toBe('external');
    if (d.mode === 'external') expect(d.reason).toBe('external_accepted_unpackaged_canonical');
  });

  // -------------------------------------------------------------------
  // Canonical 'true' + packaged → REJECTED (packaged wins).
  // -------------------------------------------------------------------

  it("env='true' + packaged → REJECTED (packaged wins)", () => {
    const d = resolveExternalServerMode({ isPackaged: true, serverExternalEnv: 'true' });
    expect(d.mode).toBe('rejected');
    if (d.mode === 'rejected') expect(d.reason).toBe('external_rejected_packaged');
  });

  // -------------------------------------------------------------------
  // Non-canonical values → REJECTED (typo protection).
  // -------------------------------------------------------------------

  const nonCanonicalValues = ['1', '0', 'TRUE', 'True', 'yes', 'no', 'on', 'off', 'YES', 'y', 'n', 'enable', 'disabled', 'stringy'];

  for (const v of nonCanonicalValues) {
    it(`env='${v}' + unpackaged → REJECTED (non-canonical)`, () => {
      const d = resolveExternalServerMode({ isPackaged: false, serverExternalEnv: v });
      expect(d.mode).toBe('rejected');
      if (d.mode === 'rejected') {
        expect(d.reason).toBe('external_rejected_non_canonical_value');
        expect(d.detail).toBe(v);
      }
    });
  }

  it("env='1' + packaged → REJECTED (non-canonical, packaged does not matter)", () => {
    const d = resolveExternalServerMode({ isPackaged: true, serverExternalEnv: '1' });
    expect(d.mode).toBe('rejected');
    if (d.mode === 'rejected') expect(d.reason).toBe('external_rejected_non_canonical_value');
  });

  it('extremely long non-canonical value → REJECTED (detail truncated to 32 chars)', () => {
    const long = 'x'.repeat(500);
    const d = resolveExternalServerMode({ isPackaged: false, serverExternalEnv: long });
    expect(d.mode).toBe('rejected');
    if (d.mode === 'rejected') {
      expect(d.reason).toBe('external_rejected_non_canonical_value');
      expect(d.detail.length).toBeLessThanOrEqual(32);
    }
  });

  // -------------------------------------------------------------------
  // Whitespace-only / mixed case — none pass the canonical 'true' check.
  // -------------------------------------------------------------------

  it("env=' true' → REJECTED (leading whitespace)", () => {
    const d = resolveExternalServerMode({ isPackaged: false, serverExternalEnv: ' true' });
    expect(d.mode).toBe('rejected');
    if (d.mode === 'rejected') expect(d.reason).toBe('external_rejected_non_canonical_value');
  });

  it("env='true ' → REJECTED (trailing whitespace)", () => {
    const d = resolveExternalServerMode({ isPackaged: false, serverExternalEnv: 'true ' });
    expect(d.mode).toBe('rejected');
  });
});
