/**
 * Stage 2 §13 — Operator authentication REST surface.
 *
 * Endpoints (all under `/api/auth`):
 *   POST /setup                  first-run: create the single operator account
 *   GET  /state                  bootstrap-safe: whether setup exists, whether locked
 *   POST /login                  { username, password } → issued token pair
 *   POST /refresh                { refreshToken }       → rotated token pair
 *   POST /logout                 current session — revoke this one
 *   POST /lock                   current session — mark idle (renderer forgets state)
 *   POST /change-password        current operator — rotate credential
 *   POST /revoke-all             current operator — revoke ALL sessions
 *   GET  /session                current session summary (sanitized)
 *
 * Bootstrap-safe endpoints (`/state` only) accept the bootstrap
 * token; the rest require an active operator session (`/setup` and
 * `/login` are unauthenticated but rate-limited by composite key).
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import * as accounts from '../auth/accounts';
import * as sessions from '../auth/sessions';
import * as limits from '../auth/loginLimits';
import { recordAuthEvent } from '../auth/events';
import { requireOperatorSession } from '../middleware/operatorSession';
import { requireBootstrapAuthorization } from '../middleware/bootstrapAuth';
import type { LocalOperatorAccountRow } from '../db/schema';

function sanitizeAccount(a: LocalOperatorAccountRow) {
  return {
    id: a.id,
    username: a.username,
    status: a.status,
    credentialVersion: a.credentialVersion,
    passwordChangedAt: a.passwordChangedAt.toISOString(),
  };
}

function issuedPairToDto(pair: sessions.IssuedTokenPair) {
  return {
    accessToken: pair.accessToken,
    accessExpiresAt: pair.accessExpiresAt.toISOString(),
    refreshToken: pair.refreshToken,
    refreshExpiresAt: pair.refreshExpiresAt.toISOString(),
    absoluteExpiresAt: pair.absoluteExpiresAt.toISOString(),
    sessionId: pair.sessionId,
  };
}

const setupBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  passwordConfirmation: z.string().min(1).max(256),
});

const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  installationId: z.union([z.number().int(), z.string().max(64)]).optional(),
  clientVersion: z.string().max(64).optional(),
});

const refreshBody = z.object({
  refreshToken: z.string().min(1).max(256),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
  newPasswordConfirmation: z.string().min(1).max(256),
});

export function operatorAuthRouter(): Router {
  const router = Router();

  router.get('/state', requireBootstrapAuthorization, async (_req: Request, res: Response) => {
    const exists = await accounts.accountsExist();
    res.json({
      known: true,
      setupCompleted: exists,
      timestamp: new Date().toISOString(),
    });
  });

  router.post('/setup', async (req: Request, res: Response) => {
    const parsed = setupBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', detail: parsed.error.issues[0]?.message });
      return;
    }
    const result = await accounts.setupInitialAccount(parsed.data);
    if (!result.ok) {
      await recordAuthEvent({
        eventType: 'password_change_failure',
        source: 'server_http',
        reasonCode: result.reason,
      });
      const status = result.reason === 'accounts_already_exist' ? 409 : 400;
      res.status(status).json({ error: result.reason, detail: result.detail });
      return;
    }
    await recordAuthEvent({
      eventType: 'setup_completed',
      accountId: result.account.id,
      source: 'server_http',
    });
    res.status(201).json({ account: sanitizeAccount(result.account) });
  });

  router.post('/login', async (req: Request, res: Response) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', detail: parsed.error.issues[0]?.message });
      return;
    }
    const { username, password, installationId, clientVersion } = parsed.data;
    const rate = await limits.checkRate({ username, installationId: installationId ?? null });
    if (!rate.allowed) {
      await recordAuthEvent({
        eventType: 'account_locked_ratelimit',
        source: 'server_http',
        reasonCode: rate.reason,
        sanitizedMetadata: { lockedUntil: rate.lockedUntil ?? null },
      });
      res.status(429).json({
        error: 'rate_limited',
        reason: rate.reason,
        lockedUntil: rate.lockedUntil,
        failedAttempts: rate.failedAttempts,
      });
      return;
    }
    const verified = await accounts.verifyCredentials(username, password);
    if (!verified.ok) {
      await limits.recordFailure({ username, installationId: installationId ?? null });
      await recordAuthEvent({
        eventType: 'login_failure',
        source: 'server_http',
        reasonCode: verified.reason,
      });
      const status = verified.reason === 'locked' || verified.reason === 'disabled' ? 423 : 401;
      res.status(status).json({ error: 'login_failed', reason: verified.reason });
      return;
    }
    await limits.recordSuccess({ username, installationId: installationId ?? null });
    await accounts.markLoginSucceeded(verified.account.id);
    const pair = await sessions.createSession({
      accountId: verified.account.id,
      installationId: typeof installationId === 'number' ? installationId : null,
      clientVersion: clientVersion ?? null,
    });
    await recordAuthEvent({
      eventType: 'login_success',
      accountId: verified.account.id,
      sessionId: pair.sessionId,
      installationId: typeof installationId === 'number' ? installationId : null,
      source: 'server_http',
    });
    res.status(200).json({
      account: sanitizeAccount(verified.account),
      tokens: issuedPairToDto(pair),
    });
  });

  router.post('/refresh', async (req: Request, res: Response) => {
    const parsed = refreshBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    const result = await sessions.refreshSession(parsed.data.refreshToken);
    if (!result.ok) {
      await recordAuthEvent({
        eventType:
          result.reason === 'already_rotated_family_revoked'
            ? 'session_refresh_reuse_detected'
            : 'session_refreshed',
        source: 'server_http',
        reasonCode: result.reason,
      });
      const status = result.reason === 'already_rotated_family_revoked' ? 401 : 401;
      res.status(status).json({ error: 'refresh_failed', reason: result.reason });
      return;
    }
    await recordAuthEvent({
      eventType: 'session_refreshed',
      sessionId: result.pair.sessionId,
      source: 'server_http',
    });
    res.json({ tokens: issuedPairToDto(result.pair) });
  });

  router.post('/logout', requireOperatorSession, async (req: Request, res: Response) => {
    if (!req.operator) return void res.status(401).json({ error: 'unauthorized' });
    await sessions.revokeSession(req.operator.session.id, 'operator_logout');
    await recordAuthEvent({
      eventType: 'logout',
      accountId: req.operator.account.id,
      sessionId: req.operator.session.id,
      source: 'server_http',
    });
    res.status(204).end();
  });

  router.post('/lock', requireOperatorSession, async (req: Request, res: Response) => {
    if (!req.operator) return void res.status(401).json({ error: 'unauthorized' });
    // Server-side lock is a family-scoped revoke of the current session only;
    // the desktop must forget its cached SanitizedAuthState.
    await sessions.revokeSession(req.operator.session.id, 'operator_lock');
    await recordAuthEvent({
      eventType: 'lock',
      accountId: req.operator.account.id,
      sessionId: req.operator.session.id,
      source: 'server_http',
    });
    res.status(204).end();
  });

  router.post('/change-password', requireOperatorSession, async (req: Request, res: Response) => {
    if (!req.operator) return void res.status(401).json({ error: 'unauthorized' });
    const parsed = changePasswordBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    const result = await accounts.changePassword({
      accountId: req.operator.account.id,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
      newPasswordConfirmation: parsed.data.newPasswordConfirmation,
    });
    if (!result.ok) {
      await recordAuthEvent({
        eventType: 'password_change_failure',
        accountId: req.operator.account.id,
        source: 'server_http',
        reasonCode: result.reason,
      });
      res.status(400).json({ error: 'password_change_failed', reason: result.reason, detail: result.detail });
      return;
    }
    // Successful password change revokes every existing session.
    await sessions.revokeAllForAccount(req.operator.account.id, 'password_changed');
    await recordAuthEvent({
      eventType: 'password_change_success',
      accountId: req.operator.account.id,
      source: 'server_http',
    });
    res.status(200).json({ ok: true });
  });

  router.post('/revoke-all', requireOperatorSession, async (req: Request, res: Response) => {
    if (!req.operator) return void res.status(401).json({ error: 'unauthorized' });
    await sessions.revokeAllForAccount(req.operator.account.id, 'revoke_all');
    await recordAuthEvent({
      eventType: 'revoke_all',
      accountId: req.operator.account.id,
      source: 'server_http',
    });
    res.status(204).end();
  });

  router.get('/session', requireOperatorSession, (req: Request, res: Response) => {
    if (!req.operator) return void res.status(401).json({ error: 'unauthorized' });
    const s = req.operator.session;
    res.json({
      account: sanitizeAccount(req.operator.account),
      session: {
        id: s.id,
        sessionFamilyId: s.sessionFamilyId,
        accessExpiresAt: s.accessExpiresAt.toISOString(),
        refreshExpiresAt: s.refreshExpiresAt.toISOString(),
        absoluteExpiresAt: s.absoluteExpiresAt.toISOString(),
        lastUsedAt: s.lastUsedAt ? s.lastUsedAt.toISOString() : null,
      },
    });
  });

  return router;
}
