/**
 * Stage 2 §11 — Operator session middleware.
 *
 * Verifies a bearer access token against `operator_auth_sessions`.
 * Populates `req.operator` with the account row + session row on
 * success. On failure the request is rejected with 401 and a reason
 * code — auth failures NEVER fall back to anonymous access.
 *
 * Also exports `requireEitherBootstrapOrOperatorSession` for endpoints
 * that are legitimately reachable both by the desktop supervisor
 * during boot AND by an authenticated operator.
 */

import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../auth/sessions';
import { findById as findAccountById } from '../auth/accounts';
import { BOOTSTRAP_HEADER, isBootstrapConfigured, verifyBootstrapToken } from '../auth/bootstrap';
import type { LocalOperatorAccountRow, OperatorAuthSessionRow } from '../db/schema';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      operator?: { account: LocalOperatorAccountRow; session: OperatorAuthSessionRow };
    }
  }
}

function extractBearer(req: Request): string | undefined {
  const h = req.header('authorization') || req.header('Authorization');
  if (!h) return undefined;
  if (!h.startsWith('Bearer ')) return undefined;
  return h.slice('Bearer '.length).trim() || undefined;
}

function isLoopback(req: Request): boolean {
  const ip = String(req.ip ?? req.socket.remoteAddress ?? '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.endsWith('127.0.0.1');
}

export async function requireOperatorSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractBearer(req);
  const result = await verifyAccessToken(token ?? '');
  if (!result.ok) {
    res.status(401).json({ error: 'unauthorized', reason: result.reason });
    return;
  }
  const account = await findAccountById(result.row.accountId);
  if (!account || account.status !== 'active') {
    res.status(401).json({ error: 'unauthorized', reason: 'account_not_active' });
    return;
  }
  req.operator = { account, session: result.row };
  next();
}

export function requireEitherBootstrapOrOperatorSession(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Bootstrap path first (loopback + token).
  if (isLoopback(req) && isBootstrapConfigured()) {
    const header = req.header(BOOTSTRAP_HEADER);
    if (verifyBootstrapToken(header)) {
      next();
      return;
    }
  }
  // Fall back to operator session.
  void requireOperatorSession(req, res, next);
}
