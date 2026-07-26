/**
 * Stage 2 §7 — Session model.
 *
 * Access token:      15 minutes  (short-lived; header-bearer, hashed at rest)
 * Refresh token:      7 days     (rotated on every refresh; family invalidation on reuse)
 * Absolute expiry:   30 days     (session family cannot outlive this from creation)
 * Idle window:       30 minutes  (lastUsedAt-driven inactivity gate; enforced by refresh)
 *
 * Server issues opaque high-entropy tokens (not JWTs). Only the sha-256
 * hash is stored. The plaintext is returned to the desktop's main process
 * once — the renderer must never see it.
 *
 * Family rotation invariant: every refresh rotates BOTH tokens and
 * marks the parent as `rotated`. If the same refresh token is presented
 * twice (reuse), the entire family is revoked immediately — a signal
 * of theft.
 */

import { randomBytes, createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { operatorAuthSessions, type OperatorAuthSessionRow } from '../db/schema';

export const ACCESS_TTL_MS = 15 * 60_000;
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60_000;
export const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60_000;
export const IDLE_TIMEOUT_MS = 30 * 60_000;

function makeToken(): string {
  return randomBytes(48).toString('base64url');
}

function hashToken(t: string): string {
  return createHash('sha256').update(t, 'utf8').digest('hex');
}

function uuidV4(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface IssuedTokenPair {
  sessionId: number;
  sessionFamilyId: string;
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface CreateSessionInput {
  accountId: number;
  installationId?: number | null;
  clientVersion?: string | null;
  now?: Date;
}

export async function createSession(input: CreateSessionInput): Promise<IssuedTokenPair> {
  const now = input.now ?? new Date();
  const familyId = uuidV4();
  const accessToken = makeToken();
  const refreshToken = makeToken();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_TTL_MS);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TTL_MS);
  const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_TTL_MS);
  const [{ insertId }] = (await db.insert(operatorAuthSessions).values({
    accountId: input.accountId,
    installationId: input.installationId ?? null,
    sessionFamilyId: familyId,
    accessTokenHash: hashToken(accessToken),
    refreshTokenHash: hashToken(refreshToken),
    accessExpiresAt,
    refreshExpiresAt,
    absoluteExpiresAt,
    createdAt: now,
    clientVersion: input.clientVersion ?? null,
  })) as unknown as { insertId: number }[];
  return {
    sessionId: Number(insertId),
    sessionFamilyId: familyId,
    accessToken,
    accessExpiresAt,
    refreshToken,
    refreshExpiresAt,
    absoluteExpiresAt,
  };
}

export type VerifyAccessResult =
  | { ok: true; row: OperatorAuthSessionRow }
  | { ok: false; reason: 'unknown' | 'revoked' | 'access_expired' | 'absolute_expired' | 'idle_expired' };

export async function verifyAccessToken(rawToken: string, now: Date = new Date()): Promise<VerifyAccessResult> {
  if (!rawToken) return { ok: false, reason: 'unknown' };
  const rows = await db
    .select()
    .from(operatorAuthSessions)
    .where(eq(operatorAuthSessions.accessTokenHash, hashToken(rawToken)))
    .limit(1);
  if (rows.length === 0) return { ok: false, reason: 'unknown' };
  const row = rows[0];
  if (row.revokedAt) return { ok: false, reason: 'revoked' };
  if (row.absoluteExpiresAt <= now) return { ok: false, reason: 'absolute_expired' };
  if (row.accessExpiresAt <= now) return { ok: false, reason: 'access_expired' };
  if (row.lastUsedAt && now.getTime() - row.lastUsedAt.getTime() > IDLE_TIMEOUT_MS) {
    return { ok: false, reason: 'idle_expired' };
  }
  await db
    .update(operatorAuthSessions)
    .set({ lastUsedAt: now })
    .where(eq(operatorAuthSessions.id, row.id));
  return { ok: true, row };
}

export type RefreshResult =
  | { ok: true; pair: IssuedTokenPair }
  | {
      ok: false;
      reason:
        | 'unknown'
        | 'already_rotated_family_revoked'
        | 'refresh_expired'
        | 'absolute_expired'
        | 'family_revoked';
    };

export async function refreshSession(rawRefreshToken: string, now: Date = new Date()): Promise<RefreshResult> {
  if (!rawRefreshToken) return { ok: false, reason: 'unknown' };
  const hash = hashToken(rawRefreshToken);
  const rows = await db
    .select()
    .from(operatorAuthSessions)
    .where(eq(operatorAuthSessions.refreshTokenHash, hash))
    .limit(1);
  if (rows.length === 0) return { ok: false, reason: 'unknown' };
  const parent = rows[0];

  const alreadyRotated = await db
    .select()
    .from(operatorAuthSessions)
    .where(eq(operatorAuthSessions.rotatedFromTokenId, parent.id))
    .limit(1);
  if (alreadyRotated.length > 0) {
    await revokeFamily(parent.sessionFamilyId, 'refresh_reuse_detected', now);
    return { ok: false, reason: 'already_rotated_family_revoked' };
  }
  if (parent.revokedAt) return { ok: false, reason: 'family_revoked' };
  if (parent.absoluteExpiresAt <= now) return { ok: false, reason: 'absolute_expired' };
  if (parent.refreshExpiresAt <= now) return { ok: false, reason: 'refresh_expired' };

  const accessToken = makeToken();
  const refreshToken = makeToken();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_TTL_MS);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TTL_MS);
  const [{ insertId }] = (await db.insert(operatorAuthSessions).values({
    accountId: parent.accountId,
    installationId: parent.installationId,
    sessionFamilyId: parent.sessionFamilyId,
    accessTokenHash: hashToken(accessToken),
    refreshTokenHash: hashToken(refreshToken),
    accessExpiresAt,
    refreshExpiresAt,
    absoluteExpiresAt: parent.absoluteExpiresAt,
    createdAt: now,
    rotatedFromTokenId: parent.id,
    clientVersion: parent.clientVersion,
  })) as unknown as { insertId: number }[];
  await db
    .update(operatorAuthSessions)
    .set({ revokedAt: now, revocationReason: 'rotated' })
    .where(eq(operatorAuthSessions.id, parent.id));
  return {
    ok: true,
    pair: {
      sessionId: Number(insertId),
      sessionFamilyId: parent.sessionFamilyId,
      accessToken,
      accessExpiresAt,
      refreshToken,
      refreshExpiresAt,
      absoluteExpiresAt: parent.absoluteExpiresAt,
    },
  };
}

export async function revokeSession(sessionId: number, reason: string, now: Date = new Date()): Promise<void> {
  await db
    .update(operatorAuthSessions)
    .set({ revokedAt: now, revocationReason: reason })
    .where(and(eq(operatorAuthSessions.id, sessionId), isNull(operatorAuthSessions.revokedAt)));
}

export async function revokeFamily(familyId: string, reason: string, now: Date = new Date()): Promise<void> {
  await db
    .update(operatorAuthSessions)
    .set({ revokedAt: now, revocationReason: reason })
    .where(and(eq(operatorAuthSessions.sessionFamilyId, familyId), isNull(operatorAuthSessions.revokedAt)));
}

export async function revokeAllForAccount(accountId: number, reason: string, now: Date = new Date()): Promise<void> {
  await db
    .update(operatorAuthSessions)
    .set({ revokedAt: now, revocationReason: reason })
    .where(and(eq(operatorAuthSessions.accountId, accountId), isNull(operatorAuthSessions.revokedAt)));
}

export async function countActiveSessions(accountId: number, now: Date = new Date()): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS n
    FROM operator_auth_sessions
    WHERE accountId = ${accountId}
      AND revokedAt IS NULL
      AND accessExpiresAt > ${now}
      AND absoluteExpiresAt > ${now}
  `);
  const n = Number(
    (rows as unknown as Array<Array<{ n: number }>>)[0]?.[0]?.n ??
      (rows as unknown as Array<{ n: number }>)[0]?.n ??
      0,
  );
  return n;
}
