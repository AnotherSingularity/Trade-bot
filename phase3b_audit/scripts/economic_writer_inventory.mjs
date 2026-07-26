#!/usr/bin/env node
/**
 * Phase 3B §C — Economic writer inventory.
 *
 * Scans apps/server/src for every DB write that touches an economic
 * table (order intents, fills, positions, cash ledger, protection
 * instances, exit attempts, round trips, outcome labels, cost
 * attribution, reconciliation state, champion versions, observer
 * decisions, promotion decisions) and classifies the writer.
 *
 * The classification is manual-inspection-friendly, not a full
 * dataflow proof: the report lists every candidate writer and asks a
 * reviewer to confirm each entry against §C.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const REPORT_DIR = join(REPO_ROOT, 'phase3b_audit/reports');
mkdirSync(REPORT_DIR, { recursive: true });

const ROOT = join(REPO_ROOT, 'apps/server/src');

const ECONOMIC_TABLES = [
  'orderIntents', 'order_intents',
  'fills',
  'positions',
  'roundTrips', 'round_trips',
  'cashLedger', 'cash_ledger', 'ledgerEntries', 'ledger_entries',
  'protectionInstances', 'protection_instances', 'protectionInstance',
  'exitAttempts', 'exit_attempts', 'exitAttempt',
  'outcomeLabels', 'outcome_labels', 'labeledOutcomes', 'labeled_outcomes',
  'costAttribution', 'cost_attribution',
  'reconciliation', 'reconciliationActions', 'reconciliationRuns',
  'championVersions', 'champion_versions', 'champion_configuration',
  'observerDecisions', 'observer_decisions', 'candidateDecisions',
  'promotionDecisions', 'promotion_decisions', 'promotions',
  'shadowExecutionPlans', 'shadow_execution_plans',
  'postFillRevalidations', 'post_fill_revalidations',
];

const WRITE_METHODS = ['insert', 'update', 'delete', 'onDuplicate', 'upsert'];

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

const results = [];
const files = walk(ROOT);
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(REPO_ROOT, f);
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const method of WRITE_METHODS) {
      const re = new RegExp(`\\b(?:${method})\\s*\\(`);
      if (re.test(line)) {
        // Look for a nearby table reference in the next 5 lines.
        const window = lines.slice(i, Math.min(i + 6, lines.length)).join(' ');
        const matched = ECONOMIC_TABLES.find((t) => new RegExp(`\\b${t}\\b`).test(window));
        if (matched) {
          results.push({
            file: rel,
            line: i + 1,
            method,
            economicTable: matched,
            observerRoot: rel.includes('/observers/') || rel.includes('/observer/'),
            reconciliationRoot: /reconciliation|reconciler/i.test(rel),
            testRoot: /(^|\/)tests?\/|fixture|__mocks__/.test(rel),
          });
        }
      }
    }
  }
}

// Bucket by economic table.
const byTable = {};
for (const r of results) {
  (byTable[r.economicTable] ??= []).push({ file: r.file, line: r.line, method: r.method, observerRoot: r.observerRoot, reconciliationRoot: r.reconciliationRoot, testRoot: r.testRoot });
}

const summary = {
  generatedAt: process.env.HORIZON_AUDIT_TIMESTAMP ?? '1970-01-01T00:00:00.000Z',
  scope: 'apps/server/src',
  totalCandidateWriters: results.length,
  distinctEconomicTables: Object.keys(byTable).length,
  observerWriters: results.filter((r) => r.observerRoot).length,
  reconciliationWriters: results.filter((r) => r.reconciliationRoot).length,
  byTable,
  // §C rules the human reviewer applies:
  reviewRules: [
    'Every champion economic writer has one authorized purpose.',
    'Every economic write retains exact lineage.',
    'Observer modules cannot call champion writers.',
    'Reconciliation uses the same entry and exit economic functions as normal processing.',
    'No unattributed ledger writer exists.',
    'No unknown plan or intent writer exists.',
    'No duplicate economic path exists.',
  ],
};

writeFileSync(join(REPORT_DIR, 'economic_writer_inventory.json'), JSON.stringify(summary, null, 2));
process.stdout.write(`economic_writer_inventory.json written (candidates=${results.length}, tables=${Object.keys(byTable).length}, observer=${summary.observerWriters}, reconciliation=${summary.reconciliationWriters})\n`);
