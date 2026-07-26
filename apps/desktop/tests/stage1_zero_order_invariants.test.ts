import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Stage 1 §17 — invariants that remain true across the runtime wiring.
// Static-source checks + logic-level checks.

const DESKTOP_SRC = join(__dirname, '..', 'src');

function walk(dir: string, acc: string[]): void {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === 'release') continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|js)$/.test(e)) acc.push(full);
  }
}

describe('stage1 §36-§39 — safe-flag + zero-order + no-stub invariants', () => {
  const files: string[] = [];
  walk(DESKTOP_SRC, files);
  const contents = files.map((f) => ({ f, c: readFileSync(f, 'utf8') }));

  it('T-S1.36: safe flags remain unchanged (DRY_RUN=true, ORDER_SUBMISSION_ENABLED=false enforced)', () => {
    const env = contents.find((x) => x.f.endsWith('localEnvironment.ts'))!;
    expect(env.c).toMatch(/DRY_RUN must be true/);
    expect(env.c).toMatch(/ORDER_SUBMISSION_ENABLED must be false/);
    expect(env.c).toMatch(/production providers must remain inactive/);
  });

  it('T-S1.37-39: no createOrder call site, no live orders endpoint anywhere in desktop', () => {
    for (const { f, c } of contents) {
      // No unguarded createOrder() call.
      expect(/\bcreateOrder\s*\(/.test(c), `${f} contains a createOrder(...) call`).toBe(false);
      // No /brokerage/orders reference.
      expect(/\/brokerage\/orders/.test(c), `${f} references live Coinbase orders endpoint`).toBe(false);
    }
  });

  it('T-S1.no-hardcoded-versions: no phase-2X policy version literal appears in main/index.ts', () => {
    const idx = contents.find((x) => x.f.endsWith('main/index.ts'))!;
    // Old Phase 3A boot hardcoded 'p2a-1', 'p2b-1', … as counter/version defaults.
    expect(idx.c.includes("'p2a-1'")).toBe(false);
    expect(idx.c.includes("'p2b-1'")).toBe(false);
    expect(idx.c.includes("'champ-1'")).toBe(false);
  });

  it('T-S1.no-hardcoded-counters: no `functionInvocations: 0, attemptCount: 0` literal in main/index.ts', () => {
    const idx = contents.find((x) => x.f.endsWith('main/index.ts'))!;
    expect(idx.c.match(/functionInvocations:\s*0,\s*attemptCount:\s*0/)).toBeNull();
  });

  it('T-S1.no-stub-runner: production factory refuses InMemoryRunner', () => {
    // Encoded in stage1_adapter_factory.test.ts; here we assert that the
    // desktop main entry no longer imports InMemoryRunner from serviceAdapters.
    const idx = contents.find((x) => x.f.endsWith('main/index.ts'))!;
    expect(idx.c).not.toMatch(/import\s*{[^}]*InMemoryRunner[^}]*}\s*from\s*['"]\.\/serviceAdapters['"]/);
    // The new factory is imported.
    expect(idx.c).toMatch(/createServiceAdapters/);
    expect(idx.c).toMatch(/assertProductionRunner/);
  });

  it('T-S1.40 (existing): existing safety invariants still hold', () => {
    // No `promoteAutomatically` etc.
    for (const { f, c } of contents) {
      expect(/promoteAutomatically|autoPromoteChallenger|autoPromoteExperiment/.test(c), `${f} references non-interactive promotion`).toBe(false);
    }
  });
});
