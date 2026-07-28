/**
 * Stage 3C-CI-RESET Part 2 Checkpoint D.1 — server-side native
 * induction controller. Test-only. Mounted ONLY when
 * decideNativeInductionPolicy returns allowed=true.
 *
 * Endpoints (all under /api/native-induction, all require
 * bootstrap-token authorization):
 *
 *   POST /activate  body: {mode, routeKey, nonce, ttlMs?}
 *     - policy check
 *     - reject if another induction is already active
 *     - set the singleton state; auto-expire after ttlMs (default 60s)
 *
 *   POST /clear     body: {nonce}
 *     - nonce must match the active induction's nonce
 *     - inactive state after
 *
 *   GET /state
 *     - returns {kind:'inactive'} or {kind:'active', mode, routeKey, ...}
 *     - NEVER returns the nonce
 *
 * The induction state is a MODULE-SCOPED singleton on this process.
 * A restart of the server child clears it; the harness must
 * re-activate.
 */

import { Router, type Request, type Response } from 'express';
import {
  NativeInductionActivateRequestSchema,
  NativeInductionClearRequestSchema,
  decideNativeInductionPolicy,
  type NativeInductionMode,
  type NativeInductionRouteKey,
  type NativeInductionState,
} from '@horizon/shared';
import { ENV } from '../env';
import { requireBootstrapAuthorization } from '../middleware/bootstrapAuth';

// ---------------------------------------------------------------------------
// Singleton state + auto-expire
// ---------------------------------------------------------------------------

interface ActiveInductionRecord {
  readonly mode: NativeInductionMode;
  readonly routeKey: NativeInductionRouteKey;
  readonly nonce: string;
  readonly activatedAt: string;
  readonly expiresAt: string;
  readonly expiryTimer: NodeJS.Timeout;
}

let active: ActiveInductionRecord | null = null;

function clearActiveIfExpired(): void {
  if (active && Date.parse(active.expiresAt) <= Date.now()) {
    clearTimeout(active.expiryTimer);
    active = null;
  }
}

/**
 * Called by an allowlisted route handler at request time. Returns
 * the active induction ONLY if the routeKey matches and the record
 * has not expired. Never leaks the nonce.
 */
export function readActiveInductionFor(routeKey: NativeInductionRouteKey): {
  mode: NativeInductionMode;
  routeKey: NativeInductionRouteKey;
} | null {
  clearActiveIfExpired();
  if (active == null) return null;
  if (active.routeKey !== routeKey) return null;
  return { mode: active.mode, routeKey: active.routeKey };
}

/**
 * Called from teardown / tests. Force-clears regardless of nonce.
 * Not exposed via HTTP.
 */
export function _testResetNativeInduction(): void {
  if (active) {
    clearTimeout(active.expiryTimer);
    active = null;
  }
}

// ---------------------------------------------------------------------------
// HTTP router (only mounted when policy allows)
// ---------------------------------------------------------------------------

function projectState(): NativeInductionState {
  clearActiveIfExpired();
  if (active == null) return { kind: 'inactive' };
  return {
    kind: 'active',
    mode: active.mode,
    routeKey: active.routeKey,
    activatedAt: active.activatedAt,
    expiresAt: active.expiresAt,
  };
}

function policyGate(_req: Request, res: Response): boolean {
  const decision = decideNativeInductionPolicy({
    nodeEnv: process.env.NODE_ENV,
    nativeDiagnostics: process.env.HORIZON_NATIVE_DIAGNOSTICS,
    serverExternal: process.env.HORIZON_SERVER_EXTERNAL,
    // isPackaged: server is never packaged the way Electron main is;
    // the presence of NODE_ENV=test + diagnostics flags is a proxy.
    isPackaged: false,
  });
  if (!decision.allowed) {
    res.status(403).json({ ok: false, error: decision.reason });
    return false;
  }
  return true;
}

export function nativeInductionRouter(): Router {
  const r = Router();
  // Every request also requires the bootstrap token — the harness
  // already owns this authority. Non-loopback / bad-token → 403.
  r.use(requireBootstrapAuthorization);

  r.post('/activate', (req: Request, res: Response) => {
    if (!policyGate(req, res)) return;
    const parse = NativeInductionActivateRequestSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ ok: false, error: 'invalid_body', detail: parse.error.issues.slice(0, 3).map((i) => i.path.join('.') + ':' + i.message).join('; ') });
      return;
    }
    clearActiveIfExpired();
    if (active != null) {
      res.status(409).json({ ok: false, error: 'mode_conflict_already_active' });
      return;
    }
    const { mode, routeKey, nonce, ttlMs } = parse.data;
    const ttl = ttlMs ?? 60_000;
    const activatedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttl).toISOString();
    const timer = setTimeout(() => {
      // Auto-expire.
      if (active && active.nonce === nonce) active = null;
    }, ttl);
    // Detach timer from event loop so tests don't hang.
    timer.unref?.();
    active = { mode, routeKey, nonce, activatedAt, expiresAt, expiryTimer: timer };
    res.status(202).json({ ok: true, state: projectState() });
  });

  r.post('/clear', (req: Request, res: Response) => {
    if (!policyGate(req, res)) return;
    const parse = NativeInductionClearRequestSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ ok: false, error: 'invalid_body' });
      return;
    }
    clearActiveIfExpired();
    if (active == null) {
      // No-op OK — nothing was active.
      res.status(200).json({ ok: true, state: projectState() });
      return;
    }
    if (active.nonce !== parse.data.nonce) {
      res.status(403).json({ ok: false, error: 'nonce_mismatch' });
      return;
    }
    clearTimeout(active.expiryTimer);
    active = null;
    res.status(200).json({ ok: true, state: projectState() });
  });

  r.get('/state', (req: Request, res: Response) => {
    if (!policyGate(req, res)) return;
    res.status(200).json({ ok: true, state: projectState() });
  });

  return r;
}

/**
 * Called from index.ts at boot time to decide whether the induction
 * route should even be mounted. Mirrors `policyGate` but at
 * request-independent scope.
 */
export function shouldMountNativeInduction(): boolean {
  return decideNativeInductionPolicy({
    nodeEnv: ENV.nodeEnv,
    nativeDiagnostics: process.env.HORIZON_NATIVE_DIAGNOSTICS,
    serverExternal: process.env.HORIZON_SERVER_EXTERNAL,
    isPackaged: false,
  }).allowed;
}
