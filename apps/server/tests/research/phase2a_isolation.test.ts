import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 2A §Q — Source-level isolation guardrail.
 *
 * The observer framework is OBSERVER-ONLY. It must not touch the
 * champion strategy behavior. This test walks the champion source
 * tree and asserts that no file imports from `src/research/*`.
 *
 * The set of champion / non-research directories is enumerated
 * explicitly so future additions must consciously opt in or out.
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

const RESEARCH_ROOT = 'research';

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

describe('Phase 2A §Q — source isolation guardrail', () => {
  it('no champion source file imports from src/research/*', () => {
    const offenders: string[] = [];
    for (const root of CHAMPION_ROOTS) {
      const dir = join(SERVER_SRC, root);
      for (const file of walk(dir)) {
        const src = readFileSync(file, 'utf8');
        // Match ES imports, dynamic imports, and require() references to research.
        const patterns = [
          /from\s+['"][^'"]*\/research\/[^'"]*['"]/g,
          /from\s+['"]\.\.?\/research\/[^'"]*['"]/g,
          /import\s*\(['"][^'"]*\/research\/[^'"]*['"]\)/g,
          /require\(['"][^'"]*\/research\/[^'"]*['"]\)/g,
        ];
        for (const p of patterns) {
          if (p.test(src)) {
            offenders.push(relative(SERVER_SRC, file).split(sep).join('/'));
            break;
          }
        }
      }
    }
    expect(offenders, `champion files may not import from src/research/*: ${offenders.join(', ')}`).toEqual([]);
  });

  it('research source files do NOT import champion strategy behavior (executor, scanner, allocation, protection state, claude prompt)', () => {
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
    for (const file of walk(join(SERVER_SRC, RESEARCH_ROOT))) {
      const src = readFileSync(file, 'utf8');
      const hits: string[] = [];
      for (const p of forbidden) {
        const m = src.match(p);
        if (m) hits.push(...m);
      }
      if (hits.length > 0) offenders.push({ file: relative(SERVER_SRC, file).split(sep).join('/'), hits });
    }
    expect(
      offenders,
      `research code must remain observer-only: ${offenders.map((o) => `${o.file}: ${o.hits.join(', ')}`).join(' | ')}`,
    ).toEqual([]);
  });

  it('research directory is the exclusive owner of the observer tables', () => {
    const observerSchemaSymbols = [
      'universeSnapshots',
      'universeProducts',
      'productMetadataObservations',
      'productHygieneDecisions',
      'productQuarantines',
      'featureDefinitions',
      'featureCalculationRuns',
      'featureValues',
      'shortlistDecisions',
      'fingerprintDefinitions',
      'fingerprintSnapshots',
      'fingerprintEvidence',
      'researchObserverRuns',
      // Phase 2B tables must also be research-only.
      'regimeDefinitions',
      'regimeTransitionPolicies',
      'regimeObserverRuns',
      'globalRegimeSnapshots',
      'productRegimeSnapshots',
      'regimeEvidence',
      'changePointEvents',
      'latentStateModelVersions',
      'latentStateAssignments',
      'latentStateMappings',
      'regimeTransitions',
      'challengerRoutingDecisions',
      'championChallengerRoutingComparisons',
    ];
    // These symbols may only be WRITTEN from research/* or db/lineage.ts (audit-only read).
    const allowedRoots = ['research', join('db', 'lineage.ts'), join('db', 'schema.ts')];
    for (const symbol of observerSchemaSymbols) {
      const writerPattern = new RegExp(
        `\\bdb\\.\\s*(insert|update)\\s*\\(\\s*${symbol}\\b`,
        'g',
      );
      const offenders: string[] = [];
      for (const root of CHAMPION_ROOTS) {
        for (const file of walk(join(SERVER_SRC, root))) {
          const rel = relative(SERVER_SRC, file).split(sep).join('/');
          if (allowedRoots.some((r) => rel.startsWith(r.split(sep).join('/')))) continue;
          const src = readFileSync(file, 'utf8');
          if (writerPattern.test(src)) offenders.push(rel);
        }
      }
      expect(offenders, `${symbol} must only be written from research/* or db/lineage: ${offenders.join(', ')}`).toEqual([]);
    }
  });
});
