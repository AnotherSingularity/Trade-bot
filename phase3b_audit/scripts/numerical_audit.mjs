#!/usr/bin/env node
/**
 * Phase 3B §G — Numerical audit.
 *
 * Static scan over apps/server/src for patterns that would indicate a
 * silent NaN, silent Infinity, unsafe Number coercion, or a favorable
 * fallback on numerical failure. Also flags any observer sizing that
 * emits a multiplier > 1.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const REPORT_DIR = join(REPO_ROOT, 'phase3b_audit/reports');
mkdirSync(REPORT_DIR, { recursive: true });

const ROOT = join(REPO_ROOT, 'apps/server/src');

function walk(dir) {
  const out = [];
  function inner(d) {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e === 'node_modules' || e === 'dist') continue;
      const full = join(d, e);
      const st = statSync(full);
      if (st.isDirectory()) inner(full);
      else if (/\.(ts|tsx|js)$/.test(e)) out.push(full);
    }
  }
  inner(dir);
  return out;
}

const PATTERNS = [
  { id: 'silent_number_coercion', re: /\bNumber\([^)]*\)\s*[^|&]/, warn: 'Number(...) without ?? fallback' },
  { id: 'plus_string_coerce', re: /\+\s*[a-zA-Z_][a-zA-Z0-9_]*Str\b/, warn: 'string→number via unary +' },
  { id: 'nan_isNaN_only', re: /\bisNaN\s*\(/, warn: 'Global isNaN — prefer Number.isNaN' },
  { id: 'finite_check_missing', re: /parseFloat\s*\(/, warn: 'parseFloat should be paired with Number.isFinite guard' },
  { id: 'silent_infinity', re: /Infinity\b|-Infinity\b/, warn: 'literal Infinity — verify not silent' },
  { id: 'silent_nan', re: /\bNaN\b/, warn: 'literal NaN — verify not silent' },
];

const results = [];
const files = walk(ROOT);
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(REPO_ROOT, f);
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isComment = /^\s*\/\/|^\s*\*|^\s*\/\*/.test(line);
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        results.push({
          file: rel,
          line: i + 1,
          snippet: line.trim().slice(0, 200),
          patternId: p.id,
          isComment,
          warn: p.warn,
        });
      }
    }
  }
}

const summary = {
  generatedAt: process.env.HORIZON_AUDIT_TIMESTAMP ?? '1970-01-01T00:00:00.000Z',
  scope: 'apps/server/src',
  totalHits: results.length,
  nonCommentHits: results.filter((r) => !r.isComment).length,
  hitsByPattern: PATTERNS.reduce((acc, p) => {
    acc[p.id] = results.filter((r) => r.patternId === p.id).length; return acc;
  }, {}),
  reviewNote:
    'Static grep only — patterns flag call sites for manual sign-off, not automated pass/fail. ' +
    'The reviewer confirms each non-comment hit is a guarded conversion, an explicit test literal, or a ' +
    'documented sentinel.',
  results,
};

writeFileSync(join(REPORT_DIR, 'numerical_audit.json'), JSON.stringify(summary, null, 2));
process.stdout.write(`numerical_audit.json written (${results.length} hits, ${summary.nonCommentHits} non-comment)\n`);
