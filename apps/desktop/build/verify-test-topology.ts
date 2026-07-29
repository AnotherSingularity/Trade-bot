/**
 * Stage 3C-CI-RESET Part 2 Checkpoint B — machine-readable Stage 3C
 * suite manifest verifier.
 *
 * Runs `npm run verify:test-topology` in apps/desktop. Every failure
 * mode below prints a specific classification and exits 1 so a CI
 * regression is visible in the check summary without hunting through
 * vitest include/exclude edits.
 *
 * Checks (fail-closed on any violation):
 *
 *   T1. Every *.test.ts / *.test.tsx file on disk under apps/desktop/tests/
 *       appears in exactly one bucket of the manifest's `assignments`
 *       map (portable / external / native / unassigned). A new test
 *       file that lands without being classified fails this check
 *       with a `topology_unclassified` tag.
 *
 *   T2. Every file the manifest lists exists on disk. A rename
 *       or delete that forgets to update the manifest fails with a
 *       `topology_missing_file` tag.
 *
 *   T3. No file appears in more than one bucket. Pre-RESET
 *       protectionSeedRegression + auth_seam_login_body were briefly
 *       included by BOTH portable's fallback glob AND the external
 *       config — that class of drift now fails with a
 *       `topology_duplicate_assignment` tag.
 *
 *   T4. The manifest's `portable` assignment equals the set of test
 *       files vitest.config.ts would resolve — i.e. all on-disk test
 *       files MINUS the exclude list MINUS anything in the external
 *       / native / unassigned bucket. Fails with
 *       `topology_portable_disagreement` and prints the diff.
 *
 *   T5. The manifest's `external` assignment equals
 *       vitest.external.config.ts's `include` list, verbatim. Fails
 *       with `topology_external_disagreement`.
 *
 *   T6. The manifest's `native` assignment equals
 *       vitest.native.config.ts's `include` list, verbatim. Fails
 *       with `topology_native_disagreement`.
 *
 *   T7. Every entry in `unassigned` MUST carry a non-empty
 *       `reason`. A file dropped into the unassigned bucket without
 *       an audit note fails with `topology_missing_reason`.
 *
 *   T8. Each suite definition MUST declare the fields the
 *       downstream tooling reads (configFile / runsOnCi /
 *       requiresServices / npmScript / includeMode). Fails with
 *       `topology_incomplete_suite_definition`.
 *
 * Not covered by this verifier: whether the tests inside a file
 * actually run, whether they pass, or how long they take. Those are
 * concerns of the test suite itself, not the topology.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(HERE, '..');
const TESTS_ROOT = resolve(DESKTOP_ROOT, 'tests');
const MANIFEST_PATH = resolve(TESTS_ROOT, 'suite-manifest.json');
const PORTABLE_CONFIG = resolve(DESKTOP_ROOT, 'vitest.config.ts');
const EXTERNAL_CONFIG = resolve(DESKTOP_ROOT, 'vitest.external.config.ts');
const NATIVE_CONFIG = resolve(DESKTOP_ROOT, 'vitest.native.config.ts');
const MANAGED_DOCKER_CONFIG = resolve(DESKTOP_ROOT, 'vitest.managed-docker.config.ts');

// ---------------------------------------------------------------------------
// Types describing the manifest shape. Kept structural (no z.parse) so
// this file has zero runtime deps beyond node built-ins + tsx.
// ---------------------------------------------------------------------------

export interface SuiteDefinition {
  configFile: string | null;
  purpose: string;
  runsOnCi: readonly string[];
  requiresServices: readonly string[];
  npmScript: string | null;
  includeMode: 'glob' | 'explicit';
  includeGlob?: readonly string[];
}

export interface UnassignedEntry {
  file: string;
  reason: string;
}

export interface SuiteManifest {
  $schema: string;
  description: string;
  generatedFor: string;
  suites: {
    portable: SuiteDefinition;
    external: SuiteDefinition;
    native: SuiteDefinition;
    'managed-docker': SuiteDefinition;
    unassigned: SuiteDefinition;
  };
  assignments: {
    portable: readonly string[];
    external: readonly string[];
    native: readonly string[];
    'managed-docker': readonly string[];
    unassigned: readonly UnassignedEntry[];
  };
}

// ---------------------------------------------------------------------------
// On-disk enumeration.
// ---------------------------------------------------------------------------

function walkTests(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      // Skip cache / build artefacts under tests/, none of which
      // hold *.test.ts files today but a future contributor might.
      if (name === 'logs') continue;
      walkTests(p, acc);
    } else if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) {
      acc.push(relative(DESKTOP_ROOT, p));
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Vitest config extraction. Dynamic-imports the config module and reads
// `default.test.include` / `default.test.exclude`. Because the configs
// use `@vitejs/plugin-react` we run under tsx (which resolves the plugin
// through the desktop workspace's node_modules).
// ---------------------------------------------------------------------------

interface VitestConfigShape {
  default?: {
    test?: {
      include?: readonly string[];
      exclude?: readonly string[];
    };
  };
}

async function loadConfig(path: string): Promise<{ include: readonly string[]; exclude: readonly string[] }> {
  const cfg = await import(pathToFileURL(path).href) as VitestConfigShape;
  const include = cfg.default?.test?.include ?? [];
  const exclude = cfg.default?.test?.exclude ?? [];
  return { include, exclude };
}

// ---------------------------------------------------------------------------
// Simple glob matcher. Only supports the two patterns the portable
// config uses: `tests/**/pattern.test.ts(x?)` style and literal file
// paths. We do NOT depend on a real glob library so this verifier has
// zero external node deps.
// ---------------------------------------------------------------------------

function toRegExp(pattern: string): RegExp {
  // Escape regex metachars EXCEPT `*` and `?`, then expand:
  //   `/**/` → `/(?:.*/)?` — matches zero-or-more path segments
  //             so `tests/**/*.test.ts` matches BOTH
  //             `tests/foo.test.ts` AND `tests/sub/foo.test.ts`.
  //   `**/` at pattern start → `(?:.*/)?`
  //   `/**` at pattern end   → `(?:/.*)?`
  //   `**`  → `.*` (any characters incl. `/`)
  //   `*`   → `[^/]*` (single-segment)
  //   `?`   → `.`
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const rx = escaped
    .replace(/\/\*\*\//g, '__SLASH_DOUBLESTAR_SLASH__')
    .replace(/^\*\*\//g, '__PREFIX_DOUBLESTAR__')
    .replace(/\/\*\*$/g, '__SUFFIX_DOUBLESTAR__')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/__SLASH_DOUBLESTAR_SLASH__/g, '/(?:.*/)?')
    .replace(/__PREFIX_DOUBLESTAR__/g, '(?:.*/)?')
    .replace(/__SUFFIX_DOUBLESTAR__/g, '(?:/.*)?');
  return new RegExp(`^${rx}$`);
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => toRegExp(p).test(path));
}

// ---------------------------------------------------------------------------
// Violation reporting.
// ---------------------------------------------------------------------------

interface Violation {
  tag: string;
  detail: string;
}

function fail(violations: readonly Violation[]): never {
  // Sort by tag then detail so a diff between runs is stable.
  const sorted = [...violations].sort((a, b) =>
    a.tag === b.tag ? a.detail.localeCompare(b.detail) : a.tag.localeCompare(b.tag),
  );
  console.error(`\nverify:test-topology FAILED — ${sorted.length} violation(s):\n`);
  for (const v of sorted) {
    console.error(`  [${v.tag}] ${v.detail}`);
  }
  console.error(`\nEdit apps/desktop/tests/suite-manifest.json or the vitest config to reconcile.\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as SuiteManifest;
  const violations: Violation[] = [];

  // T8: Each suite definition MUST carry the fields downstream tooling reads.
  for (const [name, def] of Object.entries(manifest.suites)) {
    const missing: string[] = [];
    if (def.configFile === undefined) missing.push('configFile');
    if (typeof def.purpose !== 'string' || def.purpose.length === 0) missing.push('purpose');
    if (!Array.isArray(def.runsOnCi)) missing.push('runsOnCi');
    if (!Array.isArray(def.requiresServices)) missing.push('requiresServices');
    if (def.npmScript === undefined) missing.push('npmScript');
    if (def.includeMode !== 'glob' && def.includeMode !== 'explicit') missing.push('includeMode');
    if (missing.length > 0) {
      violations.push({
        tag: 'topology_incomplete_suite_definition',
        detail: `suite '${name}' missing fields: ${missing.join(', ')}`,
      });
    }
  }

  // Enumerate on-disk files.
  const diskFiles = new Set(walkTests(TESTS_ROOT).map((p) => p.replace(/\\/g, '/')));

  // Union of every file claimed by any bucket.
  const portableSet = new Set(manifest.assignments.portable);
  const externalSet = new Set(manifest.assignments.external);
  const nativeSet = new Set(manifest.assignments.native);
  const managedDockerSet = new Set(manifest.assignments['managed-docker']);
  const unassignedSet = new Set(manifest.assignments.unassigned.map((e) => e.file));
  const allClaimed = new Set([...portableSet, ...externalSet, ...nativeSet, ...managedDockerSet, ...unassignedSet]);

  // T2: Every manifest-listed file exists on disk.
  for (const f of allClaimed) {
    if (!diskFiles.has(f)) {
      violations.push({ tag: 'topology_missing_file', detail: `${f} is listed in the manifest but does not exist on disk` });
    }
  }

  // T1: Every on-disk file is claimed by exactly one bucket (below).
  for (const f of diskFiles) {
    if (!allClaimed.has(f)) {
      violations.push({ tag: 'topology_unclassified', detail: `${f} exists on disk but is not listed in any manifest bucket` });
    }
  }

  // T3: No file is claimed by more than one bucket.
  const counts = new Map<string, string[]>();
  const add = (f: string, bucket: string): void => {
    const cur = counts.get(f) ?? [];
    cur.push(bucket);
    counts.set(f, cur);
  };
  portableSet.forEach((f) => add(f, 'portable'));
  externalSet.forEach((f) => add(f, 'external'));
  nativeSet.forEach((f) => add(f, 'native'));
  managedDockerSet.forEach((f) => add(f, 'managed-docker'));
  unassignedSet.forEach((f) => add(f, 'unassigned'));
  for (const [f, buckets] of counts) {
    if (buckets.length > 1) {
      violations.push({ tag: 'topology_duplicate_assignment', detail: `${f} appears in buckets: ${buckets.join(', ')}` });
    }
  }

  // Stage 3C-CI-RESET Part 2 Checkpoint D.0 — no executable test file
  // may remain in the `unassigned` bucket. An entry here MUST cite
  // that the file is a non-executable fixture/helper AND the on-disk
  // scan MUST corroborate (no describe/it/test declarations). For
  // now the bucket is enforced to be empty: any *.test.ts under
  // tests/ that walks a describe/it/test IS executable by
  // definition. The check below fails if the bucket contains any
  // entry whose file matches the test-discovery scan (which is all
  // of them, since the walker only picks up .test.ts files).
  for (const entry of manifest.assignments.unassigned) {
    if (diskFiles.has(entry.file)) {
      violations.push({
        tag: 'topology_unassigned_executable',
        detail: `${entry.file} is a discovered test file — it MUST be assigned to portable / external / native (reason='${(entry.reason ?? '').slice(0, 60)}')`,
      });
    } else {
      // Non-existent file in the unassigned bucket is a pure stale
      // entry — surfaces via topology_missing_file above too, but a
      // dedicated tag makes cleanup unambiguous.
      violations.push({
        tag: 'topology_unassigned_stale',
        detail: `${entry.file} listed as unassigned but not present on disk`,
      });
    }
  }

  // T5/T6: manifest external / native lists agree with the vitest configs verbatim.
  const external = await loadConfig(EXTERNAL_CONFIG);
  const native = await loadConfig(NATIVE_CONFIG);
  const portable = await loadConfig(PORTABLE_CONFIG);
  const managedDocker = await loadConfig(MANAGED_DOCKER_CONFIG);

  const externalCfgList = [...external.include].map((s) => s.replace(/\\/g, '/')).sort();
  const externalManifestList = [...manifest.assignments.external].sort();
  if (externalCfgList.join('\n') !== externalManifestList.join('\n')) {
    const cfgOnly = externalCfgList.filter((f) => !externalManifestList.includes(f));
    const manifestOnly = externalManifestList.filter((f) => !externalCfgList.includes(f));
    if (cfgOnly.length > 0) {
      violations.push({
        tag: 'topology_external_disagreement',
        detail: `files in vitest.external.config.ts but NOT in manifest.external: ${cfgOnly.join(', ')}`,
      });
    }
    if (manifestOnly.length > 0) {
      violations.push({
        tag: 'topology_external_disagreement',
        detail: `files in manifest.external but NOT in vitest.external.config.ts: ${manifestOnly.join(', ')}`,
      });
    }
  }

  const nativeCfgList = [...native.include].map((s) => s.replace(/\\/g, '/')).sort();
  const nativeManifestList = [...manifest.assignments.native].sort();
  if (nativeCfgList.join('\n') !== nativeManifestList.join('\n')) {
    const cfgOnly = nativeCfgList.filter((f) => !nativeManifestList.includes(f));
    const manifestOnly = nativeManifestList.filter((f) => !nativeCfgList.includes(f));
    if (cfgOnly.length > 0) {
      violations.push({
        tag: 'topology_native_disagreement',
        detail: `files in vitest.native.config.ts but NOT in manifest.native: ${cfgOnly.join(', ')}`,
      });
    }
    if (manifestOnly.length > 0) {
      violations.push({
        tag: 'topology_native_disagreement',
        detail: `files in manifest.native but NOT in vitest.native.config.ts: ${manifestOnly.join(', ')}`,
      });
    }
  }

  const managedDockerCfgList = [...managedDocker.include].map((s) => s.replace(/\\/g, '/')).sort();
  const managedDockerManifestList = [...manifest.assignments['managed-docker']].sort();
  if (managedDockerCfgList.join('\n') !== managedDockerManifestList.join('\n')) {
    const cfgOnly = managedDockerCfgList.filter((f) => !managedDockerManifestList.includes(f));
    const manifestOnly = managedDockerManifestList.filter((f) => !managedDockerCfgList.includes(f));
    if (cfgOnly.length > 0) {
      violations.push({
        tag: 'topology_managed_docker_disagreement',
        detail: `files in vitest.managed-docker.config.ts but NOT in manifest[managed-docker]: ${cfgOnly.join(', ')}`,
      });
    }
    if (manifestOnly.length > 0) {
      violations.push({
        tag: 'topology_managed_docker_disagreement',
        detail: `files in manifest[managed-docker] but NOT in vitest.managed-docker.config.ts: ${manifestOnly.join(', ')}`,
      });
    }
  }

  // T4: manifest.portable equals { on-disk tests matching portable.include }
  //     MINUS { anything in portable.exclude }.
  const portableIncludePatterns = portable.include;
  const portableExcludePatterns = portable.exclude;
  const portableResolved = [...diskFiles]
    .filter((f) => matchesAny(f, portableIncludePatterns))
    .filter((f) => !matchesAny(f, portableExcludePatterns))
    .sort();
  const portableManifestList = [...manifest.assignments.portable].sort();
  if (portableResolved.join('\n') !== portableManifestList.join('\n')) {
    const cfgOnly = portableResolved.filter((f) => !portableManifestList.includes(f));
    const manifestOnly = portableManifestList.filter((f) => !portableResolved.includes(f));
    if (cfgOnly.length > 0) {
      violations.push({
        tag: 'topology_portable_disagreement',
        detail: `files vitest.config.ts would resolve but NOT in manifest.portable: ${cfgOnly.join(', ')}`,
      });
    }
    if (manifestOnly.length > 0) {
      violations.push({
        tag: 'topology_portable_disagreement',
        detail: `files in manifest.portable but vitest.config.ts would NOT resolve them: ${manifestOnly.join(', ')}`,
      });
    }
  }

  if (violations.length > 0) fail(violations);

  console.log(
    `verify:test-topology OK — ${diskFiles.size} test files classified across ${Object.keys(manifest.suites).length} suites`,
  );
  console.log(
    `  portable=${manifest.assignments.portable.length}  external=${manifest.assignments.external.length}  native=${manifest.assignments.native.length}  unassigned=${manifest.assignments.unassigned.length}`,
  );
}

main().catch((e) => {
  console.error('verify:test-topology CRASHED:', e instanceof Error ? e.stack : String(e));
  process.exit(2);
});
