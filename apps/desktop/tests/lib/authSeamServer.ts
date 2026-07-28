/**
 * Stage 3C-CI-RESET Part 2 Checkpoint A.2 — auth-seam server harness.
 *
 * Replaces the generic `authseam_server_readiness_timeout` failure from
 * apps/desktop/tests/native/auth_seam_login_body.integration.test.ts with
 * a schema-aware readiness prober and a small state machine that
 * classifies EVERY failure mode of the external-services preflight.
 *
 * Design goals (see docs/audit/stage3_report.md §Checkpoint A.2):
 *
 *  1. When readiness fails, the thrown error names the actual cause,
 *     not a generic timeout. The classifications are:
 *
 *       - `authseam_server_spawn_failed:<detail>`
 *           The child process could not be spawned (ENOENT on npx, EACCES
 *           on the interpreter, etc). Includes the sanitized OS error.
 *       - `authseam_server_exited:code=<n>,signal=<s>,last=<obs>`
 *           The child exited BEFORE readiness returned ready. Includes
 *           the exit code / signal + the last readiness observation.
 *       - `authseam_readiness_http:<status>`
 *           Readiness returned a non-2xx response before the deadline.
 *           Includes the sanitized body (redacted, truncated to 400 chars).
 *       - `authseam_readiness_invalid_json:<detail>`
 *           Readiness returned 2xx but the body was not valid JSON.
 *       - `authseam_readiness_contract_mismatch:<issuePath>:<message>`
 *           Readiness returned 2xx with valid JSON but the body did not
 *           match the shared `SystemReadinessResponseSchema` from
 *           packages/shared. Distinct from `readiness_http:400` because
 *           it means the server is reachable but the contract has drifted.
 *       - `authseam_readiness_timeout:last=<obs>,elapsedMs=<n>`
 *           Deadline reached without a `ready:true` observation. The
 *           `<obs>` tag pinpoints the STICKY failure mode (transport,
 *           http_500, not_ready, etc) so a rerun can be diagnosed
 *           without re-running the suite.
 *
 *  2. The child process cannot deadlock on a full pipe: both stdout
 *     and stderr are drained into a per-run log with sanitization at
 *     write time (bearer tokens + hex tokens redacted).
 *
 *  3. Teardown is idempotent and best-effort — it can be called from
 *     both the beforeAll failure path and the afterAll hook without
 *     double-killing or throwing. Every cleanup step (SIGTERM,
 *     SIGKILL, scratch DB drop, Redis namespace clear) tolerates a
 *     missing dependency (child never spawned, scratch DB never
 *     created, redis client never connected).
 *
 *  4. The core polling loop is pure — it takes `probeChildExit` +
 *     `fetchImpl` + a clock as dependencies so the classification
 *     logic can be exercised by unit tests without spawning a real
 *     server. Regression tests live in
 *     apps/desktop/tests/main/auth_seam_readiness_classification.test.ts.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import IORedis from 'ioredis';
import { drizzle } from 'drizzle-orm/mysql2';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { SystemReadinessResponseSchema } from '@horizon/shared';
type SystemReadinessResponse = z.infer<typeof SystemReadinessResponseSchema>;
import { createScratchDb, dropScratchDb, makeScratchDbName, scratchDbUrl } from './scratchDb';

// ---------------------------------------------------------------------------
// Public types — outcomes + observations
// ---------------------------------------------------------------------------

/**
 * A single readiness sample. The prober classifies every response
 * before returning; consumers never re-classify a raw fetch result.
 *
 * Stage 3C-E.1 §A: `not_ready` and `ready` retain the FULL parsed
 * response so the timeout diagnostic writer can dump the components
 * map with actionable per-component detail (which one flipped ready
 * to false), and consumers can inspect it directly.
 */
export type AuthSeamReadinessObservation =
  | { readonly kind: 'transport_error'; readonly error: string }
  | { readonly kind: 'http'; readonly status: number; readonly sanitizedBody: string }
  | { readonly kind: 'invalid_json'; readonly error: string; readonly sanitizedBody: string }
  | { readonly kind: 'contract_mismatch'; readonly issuePath: string; readonly issueMessage: string }
  | { readonly kind: 'not_ready'; readonly known: boolean; readonly parsed: SystemReadinessResponse }
  | { readonly kind: 'ready'; readonly parsed: SystemReadinessResponse };

export interface AuthSeamChildExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Set only when the child failed at spawn(). */
  readonly spawnError?: string;
}

/**
 * Terminal outcome of `awaitAuthSeamReadiness`. `kind: 'ready'` means
 * the child is alive AND the readiness endpoint returned a body that
 * satisfies the shared schema with `ready:true`. Every other kind is
 * a failure; the accompanying fields describe WHY.
 */
export type AuthSeamReadinessOutcome =
  | { readonly kind: 'ready'; readonly elapsedMs: number }
  | { readonly kind: 'server_spawn_failed'; readonly error: string }
  | {
      readonly kind: 'server_exited';
      readonly exit: AuthSeamChildExit;
      readonly lastObservation: AuthSeamReadinessObservation | null;
    }
  | { readonly kind: 'readiness_http'; readonly status: number; readonly sanitizedBody: string }
  | { readonly kind: 'readiness_invalid_json'; readonly error: string; readonly sanitizedBody: string }
  | { readonly kind: 'readiness_contract_mismatch'; readonly issuePath: string; readonly issueMessage: string }
  | {
      readonly kind: 'readiness_timeout';
      readonly lastObservation: AuthSeamReadinessObservation | null;
      readonly elapsedMs: number;
    };

// ---------------------------------------------------------------------------
// Sanitizer — mirrored on both the log writer and the readiness prober.
// The set of patterns is intentionally small; if a new secret shape
// leaks into a server response we want the failure to be visible.
// ---------------------------------------------------------------------------

export function sanitizeForLog(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <REDACTED>')
    .replace(/[A-Fa-f0-9]{32,}/g, '<HEX_REDACTED>');
}

// ---------------------------------------------------------------------------
// Short-form outcome → error message. This is the string the caller
// throws at beforeAll time; keep every branch stable so log-mining
// regexes can match on the exact tag.
// ---------------------------------------------------------------------------

export function authSeamOutcomeToShortReason(o: AuthSeamReadinessOutcome): string {
  switch (o.kind) {
    case 'ready':
      return 'authseam_ready';
    case 'server_spawn_failed':
      return `authseam_server_spawn_failed:${o.error}`.slice(0, 240);
    case 'server_exited': {
      const code = o.exit.exitCode == null ? 'null' : String(o.exit.exitCode);
      const signal = o.exit.signal == null ? 'null' : o.exit.signal;
      const last = observationTag(o.lastObservation);
      return `authseam_server_exited:code=${code},signal=${signal},last=${last}`.slice(0, 240);
    }
    case 'readiness_http':
      return `authseam_readiness_http:${o.status}`;
    case 'readiness_invalid_json':
      return `authseam_readiness_invalid_json:${o.error}`.slice(0, 240);
    case 'readiness_contract_mismatch':
      return `authseam_readiness_contract_mismatch:${o.issuePath}:${o.issueMessage}`.slice(0, 240);
    case 'readiness_timeout': {
      const last = observationTag(o.lastObservation);
      return `authseam_readiness_timeout:last=${last},elapsedMs=${o.elapsedMs}`.slice(0, 240);
    }
  }
}

function observationTag(obs: AuthSeamReadinessObservation | null): string {
  if (obs == null) return 'no_observation';
  switch (obs.kind) {
    case 'transport_error':
      return `transport:${obs.error.slice(0, 40)}`;
    case 'http':
      return `http_${obs.status}`;
    case 'invalid_json':
      return 'invalid_json';
    case 'contract_mismatch':
      return `contract:${obs.issuePath}`;
    case 'not_ready':
      return `not_ready(known=${obs.known ? 'true' : 'false'})`;
    case 'ready':
      return 'ready';
  }
}

// ---------------------------------------------------------------------------
// Readiness polling — pure with injectable deps (fetch, clock, sleep,
// probeChildExit). This is what the classification regression tests
// exercise directly.
// ---------------------------------------------------------------------------

export interface AwaitReadinessDeps {
  readonly fetchImpl: typeof fetch;
  readonly probeChildExit: () => AuthSeamChildExit | null;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface AwaitReadinessOpts {
  readonly baseUrl: string;
  readonly bootstrapToken: string;
  readonly deadlineMs: number;
  readonly pollIntervalMs: number;
  readonly perProbeTimeoutMs: number;
}

async function probeOnce(
  fetchImpl: typeof fetch,
  opts: AwaitReadinessOpts,
): Promise<AuthSeamReadinessObservation> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.perProbeTimeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(`${opts.baseUrl}/api/system/readiness`, {
        signal: ctrl.signal,
        headers: { 'x-horizon-bootstrap-token': opts.bootstrapToken },
      });
    } catch (e) {
      return { kind: 'transport_error', error: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      return { kind: 'transport_error', error: `read_body:${(e instanceof Error ? e.message : String(e)).slice(0, 100)}` };
    }
    const sanitized = sanitizeForLog(text).slice(0, 400);
    if (!res.ok) {
      return { kind: 'http', status: res.status, sanitizedBody: sanitized };
    }
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch (e) {
      return {
        kind: 'invalid_json',
        error: (e instanceof Error ? e.message : String(e)).slice(0, 120),
        sanitizedBody: sanitized,
      };
    }
    const zr = SystemReadinessResponseSchema.safeParse(parsed);
    if (!zr.success) {
      const issue = zr.error.issues[0];
      return {
        kind: 'contract_mismatch',
        issuePath: issue?.path.join('.') || '<root>',
        issueMessage: (issue?.message ?? 'unknown').slice(0, 120),
      };
    }
    return zr.data.ready === true
      ? { kind: 'ready', parsed: zr.data }
      : { kind: 'not_ready', known: zr.data.known === true, parsed: zr.data };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Pure readiness poller. Terminates on:
 *   - the child exiting (server_exited / server_spawn_failed)
 *   - a sticky HTTP or contract failure that outlives the deadline
 *   - a `ready:true` observation
 *   - the deadline elapsing (readiness_timeout, with the last observation)
 *
 * NB: an intermittent HTTP or transport failure that eventually resolves
 * to ready:true is NOT reported as a failure — the poller stays in the
 * loop as long as the child is alive and the deadline is unreached.
 */
export async function awaitAuthSeamReadiness(
  deps: AwaitReadinessDeps,
  opts: AwaitReadinessOpts,
): Promise<AuthSeamReadinessOutcome> {
  const now = deps.now ?? ((): number => Date.now());
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  let lastObservation: AuthSeamReadinessObservation | null = null;

  while (true) {
    // 1. Always check the child first — a dead child means every
    // future fetch will fail identically, so we short-circuit.
    const exit = deps.probeChildExit();
    if (exit != null) {
      if (exit.spawnError != null) {
        return { kind: 'server_spawn_failed', error: exit.spawnError.slice(0, 200) };
      }
      return { kind: 'server_exited', exit, lastObservation };
    }

    // 2. Probe readiness.
    const obs = await probeOnce(deps.fetchImpl, opts);
    lastObservation = obs;
    if (obs.kind === 'ready') {
      return { kind: 'ready', elapsedMs: now() - start };
    }

    // 3. Deadline?
    const elapsed = now() - start;
    if (elapsed >= opts.deadlineMs) {
      return { kind: 'readiness_timeout', lastObservation, elapsedMs: elapsed };
    }

    await sleep(opts.pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// Full harness — spawn + await + teardown. Wraps the pure poller with
// the machinery the integration test needs: pipe draining, log
// sanitization, MariaDB scratch DB, Redis namespace, teardown.
// ---------------------------------------------------------------------------

export interface AuthSeamServerBootOptions {
  readonly serverCwd: string;
  readonly migrationsDir: string;
  readonly logsBaseDir: string;
  readonly redisUrl?: string;
  readonly jwtSecret?: string;
  readonly deadlineMs?: number;
  readonly pollIntervalMs?: number;
  readonly perProbeTimeoutMs?: number;
  readonly extraServerEnv?: Readonly<Record<string, string>>;
}

/**
 * Fields are intentionally NOT readonly — the harness reassigns
 * `exit` on the child's exit event, `readinessOutcome` after the
 * poller returns, and `stopAuthSeamServer` may null out resource
 * handles once cleanup completes. Callers must not mutate this
 * object directly; treat it as opaque.
 */
export interface AuthSeamServerHandle {
  child: ChildProcess | null;
  spawnArgv: readonly string[];
  cwd: string;
  pid: number | null;
  port: number | null;
  baseUrl: string | null;
  bootstrapToken: string | null;
  redisNamespace: string | null;
  redisUrl: string;
  dbName: string | null;
  dbUrl: string | null;
  logsDir: string | null;
  serverLogPath: string | null;
  /** Set once the child fires `exit` or `error`. */
  exit: AuthSeamChildExit | null;
  /** Set on successful readiness / early failure. */
  readinessOutcome: AuthSeamReadinessOutcome | null;
  /**
   * Snapshot of what was captured before the poller returned. Trimmed
   * to the last 8 KB so a runaway server does not blow up the error.
   */
  stdoutTail: () => string;
  stderrTail: () => string;
}

async function pickFreePort(): Promise<number> {
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

/**
 * Stage 3C-E.1 §A — apply migrations to the scratch database AND
 * populate the `__drizzle_migrations` tracking table exactly like
 * drizzle-orm's own mysql2 migrator would.
 *
 * The server's `/api/system/readiness` handler in
 * apps/server/src/routes/desktop.ts:251-282 requires:
 *   (a) `__drizzle_migrations` exists in the current schema
 *   (b) row count >= 1 for `migration` component ok
 *   (c) row count >= 21 for `fingerprint` component ok
 *
 * The pre-E.1 helper executed raw .sql statements only — it never
 * created or populated `__drizzle_migrations`. That kept the readiness
 * gate stuck on `ready:false` forever with `migration.ok=false` and
 * `fingerprint.ok=false`, producing the observed
 * `authseam_readiness_timeout:last=not_ready(known=true)` after 60 s.
 *
 * Why not `drizzle-orm/mysql2/migrator`? Its `migrate()` reads each
 * migration file, splits it by the `--> statement-breakpoint` marker,
 * and sends each chunk to mysql2's prepared-query path. Migration
 * 0021 (stage2_operator_authentication) predates the breakpoint
 * convention and contains 5 top-level `CREATE TABLE` statements with
 * no breakpoint markers. Drizzle's migrator therefore sends the whole
 * file as ONE query; mysql2's `execute()` rejects the second CREATE
 * with `ER_PARSE_ERROR` (errno 1064) even when the pool is created
 * with `multipleStatements: true` — the prepared-statement path does
 * not honour that option.
 *
 * Migrations 0000–0021 are frozen (byte-identical to RESET_BASE and
 * enforced by the migration-integrity suite), so we cannot add the
 * markers. This helper implements the same behaviour drizzle's
 * migrator would with breakpoint-annotated files, but goes through
 * mysql2's `query()` path — which DOES honour `multipleStatements`
 * — so a multi-statement chunk is split by the driver. The tracking
 * table is created and populated so a per-file row exists at the
 * timestamp declared by `meta/_journal.json`, matching drizzle's
 * `folderMillis`/`hash` shape exactly.
 */

interface DrizzleJournalEntry {
  readonly idx: number;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}

interface DrizzleJournal {
  readonly entries: readonly DrizzleJournalEntry[];
}

function splitMigrationStatements(sqlContent: string): readonly string[] {
  // Prefer the drizzle breakpoint marker when present — the split it
  // produces is unambiguous (comments do not embed `;`).
  if (sqlContent.includes('--> statement-breakpoint')) {
    return sqlContent
      .split(/-->\s*statement-breakpoint/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  // Fallback for migrations authored before the marker convention
  // (currently only 0021). Strip line comments first so a semicolon
  // inside a comment cannot artificially cut a statement, then split
  // by `;`. None of the frozen 0000-0021 migrations contain
  // semicolons inside quoted strings so this is safe for the current
  // migration set — a regression test pins that invariant.
  const stripped = sqlContent
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
  return stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applyMigrations(dbUrl: string, migrationsDir: string): Promise<void> {
  const journalPath = join(migrationsDir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as DrizzleJournal;
  // Deterministic order — drizzle sorts by `when`, ties broken by `idx`.
  const entries = [...journal.entries].sort((a, b) =>
    a.when === b.when ? a.idx - b.idx : a.when - b.when,
  );
  // Direct connection (not pool) with multipleStatements so
  // connection.query() accepts multi-CREATE chunks. Prepared
  // statements are never used on this connection.
  const c = await mysql.createConnection({ uri: dbUrl, multipleStatements: true });
  try {
    // Match the shape drizzle-orm creates so the server's
    // `SELECT COUNT(*) FROM __drizzle_migrations` reports the
    // expected count and the fingerprint check sees applied>=21.
    await c.query(
      'CREATE TABLE IF NOT EXISTS `__drizzle_migrations` (' +
        '`id` SERIAL PRIMARY KEY, ' +
        '`hash` TEXT NOT NULL, ' +
        '`created_at` BIGINT)',
    );
    for (const entry of entries) {
      const filePath = join(migrationsDir, `${entry.tag}.sql`);
      const sqlContent = readFileSync(filePath, 'utf8');
      const hash = createHash('sha256').update(sqlContent).digest('hex');
      for (const stmt of splitMigrationStatements(sqlContent)) {
        await c.query(stmt);
      }
      // `folderMillis` in drizzle's own migrator is `entry.when`.
      await c.query(
        'INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)',
        [hash, entry.when],
      );
    }
  } finally {
    await c.end();
  }
}

/**
 * Stage 3C-E.1 §A — seed the minimal `bot_config` row required for the
 * server's `checkReconciliation` gate to report ok=true against a
 * freshly-migrated scratch DB.
 *
 * The readiness handler at apps/server/src/routes/desktop.ts:295-305
 * computes:
 *   ok = reconciliationStatus !== 'failed' && reconciliationStatus !== 'pending'
 * On a fresh schema, `bot_config` is empty and the code path defaults
 * `reconciliationStatus` to `'pending'` → ok=false → readiness never
 * reaches ready:true.
 *
 * We insert exactly one row with `reconciliationStatus='ok'`. Every
 * other column takes the schema default. No trading state is seeded —
 * `unresolvedActions=0`, `unknownOrderLocks=0`, `nonterminalIntentCount=0`
 * all remain because the corresponding tables are empty.
 *
 * This is a test-only helper. It never runs in production; the desktop
 * supervisor establishes the same state through the real reconciliation
 * cycle at server boot.
 */
async function seedAuthSeamMinimum(dbUrl: string): Promise<void> {
  const pool = mysql.createPool({ uri: dbUrl, connectionLimit: 2 });
  try {
    const db = drizzle(pool);
    // Idempotent: if bot_config already has a row (defensive against
    // future re-entrancy in the harness), do not add a duplicate.
    await db.execute(sql`
      INSERT INTO bot_config (isRunning, isPaused, consecutiveLosses, reconciliationStatus, reconciliationDetail)
      SELECT FALSE, FALSE, 0, 'ok', 'stage3c_e1_authseam_seed'
      WHERE NOT EXISTS (SELECT 1 FROM bot_config)
    `);
  } finally {
    await pool.end();
  }
}

/**
 * Boot the auth-seam server (MariaDB scratch DB + Redis namespace +
 * spawned `npx tsx src/index.ts`), then poll readiness until we have
 * a terminal outcome. On failure, the returned handle carries every
 * captured diagnostic so the caller can teardown AND log the exact
 * classification. On success, the caller uses `handle.baseUrl` /
 * `handle.bootstrapToken` for further seam assertions.
 */
export async function startAuthSeamServer(opts: AuthSeamServerBootOptions): Promise<AuthSeamServerHandle> {
  const redisUrl = opts.redisUrl ?? 'redis://127.0.0.1:6379';
  const deadlineMs = opts.deadlineMs ?? 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 400;
  const perProbeTimeoutMs = opts.perProbeTimeoutMs ?? 2_500;

  // Mutable diagnostics collected below.
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const stdoutTail = (): string => stdoutBuf.join('').slice(-8_192);
  const stderrTail = (): string => stderrBuf.join('').slice(-8_192);

  const handle: AuthSeamServerHandle = {
    child: null,
    spawnArgv: [],
    cwd: opts.serverCwd,
    pid: null,
    port: null,
    baseUrl: null,
    bootstrapToken: null,
    redisNamespace: null,
    redisUrl,
    dbName: null,
    dbUrl: null,
    logsDir: null,
    serverLogPath: null,
    exit: null,
    readinessOutcome: null,
    stdoutTail,
    stderrTail,
  };

  // --- 1. MariaDB scratch DB + migrations + minimum seed
  const dbName = makeScratchDbName('authseam');
  handle.dbName = dbName;
  await createScratchDb(dbName);
  const dbUrl = scratchDbUrl(dbName);
  handle.dbUrl = dbUrl;
  await applyMigrations(dbUrl, opts.migrationsDir);
  await seedAuthSeamMinimum(dbUrl);

  // --- 2. Redis namespace + free port + bootstrap token
  handle.redisNamespace = `authseam_${process.pid}_${randomBytes(3).toString('hex')}`;
  handle.port = await pickFreePort();
  handle.bootstrapToken = randomBytes(32).toString('hex');
  handle.baseUrl = `http://127.0.0.1:${handle.port}`;
  handle.logsDir = join(opts.logsBaseDir, `authseam_${handle.redisNamespace}`);
  mkdirSync(handle.logsDir, { recursive: true });
  handle.serverLogPath = join(handle.logsDir, 'server.live.log');

  // --- 3. Spawn the server
  const spawnArgv = ['npx', 'tsx', 'src/index.ts'] as const;
  handle.spawnArgv = spawnArgv;
  const child = spawn(spawnArgv[0], spawnArgv.slice(1), {
    cwd: opts.serverCwd,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(handle.port),
      DATABASE_URL: dbUrl,
      REDIS_URL: redisUrl,
      JWT_SECRET: opts.jwtSecret ?? 'stage3c-ci-reset-authseam-secret-please-change',
      DRY_RUN: 'true',
      ORDER_SUBMISSION_ENABLED: 'false',
      CORS_ORIGINS: '*',
      HORIZON_BOOTSTRAP_TOKEN: handle.bootstrapToken,
      HORIZON_REDIS_NAMESPACE: handle.redisNamespace,
      ...(opts.extraServerEnv ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  handle.child = child;
  handle.pid = child.pid ?? null;

  const serverLogPath = handle.serverLogPath;
  const drain = (kind: 'stdout' | 'stderr', chunk: Buffer): void => {
    const sanitized = sanitizeForLog(String(chunk)).slice(0, 65_536);
    if (kind === 'stdout') stdoutBuf.push(sanitized);
    else stderrBuf.push(sanitized);
    try {
      appendFileSync(serverLogPath, `[${kind}] ${sanitized}`);
    } catch { /* best-effort */ }
  };
  child.stdout?.on('data', (c) => drain('stdout', c));
  child.stderr?.on('data', (c) => drain('stderr', c));
  child.on('exit', (code, signal) => {
    if (handle.exit == null) handle.exit = { exitCode: code, signal };
  });
  child.on('error', (e) => {
    if (handle.exit == null) handle.exit = { exitCode: null, signal: null, spawnError: e.message };
  });

  // --- 4. Poll readiness with rich classification
  const outcome = await awaitAuthSeamReadiness(
    {
      fetchImpl: fetch,
      probeChildExit: () => handle.exit,
    },
    {
      baseUrl: handle.baseUrl,
      bootstrapToken: handle.bootstrapToken,
      deadlineMs,
      pollIntervalMs,
      perProbeTimeoutMs,
    },
  );
  handle.readinessOutcome = outcome;
  return handle;
}

// ---------------------------------------------------------------------------
// Stage 3C-E.1 §A — readiness-timeout diagnostic writer.
//
// When a readiness timeout occurs, the caller (integration test's
// beforeAll) should immediately dump every diagnostic that could
// explain WHICH readiness component prevented ready:true from being
// observed. The dumped fields never include credentials — DB URL
// passwords are stripped, Redis URL is trimmed to host:port, bootstrap
// token is omitted entirely.
// ---------------------------------------------------------------------------

export interface AuthSeamReadinessDiagnostic {
  readonly runId: string;
  readonly elapsedMs: number;
  readonly lastHttpStatus: number | null;
  readonly lastReadinessResponse: SystemReadinessResponse | null;
  readonly components: Record<string, { ok: boolean; detail?: string }> | null;
  readonly serverPid: number | null;
  readonly serverExited: boolean;
  readonly serverExitCode: number | null;
  readonly serverSignal: string | null;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly databaseTarget: string;
  readonly redisTarget: string;
  readonly failureCode: string;
  readonly writtenAt: string;
}

/**
 * Strip credentials from a DB URL for diagnostic output. Never emits
 * the password segment even if the caller passed a URL that contains
 * one.
 */
export function sanitizeDbUrl(dbUrl: string | null): string {
  if (!dbUrl) return '<unset>';
  try {
    const u = new URL(dbUrl);
    // Strip user + password; retain host + port + database.
    const host = u.host || u.hostname;
    const db = u.pathname.replace(/^\//, '') || '<no_db>';
    return `mysql://<REDACTED>@${host}/${db}`;
  } catch {
    return '<unparseable>';
  }
}

export function sanitizeRedisUrl(redisUrl: string | null): string {
  if (!redisUrl) return '<unset>';
  try {
    const u = new URL(redisUrl);
    const host = u.host || u.hostname;
    return `redis://<REDACTED>@${host}${u.pathname || ''}`;
  } catch {
    return '<unparseable>';
  }
}

/**
 * Build the diagnostic payload from a completed (or timed-out)
 * handle. Never throws; missing pieces come back as `null`. `runId`
 * is provided by the caller so the artifact file name aligns with
 * the workflow's run identifier.
 */
export function buildReadinessDiagnostic(
  handle: AuthSeamServerHandle,
  runId: string,
): AuthSeamReadinessDiagnostic {
  const outcome = handle.readinessOutcome;
  let elapsedMs = 0;
  let failureCode = 'authseam_no_outcome';
  let lastObs: AuthSeamReadinessObservation | null = null;
  if (outcome) {
    failureCode = authSeamOutcomeToShortReason(outcome);
    if (outcome.kind === 'readiness_timeout') {
      elapsedMs = outcome.elapsedMs;
      lastObs = outcome.lastObservation;
    } else if (outcome.kind === 'server_exited') {
      lastObs = outcome.lastObservation;
    } else if (outcome.kind === 'ready') {
      elapsedMs = outcome.elapsedMs;
    }
  }
  const parsed: SystemReadinessResponse | null =
    lastObs?.kind === 'not_ready' || lastObs?.kind === 'ready' ? lastObs.parsed : null;
  const lastHttpStatus: number | null =
    lastObs?.kind === 'http' ? lastObs.status
    : lastObs?.kind === 'not_ready' || lastObs?.kind === 'ready' ? 200
    : null;
  // The components map is passthrough-shaped in the schema; extract it
  // as a plain object if present. Cast via `unknown` because the
  // schema declares `components` via passthrough and the compiler
  // does not narrow that shape.
  const componentsRaw = (parsed as unknown as { components?: unknown } | null)?.components;
  const components =
    componentsRaw && typeof componentsRaw === 'object' && !Array.isArray(componentsRaw)
      ? (componentsRaw as Record<string, { ok: boolean; detail?: string }>)
      : null;
  const exit = handle.exit;
  return {
    runId,
    elapsedMs,
    lastHttpStatus,
    lastReadinessResponse: parsed,
    components,
    serverPid: handle.pid,
    serverExited: exit != null,
    serverExitCode: exit?.exitCode ?? null,
    serverSignal: exit?.signal ?? null,
    stdoutTail: handle.stdoutTail().slice(-4_096),
    stderrTail: handle.stderrTail().slice(-4_096),
    databaseTarget: sanitizeDbUrl(handle.dbUrl),
    redisTarget: sanitizeRedisUrl(handle.redisUrl),
    failureCode,
    writtenAt: new Date().toISOString(),
  };
}

/**
 * Persist the diagnostic to `<logsBaseDir>/<runId>/authseam-readiness-diagnostic.json`.
 * Idempotent (overwrites on repeated invocations). Never throws.
 */
export function writeReadinessDiagnostic(
  diag: AuthSeamReadinessDiagnostic,
  logsBaseDir: string,
): string | null {
  try {
    const dir = join(logsBaseDir, diag.runId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'authseam-readiness-diagnostic.json');
    writeFileSync(path, JSON.stringify(diag, null, 2), 'utf8');
    return path;
  } catch {
    return null;
  }
}

/**
 * Best-effort teardown. Safe to call multiple times and safe to call
 * on a partially-initialized handle (e.g. if MariaDB was created but
 * the server spawn failed). Never throws.
 */
export async function stopAuthSeamServer(
  handle: AuthSeamServerHandle | undefined,
  opts: { readonly timeoutMs?: number } = {},
): Promise<void> {
  if (!handle) return;
  const timeoutMs = opts.timeoutMs ?? 8_000;

  // 1. Terminate the child
  if (handle.child && handle.child.exitCode == null && handle.exit == null) {
    try { handle.child.kill('SIGTERM'); } catch { /* ignore */ }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && handle.child.exitCode == null && handle.exit == null) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (handle.child.exitCode == null && handle.exit == null) {
      try { handle.child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }

  // 2. Drop the scratch DB (idempotent — dropScratchDb uses IF EXISTS)
  if (handle.dbName) {
    try { await dropScratchDb(handle.dbName); } catch { /* ignore */ }
    handle.dbName = null;
  }

  // 3. Clear the Redis namespace (idempotent — keys(...) returns []
  //    on second call after the first cleared them)
  if (handle.redisNamespace) {
    try {
      const r = new IORedis(handle.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
      try {
        await r.connect();
        const keys = await r.keys(`${handle.redisNamespace}:*`);
        if (keys.length > 0) await r.del(...keys);
      } finally {
        try { await r.quit(); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    handle.redisNamespace = null;
  }
}
