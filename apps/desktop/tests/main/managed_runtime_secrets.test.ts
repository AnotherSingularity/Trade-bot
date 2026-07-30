/**
 * Correction 2 §generated-secrets — unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  assertNotLiteralPassword,
  generateManagedRuntimeSecrets,
  ManagedRuntimeSecretRejectedError,
  redactSecretsForEvidence,
  secretsToComposeEnv,
} from '../../src/main/managedRuntimeSecrets';

const INPUT = {
  sessionId: 'sess-abcdef01234567',
  installationIdHash: 'inst-abcdef01234567',
};

describe('generateManagedRuntimeSecrets', () => {
  it('produces three non-empty credentials + a stable bundleDigest', () => {
    const s = generateManagedRuntimeSecrets(INPUT);
    expect(s.dbRootPassword.length).toBeGreaterThanOrEqual(40);
    expect(s.dbAppPassword.length).toBeGreaterThanOrEqual(40);
    expect(s.redisPassword.length).toBeGreaterThanOrEqual(40);
    expect(s.dbRootPassword).not.toBe(s.dbAppPassword);
    expect(s.dbAppPassword).not.toBe(s.redisPassword);
    expect(s.bundleDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic given a deterministic RNG', () => {
    let n = 0;
    const rng = (size: number): Buffer => {
      const b = Buffer.alloc(size);
      for (let i = 0; i < size; i++) b[i] = (n++) & 0xff;
      return b;
    };
    const a = generateManagedRuntimeSecrets({ ...INPUT, randomBytes: rng });
    n = 0;
    const b = generateManagedRuntimeSecrets({ ...INPUT, randomBytes: rng });
    expect(a.bundleDigest).toBe(b.bundleDigest);
    expect(a.dbRootPassword).toBe(b.dbRootPassword);
  });

  it('two installations produce different bundleDigests', () => {
    const a = generateManagedRuntimeSecrets(INPUT);
    const b = generateManagedRuntimeSecrets({ ...INPUT, installationIdHash: 'inst-different01' });
    expect(a.bundleDigest).not.toBe(b.bundleDigest);
  });

  it('rejects short sessionId', () => {
    expect(() => generateManagedRuntimeSecrets({ ...INPUT, sessionId: 'x' })).toThrow(ManagedRuntimeSecretRejectedError);
  });

  it('rejects short installationIdHash', () => {
    expect(() => generateManagedRuntimeSecrets({ ...INPUT, installationIdHash: 'x' })).toThrow(ManagedRuntimeSecretRejectedError);
  });
});

describe('assertNotLiteralPassword', () => {
  it('rejects "password"', () => {
    expect(() => assertNotLiteralPassword('password', 'dbRootPassword')).toThrow(ManagedRuntimeSecretRejectedError);
  });

  it('rejects mixed-case "PaSsWoRd"', () => {
    expect(() => assertNotLiteralPassword('PaSsWoRd', 'dbRootPassword')).toThrow(ManagedRuntimeSecretRejectedError);
  });

  it('rejects each canonical weak literal', () => {
    for (const bad of ['password', 'root', 'admin', '123456', 'changeme', 'default', '']) {
      expect(() => assertNotLiteralPassword(bad, 'field')).toThrow(ManagedRuntimeSecretRejectedError);
    }
  });

  it('rejects strings shorter than 16 chars', () => {
    expect(() => assertNotLiteralPassword('short-string', 'field')).toThrow(ManagedRuntimeSecretRejectedError);
  });

  it('accepts a strong random credential', () => {
    expect(() => assertNotLiteralPassword('a'.repeat(20) + 'B0xY', 'field')).not.toThrow();
  });
});

describe('secretsToComposeEnv', () => {
  it('returns three keys matching the compose file substitutions', () => {
    const s = generateManagedRuntimeSecrets(INPUT);
    const env = secretsToComposeEnv(s);
    expect(Object.keys(env).sort()).toEqual([
      'HORIZON_MANAGED_DB_APP_PASSWORD',
      'HORIZON_MANAGED_DB_ROOT_PASSWORD',
      'HORIZON_MANAGED_REDIS_PASSWORD',
    ]);
    expect(env.HORIZON_MANAGED_DB_ROOT_PASSWORD).toBe(s.dbRootPassword);
  });

  it('refuses to emit a bundle with a forbidden literal', () => {
    const forged = {
      dbRootPassword: 'password',
      dbAppPassword: 'admin',
      redisPassword: 'changeme',
      bundleDigest: 'x',
    };
    expect(() => secretsToComposeEnv(forged)).toThrow(ManagedRuntimeSecretRejectedError);
  });
});

describe('redactSecretsForEvidence', () => {
  it('never returns a raw credential', () => {
    const s = generateManagedRuntimeSecrets(INPUT);
    const r = redactSecretsForEvidence(s);
    expect(r.dbRootPassword).toBe(`<REDACTED:len=${s.dbRootPassword.length}>`);
    expect(r.dbAppPassword).toBe(`<REDACTED:len=${s.dbAppPassword.length}>`);
    expect(r.redisPassword).toBe(`<REDACTED:len=${s.redisPassword.length}>`);
    expect(r.bundleDigest).toBe(s.bundleDigest);
    expect(r.dbRootPassword).not.toContain(s.dbRootPassword);
  });
});
