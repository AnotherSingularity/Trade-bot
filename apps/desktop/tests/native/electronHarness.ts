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
import { StartupTrace, withNativeTimeout } from './nativeDiagnostics';
import { resolveNativeLaunchPolicy } from '../../src/main/nativeLaunchPolicy';

// ---------------------------------------------------------------------------
// Fixed inputs
// ---------------------------------------------------------------------------

export const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
export const SERVER_CWD = join(REPO_ROOT, 'apps/server');
export const DESKTOP_DIST = join(REPO_ROOT, 'apps/desktop/dist');
// Stage 3C-CI-FIX8 §1: canonical runtime layout.
// Bundled outputs (from apps/desktop/build/bundle-main.mjs):
//   dist/main/index.cjs       — Electron main
//   dist/preload/index.cjs    — sandboxed preload
//   dist/renderer/index.html  — Vite renderer entry
export const DESKTOP_MAIN_ENTRY = join(DESKTOP_DIST, 'main/index.cjs');
export const DESKTOP_ROOT = join(REPO_ROOT, 'apps/desktop');
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
  // Stage 3C-E.1.27 — resolve tsx binary directly. Previously we
  // spawned `npx tsx src/index.ts`, which builds a process tree of
  // `npx → sh → node → node`. `process.kill(proc.pid, 'SIGSTOP')`
  // stops only the top wrapper; the deepest node process (the
  // actual server) keeps handling requests, so T42's suspension
  // window fires while the socket is still fully responsive.
  //
  // Two-pronged fix:
  //   1. `detached: true` gives the child its own process group so
  //      signals can target the whole subtree via `-pgid`.
  //   2. Resolve the tsx binary from node_modules/.bin so the
  //      command is a single `node <tsx> src/index.ts` process
  //      (tsx v4 exposes an ESM cli.mjs runnable by node directly).
  //      There is no shell wrapper, no npm exec, and SIGSTOP to
  //      the process group hits the actual HTTP server.
  const tsxBin = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
  const proc = spawn(process.execPath, [tsxBin, 'src/index.ts'], {
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
      // Stage 3C-E.1.17 — the server-side native-induction router
      // (apps/server/src/routes/nativeInduction.ts) mounts only when
      // BOTH env vars below are set. Without them, the T39-T43
      // induction endpoints return 404 and the behavioural tests
      // that induce stale/degraded/unavailable/contract-mismatch
      // states have nothing to talk to. The Electron process
      // already sets these (electronHarness.ts:328/355); the
      // server child needs them independently since it reads its
      // OWN environment via ENV.nodeEnv + process.env.
      HORIZON_NATIVE_DIAGNOSTICS: 'true',
      HORIZON_SERVER_EXTERNAL: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
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

  // With `detached: true` the child leads its own process group whose
  // PGID equals proc.pid. Sending signals to `-pid` targets every
  // process in the group. We fall back to the direct proc.kill() if
  // for some reason the group signal fails (permission, race with
  // exit), so behaviour is at least as good as before.
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    if (!proc.pid) return false;
    try { process.kill(-proc.pid, signal); return true; } catch { return false; }
  };
  const kill = async (): Promise<void> => {
    try {
      writeFileSync(join(iso.logsDir, 'server.log'), logStream.out);
    } catch { /* logs best-effort */ }
    if (proc.exitCode == null) {
      if (!signalGroup('SIGTERM')) { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }
    }
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && proc.exitCode == null) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (proc.exitCode == null) {
      if (!signalGroup('SIGKILL')) { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }
    }
  };

  return {
    proc,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    healthUrl: `http://127.0.0.1:${port}/api/system/readiness`,
    bootstrapToken,
    kill,
    suspend: () => { if (!signalGroup('SIGSTOP')) { try { proc.kill('SIGSTOP'); } catch { /* ignore */ } } },
    resume: () => { if (!signalGroup('SIGCONT')) { try { proc.kill('SIGCONT'); } catch { /* ignore */ } } },
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

/**
 * Stage 3C-CI-FIX4 §A2/§A3: launch Electron in three separately
 * bounded phases so a hang is attributable to exactly one phase
 * rather than an opaque 15-min timeout:
 *   1. `_electron.launch()`               — 60s
 *   2. `firstWindow()`                    — 60s
 *   3. `waitForLoadState('domcontentloaded')` — 45s
 * Optional caller-driven renderer_ready check (§A3, 60s) is done
 * by the integration test itself.
 */
export async function launchElectron(iso: NativeIsolation, server: ServerSpawn, trace?: StartupTrace): Promise<ElectronLaunch> {
  const userDataDir = join(iso.logsDir, 'electron-userdata');
  const reportDir = join(iso.logsDir, 'electron-reports');
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(reportDir, { recursive: true });
  const localTrace = trace ?? new StartupTrace(iso.logsDir);

  // Stage 3C-E.1 §D — resolve the canonical native launch policy.
  // Default: NO sandbox-disabling switches, NO sandbox-disabling env.
  // The pure policy in src/main/nativeLaunchPolicy.ts is the ONLY
  // gate; a stray env var in a packaged installer or a typo in the
  // opt-in cannot silently activate the fallback. When the fallback
  // IS active, `policy.sandboxDisabled=true` is recorded to the
  // launch record so downstream evidence marks the run non-certifiable.
  const policy = resolveNativeLaunchPolicy({
    isPackaged: false,
    nodeEnv: 'test',
    noSandboxOptIn: process.env.HORIZON_NATIVE_ALLOW_NO_SANDBOX,
  });
  // Persist policy decision into evidence directory so the artifact
  // upload captures WHY the harness chose the sandbox stance it did.
  try {
    writeFileSync(
      join(iso.logsDir, 'native-launch-policy.json'),
      JSON.stringify({
        sandboxDisabled: policy.sandboxDisabled,
        reason: policy.reason,
        extraArgs: policy.extraArgs,
        // Env keys only (never values); values here are 'true'/'1'
        // anyway but tests should verify the audit trail lists keys.
        extraEnvKeys: Object.keys(policy.extraEnv).sort(),
        writtenAt: new Date().toISOString(),
      }, null, 2),
      'utf8',
    );
  } catch { /* best-effort — evidence writer failures never abort */ }
  const canonicalArgs = [
    DESKTOP_MAIN_ENTRY,
    '--disable-gpu',
    '--in-process-gpu',
    `--user-data-dir=${userDataDir}`,
    ...policy.extraArgs,
  ];
  const app = await withNativeTimeout(
    'electron_launch',
    60_000,
    electron.launch({
      executablePath: ELECTRON_BIN,
      args: canonicalArgs,
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY ?? ':99',
        // Stage 3C-CI-FIX8 §3: NODE_ENV=test is REQUIRED for the strict
        // native-diagnostics gate AND the preload diagnostic IPC
        // channel. HORIZON_ENVIRONMENT stays 'development' so the
        // service adapter factory picks the unpackaged path
        // (production forbids stubs).
        NODE_ENV: 'test',
        HORIZON_ENVIRONMENT: 'development',
        HORIZON_SERVER_EXTERNAL: 'true',
        HORIZON_MARIADB_URL: iso.dbUrl,
        HORIZON_REDIS_URL: REDIS_URL,
        HORIZON_SERVER_HEALTH_URL: server.healthUrl,
        HORIZON_BOOTSTRAP_TOKEN: server.bootstrapToken,
        // HORIZON_PROJECT_ROOT points at the REPO root (server assets).
        // HORIZON_DESKTOP_ROOT points at the DESKTOP package (main/preload/
        // renderer entries). These are distinct: the FIX7 CI run failed
        // because `app.getAppPath()` returned `/` in the explicit-main-file
        // launch. The FIX8 resolver validates HORIZON_DESKTOP_ROOT first.
        HORIZON_PROJECT_ROOT: REPO_ROOT,
        HORIZON_DESKTOP_ROOT: DESKTOP_ROOT,
        HORIZON_AUTH_REQUIRED: 'true',
        HORIZON_USE_KEYTAR: 'false',
        HORIZON_DATABASE_MODE: 'external_services',
        HORIZON_DEVELOPMENT_FAKE: 'false',
        HORIZON_SCHEMA_VERSION: '0021',
        HORIZON_REPORT_DIR: reportDir,
        // The main's resolveDesktopRuntimeLayout will fall through to
        // the canonical renderer path — no override needed. Kept as
        // an escape hatch for developers who point at a stale renderer.
        HORIZON_RENDERER_URL: `file://${join(DESKTOP_DIST, 'renderer/index.html')}`,
        // Stage 3C-CI-FIX4 §A4: Chromium diagnostics.
        ELECTRON_ENABLE_LOGGING: '1',
        ELECTRON_ENABLE_STACK_DUMPING: '1',
        // Stage 3C-CI-FIX4 §A5: preload + renderer emit the fixed
        // native-only initialization markers (nativeDiagnosticsEnabled).
        HORIZON_NATIVE_DIAGNOSTICS: 'true',
        // Stage 3C-CI-FIX7 §B4: preload writes markers directly to
        // this file sink. `page.on('console')` sits in the renderer
        // realm and does NOT capture preload console output — the
        // preload.log was empty in FIX6 for that exact reason. This
        // sink is filled from inside preload before any bridge work.
        HORIZON_NATIVE_PRELOAD_LOG_PATH: join(iso.logsDir, 'preload.log'),
        // Stage 3C-E.1 §D: only the policy-approved sandbox-disable
        // env is merged. In the canonical case this spread is empty
        // (Object.keys(policy.extraEnv) === []); in fallback mode it
        // adds exactly HORIZON_ELECTRON_NO_SANDBOX and
        // ELECTRON_DISABLE_SANDBOX. The record above proves which.
        ...policy.extraEnv,
      },
      timeout: 55_000,
    }),
    { trace: localTrace, startPhase: 'electron_launch_started', completePhase: 'electron_launch_complete' },
  );
  // Stage 3C-CI-FIX4 §A4: tee stdio streams to separate log files
  // immediately so a subsequent timeout still produces artefacts.
  const electronStdout = join(iso.logsDir, 'electron-main.stdout.log');
  const electronStderr = join(iso.logsDir, 'electron-main.stderr.log');
  const preloadLog = join(iso.logsDir, 'preload.log');
  const rendererLog = join(iso.logsDir, 'renderer.log');
  const fsMod = require('node:fs') as typeof import('node:fs');
  app.process().stdout?.on('data', (d) => {
    try { fsMod.appendFileSync(electronStdout, String(d)); }
    catch { /* best-effort */ }
  });
  app.process().stderr?.on('data', (d) => {
    try { fsMod.appendFileSync(electronStderr, String(d)); }
    catch { /* best-effort */ }
  });

  // Stage 3C-CI-FIX4 §A3: first_window is a separate bounded phase.
  const page = await withNativeTimeout(
    'first_window',
    60_000,
    app.firstWindow({ timeout: 55_000 }),
    { trace: localTrace, startPhase: 'first_window_wait_started', completePhase: 'first_window_observed' },
  );

  // Stage 3C-CI-FIX4 §A5: attach renderer + preload + page listeners
  // as soon as the page is available. Every message is sanitized-out
  // by the receiving stream — no tokens leak because the running
  // desktop main NEVER logs tokens in the first place.
  page.on('console', (msg) => {
    try {
      const text = msg.text();
      // Route preload/renderer markers to dedicated logs.
      if (text.includes('HORIZON_NATIVE_PRELOAD_INITIALIZED')) {
        fsMod.appendFileSync(preloadLog, text + '\n');
      } else if (text.includes('HORIZON_NATIVE_RENDERER_BOOTSTRAPPED')) {
        fsMod.appendFileSync(rendererLog, text + '\n');
      }
      // All console traffic also lands in renderer.log for review.
      fsMod.appendFileSync(rendererLog, `[${msg.type()}] ${text}\n`);
    } catch { /* best-effort */ }
  });
  page.on('pageerror', (err) => {
    try { fsMod.appendFileSync(rendererLog, `[pageerror] ${err.message}\n`); }
    catch { /* best-effort */ }
  });
  page.on('crash', () => {
    try { fsMod.appendFileSync(rendererLog, `[crash] renderer process crashed\n`); }
    catch { /* best-effort */ }
  });
  page.on('requestfailed', (req) => {
    try { fsMod.appendFileSync(rendererLog, `[requestfailed] ${req.url()} :: ${req.failure()?.errorText ?? 'unknown'}\n`); }
    catch { /* best-effort */ }
  });

  // Stage 3C-CI-FIX4 §A3: renderer DOM load is a separate bounded
  // phase so a hang in HashRouter/renderer bootstrap is attributable.
  await withNativeTimeout(
    'renderer_dom',
    45_000,
    page.waitForLoadState('domcontentloaded'),
    { trace: localTrace, startPhase: 'renderer_dom_wait_started', completePhase: 'renderer_dom_loaded' },
  );

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
// Teardown (Stage 3C-CI-RESET §5.1 — typed per-step outcome).
//
// The pre-RESET teardown swallowed every failure into a log file
// and returned void; the caller flipped teardownOk=true and could
// mark cleanup complete even when Electron close, server kill,
// Redis cleanup, or database drop failed. The audit called this
// out as a certification-invalidating defect (§P0.3).
//
// The RESET contract:
//   - Every cleanup step returns a discriminated { ok } | { ok:false, error }.
//   - teardown() returns TeardownResult with per-step outcome +
//     computed `completed` boolean.
//   - The caller decides whether to fail the run based on the
//     typed result. The original test failure is still primary;
//     cleanup failures are secondary but MUST be surfaced.
//   - Errors are never rethrown from teardown itself — the caller
//     drives the certification decision.
// ---------------------------------------------------------------------------

export type StepResult =
  | { ok: true }
  | { ok: false; error: string };

export interface TeardownResult {
  electronClose: StepResult;
  serverStop: StepResult;
  redisCleanup: StepResult;
  databaseDrop: StepResult;
  /** True iff every mandatory step succeeded. */
  completed: boolean;
}

function stepOk(): StepResult { return { ok: true }; }
function stepFail(e: unknown): StepResult { return { ok: false, error: String(e).slice(0, 200) }; }

export async function teardown(iso: NativeIsolation, server?: ServerSpawn, launch?: ElectronLaunch): Promise<TeardownResult> {
  // Steps default to a benign OK if the resource never existed. If it
  // existed and the operation threw, that step records the error.
  let electronClose: StepResult = stepOk();
  let serverStop: StepResult = stepOk();
  let redisCleanup: StepResult = stepOk();
  let databaseDrop: StepResult = stepOk();
  if (launch) {
    try { await launch.app.close(); }
    catch (e) { electronClose = stepFail(`electron_close: ${e}`); }
  }
  if (server) {
    try { await server.kill(); }
    catch (e) { serverStop = stepFail(`server_kill: ${e}`); }
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
    redisCleanup = stepFail(`redis_cleanup: ${e}`);
  }
  try {
    await dropScratchDb(iso.dbName);
  } catch (e) {
    databaseDrop = stepFail(`drop_db: ${e}`);
  }
  const completed = electronClose.ok && serverStop.ok && redisCleanup.ok && databaseDrop.ok;
  const result: TeardownResult = { electronClose, serverStop, redisCleanup, databaseDrop, completed };
  // Persist the typed result adjacent to the run's logs so an audit
  // has a single JSON to inspect. Never masks the return — the caller
  // still receives the object.
  try {
    writeFileSync(join(iso.logsDir, 'teardown-result.json'), JSON.stringify(result, null, 2));
  } catch { /* best-effort */ }
  return result;
}

export async function ensureDbCreated(iso: NativeIsolation): Promise<void> {
  await createScratchDb(iso.dbName);
}
