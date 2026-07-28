/**
 * Stage 3C-CI-RESET Part 2 Checkpoint C.1 + C.9 tests M1..M6 —
 * certification manifest unit tests.
 */

import { describe, expect, it } from 'vitest';
import { NINETEEN_SCREEN_MANIFEST } from '../native/deterministicSeed';
import {
  NATIVE_CERTIFICATION_CATEGORIES,
  NATIVE_CERTIFICATION_MANIFEST,
  NATIVE_SCREEN_KEYS,
  computeManifestHash,
  requirementsByCategory,
  screenRequirementIds,
} from '../native/nativeCertificationManifest';

describe('Stage 3C-CI-RESET Part 2 Checkpoint C.1 — native certification manifest', () => {
  it('M1: every requirement ID is unique', () => {
    const ids = NATIVE_CERTIFICATION_MANIFEST.map((r) => r.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes, `duplicate IDs: ${dupes.join(', ')}`).toEqual([]);
  });

  it('M2: manifest hash is deterministic across calls', () => {
    const a = computeManifestHash(NATIVE_CERTIFICATION_MANIFEST);
    const b = computeManifestHash(NATIVE_CERTIFICATION_MANIFEST);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('M2b: mutating any manifest entry changes the hash', () => {
    const original = computeManifestHash(NATIVE_CERTIFICATION_MANIFEST);
    const mutated = NATIVE_CERTIFICATION_MANIFEST.map((r, i) => (i === 0 ? { ...r, title: r.title + '_x' } : r));
    const otherHash = computeManifestHash(mutated);
    expect(otherHash).not.toBe(original);
  });

  it('M3: exactly 19 NAV entries', () => {
    const navs = NATIVE_CERTIFICATION_MANIFEST.filter((r) => r.category === 'screen_navigation' && r.id.startsWith('NAV:'));
    expect(navs).toHaveLength(19);
  });

  it('M4: exactly 19 SIG entries', () => {
    const sigs = NATIVE_CERTIFICATION_MANIFEST.filter((r) => r.category === 'screen_signature' && r.id.startsWith('SIG:'));
    expect(sigs).toHaveLength(19);
  });

  it('M5: exactly 19 MANIFEST entries', () => {
    const mans = NATIVE_CERTIFICATION_MANIFEST.filter((r) => r.category === 'screen_manifest' && r.id.startsWith('MANIFEST:'));
    expect(mans).toHaveLength(19);
  });

  it('M6: screen keys sourced from NINETEEN_SCREEN_MANIFEST (no independent list)', () => {
    // Every screen key referenced by the manifest MUST appear in
    // NINETEEN_SCREEN_MANIFEST. This is the guardrail against a
    // second maintained list drifting.
    const canonicalKeys = new Set(NINETEEN_SCREEN_MANIFEST.map((s) => s.screenKey));
    for (const key of NATIVE_SCREEN_KEYS) expect(canonicalKeys.has(key)).toBe(true);
    for (const r of NATIVE_CERTIFICATION_MANIFEST) {
      if (r.screenKey) expect(canonicalKeys.has(r.screenKey)).toBe(true);
    }
  });

  it('M7: every screen has EXACTLY one NAV, one SIG, one MANIFEST entry', () => {
    for (const screen of NINETEEN_SCREEN_MANIFEST) {
      const key = screen.screenKey;
      const nav = NATIVE_CERTIFICATION_MANIFEST.filter((r) => r.screenKey === key && r.category === 'screen_navigation');
      const sig = NATIVE_CERTIFICATION_MANIFEST.filter((r) => r.screenKey === key && r.category === 'screen_signature');
      const man = NATIVE_CERTIFICATION_MANIFEST.filter((r) => r.screenKey === key && r.category === 'screen_manifest');
      expect(nav, `${key} NAV count`).toHaveLength(1);
      expect(sig, `${key} SIG count`).toHaveLength(1);
      expect(man, `${key} MANIFEST count`).toHaveLength(1);
      const ids = screenRequirementIds(key);
      expect(nav[0].id).toBe(ids.nav);
      expect(sig[0].id).toBe(ids.sig);
      expect(man[0].id).toBe(ids.manifest);
    }
  });

  it('M8: every category value in the manifest is one of the 12 recognized categories', () => {
    for (const r of NATIVE_CERTIFICATION_MANIFEST) {
      expect(NATIVE_CERTIFICATION_CATEGORIES).toContain(r.category);
    }
  });

  it('M9: no unknown screen key appears', () => {
    const canonical = new Set(NINETEEN_SCREEN_MANIFEST.map((s) => s.screenKey));
    for (const r of NATIVE_CERTIFICATION_MANIFEST) {
      if (r.screenKey != null) {
        expect(canonical.has(r.screenKey), `${r.id} references unknown screen ${r.screenKey}`).toBe(true);
      }
    }
  });

  it('M10: requirementsByCategory sums to total requirement count', () => {
    const byCategory = requirementsByCategory(NATIVE_CERTIFICATION_MANIFEST);
    const sum = Object.values(byCategory).reduce((a, b) => a + b, 0);
    expect(sum).toBe(NATIVE_CERTIFICATION_MANIFEST.length);
  });
});
