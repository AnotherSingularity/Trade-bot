import { describe, expect, it } from 'vitest';
import {
  AuthenticationManager,
  DEFAULT_AUTH_CONFIG,
  hashPassword,
  validatePasswordPolicy,
  verifyPassword,
} from '../src/main/authentication';

describe('phase3a §G — authentication', () => {
  it('T46: password policy rejects short passwords', () => {
    const r = validatePasswordPolicy('short');
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('too_short');
  });

  it('T47: password policy rejects common passwords', () => {
    const r = validatePasswordPolicy('Password123!');
    // "password123" appears in COMMON_PASSWORDS after toLower, but "Password123!" is not — verify the exact match.
    expect(validatePasswordPolicy('password').violations).toContain('common_password');
    expect(r.ok).toBe(true);
  });

  it('T48: password policy rejects product-name-containing passwords', () => {
    const r = validatePasswordPolicy('HorizonAdmin123!');
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('contains_product_name');
  });

  it('T49: scrypt hash then verify round-trips', () => {
    const h = hashPassword('sufficiently-long-passphrase-1');
    expect(verifyPassword('sufficiently-long-passphrase-1', h)).toBe(true);
    expect(verifyPassword('wrong-passphrase', h)).toBe(false);
  });

  it('T50: hashPassword produces distinct salts per invocation', () => {
    const a = hashPassword('sufficiently-long-passphrase-1');
    const b = hashPassword('sufficiently-long-passphrase-1');
    expect(a.saltHex).not.toBe(b.saltHex);
    expect(a.hashHex).not.toBe(b.hashHex);
  });

  it('T51: login after setupAdmin returns a session; wrong password throws', () => {
    const auth = new AuthenticationManager();
    auth.setupAdmin('admin', 'sufficiently-long-passphrase-1');
    const s = auth.login('admin', 'sufficiently-long-passphrase-1');
    expect(s.actor).toBe('admin');
    expect(s.revoked).toBe(false);
    expect(() => auth.login('admin', 'wrong')).toThrow(/invalid_credentials/);
  });

  it('T52: rate limit rejects after too many attempts', () => {
    const auth = new AuthenticationManager({ ...DEFAULT_AUTH_CONFIG, maxAttemptsPerWindow: 2 });
    auth.setupAdmin('admin', 'sufficiently-long-passphrase-1');
    expect(() => auth.login('admin', 'wrong')).toThrow(/invalid_credentials/);
    expect(() => auth.login('admin', 'wrong')).toThrow(/invalid_credentials/);
    expect(() => auth.login('admin', 'sufficiently-long-passphrase-1')).toThrow(/too_many_attempts/);
  });

  it('T53: verifySession honours expiry and revocation', () => {
    let ts = new Date('2026-07-26T00:00:00Z').getTime();
    const auth = new AuthenticationManager({ ...DEFAULT_AUTH_CONFIG, sessionDurationMs: 1000 }, () => new Date(ts));
    auth.setupAdmin('admin', 'sufficiently-long-passphrase-1');
    const s = auth.login('admin', 'sufficiently-long-passphrase-1');
    expect(auth.verifySession(s.token)?.actor).toBe('admin');
    ts += 2000;
    expect(auth.verifySession(s.token)).toBeNull();
    ts = new Date('2026-07-26T00:00:00Z').getTime();
    const s2 = auth.login('admin', 'sufficiently-long-passphrase-1');
    auth.revoke(s2.token);
    expect(auth.verifySession(s2.token)).toBeNull();
  });
});
