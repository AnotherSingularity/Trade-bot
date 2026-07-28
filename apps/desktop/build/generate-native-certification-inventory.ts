/**
 * Stage 3C-CI-RESET Part 2 Checkpoint D.0 — native certification
 * inventory generator.
 *
 * Emits `native-certification-inventory.json` alongside the manifest
 * source. The file is regenerated on every CI run and cross-checked
 * against the runtime-manifest hash in the native-execution-summary
 * so a drift between the source manifest and the emitted inventory
 * fails CI.
 *
 * The inventory schema:
 *
 *   {
 *     contract: 'stage3c-native-certification-inventory.v1',
 *     manifestHash: string,          // sha256 of the canonical manifest
 *     totalRequirements: number,
 *     byCategory: Record<Category, number>,
 *     screenKeys: string[],           // NINETEEN_SCREEN_MANIFEST keys
 *     requirements: Array<{
 *       id, category, title, screenKey?,
 *       originatingDeclaration: 'certIt:<id>' | 'certIt:NAV:<key>' | ...
 *     }>
 *   }
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NATIVE_CERTIFICATION_CATEGORIES,
  NATIVE_CERTIFICATION_MANIFEST,
  NATIVE_SCREEN_KEYS,
  computeManifestHash,
  requirementsByCategory,
  type NativeCertificationRequirement,
} from '../tests/native/nativeCertificationManifest';

const HERE = dirname(fileURLToPath(import.meta.url));
const NATIVE_TEST = resolve(HERE, '..', 'tests/native/nativeElectron.integration.test.ts');
const OUT_PATH = resolve(HERE, '..', 'tests/native/native-certification-inventory.json');

function classifyDeclaration(r: NativeCertificationRequirement, testSrc: string): string {
  // Static certIt calls appear verbatim (certIt('T0', 'title', ...))
  // dynamic loops appear as `certIt(\`NAV:${route.key}\`, ...)`.
  const staticPattern = `certIt('${r.id}'`;
  if (testSrc.includes(staticPattern)) return `static:certIt('${r.id}')`;
  if (r.id.startsWith('NAV:') && testSrc.includes('certIt(`NAV:${route.key}`')) return 'dynamic:NAV_loop';
  if (r.id.startsWith('SIG:')) return `static:certIt('${r.id}')`;
  if (r.id.startsWith('MANIFEST:') && testSrc.includes('certIt(`MANIFEST:${entry.screenKey}`')) return 'dynamic:MANIFEST_loop';
  if (r.id.startsWith('CLEANUP:')) return `afterAll:ledger.recordCleanup('${r.id}')`;
  return 'unresolved';
}

async function main(): Promise<void> {
  const testSrc = readFileSync(NATIVE_TEST, 'utf8');
  const inventory = {
    contract: 'stage3c-native-certification-inventory.v1',
    manifestHash: computeManifestHash(NATIVE_CERTIFICATION_MANIFEST),
    totalRequirements: NATIVE_CERTIFICATION_MANIFEST.length,
    categoriesRecognized: [...NATIVE_CERTIFICATION_CATEGORIES],
    byCategory: requirementsByCategory(NATIVE_CERTIFICATION_MANIFEST),
    screenKeys: [...NATIVE_SCREEN_KEYS],
    requirements: NATIVE_CERTIFICATION_MANIFEST.map((r) => ({
      id: r.id,
      category: r.category,
      title: r.title,
      screenKey: r.screenKey ?? null,
      originatingDeclaration: classifyDeclaration(r, testSrc),
    })),
  };
  writeFileSync(OUT_PATH, JSON.stringify(inventory, null, 2));
  const unresolved = inventory.requirements.filter((r) => r.originatingDeclaration === 'unresolved');
  if (unresolved.length > 0) {
    console.error(`generate-native-certification-inventory: ${unresolved.length} unresolved requirements:`);
    for (const r of unresolved) console.error(`  - ${r.id}`);
    process.exit(1);
  }
  const total = Object.values(inventory.byCategory).reduce((a, b) => a + b, 0);
  if (total !== inventory.totalRequirements) {
    console.error(`generate-native-certification-inventory: category sum ${total} !== total ${inventory.totalRequirements}`);
    process.exit(1);
  }
  console.log(`generate-native-certification-inventory OK — ${inventory.totalRequirements} requirements, hash ${inventory.manifestHash.slice(0, 16)}…`);
  console.log(`  emitted ${OUT_PATH}`);
}

main().catch((e) => {
  console.error('generate-native-certification-inventory CRASHED:', e instanceof Error ? e.stack : String(e));
  process.exit(2);
});
