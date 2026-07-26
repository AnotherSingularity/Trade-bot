/**
 * Stage 2 §11 — Bootstrap authorization middleware.
 *
 * Applied to endpoints whose sole trust anchor is the bootstrap token
 * (readiness, counters, scanner-readiness, reconciliation status).
 * Access requires BOTH:
 *   1. Loopback origin (127.0.0.1 / ::1).
 *   2. Valid `X-Horizon-Bootstrap-Token` header (constant-time verified).
 *
 * When the token env is unset, requests are refused with 503 — the
 * server refuses to boot in production without a token; test setups
 * either configure a token or hit routes that use the alternate
 * `requireEither` middleware.
 */

import type { NextFunction, Request, Response } from 'express';
import { BOOTSTRAP_HEADER, isBootstrapConfigured, verifyBootstrapToken } from '../auth/bootstrap';
import { recordAuthEvent } from '../auth/events';

function isLoopback(req: Request): boolean {
  const ip = String(req.ip ?? req.socket.remoteAddress ?? '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.endsWith('127.0.0.1');
}

export function requireBootstrapAuthorization(req: Request, res: Response, next: NextFunction): void {
  if (!isLoopback(req)) {
    res.status(403).json({ error: 'bootstrap_endpoint_is_localhost_only' });
    return;
  }
  if (!isBootstrapConfigured()) {
    res.status(503).json({ error: 'bootstrap_channel_not_configured' });
    return;
  }
  const header = req.header(BOOTSTRAP_HEADER);
  if (!verifyBootstrapToken(header)) {
    void recordAuthEvent({
      eventType: 'bootstrap_rejected',
      source: 'server_http',
      reasonCode: header ? 'header_mismatch' : 'header_missing',
      sanitizedMetadata: { path: req.path.slice(0, 128), method: req.method },
    }).catch(() => { /* best-effort audit */ });
    res.status(401).json({ error: 'bootstrap_token_required' });
    return;
  }
  next();
}
