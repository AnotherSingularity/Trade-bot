import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 2C §AB — Source-level isolation guardrail.
 *
 * The RiskEngine must remain observer-only:
 *   - No champion file imports from src/research/risk/*.
 *   - No src/research/risk/* file imports champion strategy behavior
 *     (executor, scanner authorization, allocator, protection,
 *     Claude prompt, runtime shadow, scan job).
 *   - RiskEngine may not write fills, positions, ledger entries or
 *     round trips.
 *   - No implementation or fixture may set a risk multiplier > 1.
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

describe('Phase 2C §AB — RiskEngine source isolation', () => {
  it('no champion source file imports from src/research/risk/*', () => {
    const offenders: string[] = [];
    for (const root of CHAMPION_ROOTS) {
      const dir = join(SERVER_SRC, root);
      for (const file of walk(dir)) {
        const src = readFileSync(file, 'utf8');
        const patterns = [
          /from\s+['"][^'"]*\/research\/risk\/[^'"]*['"]/g,
          /import\s*\(['"][^'"]*\/research\/risk\/[^'"]*['"]\)/g,
          /require\(['"][^'"]*\/research\/risk\/[^'"]*['"]\)/g,
        ];
        for (const p of patterns) {
          if (p.test(src)) {
            offenders.push(relative(SERVER_SRC, file).split(sep).join('/'));
            break;
          }
        }
      }
    }
    expect(offenders, `champion files may not import Phase 2C risk code: ${offenders.join(', ')}`).toEqual([]);
  });

  it('RiskEngine files do not import champion strategy behavior', () => {
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
    for (const file of walk(join(SERVER_SRC, 'research', 'risk'))) {
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
      `risk code must remain observer-only: ${offenders.map((o) => `${o.file}: ${o.hits.join(', ')}`).join(' | ')}`,
    ).toEqual([]);
  });

  it('RiskEngine cannot write to any champion economic table', () => {
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
    ];
    const offenders: string[] = [];
    for (const file of walk(join(SERVER_SRC, 'research', 'risk'))) {
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
    expect(offenders, `risk observer must not mutate champion tables: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no implementation file assigns a size multiplier above 1', () => {
    const offenders: string[] = [];
    // Any literal like `multiplier: 1.5`, `sizeMultiplier > 1`, `*= 2` inside risk/.
    const patterns = [
      /\bmultiplier\s*[:=]\s*(?:[2-9](?:\.\d+)?|1\.[1-9])/g,
      /\bsizeMultiplier\s*[:=]\s*(?:[2-9](?:\.\d+)?|1\.[1-9])/g,
    ];
    for (const file of walk(join(SERVER_SRC, 'research', 'risk'))) {
      const src = readFileSync(file, 'utf8');
      for (const p of patterns) {
        if (p.test(src)) offenders.push(relative(SERVER_SRC, file).split(sep).join('/'));
      }
    }
    expect(offenders, `risk multiplier must never exceed 1: ${offenders.join(', ')}`).toEqual([]);
  });
});
