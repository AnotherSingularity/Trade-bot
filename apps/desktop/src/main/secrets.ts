/**
 * Phase 3A §F — Secrets architecture.
 *
 * Credentials are stored only in the Electron main process or via the
 * operating-system credential store (keytar). Renderer state, browser
 * storage, logs, exports, crash reports, and IPC responses NEVER see
 * a raw credential. The redacted status enum is what the renderer may
 * display.
 *
 * Transfer-enabled permissions must trigger a prominent warning; no
 * withdrawal or transfer capability is implemented in Phase 3A.
 */

export type CredentialStatus = 'absent' | 'present_encrypted' | 'expired' | 'unknown';

export interface SecretsAdapter {
  getCredentialStatus(scope: string, key: string): Promise<CredentialStatus>;
  storeCredential(scope: string, key: string, value: string): Promise<void>;
  deleteCredential(scope: string, key: string): Promise<void>;
}

/**
 * Memory-only adapter used in tests. Never persists to disk.
 */
export class InMemorySecretsAdapter implements SecretsAdapter {
  private store = new Map<string, string>();
  private makeKey(scope: string, key: string) { return `${scope}::${key}`; }

  async getCredentialStatus(scope: string, key: string): Promise<CredentialStatus> {
    return this.store.has(this.makeKey(scope, key)) ? 'present_encrypted' : 'absent';
  }
  async storeCredential(scope: string, key: string, value: string): Promise<void> {
    if (!value) throw new Error('empty credential rejected');
    this.store.set(this.makeKey(scope, key), value);
  }
  async deleteCredential(scope: string, key: string): Promise<void> {
    this.store.delete(this.makeKey(scope, key));
  }
}

/**
 * Production keytar-backed adapter. Not constructed under Node <
 * electron; the Electron main process instantiates it at startup.
 */
export class KeytarSecretsAdapter implements SecretsAdapter {
  constructor(private readonly service: string = 'horizon-trade-desktop') {}
  private async keytar() {
    // Lazy import so tests without native modules can still load this file.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return await import('keytar').then((m) => m.default ?? m);
  }
  async getCredentialStatus(scope: string, key: string): Promise<CredentialStatus> {
    const kt = await this.keytar();
    const account = `${scope}::${key}`;
    const value = await (kt as { getPassword: (s: string, a: string) => Promise<string | null> }).getPassword(this.service, account);
    return value ? 'present_encrypted' : 'absent';
  }
  async storeCredential(scope: string, key: string, value: string): Promise<void> {
    if (!value) throw new Error('empty credential rejected');
    const kt = await this.keytar();
    const account = `${scope}::${key}`;
    await (kt as { setPassword: (s: string, a: string, v: string) => Promise<void> }).setPassword(this.service, account, value);
  }
  async deleteCredential(scope: string, key: string): Promise<void> {
    const kt = await this.keytar();
    const account = `${scope}::${key}`;
    await (kt as { deletePassword: (s: string, a: string) => Promise<boolean> }).deletePassword(this.service, account);
  }
}

/**
 * Sanitized status map safe to expose over IPC. Never contains a
 * credential value — only presence + condition.
 */
export type CredentialStatusMap = Readonly<Record<string, CredentialStatus>>;

export async function collectCredentialStatuses(
  adapter: SecretsAdapter,
  scopes: readonly { scope: string; key: string }[],
): Promise<CredentialStatusMap> {
  const out: Record<string, CredentialStatus> = {};
  for (const s of scopes) {
    out[`${s.scope}.${s.key}`] = await adapter.getCredentialStatus(s.scope, s.key);
  }
  return out;
}
