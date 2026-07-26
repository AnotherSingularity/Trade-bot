/**
 * Stage 2 §18 — Append-only operator authentication events.
 *
 * Every material auth transition (setup / login-attempt / login-success
 * / refresh / logout / password-change / lockout / revocation / recovery)
 * inserts one row. The table has no UPDATE / DELETE path from
 * application code; append is enforced by the database schema (no
 * unique key that would force upsert, no application-side update
 * helper). Metadata is caller-sanitized — no raw secrets, no full
 * IPs (loopback marker only), no free-form message text.
 */

import { db } from '../db';
import { operatorAuthEvents } from '../db/schema';

export const AUTH_EVENT_TYPES = [
  'setup_completed',
  'login_success',
  'login_failure',
  'password_change_success',
  'password_change_failure',
  'session_refreshed',
  'session_refresh_reuse_detected',
  'session_lockedout',
  'session_expired_absolute',
  'session_idle_expired',
  'logout',
  'revoke_all',
  'lock',
  'account_locked_ratelimit',
  'recovery_requested',
  'recovery_performed',
  'bootstrap_rejected',
] as const;

export type AuthEventType = (typeof AUTH_EVENT_TYPES)[number];

export interface RecordAuthEventInput {
  eventType: AuthEventType;
  accountId?: number | null;
  sessionId?: number | null;
  installationId?: number | null;
  source: 'server_http' | 'server_internal' | 'cli' | 'test';
  reasonCode?: string | null;
  sanitizedMetadata?: Record<string, string | number | boolean | null> | null;
}

export async function recordAuthEvent(input: RecordAuthEventInput): Promise<void> {
  await db.insert(operatorAuthEvents).values({
    eventType: input.eventType,
    accountId: input.accountId ?? null,
    sessionId: input.sessionId ?? null,
    installationId: input.installationId ?? null,
    source: input.source,
    reasonCode: input.reasonCode ?? null,
    sanitizedMetadata: input.sanitizedMetadata ?? null,
  });
}
