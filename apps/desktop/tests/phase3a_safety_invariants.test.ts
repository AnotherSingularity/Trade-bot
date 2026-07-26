import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DESKTOP_ROOT = join(__dirname, '..');
const FORBIDDEN_PATTERNS = [
  /\/brokerage\/orders/,
  /coinbase\.com\/api\/v3\/brokerage\/orders/,
];
const FORBIDDEN_NON_INTERACTIVE_PROMOTION = /promoteAutomatically|autoPromoteChallenger|autoPromoteExperiment/;

function walk(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'release') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry)) acc.push(full);
  }
}

describe('phase3a §A,§I — safety invariants inspected on source', () => {
  const files: string[] = [];
  walk(join(DESKTOP_ROOT, 'src'), files);
  const contents = files.map((f) => ({ f, c: readFileSync(f, 'utf8') }));

  it('T73: desktop source contains no live Coinbase order endpoint references', () => {
    for (const { f, c } of contents) {
      for (const p of FORBIDDEN_PATTERNS) {
        expect(p.test(c), `${f} references forbidden pattern ${p}`).toBe(false);
      }
    }
  });

  it('T74: no createOrder function call site exists in desktop source', () => {
    for (const { f, c } of contents) {
      // Match createOrder as a call token (not the word inside comments/strings for a safety guardrail we allow).
      // We disallow function calls of the form createOrder(...) entirely.
      const bad = /\bcreateOrder\s*\(/.test(c);
      expect(bad, `${f} contains a createOrder(...) call`).toBe(false);
    }
  });

  it('T75: no non-interactive promotion helper identifier exists in desktop source', () => {
    for (const { f, c } of contents) {
      expect(FORBIDDEN_NON_INTERACTIVE_PROMOTION.test(c), `${f} references a non-interactive promotion identifier`).toBe(false);
    }
  });

  it('T76: renderer bundle does not import electron directly', () => {
    for (const { f, c } of contents) {
      if (!f.includes('/renderer/')) continue;
      expect(/from ['"]electron['"]/.test(c), `${f} imports electron in the renderer`).toBe(false);
    }
  });

  it('T77: renderer bundle does not import node:fs, node:child_process or keytar', () => {
    for (const { f, c } of contents) {
      if (!f.includes('/renderer/')) continue;
      expect(/from ['"]node:fs['"]/.test(c), `${f} imports node:fs`).toBe(false);
      expect(/from ['"]node:child_process['"]/.test(c), `${f} imports child_process`).toBe(false);
      expect(/from ['"]keytar['"]/.test(c), `${f} imports keytar in renderer`).toBe(false);
    }
  });
});
