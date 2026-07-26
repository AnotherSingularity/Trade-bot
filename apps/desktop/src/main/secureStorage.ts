/**
 * Stage 2 §8 — Secure token storage for the desktop main process.
 *
 * Purpose: persist the refresh token (and only the refresh token —
 * the short-lived access token stays in RAM) across app restarts.
 * On packaged builds the storage MUST be OS-native (keytar → Windows
 * Credential Manager / macOS Keychain / libsecret). In-memory storage
 * is permitted in dev + tests only; packaged mode refuses to fall back.
 *
 * The renderer NEVER receives any of these values via IPC.
 */

import { SecretsAdapter } from './secrets';

const REFRESH_SCOPE = 'operator_session';
const REFRESH_KEY = 'refresh_token';

export interface AuthTokenStorage {
  /** Save (or overwrite) the current refresh token. */
  saveRefreshToken(token: string): Promise<void>;
  /** Read the stored refresh token, or null if absent. */
  readRefreshToken(): Promise<string | null>;
  /** Erase the refresh token from OS storage. */
  clearRefreshToken(): Promise<void>;
}

export class SecretsAuthTokenStorage implements AuthTokenStorage {
  constructor(
    private readonly secrets: SecretsAdapter,
    private readonly reader: (scope: string, key: string) => Promise<string | null>,
  ) {}

  async saveRefreshToken(token: string): Promise<void> {
    if (!token) throw new Error('empty refresh token rejected');
    await this.secrets.storeCredential(REFRESH_SCOPE, REFRESH_KEY, token);
  }

  async readRefreshToken(): Promise<string | null> {
    return this.reader(REFRESH_SCOPE, REFRESH_KEY);
  }

  async clearRefreshToken(): Promise<void> {
    await this.secrets.deleteCredential(REFRESH_SCOPE, REFRESH_KEY);
  }
}

/**
 * Factory that binds to whichever SecretsAdapter is provided.
 *
 * When `packagedRequiresKeytar` is true and the adapter is NOT the
 * keytar-backed one, this throws — packaged production must never
 * fall back to plaintext.
 */
export function createAuthTokenStorage(input: {
  adapter: SecretsAdapter;
  reader: (scope: string, key: string) => Promise<string | null>;
  packagedRequiresKeytar: boolean;
  isKeytar: boolean;
}): AuthTokenStorage {
  if (input.packagedRequiresKeytar && !input.isKeytar) {
    throw new Error(
      'Packaged production requires OS credential storage (keytar). Refusing to fall back to in-memory storage.',
    );
  }
  return new SecretsAuthTokenStorage(input.adapter, input.reader);
}
