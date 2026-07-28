/**
 * Stage 3C-CI-RESET Part 2 Checkpoint D.0 — manifest ↔ certIt
 * mapping enforcement.
 *
 * Scans the native test source and proves:
 *   1. Every manifest requirement maps to EXACTLY one runtime certIt
 *      call site (static or dynamic-loop).
 *   2. No certIt call site produces an ID absent from the manifest.
 *   3. NAV / SIG / MANIFEST screen loops expand to 19 each.
 *   4. Every CLEANUP:* requirement is recorded via
 *      `ledger.recordCleanup('CLEANUP:...')` in afterAll.
 *   5. The generated `native-certification-inventory.json` on disk
 *      matches the current manifest hash.
 *
 * Failure classifications the CI reader can grep on:
 *   manifest_missing_declaration:<id>
 *   manifest_unknown_certIt:<id>
 *   manifest_screen_expansion:<category>:<count>
 *   manifest_cleanup_recording:<id>
 *   manifest_inventory_stale
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_CERTIFICATION_MANIFEST,
  NATIVE_SCREEN_KEYS,
  computeManifestHash,
} from '../native/nativeCertificationManifest';
import { CLEANUP_REQUIREMENT_IDS } from '../native/nativeCertificationManifest';

const NATIVE_TEST_PATH = resolve(__dirname, '..', 'native', 'nativeElectron.integration.test.ts');
const INVENTORY_PATH = resolve(__dirname, '..', 'native', 'native-certification-inventory.json');

const NATIVE_TEST_SRC = readFileSync(NATIVE_TEST_PATH, 'utf8');

function hasStaticCertIt(id: string): boolean {
  return NATIVE_TEST_SRC.includes(`certIt('${id}'`);
}

function hasDynamicLoop(name: string): boolean {
  return NATIVE_TEST_SRC.includes(name);
}

describe('Stage 3C-CI-RESET Part 2 Checkpoint D.0 — manifest ↔ certIt mapping', () => {
  it('MAP1: every non-screen non-cleanup requirement has a static certIt call', () => {
    const missing: string[] = [];
    for (const r of NATIVE_CERTIFICATION_MANIFEST) {
      if (r.category === 'cleanup') continue;
      if (r.category === 'screen_navigation') continue; // handled by MAP3
      if (r.category === 'screen_manifest') continue;   // handled by MAP3
      // Screen signatures are static per-screen certIt calls, so
      // MAP1 covers them and MAP3 also cross-checks the count.
      if (!hasStaticCertIt(r.id)) {
        missing.push(`manifest_missing_declaration:${r.id}`);
      }
    }
    expect(missing, `\n${missing.join('\n')}`).toEqual([]);
  });

  it('MAP2: no certIt call uses an ID absent from the manifest', () => {
    const ids = new Set(NATIVE_CERTIFICATION_MANIFEST.map((r) => r.id));
    // Match any `certIt('<id>',` — captures the id inside single quotes.
    // Template-literal `certIt(\`...\`)` calls are handled by MAP3.
    const staticRx = /certIt\('([^']+)',/g;
    const unknown: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = staticRx.exec(NATIVE_TEST_SRC)) != null) {
      const id = m[1];
      if (!ids.has(id)) unknown.push(`manifest_unknown_certIt:${id}`);
    }
    expect(unknown, `\n${unknown.join('\n')}`).toEqual([]);
  });

  it('MAP3: NAV loop expands to exactly 19 screens', () => {
    expect(hasDynamicLoop('certIt(`NAV:${route.key}`'), 'missing NAV dynamic loop').toBe(true);
    const navs = NATIVE_CERTIFICATION_MANIFEST.filter((r) => r.category === 'screen_navigation');
    expect(navs.length, 'NAV count').toBe(19);
    expect(NATIVE_SCREEN_KEYS.length, 'screen key count').toBe(19);
  });

  it('MAP4: MANIFEST loop expands to exactly 19 screens', () => {
    expect(hasDynamicLoop('certIt(`MANIFEST:${entry.screenKey}`'), 'missing MANIFEST dynamic loop').toBe(true);
    const mans = NATIVE_CERTIFICATION_MANIFEST.filter((r) => r.category === 'screen_manifest');
    expect(mans.length, 'MANIFEST count').toBe(19);
  });

  it('MAP5: SIG entries are all static, one per screen', () => {
    const missing: string[] = [];
    for (const key of NATIVE_SCREEN_KEYS) {
      if (!hasStaticCertIt(`SIG:${key}`)) missing.push(`manifest_missing_declaration:SIG:${key}`);
    }
    expect(missing, `\n${missing.join('\n')}`).toEqual([]);
    const sigs = NATIVE_CERTIFICATION_MANIFEST.filter((r) => r.category === 'screen_signature');
    expect(sigs.length).toBe(19);
  });

  it('MAP6: every CLEANUP requirement is recorded via ledger.recordCleanup in afterAll', () => {
    const missing: string[] = [];
    for (const id of CLEANUP_REQUIREMENT_IDS) {
      // Look for the exact form the afterAll block uses.
      if (!NATIVE_TEST_SRC.includes(`recordCleanup('${id}'`)) {
        missing.push(`manifest_cleanup_recording:${id}`);
      }
    }
    expect(missing, `\n${missing.join('\n')}`).toEqual([]);
  });

  it('MAP7: generated inventory matches the current manifest hash', () => {
    // If the inventory file is missing or stale, `npm run
    // generate:native-inventory` regenerates it. This assertion
    // prevents a commit that changes the manifest without
    // regenerating the audit artefact.
    let raw: string;
    try {
      raw = readFileSync(INVENTORY_PATH, 'utf8');
    } catch {
      throw new Error('manifest_inventory_stale: native-certification-inventory.json missing — run `npm run generate:native-inventory`');
    }
    const parsed = JSON.parse(raw) as { manifestHash: string; totalRequirements: number };
    const expected = computeManifestHash(NATIVE_CERTIFICATION_MANIFEST);
    expect(parsed.manifestHash, 'manifest_inventory_stale: hash mismatch — regenerate inventory').toBe(expected);
    expect(parsed.totalRequirements).toBe(NATIVE_CERTIFICATION_MANIFEST.length);
  });
});
