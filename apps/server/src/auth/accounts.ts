/**
 * Stage 2 §4 — Local administrator accounts.
 *
 * Single-operator boundary — one active account is expected. Additional
 * accounts remain possible (for hand-off) but no self-service signup
 * exists; setup is a first-run flow that only succeeds when zero
 * accounts exist. All authenticate paths route through this module.
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import {
  localOperatorAccounts,
  type LocalOperatorAccountRow,
  type OperatorAccountStatus,
} from '../db/schema';
import {
  DEFAULT_SCRYPT_PARAMETERS,
  hashPassword,
  PASSWORD_ALGORITHM,
  verifyPassword,
  validatePassword,
} from './passwords';
import { normalizeUsername } from './loginLimits';

const USERNAME_MIN = 3;
const USERNAME_MAX = 64;
const USERNAME_ALLOWED = /^[A-Za-z0-9_.-]+$/;

export interface CreateAccountResult {
  ok: true;
  account: LocalOperatorAccountRow;
}

export interface CreateAccountFailure {
  ok: false;
  reason:
    | 'username_invalid'
    | 'username_taken'
    | 'password_policy_violation'
    | 'password_mismatch'
    | 'accounts_already_exist';
  detail: string;
}

export async function accountsExist(): Promise<boolean> {
  const rows = await db.select({ id: localOperatorAccounts.id }).from(localOperatorAccounts).limit(1);
  return rows.length > 0;
}

export async function findByUsername(username: string): Promise<LocalOperatorAccountRow | null> {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;
  const rows = await db
    .select()
    .from(localOperatorAccounts)
    .where(eq(localOperatorAccounts.usernameNormalized, normalized))
    .limit(1);
  return rows[0] ?? null;
}

export async function findById(id: number): Promise<LocalOperatorAccountRow | null> {
  const rows = await db.select().from(localOperatorAccounts).where(eq(localOperatorAccounts.id, id)).limit(1);
  return rows[0] ?? null;
}

export interface SetupAccountInput {
  username: string;
  password: string;
  passwordConfirmation: string;
}

/** First-run setup — succeeds only when zero accounts exist. */
export async function setupInitialAccount(
  input: SetupAccountInput,
): Promise<CreateAccountResult | CreateAccountFailure> {
  if (await accountsExist()) {
    return { ok: false, reason: 'accounts_already_exist', detail: 'setup already completed' };
  }
  const normalized = normalizeUsername(input.username);
  if (!normalized) {
    return { ok: false, reason: 'username_invalid', detail: 'username may not be empty' };
  }
  if (normalized.length < USERNAME_MIN || normalized.length > USERNAME_MAX) {
    return {
      ok: false,
      reason: 'username_invalid',
      detail: `username length must be between ${USERNAME_MIN} and ${USERNAME_MAX}`,
    };
  }
  if (!USERNAME_ALLOWED.test(normalized)) {
    return {
      ok: false,
      reason: 'username_invalid',
      detail: 'username may only contain letters, digits, underscore, dot, or hyphen',
    };
  }
  if (input.password !== input.passwordConfirmation) {
    return { ok: false, reason: 'password_mismatch', detail: 'password confirmation does not match' };
  }
  const pw = validatePassword(input.password, { username: normalized });
  if (pw) return { ok: false, reason: 'password_policy_violation', detail: pw.detail };

  const existing = await findByUsername(input.username);
  if (existing) return { ok: false, reason: 'username_taken', detail: 'username already in use' };

  const now = new Date();
  const hashed = await hashPassword(input.password);
  const [{ insertId }] = (await db
    .insert(localOperatorAccounts)
    .values({
      username: input.username.trim(),
      usernameNormalized: normalized,
      passwordHashHex: hashed.hashHex,
      passwordSaltHex: hashed.saltHex,
      passwordAlgorithm: hashed.algorithm,
      passwordParameters: hashed.parameters as unknown as Record<string, unknown>,
      credentialVersion: 1,
      status: 'active',
      passwordChangedAt: now,
    })) as unknown as { insertId: number }[];
  const account = await findById(Number(insertId));
  if (!account) throw new Error(`setupInitialAccount: could not read inserted account id=${String(insertId)}`);
  return { ok: true, account };
}

export type VerifyCredentialsResult =
  | { ok: true; account: LocalOperatorAccountRow }
  | { ok: false; reason: 'not_found' | 'disabled' | 'locked' | 'recovery_required' | 'password_mismatch' };

export async function verifyCredentials(
  username: string,
  password: string,
  now: Date = new Date(),
): Promise<VerifyCredentialsResult> {
  const account = await findByUsername(username);
  if (!account) return { ok: false, reason: 'not_found' };
  if (account.status === 'disabled') return { ok: false, reason: 'disabled' };
  if (account.status === 'recovery_required') return { ok: false, reason: 'recovery_required' };
  if (account.status === 'locked' || (account.lockedUntil && account.lockedUntil > now)) {
    return { ok: false, reason: 'locked' };
  }
  const ok = await verifyPassword(password, {
    algorithm: account.passwordAlgorithm,
    parameters: account.passwordParameters as unknown as {
      N: number; r: number; p: number; keyLength: number;
    },
    saltHex: account.passwordSaltHex,
    hashHex: account.passwordHashHex,
  });
  if (!ok) return { ok: false, reason: 'password_mismatch' };
  return { ok: true, account };
}

export async function markLoginFailed(accountId: number, lockThreshold = 5, lockMinutes = 15): Promise<void> {
  const now = new Date();
  const account = await findById(accountId);
  if (!account) return;
  const nextFailed = account.failedLoginCount + 1;
  const lockedUntil = nextFailed >= lockThreshold ? new Date(now.getTime() + lockMinutes * 60_000) : null;
  await db
    .update(localOperatorAccounts)
    .set({ failedLoginCount: nextFailed, lockedUntil })
    .where(eq(localOperatorAccounts.id, accountId));
}

export async function markLoginSucceeded(accountId: number): Promise<void> {
  await db
    .update(localOperatorAccounts)
    .set({ failedLoginCount: 0, lockedUntil: null })
    .where(eq(localOperatorAccounts.id, accountId));
}

export interface ChangePasswordInput {
  accountId: number;
  currentPassword: string;
  newPassword: string;
  newPasswordConfirmation: string;
}

export type ChangePasswordResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'current_password_mismatch'
        | 'password_mismatch'
        | 'password_policy_violation';
      detail?: string;
    };

export async function changePassword(input: ChangePasswordInput): Promise<ChangePasswordResult> {
  const account = await findById(input.accountId);
  if (!account) return { ok: false, reason: 'not_found' };
  const verified = await verifyPassword(input.currentPassword, {
    algorithm: account.passwordAlgorithm,
    parameters: account.passwordParameters as unknown as {
      N: number; r: number; p: number; keyLength: number;
    },
    saltHex: account.passwordSaltHex,
    hashHex: account.passwordHashHex,
  });
  if (!verified) return { ok: false, reason: 'current_password_mismatch' };
  if (input.newPassword !== input.newPasswordConfirmation) {
    return { ok: false, reason: 'password_mismatch', detail: 'confirmation does not match' };
  }
  const pw = validatePassword(input.newPassword, { username: account.usernameNormalized });
  if (pw) return { ok: false, reason: 'password_policy_violation', detail: pw.detail };
  const hashed = await hashPassword(input.newPassword, DEFAULT_SCRYPT_PARAMETERS);
  await db
    .update(localOperatorAccounts)
    .set({
      passwordHashHex: hashed.hashHex,
      passwordSaltHex: hashed.saltHex,
      passwordAlgorithm: hashed.algorithm,
      passwordParameters: hashed.parameters as unknown as Record<string, unknown>,
      credentialVersion: account.credentialVersion + 1,
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
      status: 'active',
    })
    .where(eq(localOperatorAccounts.id, input.accountId));
  return { ok: true };
}

export async function setStatus(accountId: number, status: OperatorAccountStatus): Promise<void> {
  await db.update(localOperatorAccounts).set({ status }).where(eq(localOperatorAccounts.id, accountId));
}

export async function forcePasswordReset(
  accountId: number,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'password_policy_violation'; detail?: string }> {
  const account = await findById(accountId);
  if (!account) return { ok: false, reason: 'not_found' };
  const pw = validatePassword(newPassword, { username: account.usernameNormalized });
  if (pw) return { ok: false, reason: 'password_policy_violation', detail: pw.detail };
  const hashed = await hashPassword(newPassword);
  await db
    .update(localOperatorAccounts)
    .set({
      passwordHashHex: hashed.hashHex,
      passwordSaltHex: hashed.saltHex,
      passwordAlgorithm: hashed.algorithm,
      passwordParameters: hashed.parameters as unknown as Record<string, unknown>,
      credentialVersion: account.credentialVersion + 1,
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
      status: 'active',
    })
    .where(eq(localOperatorAccounts.id, accountId));
  return { ok: true };
}

export async function currentAlgorithmMatchesDefault(account: LocalOperatorAccountRow): Promise<boolean> {
  if (account.passwordAlgorithm !== PASSWORD_ALGORITHM) return false;
  const params = account.passwordParameters as unknown as { N?: number; r?: number; p?: number; keyLength?: number };
  return (
    params?.N === DEFAULT_SCRYPT_PARAMETERS.N &&
    params?.r === DEFAULT_SCRYPT_PARAMETERS.r &&
    params?.p === DEFAULT_SCRYPT_PARAMETERS.p &&
    params?.keyLength === DEFAULT_SCRYPT_PARAMETERS.keyLength
  );
}

export async function anyLockedAccount(): Promise<boolean> {
  const rows = await db
    .select({ id: localOperatorAccounts.id })
    .from(localOperatorAccounts)
    .where(and(eq(localOperatorAccounts.status, 'locked'), isNotNull(localOperatorAccounts.id)))
    .limit(1);
  return rows.length > 0;
}
