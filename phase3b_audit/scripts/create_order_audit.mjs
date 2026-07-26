#!/usr/bin/env node
/**
 * Phase 3B §D — Create Order + outbound-network path audit.
 *
 * Static scan of the active release surface for every Create Order
 * signature or outbound-network primitive. Records each occurrence
 * with a classification (barrier/guardrail, test-fixture, comment,
 * legitimate observer, forbidden) so a reviewer can prove no
 * alternate path exists.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const REPORT_DIR = join(REPO_ROOT, 'phase3b_audit/reports');
mkdirSync(REPORT_DIR, { recursive: true });

const ACTIVE = ['apps/server/src', 'apps/desktop/src', 'packages/shared/src'];

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

const PATTERNS = [
  { id: 'createOrderCallSite', re: /\bcreateOrder\s*\(/, kind: 'coinbase-create-order-call' },
  { id: 'createOrderIdentifier', re: /\bcreateOrder\b/, kind: 'coinbase-create-order-identifier' },
  { id: 'brokerageOrdersEndpoint', re: /\/brokerage\/orders/, kind: 'coinbase-orders-endpoint' },
  { id: 'coinbaseOrdersUrl', re: /coinbase\.com\/api\/v3\/brokerage\/orders/, kind: 'coinbase-orders-url' },
  { id: 'fetchInvocation', re: /\bfetch\s*\(/, kind: 'fetch-call' },
  { id: 'axiosImport', re: /(^|[^a-zA-Z_])axios[\s.,\(\[\]]/, kind: 'axios' },
  { id: 'undiciImport', re: /(^|[^a-zA-Z_])undici[\s.,\(\[\]]/, kind: 'undici' },
  { id: 'nodeHttpRequire', re: /require\(['"]node:https?['"]\)|from ['"]node:https?['"]/, kind: 'node-http' },
  { id: 'websocketCtor', re: /new\s+WebSocket\s*\(/, kind: 'websocket-ctor' },
];

const results = [];
for (const rootRel of ACTIVE) {
  const root = join(REPO_ROOT, rootRel);
  for (const f of walk(root)) {
    const src = readFileSync(f, 'utf8');
    const lines = src.split('\n');
    for (const p of PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (p.re.test(lines[i])) {
          const line = lines[i].trim();
          const isComment = /^\s*\/\/|^\s*\*|^\s*\/\*|^#/.test(line);
          const isString = /(['"`])[^'"`]*(createOrder|brokerage\/orders)[^'"`]*\1/.test(line);
          results.push({
            file: relative(REPO_ROOT, f),
            line: i + 1,
            snippet: line.slice(0, 200),
            patternId: p.id,
            kind: p.kind,
            classification: classify(relative(REPO_ROOT, f), p.id, line, isComment, isString),
          });
        }
      }
    }
  }
}

function classify(file, patternId, line, isComment, isString) {
  if (isComment) return 'comment';
  if (patternId === 'brokerageOrdersEndpoint' || patternId === 'coinbaseOrdersUrl') {
    if (/coinbaseClient|coinbaseAdapter|prodCoinbase|trading\/coinbase\.ts/i.test(file) && /createOrder|POST/.test(line)) {
      return 'canonical-client-endpoint';
    }
    if (/test|fixture|spec|guard/.test(file)) return 'test-fixture-or-guardrail';
    return 'endpoint-reference';
  }
  if (patternId === 'createOrderCallSite') {
    if (/test|fixture|spec|guard|barrier|counter|policy|README/i.test(file)) return 'test-guardrail-or-barrier';
    if (file === 'apps/server/src/trading/coinbase.ts') return 'canonical-client-method-definition';
    if (file === 'apps/server/src/trading/executor.ts') return 'double-lock-guarded-call-site';
    if (/coinbaseClient|coinbaseAdapter|prodCoinbase/i.test(file)) return 'canonical-client-method-definition';
    return 'call-site-requires-review';
  }
  if (patternId === 'createOrderIdentifier') {
    if (/counter|barrier|shadowRuntime|policy|guard|test|fixture|spec|README|md$/i.test(file)) return 'guardrail-or-instrumentation';
    return 'identifier-requires-review';
  }
  if (patternId === 'fetchInvocation') {
    if (/fetchBarrier|guard|policy/i.test(file)) return 'barrier-or-guardrail';
    if (/test|fixture|spec/.test(file)) return 'test';
    return 'fetch-call';
  }
  if (patternId === 'websocketCtor') {
    if (/coinbaseStream|marketData|WebSocketSupervisor/i.test(file)) return 'market-data-ws';
    if (/test|fixture|spec/.test(file)) return 'test-ws';
    return 'ws-call';
  }
  return 'unclassified';
}

const summary = {
  generatedAt: process.env.HORIZON_AUDIT_TIMESTAMP ?? '1970-01-01T00:00:00.000Z',
  scopes: ACTIVE,
  totalHits: results.length,
  hitsByPattern: PATTERNS.reduce((acc, p) => {
    acc[p.id] = results.filter((r) => r.patternId === p.id).length; return acc;
  }, {}),
  hitsByClassification: results.reduce((acc, r) => {
    acc[r.classification] = (acc[r.classification] || 0) + 1; return acc;
  }, {}),
  forbiddenCreateOrderCallSitesInProductionCode: results.filter((r) =>
    r.patternId === 'createOrderCallSite' && r.classification === 'call-site-requires-review',
  ),
  results,
};

writeFileSync(join(REPORT_DIR, 'create_order_audit.json'), JSON.stringify(summary, null, 2));
process.stdout.write(
  `create_order_audit.json written; totalHits=${summary.totalHits}; forbidden_call_sites=${summary.forbiddenCreateOrderCallSitesInProductionCode.length}\n`,
);
if (summary.forbiddenCreateOrderCallSitesInProductionCode.length > 0) {
  process.exit(1);
}
