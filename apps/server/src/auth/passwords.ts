/**
 * Stage 2 §5 — Password hashing policy (versioned).
 *
 * Uses Node's builtin `scrypt` (memory-hard KDF). Algorithm + parameters
 * are stored on every account row so a future upgrade can rehash on
 * next successful login without invalidating existing credentials.
 *
 * Policy:
 *   - Minimum length: 14 characters. No composition rules — length +
 *     entropy is what actually matters.
 *   - Rejected placeholders: obvious weak strings that operators
 *     historically type when frustrated with policies.
 *   - Every hash is per-account salted (32 random bytes) — no shared
 *     salt, no rainbow-table exposure.
 *   - Comparison is `timingSafeEqual` on the raw derived-key buffer.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  pwd: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

function paramNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function scryptMaxmem(N: number, r: number): number {
  // scrypt's default is 32MB; N=16384,r=8 needs ~16MB. Grant 4x to
  // stay well clear of the default limit while capping at 256MB.
  return Math.min(256 * 1024 * 1024, Math.max(64 * 1024 * 1024, N * r * 128 * 4));
}

export const PASSWORD_ALGORITHM = 'scrypt-v1';

export interface PasswordParameters {
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

export const DEFAULT_SCRYPT_PARAMETERS: PasswordParameters = {
  N: 16_384,
  r: 8,
  p: 1,
  keyLength: 64,
};

export const MINIMUM_PASSWORD_LENGTH = 14;
export const MAXIMUM_PASSWORD_LENGTH = 256;

const PLACEHOLDER_REJECTS = new Set([
  'password',
  'passwordpassword',
  'passwordpasswordpassword',
  '00000000000000',
  '11111111111111',
  '1234567890abcd',
  'aaaaaaaaaaaaaa',
  'abcdefghijklmn',
  'qwertyuiopasdf',
  'letmeinletmein',
]);

export interface PasswordPolicyError {
  code:
    | 'too_short'
    | 'too_long'
    | 'placeholder_rejected'
    | 'must_differ_from_username';
  detail: string;
}

export function validatePassword(
  password: string,
  opts: { username?: string } = {},
): PasswordPolicyError | null {
  if (typeof password !== 'string') {
    return { code: 'too_short', detail: `must be string; got ${typeof password}` };
  }
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return { code: 'too_short', detail: `minimum length is ${MINIMUM_PASSWORD_LENGTH}` };
  }
  if (password.length > MAXIMUM_PASSWORD_LENGTH) {
    return { code: 'too_long', detail: `maximum length is ${MAXIMUM_PASSWORD_LENGTH}` };
  }
  const lower = password.toLowerCase();
  if (PLACEHOLDER_REJECTS.has(lower)) {
    return { code: 'placeholder_rejected', detail: 'password is a known placeholder' };
  }
  if (opts.username) {
    const normUser = opts.username.trim().toLowerCase();
    if (normUser.length >= 3 && lower.includes(normUser)) {
      return {
        code: 'must_differ_from_username',
        detail: 'password must not contain the username',
      };
    }
  }
  return null;
}

export interface HashedPassword {
  algorithm: string;
  parameters: PasswordParameters;
  saltHex: string;
  hashHex: string;
}

export async function hashPassword(
  password: string,
  parameters: PasswordParameters = DEFAULT_SCRYPT_PARAMETERS,
): Promise<HashedPassword> {
  const salt = randomBytes(32);
  const derived = await scrypt(password, salt, parameters.keyLength, {
    N: parameters.N,
    r: parameters.r,
    p: parameters.p,
    maxmem: scryptMaxmem(parameters.N, parameters.r),
  });
  return {
    algorithm: PASSWORD_ALGORITHM,
    parameters,
    saltHex: salt.toString('hex'),
    hashHex: derived.toString('hex'),
  };
}

export async function verifyPassword(
  password: string,
  stored: {
    algorithm: string;
    // Parameters may come back from MariaDB JSON as string keys — coerce.
    parameters: PasswordParameters | Record<string, unknown>;
    saltHex: string;
    hashHex: string;
  },
): Promise<boolean> {
  if (stored.algorithm !== PASSWORD_ALGORITHM) return false;
  const salt = Buffer.from(stored.saltHex, 'hex');
  const expected = Buffer.from(stored.hashHex, 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const params = stored.parameters as Record<string, unknown>;
  const N = paramNumber(params.N, DEFAULT_SCRYPT_PARAMETERS.N);
  const r = paramNumber(params.r, DEFAULT_SCRYPT_PARAMETERS.r);
  const p = paramNumber(params.p, DEFAULT_SCRYPT_PARAMETERS.p);
  const derived = await scrypt(password, salt, expected.length, {
    N, r, p,
    maxmem: scryptMaxmem(N, r),
  });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
