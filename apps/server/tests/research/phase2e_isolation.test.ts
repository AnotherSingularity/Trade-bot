import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVER_SRC = join(__dirname, '..', '..', 'src');
const CHAMPION_ROOTS = ['trading', 'jobs', 'labeling', 'market_data', 'reporting', 'routers', 'soak', 'lib', 'middleware', 'db'];

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

describe('Phase 2E §R — context isolation', () => {
  it('no champion source file imports from src/research/context/*', () => {
    const offenders: string[] = [];
    for (const root of CHAMPION_ROOTS) {
      const dir = join(SERVER_SRC, root);
      for (const file of walk(dir)) {
        const src = readFileSync(file, 'utf8');
        if (/from\s+['"][^'"]*\/research\/context\/[^'"]*['"]/.test(src)) {
          offenders.push(relative(SERVER_SRC, file).split(sep).join('/'));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('context observer does not import champion strategy behavior', () => {
    const forbidden = [
      /from\s+['"][^'"]*\/trading\/executor(?:['"]|\/)/g,
      /from\s+['"][^'"]*\/trading\/scanner(?:['"]|\/)/g,
      /from\s+['"][^'"]*\/trading\/protection(?:\/|['"])/g,
      /from\s+['"][^'"]*\/trading\/claude(?:['"]|\/)/g,
      /from\s+['"][^'"]*\/trading\/shadow(?:\/|['"])/g,
      /from\s+['"][^'"]*\/jobs\/(?:scanJob|queue|lease)(?:['"]|\/)/g,
    ];
    const offenders: string[] = [];
    for (const file of walk(join(SERVER_SRC, 'research', 'context'))) {
      const src = readFileSync(file, 'utf8');
      for (const p of forbidden) if (p.test(src)) offenders.push(relative(SERVER_SRC, file).split(sep).join('/'));
    }
    expect(offenders).toEqual([]);
  });

  it('context observer cannot write any champion economic table', () => {
    const championTables = [
      'orderIntents', 'fills', 'positions', 'roundTrips', 'cashLedger',
      'protectionInstances', 'protectionEvents', 'shadowExecutionPlans',
      'postFillRevalidations', 'decisionChains', 'quantitativeDecisions',
      'signalCandidates', 'executionCostForecasts',
    ];
    const offenders: string[] = [];
    for (const file of walk(join(SERVER_SRC, 'research', 'context'))) {
      const src = readFileSync(file, 'utf8');
      for (const t of championTables) {
        if (new RegExp(`\\bdb\\.\\s*(insert|update|delete)\\s*\\(\\s*${t}\\b`, 'g').test(src)) {
          offenders.push(`${relative(SERVER_SRC, file).split(sep).join('/')}: ${t}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('context observer never sets a multiplier above 1', () => {
    const offenders: string[] = [];
    for (const file of walk(join(SERVER_SRC, 'research', 'context'))) {
      const src = readFileSync(file, 'utf8');
      if (/\bcontextMultiplier\s*[:=]\s*(?:[2-9](?:\.\d+)?|1\.[1-9])/.test(src)) {
        offenders.push(relative(SERVER_SRC, file).split(sep).join('/'));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('context observer contains no createOrder / fetch / order endpoint refs', () => {
    for (const f of walk(join(SERVER_SRC, 'research', 'context'))) {
      const src = readFileSync(f, 'utf8');
      expect(/createOrder|submitOrder|placeOrder/.test(src)).toBe(false);
      expect(/\bfetch\s*\(/.test(src)).toBe(false);
      expect(/\/brokerage\/orders/.test(src)).toBe(false);
    }
  });

  it('Phase 2C and Phase 2D observers do not import context', () => {
    const offenders: string[] = [];
    for (const dir of ['risk', 'microstructure']) {
      for (const f of walk(join(SERVER_SRC, 'research', dir))) {
        const src = readFileSync(f, 'utf8');
        if (/from\s+['"][^'"]*\/research\/context\/[^'"]*['"]/.test(src)) {
          offenders.push(relative(SERVER_SRC, f).split(sep).join('/'));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('Claude prompt generation does not import context', () => {
    const src = readFileSync(join(SERVER_SRC, 'trading', 'claude.ts'), 'utf8');
    expect(/research\/context/.test(src)).toBe(false);
  });
});
