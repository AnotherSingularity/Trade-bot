/**
 * Stage 3A verification correction §4 — read-only boundary guards.
 *
 * Source-level assertions that the Stage 3 desktop query surface cannot
 * touch anything it must not touch:
 *
 *   §4.1 desktop query services cannot import economic writers
 *   §4.2 desktop query services cannot create plans, intents, fills,
 *        positions, ledger entries, promotions, or policy versions
 *   §4.3 the desktop.data channel cannot invoke arbitrary tRPC
 *        procedures — the compiled-in path map is the only surface
 *   §4.4 the renderer cannot select raw procedure names or server
 *        paths — every key must appear in DESKTOP_DATA_KEYS
 *
 * These are file-content assertions (no MariaDB required). They act as
 * lockdown tests — a future change that adds a forbidden import will
 * fail this suite before it reaches production.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_DATA_KEYS,
  type DesktopDataRequestKey,
} from '@horizon/shared';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DESKTOP_QUERIES_DIR = resolve(__dirname, '..', 'src', 'desktop', 'queries');

function readAllQueries(): Record<string, string> {
  const files = readdirSync(DESKTOP_QUERIES_DIR).filter((f) => f.endsWith('.ts'));
  const out: Record<string, string> = {};
  for (const f of files) {
    out[f] = readFileSync(join(DESKTOP_QUERIES_DIR, f), 'utf8');
  }
  return out;
}

/**
 * Modules the desktop query layer MUST NEVER import. These modules
 * write economic state (positions, ledger, fills, plans) — a query
 * service that touches them can no longer be classified as read-only.
 */
const FORBIDDEN_IMPORT_PATTERNS: RegExp[] = [
  /from ['"]\.\.\/\.\.\/execution\//,
  /from ['"]\.\.\/\.\.\/executor(?:\/|['"])/,
  /from ['"]\.\.\/\.\.\/entryExecutor/,
  /from ['"]\.\.\/\.\.\/exitExecutor/,
  /from ['"]\.\.\/\.\.\/scanner\//,
  /from ['"]\.\.\/\.\.\/coinbase\//,
  /from ['"]\.\.\/\.\.\/lib\/economicState/,
  /from ['"]\.\.\/\.\.\/reconciliation\//,
  /from ['"]\.\.\/\.\.\/protection\//,
  /from ['"]\.\.\/\.\.\/promotion\//,
  /from ['"]\.\.\/\.\.\/mode\//,
  /from ['"]\.\.\/\.\.\/shadow\/runtimeService/,
];

/**
 * Forbidden SQL verbs. Query services may run SELECT and read-only
 * queries; they must never INSERT / UPDATE / DELETE / TRUNCATE / DROP /
 * ALTER any table. This test scans the source for these keywords in
 * the SQL template positions (case-insensitive, word-boundary).
 */
const FORBIDDEN_SQL_VERBS: RegExp[] = [
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+\w+\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\b/i,
  /\bDROP\s+(TABLE|DATABASE|INDEX)\b/i,
  /\bALTER\s+TABLE\b/i,
  /\bREPLACE\s+INTO\b/i,
];

/**
 * Drizzle mutation helpers — the query layer must not call these.
 */
const FORBIDDEN_DRIZZLE_MUTATIONS: RegExp[] = [
  /\bdb\.insert\s*\(/,
  /\bdb\.update\s*\(/,
  /\bdb\.delete\s*\(/,
  /\.insert\s*\(schema\./,
  /\.update\s*\(schema\./,
  /\.delete\s*\(schema\./,
  /applyEntryEconomicStateTx/,
  /applyExitEconomicStateTx/,
  /createPlan/,
  /createOrderIntent/,
  /recordFill/,
  /recordLedger/,
  /promoteChallenger/,
  /publishPolicyVersion/,
];

describe('Stage 3A-FIX §4.1 + §4.2 — desktop query services are read-only', () => {
  const queries = readAllQueries();

  it('at least one query file is loaded (guard against fs typo)', () => {
    expect(Object.keys(queries).length).toBeGreaterThanOrEqual(6);
    expect(queries).toHaveProperty('common.ts');
    expect(queries).toHaveProperty('overview.ts');
    expect(queries).toHaveProperty('portfolio.ts');
    expect(queries).toHaveProperty('positions.ts');
    expect(queries).toHaveProperty('decisions.ts');
    expect(queries).toHaveProperty('stubs.ts');
  });

  it('no query service imports an economic writer or execution module', () => {
    for (const [file, src] of Object.entries(queries)) {
      for (const pat of FORBIDDEN_IMPORT_PATTERNS) {
        expect(pat.test(src), `${file} contains forbidden import matching ${pat}`).toBe(false);
      }
    }
  });

  it('no query service uses INSERT / UPDATE / DELETE / TRUNCATE / DROP / ALTER SQL verbs', () => {
    for (const [file, src] of Object.entries(queries)) {
      for (const pat of FORBIDDEN_SQL_VERBS) {
        expect(pat.test(src), `${file} contains forbidden SQL verb matching ${pat}`).toBe(false);
      }
    }
  });

  it('no query service calls drizzle mutation helpers or economic-writer functions', () => {
    for (const [file, src] of Object.entries(queries)) {
      for (const pat of FORBIDDEN_DRIZZLE_MUTATIONS) {
        expect(pat.test(src), `${file} contains forbidden mutation matching ${pat}`).toBe(false);
      }
    }
  });
});

describe('Stage 3A-FIX §4.3 — desktop.data channel cannot invoke arbitrary tRPC procedures', () => {
  const desktopDataClientSrc = readFileSync(
    resolve(__dirname, '..', '..', 'desktop', 'src', 'main', 'desktopDataClient.ts'),
    'utf8',
  );

  it('DesktopDataClient defines an exhaustive `PROCEDURE_PATHS` map keyed by DesktopDataRequestKey', () => {
    for (const k of DESKTOP_DATA_KEYS) {
      expect(desktopDataClientSrc.includes(`'${k}'`), `PROCEDURE_PATHS missing key '${k}'`).toBe(true);
    }
  });

  it('DesktopDataClient rejects unknown request keys before touching fetch (contract mismatch)', () => {
    // The client entry point parses the request through the shared
    // discriminated union; unknown keys fall out of that safeParse.
    expect(desktopDataClientSrc.includes('DesktopDataRequestSchema.safeParse')).toBe(true);
    expect(desktopDataClientSrc.includes("kind: 'contract_mismatch'")).toBe(true);
    // Confirm no code path that constructs a URL from an
    // externally-supplied string (defense-in-depth).
    expect(desktopDataClientSrc.match(/`\$\{[^}]*baseUrl[^}]*\}\$\{input\./i)).toBeNull();
  });

  it('DesktopDataClient constructs URLs only from the compiled-in `spec.path`', () => {
    // The path fragment MUST come from `spec.path` — the compiled-in
    // PROCEDURE_PATHS record — never from renderer input.
    expect(desktopDataClientSrc.includes('/trpc/${spec.path}')).toBe(true);
    // Renderer input is passed only as ?input=<json> (queries) or JSON
    // body (mutations); it never becomes the path.
  });
});

describe('Stage 3A-FIX §4.4 — renderer cannot select raw procedure names or server paths', () => {
  const preloadSrc = readFileSync(
    resolve(__dirname, '..', '..', 'desktop', 'src', 'preload', 'index.ts'),
    'utf8',
  );
  const ipcContractSrc = readFileSync(
    resolve(__dirname, '..', '..', 'desktop', 'src', 'shared', 'ipcContract.ts'),
    'utf8',
  );

  it('the preload bridge validates the desktop-data key against DESKTOP_DATA_KEYS before invoking IPC', () => {
    expect(preloadSrc.includes('DESKTOP_DATA_KEYS')).toBe(true);
    expect(preloadSrc.includes('unknown_desktop_data_key')).toBe(true);
  });

  it('the IPC allowlist declares the `desktop.data` channel as authenticated + schema-validated', () => {
    expect(ipcContractSrc.includes("desktopData: 'desktop.data'")).toBe(true);
    // The allowlist entry pairs the channel with DesktopDataChannelRequestSchema
    // + `requiresAuthenticatedSession: true`. If either is missing, the
    // channel is either unreachable or unauthenticated — either would fail
    // the pre-existing Stage 2-FIX privileged-IPC test.
    expect(ipcContractSrc.includes('DesktopDataChannelRequestSchema')).toBe(true);
    const desktopDataAllowlistEntry = ipcContractSrc.slice(
      ipcContractSrc.indexOf('IPC_CHANNELS.desktopData,'),
      ipcContractSrc.indexOf('IPC_CHANNELS.desktopData,') + 500,
    );
    expect(desktopDataAllowlistEntry.includes('requiresAuthenticatedSession: true')).toBe(true);
  });

  it('the preload bridge never exposes a generic tRPC proxy or arbitrary invoke', () => {
    // Only the compiled-in `desktopData(key, input?)` and the eight
    // auth channels + eleven service/config channels. No generic
    // invoke, no arbitrary URL, no raw ipcRenderer expose.
    expect(preloadSrc.includes('contextBridge.exposeInMainWorld')).toBe(true);
    // Confirm ipcRenderer is used *internally* (as expected) — a bridge
    // that never referenced ipcRenderer would be a bug of its own.
    expect(preloadSrc.includes('ipcRenderer')).toBe(true);
    // Assert we don't expose the raw ipcRenderer object to the renderer.
    expect(preloadSrc.match(/exposeInMainWorld[^,]+,\s*ipcRenderer/)).toBeNull();
  });
});

describe('Stage 3A-FIX §4.4 — DESKTOP_DATA_KEYS enumerates the entire renderer surface', () => {
  it('every enumerated key has a compiled-in tRPC procedure path', async () => {
    // Cross-check the shared key list against the tRPC inventory.
    const { buildTrpcInventory } = await import('../src/lib/trpcInventory');
    const inv = buildTrpcInventory();
    const desktopPaths = new Set(inv.filter((e) => e.path.startsWith('desktop.')).map((e) => e.path));
    for (const k of DESKTOP_DATA_KEYS) {
      const trpcPath = `desktop.${k}`;
      expect(desktopPaths.has(trpcPath), `DESKTOP_DATA_KEYS '${k}' has no matching tRPC procedure ('${trpcPath}')`).toBe(true);
    }
  });

  it('no `desktop.*` tRPC procedure is missing from DESKTOP_DATA_KEYS', async () => {
    const { buildTrpcInventory } = await import('../src/lib/trpcInventory');
    const inv = buildTrpcInventory();
    const declared = new Set(DESKTOP_DATA_KEYS.map((k) => `desktop.${k}`));
    for (const entry of inv) {
      if (!entry.path.startsWith('desktop.')) continue;
      expect(declared.has(entry.path), `tRPC procedure '${entry.path}' is not in DESKTOP_DATA_KEYS`).toBe(true);
    }
  });
});

// Compile-time discriminator — ensures the key list stays synchronized
// with the shared type. TypeScript will fail this file if DESKTOP_DATA_KEYS
// diverges from DesktopDataRequestKey.
const _typecheck: readonly DesktopDataRequestKey[] = DESKTOP_DATA_KEYS;
void _typecheck;
void REPO_ROOT;
