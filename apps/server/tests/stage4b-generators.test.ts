/**
 * Stage 4 §S4B — generator-registry contract tests.
 *
 * These are pure structural tests — no DB. They enforce the two
 * invariants a downstream worker relies on before it opens a
 * transaction:
 *   1. `REPORT_GENERATORS` covers every `REPORT_KINDS` entry, and
 *      each generator's `.kind` matches its registry key.
 *   2. Every generator's `.specVersion` is exactly
 *      `REPORT_SPEC_VERSIONS[kind]` — a shipped generator that forgot
 *      to bump its version cannot silently reuse an old artifact's
 *      contentDigest.
 *
 * DB-driven generator tests (source-HWM stability, csvSections shape,
 * redaction integration) are covered by the Stage 4C worker suite
 * once the transaction plumbing exists.
 */
import { describe, expect, it } from 'vitest';
import { REPORT_KINDS, REPORT_SPEC_VERSIONS } from '@horizon/shared';
import { REPORT_GENERATORS } from '../src/reports/generators';

describe('REPORT_GENERATORS — registry coverage', () => {
  it('covers every REPORT_KINDS entry exactly once', () => {
    const keys = Object.keys(REPORT_GENERATORS).sort();
    const kinds = [...REPORT_KINDS].sort();
    expect(keys).toEqual(kinds);
  });

  it('every generator kind matches its registry key', () => {
    for (const kind of REPORT_KINDS) {
      const gen = REPORT_GENERATORS[kind];
      expect(gen.kind).toBe(kind);
    }
  });

  it('every generator specVersion matches REPORT_SPEC_VERSIONS[kind]', () => {
    for (const kind of REPORT_KINDS) {
      const gen = REPORT_GENERATORS[kind];
      expect(gen.specVersion).toBe(REPORT_SPEC_VERSIONS[kind]);
    }
  });

  it('every generator exposes an async generate()', () => {
    for (const kind of REPORT_KINDS) {
      const gen = REPORT_GENERATORS[kind];
      expect(typeof gen.generate).toBe('function');
    }
  });

  it('registry is frozen so a misbehaving caller cannot swap a generator', () => {
    expect(Object.isFrozen(REPORT_GENERATORS)).toBe(true);
  });
});
