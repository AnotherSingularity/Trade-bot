/**
 * Stage 2 §5 — Password policy + scrypt hashing.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRYPT_PARAMETERS,
  MINIMUM_PASSWORD_LENGTH,
  MAXIMUM_PASSWORD_LENGTH,
  PASSWORD_ALGORITHM,
  hashPassword,
  validatePassword,
  verifyPassword,
} from '../src/auth/passwords';

describe('stage2 §5 password policy', () => {
  it('P1: minimum length is 14 characters', () => {
    expect(MINIMUM_PASSWORD_LENGTH).toBe(14);
    expect(validatePassword('short'.padEnd(13, 'x'))).toMatchObject({ code: 'too_short' });
    expect(validatePassword('short'.padEnd(14, 'x'))).toBeNull();
  });

  it('P2: passwords longer than 256 chars are rejected (avoid DoS via scrypt)', () => {
    expect(validatePassword('x'.repeat(MAXIMUM_PASSWORD_LENGTH + 1))).toMatchObject({ code: 'too_long' });
  });

  it('P3: placeholder passwords are rejected', () => {
    expect(validatePassword('passwordpassword')).toMatchObject({ code: 'placeholder_rejected' });
    expect(validatePassword('AAAAAAAAAAAAAA')).toMatchObject({ code: 'placeholder_rejected' });
  });

  it('P4: passwords containing the username are rejected', () => {
    expect(validatePassword('operator-hunter42', { username: 'operator' })).toMatchObject({ code: 'must_differ_from_username' });
    expect(validatePassword('unrelated-passphrase-42', { username: 'operator' })).toBeNull();
  });

  it('P5: no character-class complexity rules — length matters, not composition', () => {
    expect(validatePassword('aaaaaaaaaaaaaabbb')).toBeNull();
  });
});

describe('stage2 §5 scrypt hash + verify', () => {
  it('H1: hashPassword uses the compiled-in scrypt-v1 algorithm identifier', async () => {
    const h = await hashPassword('correct-horse-battery-staple-1');
    expect(h.algorithm).toBe(PASSWORD_ALGORITHM);
    expect(h.algorithm).toBe('scrypt-v1');
  });

  it('H2: parameters default to N=16384, r=8, p=1, keyLength=64', () => {
    expect(DEFAULT_SCRYPT_PARAMETERS).toEqual({ N: 16_384, r: 8, p: 1, keyLength: 64 });
  });

  it('H3: hashPassword produces per-account random salt (16+ bytes = 32+ hex chars)', async () => {
    const h1 = await hashPassword('correct-horse-battery-staple-1');
    const h2 = await hashPassword('correct-horse-battery-staple-1');
    expect(h1.saltHex.length).toBeGreaterThanOrEqual(32);
    expect(h1.saltHex).not.toBe(h2.saltHex);
    expect(h1.hashHex).not.toBe(h2.hashHex);
  });

  it('H4: verifyPassword returns true on match', async () => {
    const h = await hashPassword('correct-horse-battery-staple-1');
    expect(await verifyPassword('correct-horse-battery-staple-1', h)).toBe(true);
  });

  it('H5: verifyPassword returns false on mismatch', async () => {
    const h = await hashPassword('correct-horse-battery-staple-1');
    expect(await verifyPassword('wrong-password-of-the-right-length', h)).toBe(false);
  });

  it('H6: verifyPassword returns false for unknown algorithm', async () => {
    const h = await hashPassword('correct-horse-battery-staple-1');
    expect(await verifyPassword('correct-horse-battery-staple-1', { ...h, algorithm: 'unknown-v99' })).toBe(false);
  });

  it('H7: hash/salt payloads are hex-encoded (no non-hex chars)', async () => {
    const h = await hashPassword('correct-horse-battery-staple-1');
    expect(/^[0-9a-f]+$/i.test(h.hashHex)).toBe(true);
    expect(/^[0-9a-f]+$/i.test(h.saltHex)).toBe(true);
  });
}, 30_000);
