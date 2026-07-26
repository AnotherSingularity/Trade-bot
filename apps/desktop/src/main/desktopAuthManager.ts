/**
 * Stage 2 §9 — DesktopAuthManager.
 *
 * Owns:
 *   - The current access/refresh token pair (in memory only).
 *   - Persistence of the refresh token via `AuthTokenStorage`
 *     (keytar-backed in packaged builds).
 *   - The idle/absolute lifecycle windows.
 *   - Every server auth call — setup / login / logout / lock / refresh
 *     / change-password / revoke-all — via the AuthenticatedApiClient.
 *   - The SanitizedAuthState projection that leaves the process via IPC.
 *
 * The renderer NEVER receives the raw tokens — only phase + sanitized
 * account fields.
 */

import type {
  OperatorAuthPhase,
  SanitizedAuthState,
  AuthOperationResponse,
} from '../shared/ipcContract';
import type { AuthenticatedApiClient } from './authenticatedApiClient';
import { ApiCallError } from './authenticatedApiClient';
import type { AuthTokenStorage } from './secureStorage';

interface ServerTokenPair {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  absoluteExpiresAt: string;
  sessionId: number;
}

interface ServerAccount {
  id: number;
  username: string;
  status: 'active' | 'locked' | 'disabled' | 'recovery_required';
  credentialVersion: number;
  passwordChangedAt: string;
}

interface Snapshot {
  phase: OperatorAuthPhase;
  account: ServerAccount | null;
  pair: ServerTokenPair | null;
  lastActivityAt: string | null;
  failureReason: string | null;
}

export interface DesktopAuthManagerInput {
  api: AuthenticatedApiClient;
  tokenStorage: AuthTokenStorage;
  installationId?: number | null;
  clientVersion?: string;
  clock?: () => Date;
}

/**
 * The manager exposes a purely-async API. Every public method returns
 * an AuthOperationResponse whose `state` is safe to send to the
 * renderer (never contains a raw token).
 */
export class DesktopAuthManager {
  private snap: Snapshot = {
    phase: 'unauthenticated',
    account: null,
    pair: null,
    lastActivityAt: null,
    failureReason: null,
  };
  private readonly api: AuthenticatedApiClient;
  private readonly tokenStorage: AuthTokenStorage;
  private readonly installationId: number | null;
  private readonly clientVersion: string;
  private readonly now: () => Date;
  private refreshInFlight: Promise<{ ok: true; newAccessToken: string } | { ok: false; reason: string }> | null = null;

  constructor(input: DesktopAuthManagerInput) {
    this.api = input.api;
    this.tokenStorage = input.tokenStorage;
    this.installationId = input.installationId ?? null;
    this.clientVersion = input.clientVersion ?? 'stage2-desktop';
    this.now = input.clock ?? (() => new Date());
  }

  /**
   * On startup, learn the server's setup status + attempt to resume
   * from a persisted refresh token. Never throws on unavailable server —
   * yields `bootstrap_unavailable` so the renderer can wait.
   */
  async initialize(): Promise<SanitizedAuthState> {
    try {
      const stateRes = await this.api.request<{ setupCompleted: boolean }>('authState');
      if (stateRes.status !== 200) {
        this.snap = { ...this.snap, phase: 'bootstrap_unavailable', failureReason: `state_status_${stateRes.status}` };
        return this.sanitize();
      }
      if (!stateRes.body?.setupCompleted) {
        this.snap = { ...this.snap, phase: 'setup_required' };
        return this.sanitize();
      }
    } catch (e) {
      this.snap = { ...this.snap, phase: 'bootstrap_unavailable', failureReason: describeError(e) };
      return this.sanitize();
    }

    const persisted = await this.tokenStorage.readRefreshToken();
    if (!persisted) {
      this.snap = { ...this.snap, phase: 'unauthenticated' };
      return this.sanitize();
    }
    // Attempt to resume using the stored refresh token.
    const refresh = await this.performRefresh(persisted);
    if (refresh.ok) {
      this.snap = { ...this.snap, phase: 'authenticated' };
    } else {
      // Persistent state is stale — clear and mark as unauthenticated.
      await this.tokenStorage.clearRefreshToken();
      this.snap = {
        phase: refresh.reason.includes('reuse') ? 'session_revoked' : 'session_expired',
        account: null,
        pair: null,
        lastActivityAt: null,
        failureReason: refresh.reason,
      };
    }
    return this.sanitize();
  }

  async getState(): Promise<SanitizedAuthState> {
    // The current phase is authoritative on this side; the caller may
    // still want to know if server-side setup exists (for the initial
    // launch path). Cheap re-check when we're not authenticated.
    if (this.snap.phase === 'bootstrap_unavailable' || this.snap.phase === 'setup_required') {
      try {
        const res = await this.api.request<{ setupCompleted: boolean }>('authState');
        if (res.status === 200) {
          this.snap.phase = res.body?.setupCompleted ? 'unauthenticated' : 'setup_required';
        }
      } catch { /* keep prior phase */ }
    }
    return this.sanitize();
  }

  async setup(input: { username: string; password: string; passwordConfirmation: string }): Promise<AuthOperationResponse> {
    try {
      const res = await this.api.request<{ account?: ServerAccount; error?: string; detail?: string }>('authSetup', input);
      if (res.status === 201 && res.body?.account) {
        this.snap.phase = 'unauthenticated';
        this.snap.failureReason = null;
        return this.opResponse(true, null);
      }
      this.snap.failureReason = res.body?.error ?? 'setup_failed';
      return this.opResponse(false, this.snap.failureReason);
    } catch (e) {
      return this.opResponse(false, describeError(e));
    }
  }

  async login(input: { username: string; password: string }): Promise<AuthOperationResponse> {
    try {
      const res = await this.api.request<{
        account?: ServerAccount;
        tokens?: ServerTokenPair;
        error?: string;
        reason?: string;
      }>('authLogin', {
        username: input.username,
        password: input.password,
        installationId: this.installationId,
        clientVersion: this.clientVersion,
      });
      if (res.status !== 200 || !res.body?.account || !res.body?.tokens) {
        const reason = res.body?.reason ?? res.body?.error ?? `status_${res.status}`;
        if (reason === 'locked' || res.status === 423) {
          this.snap.phase = 'account_locked';
        } else if (res.status === 429) {
          this.snap.phase = 'account_locked';
        }
        this.snap.failureReason = String(reason);
        return this.opResponse(false, String(reason));
      }
      this.snap.account = res.body.account;
      this.snap.pair = res.body.tokens;
      this.snap.lastActivityAt = this.now().toISOString();
      this.snap.phase = 'authenticated';
      this.snap.failureReason = null;
      await this.tokenStorage.saveRefreshToken(res.body.tokens.refreshToken);
      return this.opResponse(true, null);
    } catch (e) {
      return this.opResponse(false, describeError(e));
    }
  }

  async logout(): Promise<AuthOperationResponse> {
    if (!this.snap.pair) {
      this.snap.phase = 'unauthenticated';
      await this.tokenStorage.clearRefreshToken();
      return this.opResponse(true, null);
    }
    try {
      await this.api.request('authLogout');
    } catch { /* best-effort — clear local state even if server call failed */ }
    this.snap.account = null;
    this.snap.pair = null;
    this.snap.lastActivityAt = null;
    this.snap.phase = 'unauthenticated';
    await this.tokenStorage.clearRefreshToken();
    return this.opResponse(true, null);
  }

  async lock(): Promise<AuthOperationResponse> {
    if (!this.snap.pair) return this.opResponse(true, null);
    try {
      await this.api.request('authLock');
    } catch { /* still transition locally */ }
    this.snap.account = null;
    this.snap.pair = null;
    this.snap.lastActivityAt = null;
    this.snap.phase = 'locked';
    await this.tokenStorage.clearRefreshToken();
    return this.opResponse(true, null);
  }

  async refresh(): Promise<AuthOperationResponse> {
    if (!this.snap.pair) return this.opResponse(false, 'no_refresh_token');
    const result = await this.performRefresh(this.snap.pair.refreshToken);
    return this.opResponse(result.ok, result.ok ? null : result.reason);
  }

  async changePassword(input: {
    currentPassword: string;
    newPassword: string;
    newPasswordConfirmation: string;
  }): Promise<AuthOperationResponse> {
    if (!this.snap.pair) return this.opResponse(false, 'unauthenticated');
    try {
      const res = await this.api.request<{ ok?: boolean; reason?: string; detail?: string }>('authChangePassword', input);
      if (res.status !== 200) {
        return this.opResponse(false, res.body?.reason ?? `status_${res.status}`);
      }
      // Server revoked every session on success. Re-login required.
      this.snap.account = null;
      this.snap.pair = null;
      this.snap.lastActivityAt = null;
      this.snap.phase = 'unauthenticated';
      await this.tokenStorage.clearRefreshToken();
      return this.opResponse(true, null);
    } catch (e) {
      return this.opResponse(false, describeError(e));
    }
  }

  async revokeAll(): Promise<AuthOperationResponse> {
    if (!this.snap.pair) return this.opResponse(true, null);
    try {
      await this.api.request('authRevokeAll');
    } catch { /* proceed to clear local state */ }
    this.snap.account = null;
    this.snap.pair = null;
    this.snap.lastActivityAt = null;
    this.snap.phase = 'session_revoked';
    await this.tokenStorage.clearRefreshToken();
    return this.opResponse(true, null);
  }

  // ------------- token accessors used by AuthenticatedApiClient -------------

  currentAccessToken(): string | null {
    return this.snap.pair?.accessToken ?? null;
  }

  /** Refresh callback wired into AuthenticatedApiClient. */
  refreshCallback = async (): Promise<{ ok: true; newAccessToken: string } | { ok: false; reason: string }> => {
    if (!this.snap.pair) return { ok: false, reason: 'no_refresh_token' };
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.performRefresh(this.snap.pair.refreshToken).finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  };

  private async performRefresh(refreshToken: string): Promise<{ ok: true; newAccessToken: string } | { ok: false; reason: string }> {
    try {
      const res = await this.api.request<{ tokens?: ServerTokenPair; reason?: string; error?: string }>('authRefresh', { refreshToken });
      if (res.status !== 200 || !res.body?.tokens) {
        const reason = res.body?.reason ?? res.body?.error ?? `status_${res.status}`;
        if (reason === 'already_rotated_family_revoked') {
          this.snap.pair = null;
          this.snap.account = null;
          this.snap.phase = 'session_revoked';
          this.snap.failureReason = 'refresh_reuse_detected';
        } else if (reason === 'absolute_expired' || reason === 'refresh_expired') {
          this.snap.pair = null;
          this.snap.account = null;
          this.snap.phase = 'session_expired';
          this.snap.failureReason = reason;
        }
        return { ok: false, reason: String(reason) };
      }
      this.snap.pair = res.body.tokens;
      this.snap.lastActivityAt = this.now().toISOString();
      await this.tokenStorage.saveRefreshToken(res.body.tokens.refreshToken);
      return { ok: true, newAccessToken: res.body.tokens.accessToken };
    } catch (e) {
      if (e instanceof ApiCallError && e.status === 401) {
        this.snap.pair = null;
        this.snap.account = null;
        this.snap.phase = 'session_expired';
      }
      return { ok: false, reason: describeError(e) };
    }
  }

  // ------------- sanitization + response helpers -------------

  sanitize(): SanitizedAuthState {
    return {
      phase: this.snap.phase,
      username: this.snap.account?.username ?? null,
      passwordChangedAt: this.snap.account?.passwordChangedAt ?? null,
      accessExpiresAt: this.snap.pair?.accessExpiresAt ?? null,
      absoluteExpiresAt: this.snap.pair?.absoluteExpiresAt ?? null,
      lastActivityAt: this.snap.lastActivityAt,
      failureReason: this.snap.failureReason,
    };
  }

  private opResponse(ok: boolean, reason: string | null): AuthOperationResponse {
    return { ok, state: this.sanitize(), reason };
  }
}

function describeError(e: unknown): string {
  if (e instanceof ApiCallError) return `api_${e.status}`;
  if (e instanceof Error) return e.message.slice(0, 120);
  return String(e).slice(0, 120);
}
