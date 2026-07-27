/**
 * Stage 3C — native Electron harness.
 *
 * Boots the full end-to-end runtime for a single native integration
 * test run:
 *
 *   MariaDB (localhost) → uniquely-named scratch DB
 *   → migrations 0000-0021 applied via direct SQL
 *   → deterministic seed inserted
 *   → Horizon server spawned via `npx tsx apps/server/src/index.ts`
 *   → readiness endpoint polled
 *   → Electron main process launched via Playwright `_electron`
 *   → renderer window returned to the caller
 *
 * The harness owns the entire lifecycle. It uses the shared
 * `scratchDb` helper (see `apps/desktop/tests/lib/scratchDb.ts`) so
 * teardown structurally refuses to drop the protected shared
 * databases even if a caller passes them explicitly.
 *
 * The desktop is launched with `HORIZON_SERVER_EXTERNAL=true` so its
 * supervisor picks `createServerAdapterExternal` and does NOT try to
 * spawn a competing server. Every other adapter is real: the
 * `ChildProcessCommandRunner`, the real MariaDB / Redis probes, the
 * real preload, the real renderer bundle.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createConnection } from 'mysql2/promise';
import IORedis from 'ioredis';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createScratchDb, dropScratchDb, makeScratchDbName, scratchDbUrl } from '../lib/scratchDb';

// ---------------------------------------------------------------------------
// Fixed inputs
// ---------------------------------------------------------------------------

export const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
export const SERVER_CWD = join(REPO_ROOT, 'apps/server');
export const DESKTOP_DIST = join(REPO_ROOT, 'apps/desktop/dist');
export const DESKTOP_MAIN_ENTRY = join(DESKTOP_DIST, 'main/main/index.js');
export const ELECTRON_BIN = join(REPO_ROOT, 'node_modules/.bin/electron');
export const MARIADB_ROOT = { host: '127.0.0.1', port: 3306, user: 'root', password: 'password' } as const;
export const REDIS_URL = 'redis://127.0.0.1:6379';

// Deterministic administrator credentials for the native test.
export const ADMIN_USER = 'nativeoperator';
export const ADMIN_PASSWORD = 'Native-3C-passphrase-!';

// ---------------------------------------------------------------------------
// Isolation primitives
// ---------------------------------------------------------------------------

export async function pickFreePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => {
        if (typeof addr === 'object' && addr) res(addr.port);
        else rej(new Error('no address'));
      });
    });
    s.on('error', rej);
  });
}

export interface NativeIsolation {
  dbName: string;
  dbUrl: string;
  redisNamespace: string;
  runId: string;
  logsDir: string;
}

export function mintIsolation(): NativeIsolation {
  const dbName = makeScratchDbName('native');
  const runId = `${process.pid}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  // Redis namespace mirrors the DB name so the leftover set never
  // collides with parallel runs or the shared suite's namespace. The
  // server env schema restricts HORIZON_REDIS_NAMESPACE to
  // /^[A-Za-z0-9_-]+$/ (see apps/server/src/env.ts), so we use
  // an underscore-only compound instead of the `native:<runId>`
  // form that Redis normally accepts.
  const redisNamespace = `native_${runId}`;
  const logsDir = join(__dirname, 'logs', runId);
  mkdirSync(logsDir, { recursive: true });
  return { dbName, dbUrl: scratchDbUrl(dbName), redisNamespace, runId, logsDir };
}

export async function externalServicesAvailable(): Promise<boolean> {
  try {
    const c = await createConnection(MARIADB_ROOT);
    await c.ping();
    await c.end();
    const r = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    await r.connect();
    await r.ping();
    await r.quit();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Migration + seed
// ---------------------------------------------------------------------------

/**
 * Applies migrations 0000-0021 directly via SQL. Mirrors the
 * pattern used by `stage1fix_external_services_integration.test.ts`
 * — drizzle-kit migrate hangs on MariaDB when JSON columns are
 * present (see scripts/repro/mariadb-json-hang-repro.md), so both
 * production and every integration test path apply migrations as
 * raw SQL split on `;`.
 */
export async function applyMigrations(dbUrl: string): Promise<void> {
  const conn = await createConnection({ uri: dbUrl });
  const migrationsDir = join(SERVER_CWD, 'drizzle/migrations');
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const splitStatements = (sql: string): string[] => sql
    .replace(/-->\s*statement-breakpoint/g, '')
    .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  try {
    for (const f of files) {
      for (const stmt of splitStatements(readFileSync(join(migrationsDir, f), 'utf-8'))) {
        await conn.query(stmt);
      }
    }
    await conn.query('CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INT PRIMARY KEY AUTO_INCREMENT, hash VARCHAR(64), created_at BIGINT)');
    for (let i = 0; i < files.length; i++) {
      await conn.query(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('m${i}', UNIX_TIMESTAMP()*1000)`);
    }
  } finally {
    await conn.end();
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export interface ServerSpawn {
  proc: ChildProcess;
  port: number;
  baseUrl: string;
  healthUrl: string;
  bootstrapToken: string;
  kill: () => Promise<void>;
  suspend: () => void;
  resume: () => void;
}

export async function spawnServer(iso: NativeIsolation): Promise<ServerSpawn> {
  const port = await pickFreePort();
  const bootstrapToken = randomBytes(32).toString('hex');
  const logStream = { out: '' as string };
  const proc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_CWD,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_URL: iso.dbUrl,
      REDIS_URL,
      JWT_SECRET: 'stage3c-native-secret-please-change-1234',
      DRY_RUN: 'true',
      ORDER_SUBMISSION_ENABLED: 'false',
      CORS_ORIGINS: '*',
      HORIZON_BOOTSTRAP_TOKEN: bootstrapToken,
      HORIZON_REDIS_NAMESPACE: iso.redisNamespace,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Always append to disk immediately so a crashing test can still be
  // diagnosed. The captured buffer is written on kill() as a
  // convenience redundancy.
  const liveServerLog = join(iso.logsDir, 'server.live.log');
  const debug = process.env.NATIVE_DEBUG === '1';
  proc.stdout?.on('data', (d) => {
    logStream.out += String(d);
    try { require('node:fs').appendFileSync(liveServerLog, String(d)); } catch { /* ignore */ }
    if (debug) process.stderr.write('[srv-out] ' + String(d));
  });
  proc.stderr?.on('data', (d) => {
    logStream.out += String(d);
    try { require('node:fs').appendFileSync(liveServerLog, String(d)); } catch { /* ignore */ }
    if (debug) process.stderr.write('[srv-err] ' + String(d));
  });

  const kill = async (): Promise<void> => {
    try {
      writeFileSync(join(iso.logsDir, 'server.log'), logStream.out);
    } catch { /* logs best-effort */ }
    if (proc.exitCode == null) proc.kill('SIGTERM');
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && proc.exitCode == null) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (proc.exitCode == null) proc.kill('SIGKILL');
  };

  return {
    proc,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    healthUrl: `http://127.0.0.1:${port}/api/system/readiness`,
    bootstrapToken,
    kill,
    suspend: () => { if (proc.pid) try { process.kill(proc.pid, 'SIGSTOP'); } catch { /* ignore */ } },
    resume: () => { if (proc.pid) try { process.kill(proc.pid, 'SIGCONT'); } catch { /* ignore */ } },
  };
}

export async function waitForReadiness(server: ServerSpawn, deadlineMs = 60_000): Promise<{ ok: boolean; ms: number; body?: unknown }> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2_500);
      const res = await fetch(server.healthUrl, {
        signal: ctrl.signal,
        headers: { 'x-horizon-bootstrap-token': server.bootstrapToken },
      });
      clearTimeout(t);
      if (res.ok) {
        const body = await res.json() as { ready?: boolean };
        if (body?.ready) return { ok: true, ms: Date.now() - start, body };
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, ms: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Electron lifecycle
// ---------------------------------------------------------------------------

export interface ElectronLaunch {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
}

export async function launchElectron(iso: NativeIsolation, server: ServerSpawn): Promise<ElectronLaunch> {
  const userDataDir = join(iso.logsDir, 'electron-userdata');
  const reportDir = join(iso.logsDir, 'electron-reports');
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(reportDir, { recursive: true });
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [
      DESKTOP_MAIN_ENTRY,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--in-process-gpu',
      `--user-data-dir=${userDataDir}`,
    ],
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY ?? ':99',
      NODE_ENV: 'development',
      HORIZON_ENVIRONMENT: 'development',
      HORIZON_SERVER_EXTERNAL: 'true',
      HORIZON_MARIADB_URL: iso.dbUrl,
      HORIZON_REDIS_URL: REDIS_URL,
      HORIZON_SERVER_HEALTH_URL: server.healthUrl,
      HORIZON_BOOTSTRAP_TOKEN: server.bootstrapToken,
      HORIZON_PROJECT_ROOT: REPO_ROOT,
      HORIZON_AUTH_REQUIRED: 'true',
      HORIZON_USE_KEYTAR: 'false',
      HORIZON_DATABASE_MODE: 'external_services',
      HORIZON_DEVELOPMENT_FAKE: 'false',
      HORIZON_SCHEMA_VERSION: '0021',
      HORIZON_REPORT_DIR: reportDir,
      // Main is bundled to dist/main/main/index.js; the renderer index.html
      // is at dist/renderer/index.html. Override the default resolver
      // which assumes an untouched tsc layout.
      HORIZON_RENDERER_URL: `file://${join(DESKTOP_DIST, 'renderer/index.html')}`,
      HORIZON_ELECTRON_NO_SANDBOX: 'true',
      // Electron/Chromium refuse to run as root without --no-sandbox
      // in child processes; the env-level flag propagates to every
      // subprocess (renderer, GPU, network, utility).
      ELECTRON_DISABLE_SANDBOX: '1',
    },
    timeout: 45_000,
  });
  // Fire-and-forget log capture for the electron process itself.
  app.process().stdout?.on('data', (d) => {
    try { const f = join(iso.logsDir, 'electron.log'); require('node:fs').appendFileSync(f, String(d)); } catch { /* best-effort */ }
  });
  app.process().stderr?.on('data', (d) => {
    try { const f = join(iso.logsDir, 'electron.log'); require('node:fs').appendFileSync(f, String(d)); } catch { /* best-effort */ }
  });
  const page = await app.firstWindow({ timeout: 30_000 });
  return { app, page, userDataDir };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Provisions the local operator account via the server's setup
 * endpoint (unauthenticated). Idempotent — a repeat call to a server
 * whose setup already ran returns 409, which we accept as "already
 * exists" (used by the relaunch test path).
 */
export async function ensureLocalOperator(server: ServerSpawn): Promise<void> {
  const url = `${server.baseUrl}/api/operator-auth/setup`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-horizon-bootstrap-token': server.bootstrapToken,
    },
    body: JSON.stringify({
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
      passwordConfirmation: ADMIN_PASSWORD,
    }),
  });
  if (!res.ok && res.status !== 409) {
    const body = await res.text();
    throw new Error(`operator setup failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

/**
 * Reads the authoritative Create Order counters from the running
 * server. Never trusts a value the desktop main might have cached.
 */
export async function readCreateOrderCounters(server: ServerSpawn): Promise<{
  functionInvocations: number; attemptCount: number; networkCount: number;
}> {
  const res = await fetch(`${server.baseUrl}/api/desktop/create-order-counters`, {
    headers: { 'x-horizon-bootstrap-token': server.bootstrapToken },
  });
  if (!res.ok) throw new Error(`counters read failed: ${res.status}`);
  const body = await res.json() as {
    functionInvocations: number; attemptCount: number; networkCount: number;
  };
  return body;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Process-leak check + evidence bundle (Stage 3C-ENV §5/§6)
// ---------------------------------------------------------------------------

export interface ProcessLeakResult {
  ok: boolean;
  survivors: Array<{ pid: number; comm: string; role: string }>;
}

/**
 * After teardown, enumerate the process table and assert none of the
 * spawned children survived. Uses `ps -eo pid,comm` — portable on any
 * Linux/CI host we target.
 */
export function checkProcessLeak(server?: ServerSpawn, launch?: ElectronLaunch): ProcessLeakResult {
  const targets: Array<{ pid: number; role: string }> = [];
  if (server?.proc?.pid) targets.push({ pid: server.proc.pid, role: 'server' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appProc: any = launch?.app?.process?.();
  if (appProc?.pid) targets.push({ pid: appProc.pid, role: 'electron' });
  if (targets.length === 0) return { ok: true, survivors: [] };
  const survivors: ProcessLeakResult['survivors'] = [];
  try {
    const ps = spawnSync('ps', ['-eo', 'pid,comm'], { encoding: 'utf8' });
    if (ps.status !== 0) return { ok: true, survivors: [] }; // ps unavailable → skip
    const lines = ps.stdout.split('\n').slice(1);
    const alive = new Map<number, string>();
    for (const line of lines) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m) alive.set(Number(m[1]), m[2]);
    }
    for (const t of targets) {
      if (alive.has(t.pid)) survivors.push({ pid: t.pid, comm: alive.get(t.pid)!, role: t.role });
    }
  } catch { /* ignore */ }
  return { ok: survivors.length === 0, survivors };
}

// ---------------------------------------------------------------------------
// Sanitizer — redacts bearer tokens, bootstrap tokens, hashes from logs
// ---------------------------------------------------------------------------

const REDACTORS: ReadonlyArray<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <REDACTED>'],
  [/(x-horizon-bootstrap-token[^:]*:\s*)[A-Fa-f0-9]{32,}/g, '$1<REDACTED>'],
  [/(bootstrapToken["'\s:=]+)[A-Fa-f0-9]{32,}/g, '$1<REDACTED>'],
  [/(passwordHash["'\s:=]+)"?[^"',\s]+/g, '$1<REDACTED>'],
  [/(sessionToken["'\s:=]+)[A-Fa-f0-9]{32,}/g, '$1<REDACTED>'],
  [/(accessToken["'\s:=]+)[A-Za-z0-9._-]{20,}/g, '$1<REDACTED>'],
  [/(refreshToken["'\s:=]+)[A-Za-z0-9._-]{20,}/g, '$1<REDACTED>'],
];

export function sanitizeLog(raw: string): string {
  let out = raw;
  for (const [re, repl] of REDACTORS) out = out.replace(re, repl);
  return out;
}

// ---------------------------------------------------------------------------
// Evidence bundle — machine-readable manifest the CI job uploads.
// ---------------------------------------------------------------------------

export interface EvidenceBundle {
  contract: 'stage3c-native-evidence.v1';
  runId: string;
  ciRunId: string | null;
  gitCommit: string;
  os: string;
  nodeVersion: string;
  electronPid: number | null;
  serverPid: number | null;
  dbName: string;
  redisNamespace: string;
  migrationHeadCount: number;
  schemaFingerprintResult: 'skipped_external_harness' | 'verified' | 'unavailable';
  seedSummary: unknown;
  seedCoverageComplete: boolean;
  screenMatrix: Array<{ key: string; hash: string; state: string; passed: boolean; detail?: string }>;
  assertionResults: { total: number; passed: number; failed: number; skipped: number };
  rendererSecurityResult: { hasProcess: boolean; hasRequire: boolean; hasIpcRenderer: boolean; hasHorizon: boolean };
  shutdownResult: { closed: boolean; detail: string };
  processLeakResult: ProcessLeakResult;
  createOrderCounters: { functionInvocations: number; attemptCount: number; networkCount: number };
  safeFlags: {
    DRY_RUN: boolean; ORDER_SUBMISSION_ENABLED: boolean;
    SIMULATION_MODE: string; liveCapitalAuthorized: boolean;
    promotionEnabled: boolean; kellyEnabled: boolean;
  };
  serverLogFile: string;
  electronLogFile: string;
}

export function writeEvidenceBundle(iso: NativeIsolation, bundle: EvidenceBundle): string {
  const path = join(iso.logsDir, 'evidence.json');
  writeFileSync(path, JSON.stringify(bundle, null, 2));
  return path;
}

export function writeSanitizedLog(iso: NativeIsolation, name: string, raw: string): string {
  const path = join(iso.logsDir, `sanitized-${name}.log`);
  writeFileSync(path, sanitizeLog(raw));
  return path;
}

// ---------------------------------------------------------------------------
// Teardown (extended: writes sanitized logs + process-leak check result)
// ---------------------------------------------------------------------------

export async function teardown(iso: NativeIsolation, server?: ServerSpawn, launch?: ElectronLaunch): Promise<void> {
  const errors: string[] = [];
  if (launch) {
    try { await launch.app.close(); } catch (e) { errors.push(`electron_close: ${String(e).slice(0, 120)}`); }
  }
  if (server) {
    try { await server.kill(); } catch (e) { errors.push(`server_kill: ${String(e).slice(0, 120)}`); }
  }
  try {
    const r = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    await r.connect();
    // Scoped delete: only keys prefixed with our namespace.
    const stream = r.scanStream({ match: `${iso.redisNamespace}*`, count: 500 });
    const toDel: string[] = [];
    for await (const keys of stream) toDel.push(...(keys as string[]));
    if (toDel.length > 0) await r.del(...toDel);
    await r.quit();
  } catch (e) {
    errors.push(`redis_cleanup: ${String(e).slice(0, 120)}`);
  }
  try {
    await dropScratchDb(iso.dbName);
  } catch (e) {
    errors.push(`drop_db: ${String(e).slice(0, 120)}`);
  }
  if (errors.length > 0) {
    // Log to the run's logs dir but do NOT throw — teardown must
    // never mask a real test failure.
    try {
      writeFileSync(join(iso.logsDir, 'teardown-errors.log'), errors.join('\n'));
    } catch { /* best-effort */ }
  }
}

export async function ensureDbCreated(iso: NativeIsolation): Promise<void> {
  await createScratchDb(iso.dbName);
}
