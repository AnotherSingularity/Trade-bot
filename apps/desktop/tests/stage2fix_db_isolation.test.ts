/**
 * Stage 2-FIX §1 — regression guard: the desktop scratch-DB helper
 * structurally refuses to drop or create the shared server test DB (or
 * any protected database), even if a future test names one explicitly.
 *
 * Also verifies that generated scratch names are unique across pid,
 * timestamp, and random suffix — two concurrent runs cannot collide.
 *
 * Runs entirely in-process; no MariaDB required.
 */
import { describe, expect, it } from 'vitest';
import {
  PROTECTED_DATABASES,
  SCRATCH_PREFIX,
  assertScratchDb,
  createScratchDb,
  dropScratchDb,
  makeScratchDbName,
  scratchDbUrl,
} from './lib/scratchDb';

describe('stage2-fix §1 test-database isolation', () => {
  it('DBI1: assertScratchDb rejects the server suite database', () => {
    expect(() => assertScratchDb('horizon_trade_test')).toThrow(/protected database/);
  });

  it('DBI2: assertScratchDb rejects the application database', () => {
    expect(() => assertScratchDb('horizon_trade')).toThrow(/protected database/);
  });

  it('DBI3: assertScratchDb rejects every MariaDB system schema', () => {
    for (const name of ['mysql', 'information_schema', 'performance_schema', 'sys']) {
      expect(() => assertScratchDb(name)).toThrow(/protected database/);
    }
  });

  it('DBI4: assertScratchDb rejects any name without the scratch prefix', () => {
    expect(() => assertScratchDb('random_temp')).toThrow(/scratch database/);
    expect(() => assertScratchDb('horizon_experiment')).toThrow(/scratch database/);
  });

  it('DBI5: assertScratchDb accepts a well-formed scratch name', () => {
    expect(() => assertScratchDb(`${SCRATCH_PREFIX}session_pid123_abcdef`)).not.toThrow();
  });

  it('DBI6: createScratchDb refuses protected databases before touching MariaDB', async () => {
    for (const name of PROTECTED_DATABASES) {
      await expect(createScratchDb(name)).rejects.toThrow(/protected database/);
    }
  });

  it('DBI7: dropScratchDb refuses protected databases before touching MariaDB', async () => {
    for (const name of PROTECTED_DATABASES) {
      await expect(dropScratchDb(name)).rejects.toThrow(/protected database/);
    }
  });

  it('DBI8: dropScratchDb refuses a name without the scratch prefix', async () => {
    await expect(dropScratchDb('unrelated_db')).rejects.toThrow(/scratch database/);
  });

  it('DBI9: makeScratchDbName always produces the scratch prefix + pid + unique suffix', () => {
    const a = makeScratchDbName('sample');
    expect(a).toMatch(new RegExp(`^${SCRATCH_PREFIX}sample_${process.pid}_[a-z0-9]+$`));
    expect(a).not.toBe(makeScratchDbName('sample'));
  });

  it('DBI10: makeScratchDbName produces distinct names on rapid successive calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(makeScratchDbName('bulk'));
    expect(seen.size).toBe(100);
  });

  it('DBI11: makeScratchDbName rejects malformed labels (no path traversal / no SQL metachars)', () => {
    for (const bad of ['../etc', 'has space', 'has-dash', "with'quote", '']) {
      expect(() => makeScratchDbName(bad)).toThrow(/scratch label/);
    }
  });

  it('DBI12: scratchDbUrl embeds the scratch DB path and only accepts scratch names', () => {
    const name = makeScratchDbName('url');
    expect(scratchDbUrl(name)).toBe(`mysql://root:password@127.0.0.1:3306/${name}`);
    expect(() => scratchDbUrl('horizon_trade_test')).toThrow(/protected database/);
  });
});
