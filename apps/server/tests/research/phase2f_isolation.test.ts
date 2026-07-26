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

describe('Phase 2F §V — validation isolation', () => {
  it('no champion source file imports from src/research/validation/*', () => {
    const offenders: string[] = [];
    for (const root of CHAMPION_ROOTS) {
      const dir = join(SERVER_SRC, root);
      for (const file of walk(dir)) {
        const src = readFileSync(file, 'utf8');
        if (/from\s+['"][^'"]*\/research\/validation\/[^'"]*['"]/.test(src)) {
          offenders.push(relative(SERVER_SRC, file).split(sep).join('/'));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('validation observer does not import champion strategy behavior', () => {
    const forbidden = [
      /from\s+['"][^'"]*\/trading\/executor(?:['"]|\/)/g,
      /from\s+['"][^'"]*\/trading\/scanner(?:['"]|\/)/g,
      /from\s+['"][^'"]*\/trading\/protection(?:\/|['"])/g,
      /from\s+['"][^'"]*\/trading\/claude(?:['"]|\/)/g,
      /from\s+['"][^'"]*\/trading\/shadow(?:\/|['"])/g,
      /from\s+['"][^'"]*\/jobs\/(?:scanJob|queue|lease)(?:['"]|\/)/g,
    ];
    const offenders: string[] = [];
    for (const file of walk(join(SERVER_SRC, 'research', 'validation'))) {
      const src = readFileSync(file, 'utf8');
      for (const p of forbidden) if (p.test(src)) offenders.push(relative(SERVER_SRC, file).split(sep).join('/'));
    }
    expect(offenders).toEqual([]);
  });

  it('validation observer cannot write any champion economic table', () => {
    const championTables = [
      'orderIntents', 'fills', 'positions', 'roundTrips', 'cashLedger',
      'protectionInstances', 'protectionEvents', 'shadowExecutionPlans',
      'postFillRevalidations', 'decisionChains', 'quantitativeDecisions',
      'signalCandidates', 'executionCostForecasts',
    ];
    const offenders: string[] = [];
    for (const file of walk(join(SERVER_SRC, 'research', 'validation'))) {
      const src = readFileSync(file, 'utf8');
      for (const t of championTables) {
        if (new RegExp(`\\bdb\\.\\s*(insert|update|delete)\\s*\\(\\s*${t}\\b`, 'g').test(src)) {
          offenders.push(`${relative(SERVER_SRC, file).split(sep).join('/')}: ${t}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('unified challenger multiplier is never set above 1', () => {
    const src = readFileSync(join(SERVER_SRC, 'research', 'validation', 'evaluation.ts'), 'utf8');
    // The evaluator uses `Math.min(rm, mm, cm)` and `Math.max(0, Math.min(1, ...))`
    // — verify that the multiplier is always clamped to [0,1] with no literal path > 1.
    expect(/finalObserverMultiplier\s*[:=]\s*(?:[2-9]|1\.[1-9])/.test(src)).toBe(false);
    expect(/riskMultiplier\s*[:=]\s*(?:[2-9]|1\.[1-9])/.test(src)).toBe(false);
    expect(/microstructureMultiplier\s*[:=]\s*(?:[2-9]|1\.[1-9])/.test(src)).toBe(false);
    expect(/contextMultiplier\s*[:=]\s*(?:[2-9]|1\.[1-9])/.test(src)).toBe(false);
  });

  it('promotion functions require an explicit human actor', () => {
    const src = readFileSync(join(SERVER_SRC, 'research', 'validation', 'promotion.ts'), 'utf8');
    // Every promotion request checks humanApprovalActor and humanApprovalAt.
    expect(/humanApprovalActor/.test(src)).toBe(true);
    expect(/humanApprovalAt/.test(src)).toBe(true);
  });

  it('no automatic promotion function exists', () => {
    for (const f of walk(SERVER_SRC)) {
      const src = readFileSync(f, 'utf8');
      expect(/\bpromoteAutomatically\b|\bautoPromote\b|\bautomaticPromotion\b/.test(src)).toBe(false);
    }
  });

  it('Kelly cannot affect allocation (no kelly imports in champion allocation)', () => {
    for (const root of ['trading', 'jobs', 'labeling']) {
      const dir = join(SERVER_SRC, root);
      for (const f of walk(dir)) {
        const src = readFileSync(f, 'utf8');
        expect(/kellyActivationEvaluations|evaluateKellyActivation/.test(src)).toBe(false);
      }
    }
  });

  it('Claude prompt generation does not import validation', () => {
    const src = readFileSync(join(SERVER_SRC, 'trading', 'claude.ts'), 'utf8');
    expect(/research\/validation/.test(src)).toBe(false);
  });

  it('validation observer contains no createOrder / fetch / order endpoint refs', () => {
    for (const f of walk(join(SERVER_SRC, 'research', 'validation'))) {
      const src = readFileSync(f, 'utf8');
      expect(/createOrder|submitOrder|placeOrder/.test(src)).toBe(false);
      expect(/\bfetch\s*\(/.test(src)).toBe(false);
      expect(/\/brokerage\/orders/.test(src)).toBe(false);
    }
  });

  it('Phase 2A-2E observers do not import Phase 2F validation code', () => {
    const offenders: string[] = [];
    for (const dir of ['universe', 'fingerprint', 'regime', 'risk', 'microstructure', 'context', 'features', 'shortlist', 'hygiene']) {
      const d = join(SERVER_SRC, 'research', dir);
      let entries: string[] = [];
      try { entries = readdirSync(d); } catch { continue; }
      for (const name of entries) {
        const full = join(d, name);
        if (statSync(full).isDirectory()) {
          for (const f of walk(full)) {
            const src = readFileSync(f, 'utf8');
            if (/from\s+['"][^'"]*\/research\/validation\/[^'"]*['"]/.test(src)) offenders.push(f);
          }
        } else if (full.endsWith('.ts')) {
          const src = readFileSync(full, 'utf8');
          if (/from\s+['"][^'"]*\/research\/validation\/[^'"]*['"]/.test(src)) offenders.push(full);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
