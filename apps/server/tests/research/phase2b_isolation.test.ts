import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 2B §R — Source-level isolation guardrail.
 *
 * The regime observer must remain read-only against champion behavior:
 *   - No champion file imports from `src/research/regime/*`.
 *   - No `src/research/regime/*` file imports champion strategy code
 *     (executor, scanner authorization, allocation, protection,
 *     Claude prompt generation, runtime shadow execution).
 *   - Phase 2B may READ champion decisions for comparison ONLY via
 *     `champion_challenger_routing_comparisons`, which is populated
 *     AFTER the champion decision persists. It may not MUTATE any
 *     champion table.
 */

const SERVER_SRC = join(__dirname, '..', '..', 'src');

const CHAMPION_ROOTS = [
  'trading',
  'jobs',
  'labeling',
  'market_data',
  'reporting',
  'routers',
  'soak',
  'lib',
  'middleware',
  'db',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) out.push(full);
  }
  return out;
}

describe('Phase 2B §R — regime observer source isolation', () => {
  it('no champion source file imports from src/research/regime/*', () => {
    const offenders: string[] = [];
    for (const root of CHAMPION_ROOTS) {
      const dir = join(SERVER_SRC, root);
      for (const file of walk(dir)) {
        const src = readFileSync(file, 'utf8');
        const patterns = [
          /from\s+['"][^'"]*\/research\/regime\/[^'"]*['"]/g,
          /import\s*\(['"][^'"]*\/research\/regime\/[^'"]*['"]\)/g,
          /require\(['"][^'"]*\/research\/regime\/[^'"]*['"]\)/g,
        ];
        for (const p of patterns) {
          if (p.test(src)) {
            offenders.push(relative(SERVER_SRC, file).split(sep).join('/'));
            break;
          }
        }
      }
    }
    expect(offenders, `champion files may not import Phase 2B regime code: ${offenders.join(', ')}`).toEqual([]);
  });

  it('regime observer files do not import champion strategy behavior', () => {
    const forbidden = [
      /from\s+['"][^'"]*\/trading\/executor(?:['"]|\/)/g,
      /from\s+['"][^'"]*\/trading\/scanner(?:['"]|\/)/g,
      /from\s+['"][^'"]*\/trading\/exitAttemptAllocator(?:['"]|\/)/g,
      /from\s+['"][^'"]*\/trading\/protection(?:\/|['"])/g,
      /from\s+['"][^'"]*\/trading\/claude(?:['"]|\/)/g,
      /from\s+['"][^'"]*\/trading\/shadow(?:\/|['"])/g,
      /from\s+['"][^'"]*\/jobs\/(?:scanJob|queue|lease)(?:['"]|\/)/g,
    ];
    const offenders: Array<{ file: string; hits: string[] }> = [];
    for (const file of walk(join(SERVER_SRC, 'research', 'regime'))) {
      const src = readFileSync(file, 'utf8');
      const hits: string[] = [];
      for (const p of forbidden) {
        const m = src.match(p);
        if (m) hits.push(...m);
      }
      if (hits.length > 0)
        offenders.push({ file: relative(SERVER_SRC, file).split(sep).join('/'), hits });
    }
    expect(
      offenders,
      `regime code must remain observer-only: ${offenders.map((o) => `${o.file}: ${o.hits.join(', ')}`).join(' | ')}`,
    ).toEqual([]);
  });

  it('regime observer does not mutate any champion table', () => {
    const championTables = [
      'orderIntents',
      'fills',
      'positions',
      'roundTrips',
      'cashLedger',
      'protectionInstances',
      'protectionEvents',
      'shadowExecutionPlans',
      'postFillRevalidations',
      'decisionChains',
      'quantitativeDecisions',
      'signalCandidates',
      'executionCostForecasts',
      'setupEvaluations',
      'eligibilityDecisions',
      'strategyRoutingDecisions',
    ];
    const offenders: string[] = [];
    for (const file of walk(join(SERVER_SRC, 'research', 'regime'))) {
      const src = readFileSync(file, 'utf8');
      for (const t of championTables) {
        const insertPattern = new RegExp(`\\bdb\\.\\s*insert\\s*\\(\\s*${t}\\b`, 'g');
        const updatePattern = new RegExp(`\\bdb\\.\\s*update\\s*\\(\\s*${t}\\b`, 'g');
        const deletePattern = new RegExp(`\\bdb\\.\\s*delete\\s*\\(\\s*${t}\\b`, 'g');
        if (insertPattern.test(src) || updatePattern.test(src) || deletePattern.test(src)) {
          offenders.push(`${relative(SERVER_SRC, file).split(sep).join('/')}: ${t}`);
        }
      }
    }
    expect(offenders, `regime observer must not mutate champion tables: ${offenders.join(', ')}`).toEqual([]);
  });
});
