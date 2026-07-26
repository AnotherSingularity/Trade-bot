#!/usr/bin/env node
/**
 * Phase 3B §B — Static dependency graph for the active release surface.
 *
 * Scans every .ts/.tsx source file under active workspaces and records
 * every import statement. Produces a machine-readable graph plus a
 * markdown summary. Then applies the Phase 3B boundary rules and
 * reports violations.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const REPORT_DIR = join(REPO_ROOT, 'phase3b_audit/reports');
mkdirSync(REPORT_DIR, { recursive: true });

const ACTIVE = ['apps/server', 'apps/desktop', 'packages/shared'];

function walk(dir) {
  const out = [];
  function inner(d) {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e === 'node_modules' || e === 'dist' || e === '.turbo') continue;
      const full = join(d, e);
      const st = statSync(full);
      if (st.isDirectory()) inner(full);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e)) out.push(full);
    }
  }
  inner(dir);
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import\s+(?:[^'"\n]+\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\))/g;

function extractImports(src) {
  const out = new Set();
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src)) != null) {
    const spec = m[1] || m[2] || m[3];
    if (spec) out.add(spec);
  }
  return [...out];
}

const graph = {};
for (const ws of ACTIVE) {
  const wsRoot = join(REPO_ROOT, ws);
  const files = walk(wsRoot);
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const imports = extractImports(src);
    graph[relative(REPO_ROOT, f)] = { imports };
  }
}

// Boundary rules — every entry says the rule name, the file that would
// violate, and whether it currently violates.
const RULES = [
  {
    id: 'renderer_no_electron',
    description: 'Desktop renderer must never import from `electron`.',
    predicate: (file, imports) =>
      file.startsWith('apps/desktop/src/renderer/') &&
      imports.some((i) => i === 'electron' || i.startsWith('electron/')),
  },
  {
    id: 'renderer_no_node_fs',
    description: 'Desktop renderer must never import node:fs/node:child_process/node:https.',
    predicate: (file, imports) =>
      file.startsWith('apps/desktop/src/renderer/') &&
      imports.some((i) => /^node:(fs|child_process|https|http|net|dgram|tls)$/.test(i)),
  },
  {
    id: 'renderer_no_keytar',
    description: 'Desktop renderer must never import keytar.',
    predicate: (file, imports) =>
      file.startsWith('apps/desktop/src/renderer/') && imports.includes('keytar'),
  },
  {
    id: 'renderer_no_mariadb_or_drizzle',
    description: 'Desktop renderer must never import a MariaDB driver or drizzle-orm.',
    predicate: (file, imports) =>
      file.startsWith('apps/desktop/src/renderer/') &&
      imports.some((i) => i === 'mysql2' || i === 'mysql2/promise' || i === 'drizzle-orm' || i.startsWith('drizzle-orm/')),
  },
  {
    id: 'renderer_no_ioredis',
    description: 'Desktop renderer must never import ioredis or redis client.',
    predicate: (file, imports) =>
      file.startsWith('apps/desktop/src/renderer/') &&
      imports.some((i) => i === 'ioredis' || i === 'redis'),
  },
  {
    id: 'renderer_no_server_internals',
    description: 'Desktop renderer must never import from apps/server.',
    predicate: (file, imports) =>
      file.startsWith('apps/desktop/src/renderer/') &&
      imports.some((i) => /(^|\/)apps\/server\//.test(i) || /(^|\/)server\/src\//.test(i)),
  },
  {
    id: 'renderer_no_main_process',
    description: 'Desktop renderer must never import from apps/desktop/src/main or preload.',
    predicate: (file, imports) =>
      file.startsWith('apps/desktop/src/renderer/') &&
      imports.some((i) => /\.\.\/main\//.test(i) || /\.\.\/preload\//.test(i) || i.includes('desktop/src/main') || i.includes('desktop/src/preload')),
  },
  {
    id: 'champion_scanner_no_observer_import',
    description: 'Champion scanner must not import Phase 2A-2F observer modules.',
    predicate: (file, imports) =>
      /apps\/server\/src\/scanner\/(champion|core|runtime|liveScanner|shadowRuntime)/.test(file) &&
      imports.some((i) => /observers?\/(universe|regime|risk|microstructure|context|validation)/.test(i)),
  },
  {
    id: 'observer_no_champion_writer',
    description: 'Observer modules must not import champion economic writers.',
    predicate: (file, imports) =>
      /apps\/server\/src\/observers?\//.test(file) &&
      imports.some((i) => /applyEntryEconomicStateTx|applyExitEconomicStateTx|championExecutor|championAllocator/.test(i)),
  },
  {
    id: 'no_dynamic_electron_import',
    description: 'No file may dynamically import electron.',
    predicate: (file, imports) => imports.some((i) => i === 'electron' && file.startsWith('apps/desktop/src/renderer/')),
  },
];

const violations = [];
for (const [file, entry] of Object.entries(graph)) {
  for (const rule of RULES) {
    if (rule.predicate(file, entry.imports)) {
      violations.push({ ruleId: rule.id, file, matchedImports: entry.imports });
    }
  }
}

const report = {
  generatedAt: process.env.HORIZON_AUDIT_TIMESTAMP ?? '1970-01-01T00:00:00.000Z',
  workspaces: ACTIVE,
  totalFilesScanned: Object.keys(graph).length,
  ruleCount: RULES.length,
  violations,
  rulesEvaluated: RULES.map(({ id, description }) => ({ id, description })),
};

writeFileSync(join(REPORT_DIR, 'dependency_graph.json'), JSON.stringify(graph, null, 2));
writeFileSync(join(REPORT_DIR, 'isolation_report.json'), JSON.stringify(report, null, 2));

process.stdout.write(`dependency_graph.json + isolation_report.json written (files=${Object.keys(graph).length}, violations=${violations.length})\n`);
if (violations.length > 0) {
  process.stderr.write(`ISOLATION VIOLATIONS:\n${JSON.stringify(violations, null, 2)}\n`);
  process.exit(1);
}
