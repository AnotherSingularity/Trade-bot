import { describe, expect, it } from 'vitest';
import { InMemorySecretsAdapter, collectCredentialStatuses } from '../src/main/secrets';

describe('phase3a §F — secrets architecture', () => {
  it('T41: unknown credentials are reported absent', async () => {
    const a = new InMemorySecretsAdapter();
    expect(await a.getCredentialStatus('coinbase', 'apiKey')).toBe('absent');
  });

  it('T42: stored credentials are reported present_encrypted (never returned)', async () => {
    const a = new InMemorySecretsAdapter();
    await a.storeCredential('coinbase', 'apiKey', 'sk_test_1234567890');
    expect(await a.getCredentialStatus('coinbase', 'apiKey')).toBe('present_encrypted');
  });

  it('T43: empty credentials are refused', async () => {
    const a = new InMemorySecretsAdapter();
    await expect(a.storeCredential('coinbase', 'apiKey', '')).rejects.toThrow(/empty/);
  });

  it('T44: deleteCredential removes it and status returns to absent', async () => {
    const a = new InMemorySecretsAdapter();
    await a.storeCredential('coinbase', 'apiKey', 'x');
    await a.deleteCredential('coinbase', 'apiKey');
    expect(await a.getCredentialStatus('coinbase', 'apiKey')).toBe('absent');
  });

  it('T45: collectCredentialStatuses returns a scoped map without values', async () => {
    const a = new InMemorySecretsAdapter();
    await a.storeCredential('coinbase', 'apiKey', 'secret_a');
    await a.storeCredential('coinbase', 'apiSecret', 'secret_b');
    const map = await collectCredentialStatuses(a, [
      { scope: 'coinbase', key: 'apiKey' },
      { scope: 'coinbase', key: 'apiSecret' },
      { scope: 'session', key: 'admin' },
    ]);
    expect(map).toEqual({
      'coinbase.apiKey': 'present_encrypted',
      'coinbase.apiSecret': 'present_encrypted',
      'session.admin': 'absent',
    });
    // Ensure no raw value key exists.
    const asString = JSON.stringify(map);
    expect(asString).not.toContain('secret_a');
    expect(asString).not.toContain('secret_b');
  });
});
