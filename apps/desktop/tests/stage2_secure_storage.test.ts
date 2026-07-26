/**
 * Stage 2 §8 — Secure token storage.
 */
import { describe, expect, it } from 'vitest';
import { InMemorySecretsAdapter } from '../src/main/secrets';
import { SecretsAuthTokenStorage, createAuthTokenStorage } from '../src/main/secureStorage';

describe('stage2 §8 secure token storage', () => {
  it('SS1: save + read roundtrips the refresh token', async () => {
    const secrets = new InMemorySecretsAdapter();
    const memory = new Map<string, string>();
    const originalStore = secrets.storeCredential.bind(secrets);
    secrets.storeCredential = async (s, k, v) => { memory.set(`${s}::${k}`, v); return originalStore(s, k, v); };
    const storage = new SecretsAuthTokenStorage(secrets, async (s, k) => memory.get(`${s}::${k}`) ?? null);
    await storage.saveRefreshToken('the-refresh-token');
    expect(await storage.readRefreshToken()).toBe('the-refresh-token');
  });

  it('SS2: clear erases the stored value', async () => {
    const secrets = new InMemorySecretsAdapter();
    const memory = new Map<string, string>();
    const originalStore = secrets.storeCredential.bind(secrets);
    const originalDelete = secrets.deleteCredential.bind(secrets);
    secrets.storeCredential = async (s, k, v) => { memory.set(`${s}::${k}`, v); return originalStore(s, k, v); };
    secrets.deleteCredential = async (s, k) => { memory.delete(`${s}::${k}`); return originalDelete(s, k); };
    const storage = new SecretsAuthTokenStorage(secrets, async (s, k) => memory.get(`${s}::${k}`) ?? null);
    await storage.saveRefreshToken('x');
    await storage.clearRefreshToken();
    expect(await storage.readRefreshToken()).toBeNull();
  });

  it('SS3: empty token is rejected', async () => {
    const secrets = new InMemorySecretsAdapter();
    const storage = new SecretsAuthTokenStorage(secrets, async () => null);
    await expect(storage.saveRefreshToken('')).rejects.toThrow(/empty/);
  });

  it('SS4: packaged mode without keytar throws — no plaintext fallback', () => {
    const secrets = new InMemorySecretsAdapter();
    expect(() => createAuthTokenStorage({
      adapter: secrets,
      reader: async () => null,
      packagedRequiresKeytar: true,
      isKeytar: false,
    })).toThrow(/keytar/);
  });

  it('SS5: packaged mode with keytar succeeds', () => {
    const secrets = new InMemorySecretsAdapter();
    expect(() => createAuthTokenStorage({
      adapter: secrets,
      reader: async () => null,
      packagedRequiresKeytar: true,
      isKeytar: true,
    })).not.toThrow();
  });

  it('SS6: non-packaged mode with in-memory storage is allowed', () => {
    const secrets = new InMemorySecretsAdapter();
    expect(() => createAuthTokenStorage({
      adapter: secrets,
      reader: async () => null,
      packagedRequiresKeytar: false,
      isKeytar: false,
    })).not.toThrow();
  });
});
