/**
 * Stage 3C-CI-RESET Part 2 Checkpoint A.2 — auth-seam readiness
 * classification regression suite.
 *
 * Exercises the pure `awaitAuthSeamReadiness` poller from
 * apps/desktop/tests/lib/authSeamServer.ts against controlled fakes
 * for the child-process and fetch dependencies. Every failure mode
 * that the integration preflight can hit maps to a distinct
 * classification tag; this suite fails if the mapping regresses.
 *
 * The tests deliberately do NOT spawn a real server — they exist so
 * that a broken classifier is caught by the fast unit run, not by a
 * 60-second real-server timeout on CI.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  authSeamOutcomeToShortReason,
  awaitAuthSeamReadiness,
  sanitizeForLog,
  stopAuthSeamServer,
  type AuthSeamChildExit,
  type AuthSeamReadinessOutcome,
  type AwaitReadinessOpts,
} from '../lib/authSeamServer';

// ---------------------------------------------------------------------------
// Small clock + sleep fakes to keep every test deterministic and fast.
// ---------------------------------------------------------------------------

function makeClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let cursor = startMs;
  return {
    now: () => cursor,
    advance: (ms) => { cursor += ms; },
  };
}

const READY_BODY = JSON.stringify({ known: true, ready: true });
const NOT_READY_BODY = JSON.stringify({ known: true, ready: false });

const BASE_OPTS: AwaitReadinessOpts = {
  baseUrl: 'http://127.0.0.1:65535',
  bootstrapToken: 'deadbeef' + '0'.repeat(56),
  deadlineMs: 5_000,
  pollIntervalMs: 100,
  perProbeTimeoutMs: 500,
};

/**
 * Build a fetchImpl that returns a scripted sequence of Response
 * fixtures. When the script runs out, throws — a well-written test
 * either terminates before then (via child exit / ready) or has a
 * bounded deadline that the fake clock crosses.
 */
function scriptFetch(responses: Array<() => Response | Promise<Response>>): typeof fetch {
  let i = 0;
  return (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    if (i >= responses.length) throw new Error(`fetch script exhausted after ${i} calls`);
    const step = responses[i++];
    return await step();
  }) as unknown as typeof fetch;
}

describe('Stage 3C-CI-RESET Part 2 Checkpoint A.2 — awaitAuthSeamReadiness classification', () => {
  it('R1: happy path — a 200 with `ready:true` returns { kind: "ready" }', async () => {
    const clock = makeClock();
    const outcome = await awaitAuthSeamReadiness(
      {
        fetchImpl: scriptFetch([() => new Response(READY_BODY, { status: 200 })]),
        probeChildExit: () => null,
        now: clock.now,
        sleep: async (ms) => { clock.advance(ms); },
      },
      BASE_OPTS,
    );
    expect(outcome.kind).toBe('ready');
    expect(authSeamOutcomeToShortReason(outcome)).toBe('authseam_ready');
  });

  it('R2: transient non-ready then ready — poller stays in the loop and reports ready', async () => {
    const clock = makeClock();
    const outcome = await awaitAuthSeamReadiness(
      {
        fetchImpl: scriptFetch([
          () => new Response(NOT_READY_BODY, { status: 200 }),
          () => new Response(NOT_READY_BODY, { status: 200 }),
          () => new Response(READY_BODY, { status: 200 }),
        ]),
        probeChildExit: () => null,
        now: clock.now,
        sleep: async (ms) => { clock.advance(ms); },
      },
      BASE_OPTS,
    );
    expect(outcome.kind).toBe('ready');
  });

  it('R3: child exits before readiness — classified as server_exited with the last observation attached', async () => {
    const clock = makeClock();
    let observed = 0;
    let exit: AuthSeamChildExit | null = null;
    const outcome = await awaitAuthSeamReadiness(
      {
        fetchImpl: scriptFetch([
          () => new Response('crash landing', { status: 500 }),
          // Second probe never runs — probeChildExit is checked
          // FIRST on the next iteration and observes the exit.
        ]),
        probeChildExit: () => {
          if (observed === 0) {
            observed++;
            return null; // alive at start of iteration 1
          }
          if (exit == null) exit = { exitCode: 137, signal: null };
          return exit;
        },
        now: clock.now,
        sleep: async (ms) => { clock.advance(ms); },
      },
      BASE_OPTS,
    );
    expect(outcome.kind).toBe('server_exited');
    if (outcome.kind !== 'server_exited') throw new Error('narrowing');
    expect(outcome.exit.exitCode).toBe(137);
    expect(outcome.lastObservation?.kind).toBe('http');
    const tag = authSeamOutcomeToShortReason(outcome);
    expect(tag).toMatch(/^authseam_server_exited:code=137,signal=null,last=http_500/);
  });

  it('R4: spawn error — reported as server_spawn_failed, not server_exited', async () => {
    const outcome = await awaitAuthSeamReadiness(
      {
        fetchImpl: scriptFetch([]),
        probeChildExit: () => ({ exitCode: null, signal: null, spawnError: 'spawn npx ENOENT' }),
      },
      BASE_OPTS,
    );
    expect(outcome.kind).toBe('server_spawn_failed');
    if (outcome.kind !== 'server_spawn_failed') throw new Error('narrowing');
    expect(outcome.error).toBe('spawn npx ENOENT');
    expect(authSeamOutcomeToShortReason(outcome)).toBe('authseam_server_spawn_failed:spawn npx ENOENT');
  });

  it('R5: deadline reached with only HTTP 500 responses — timeout with last=http_500', async () => {
    const clock = makeClock();
    const opts: AwaitReadinessOpts = { ...BASE_OPTS, deadlineMs: 300, pollIntervalMs: 100 };
    const outcome = await awaitAuthSeamReadiness(
      {
        fetchImpl: () => Promise.resolve(new Response('internal', { status: 500 })),
        probeChildExit: () => null,
        now: clock.now,
        sleep: async (ms) => { clock.advance(ms); },
      },
      opts,
    );
    expect(outcome.kind).toBe('readiness_timeout');
    if (outcome.kind !== 'readiness_timeout') throw new Error('narrowing');
    expect(outcome.lastObservation?.kind).toBe('http');
    const tag = authSeamOutcomeToShortReason(outcome);
    expect(tag).toMatch(/^authseam_readiness_timeout:last=http_500,elapsedMs=/);
  });

  it('R6: deadline reached with only transport errors — timeout with last=transport:...', async () => {
    const clock = makeClock();
    const opts: AwaitReadinessOpts = { ...BASE_OPTS, deadlineMs: 300, pollIntervalMs: 100 };
    const outcome = await awaitAuthSeamReadiness(
      {
        fetchImpl: () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:65535')),
        probeChildExit: () => null,
        now: clock.now,
        sleep: async (ms) => { clock.advance(ms); },
      },
      opts,
    );
    expect(outcome.kind).toBe('readiness_timeout');
    if (outcome.kind !== 'readiness_timeout') throw new Error('narrowing');
    expect(outcome.lastObservation?.kind).toBe('transport_error');
    const tag = authSeamOutcomeToShortReason(outcome);
    expect(tag).toMatch(/^authseam_readiness_timeout:last=transport:ECONNREFUSED/);
  });

  it('R7: 200 with malformed JSON on the very last allowed probe — timeout, last=invalid_json', async () => {
    const clock = makeClock();
    const opts: AwaitReadinessOpts = { ...BASE_OPTS, deadlineMs: 300, pollIntervalMs: 100 };
    const outcome = await awaitAuthSeamReadiness(
      {
        fetchImpl: () => Promise.resolve(new Response('<html>500</html>', { status: 200 })),
        probeChildExit: () => null,
        now: clock.now,
        sleep: async (ms) => { clock.advance(ms); },
      },
      opts,
    );
    expect(outcome.kind).toBe('readiness_timeout');
    if (outcome.kind !== 'readiness_timeout') throw new Error('narrowing');
    expect(outcome.lastObservation?.kind).toBe('invalid_json');
  });

  it('R8: 200 with valid JSON but wrong schema — timeout with last=contract:<path>', async () => {
    const clock = makeClock();
    const opts: AwaitReadinessOpts = { ...BASE_OPTS, deadlineMs: 300, pollIntervalMs: 100 };
    // `known` is required to be the literal `true` per
    // SystemReadinessResponseSchema. `false` here forces a Zod
    // contract mismatch on the union head — the exact drift signal
    // we want the classifier to surface.
    const outcome = await awaitAuthSeamReadiness(
      {
        fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ known: 'nope', ready: true }), { status: 200 })),
        probeChildExit: () => null,
        now: clock.now,
        sleep: async (ms) => { clock.advance(ms); },
      },
      opts,
    );
    expect(outcome.kind).toBe('readiness_timeout');
    if (outcome.kind !== 'readiness_timeout') throw new Error('narrowing');
    expect(outcome.lastObservation?.kind).toBe('contract_mismatch');
    if (outcome.lastObservation?.kind !== 'contract_mismatch') throw new Error('narrowing');
    // Path is 'known' — that is the exact field that drifted.
    expect(outcome.lastObservation.issuePath).toBe('known');
  });

  it('R9: deadline reached with only not_ready observations — timeout with last=not_ready(known=true)', async () => {
    const clock = makeClock();
    const opts: AwaitReadinessOpts = { ...BASE_OPTS, deadlineMs: 300, pollIntervalMs: 100 };
    const outcome = await awaitAuthSeamReadiness(
      {
        fetchImpl: () => Promise.resolve(new Response(NOT_READY_BODY, { status: 200 })),
        probeChildExit: () => null,
        now: clock.now,
        sleep: async (ms) => { clock.advance(ms); },
      },
      opts,
    );
    expect(outcome.kind).toBe('readiness_timeout');
    if (outcome.kind !== 'readiness_timeout') throw new Error('narrowing');
    const tag = authSeamOutcomeToShortReason(outcome);
    expect(tag).toContain('last=not_ready(known=true)');
  });

  it('R10: child exit tag surfaces both the signal AND the last observation', async () => {
    const outcome: AuthSeamReadinessOutcome = {
      kind: 'server_exited',
      exit: { exitCode: null, signal: 'SIGKILL' },
      lastObservation: { kind: 'contract_mismatch', issuePath: 'ready', issueMessage: 'Expected boolean' },
    };
    const tag = authSeamOutcomeToShortReason(outcome);
    expect(tag).toBe('authseam_server_exited:code=null,signal=SIGKILL,last=contract:ready');
  });
});

describe('Stage 3C-CI-RESET Part 2 Checkpoint A.2 — sanitizeForLog', () => {
  it('S1: redacts Bearer tokens', () => {
    const out = sanitizeForLog('Authorization: Bearer abc.def_ghi-jkl123~xyz+abc/def=xyz');
    expect(out).toBe('Authorization: Bearer <REDACTED>');
  });

  it('S2: redacts hex tokens ≥32 chars', () => {
    const out = sanitizeForLog('token=0123456789abcdef0123456789abcdef and short=abc123');
    expect(out).toBe('token=<HEX_REDACTED> and short=abc123');
  });

  it('S3: leaves ordinary text alone', () => {
    const out = sanitizeForLog('the server printed a helpful message');
    expect(out).toBe('the server printed a helpful message');
  });
});

describe('Stage 3C-CI-RESET Part 2 Checkpoint A.2 — stopAuthSeamServer teardown safety', () => {
  it('T1: undefined handle is a no-op (does not throw)', async () => {
    await expect(stopAuthSeamServer(undefined)).resolves.toBeUndefined();
  });

  it('T2: partially-initialized handle (child null, dbName null) is a safe no-op', async () => {
    // Cast: intentionally exercising the "beforeAll failed before
    // spawn" cleanup path — the handle has NO real dependencies.
    const emptyHandle = {
      child: null,
      spawnArgv: [],
      cwd: '',
      pid: null,
      port: null,
      baseUrl: null,
      bootstrapToken: null,
      redisNamespace: null,
      redisUrl: 'redis://127.0.0.1:6379',
      dbName: null,
      dbUrl: null,
      logsDir: null,
      serverLogPath: null,
      exit: null,
      readinessOutcome: null,
      stdoutTail: () => '',
      stderrTail: () => '',
    };
    await expect(stopAuthSeamServer(emptyHandle)).resolves.toBeUndefined();
  });
});

// Ensures the classification schema stays exhaustive — a new outcome
// tag added without a `authSeamOutcomeToShortReason` case falls through
// the switch and TypeScript catches it at compile time. This runtime
// test additionally proves each kind maps to a non-empty stable prefix.
describe('Stage 3C-CI-RESET Part 2 Checkpoint A.2 — outcome tag stability', () => {
  const SAMPLES: AuthSeamReadinessOutcome[] = [
    { kind: 'ready', elapsedMs: 123 },
    { kind: 'server_spawn_failed', error: 'spawn npx ENOENT' },
    { kind: 'server_exited', exit: { exitCode: 1, signal: null }, lastObservation: null },
    { kind: 'readiness_http', status: 502, sanitizedBody: 'bad gateway' },
    { kind: 'readiness_invalid_json', error: 'Unexpected token <', sanitizedBody: '<html>' },
    { kind: 'readiness_contract_mismatch', issuePath: 'ready', issueMessage: 'Required' },
    { kind: 'readiness_timeout', lastObservation: null, elapsedMs: 60_000 },
  ];
  const EXPECTED_PREFIXES = z.enum([
    'authseam_ready',
    'authseam_server_spawn_failed:',
    'authseam_server_exited:',
    'authseam_readiness_http:',
    'authseam_readiness_invalid_json:',
    'authseam_readiness_contract_mismatch:',
    'authseam_readiness_timeout:',
  ]).options;
  it('every terminal outcome maps to a stable prefix', () => {
    for (let i = 0; i < SAMPLES.length; i++) {
      const tag = authSeamOutcomeToShortReason(SAMPLES[i]);
      const prefix = EXPECTED_PREFIXES[i];
      expect(tag.startsWith(prefix), `sample ${SAMPLES[i].kind} → '${tag}' does not start with '${prefix}'`).toBe(true);
    }
  });
});
