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
import {
  ApiCallError,
  DesktopApiContractMismatchError,
  DesktopApiHttpError,
  DesktopApiInvalidJsonError,
  DesktopApiTransportError,
} from './authenticatedApiClient';
import type { AuthTokenStorage } from './secureStorage';
// Stage 3C-CI-FIX10A §1: canonical login body construction. The
// helper omits optional fields when absent so `installationId: null`
// can never reach the wire. See operatorLoginBody.ts for the exact
// contract and the FIX10A native-run root cause.
import { buildOperatorLoginBody } from './operatorLoginBody';
// Stage 3C-CI-RESET Part 2 §1 (Checkpoint A.1): shared schemas the
// manager reparses to narrow the `unknown` requestValidated returns.
// The schemas already ran under requestValidated; reparse is
// idempotent and never accepts a shape the client would reject.
import {
  OperatorAuthStateServerResponseSchema,
  OperatorSetupServerResponseSchema,
  OperatorLoginServerResponseSchema,
  OperatorRefreshServerResponseSchema,
} from '@horizon/shared';

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
  // Stage 3C-CI-FIX10A §1: internal representation is `number | undefined`
  // — an absent optional value can no longer be accidentally serialised
  // as `null`. The input contract retains the wider `number | null |
  // undefined` for caller compatibility (some callers thread the value
  // through from database rows that natively carry `null`); the
  // constructor normalises at the boundary.
  private readonly installationId: number | undefined;
  private readonly clientVersion: string;
  private readonly now: () => Date;
  private refreshInFlight: Promise<{ ok: true; newAccessToken: string } | { ok: false; reason: string }> | null = null;

  constructor(input: DesktopAuthManagerInput) {
    this.api = input.api;
    this.tokenStorage = input.tokenStorage;
    this.installationId = typeof input.installationId === 'number' ? input.installationId : undefined;
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
      const raw = await this.api.requestValidated('authState');
      const stateBody = OperatorAuthStateServerResponseSchema.parse(raw);
      if (!stateBody.setupCompleted) {
        this.snap = { ...this.snap, phase: 'setup_required' };
        return this.sanitize();
      }
    } catch (e) {
      if (e instanceof DesktopApiHttpError) {
        this.snap = { ...this.snap, phase: 'bootstrap_unavailable', failureReason: `state_status_${e.status}` };
        return this.sanitize();
      }
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
        const raw = await this.api.requestValidated('authState');
        const body = OperatorAuthStateServerResponseSchema.parse(raw);
        this.snap.phase = body.setupCompleted ? 'unauthenticated' : 'setup_required';
      } catch { /* keep prior phase */ }
    }
    return this.sanitize();
  }

  async setup(input: { username: string; password: string; passwordConfirmation: string }): Promise<AuthOperationResponse> {
    try {
      const raw = await this.api.requestValidated('authSetup', input);
      const body = OperatorSetupServerResponseSchema.parse(raw);
      if (body.account) {
        this.snap.phase = 'unauthenticated';
        this.snap.failureReason = null;
        return this.opResponse(true, null);
      }
      // Should be unreachable — schema requires `account`. Defensive.
      this.snap.failureReason = 'setup_failed';
      return this.opResponse(false, this.snap.failureReason);
    } catch (e) {
      return this.opResponse(false, apiErrorToReason(e, 'setup_failed'));
    }
  }

  async login(input: { username: string; password: string }): Promise<AuthOperationResponse> {
    try {
      // Stage 3C-CI-FIX10A §1: normalize the body via the pure helper.
      // Absent optional fields are OMITTED from the serialized JSON;
      // in particular `installationId: null` can never reach the wire.
      const body = buildOperatorLoginBody({
        username: input.username,
        password: input.password,
        installationId: this.installationId,
        clientVersion: this.clientVersion,
      });
      const raw = await this.api.requestValidated('authLogin', body);
      const parsed = OperatorLoginServerResponseSchema.parse(raw);
      this.snap.account = parsed.account;
      this.snap.pair = parsed.tokens;
      this.snap.lastActivityAt = this.now().toISOString();
      this.snap.phase = 'authenticated';
      this.snap.failureReason = null;
      await this.tokenStorage.saveRefreshToken(parsed.tokens.refreshToken);
      return this.opResponse(true, null);
    } catch (e) {
      // Stage 3C-CI-RESET Part 2 §1 (Checkpoint A.1): typed error
      // classification. DesktopApiHttpError carries the sanitized
      // reason + status; we map 423/429/`locked` to account_locked
      // phase and stash the reason.
      if (e instanceof DesktopApiHttpError) {
        const reason = (e.reason === 'unspecified' ? `status_${e.status}` : e.reason);
        if (reason === 'locked' || e.status === 423 || e.status === 429) {
          this.snap.phase = 'account_locked';
        }
        this.snap.failureReason = reason;
        return this.opResponse(false, reason);
      }
      return this.opResponse(false, apiErrorToReason(e, 'login_failed'));
    }
  }

  async logout(): Promise<AuthOperationResponse> {
    if (!this.snap.pair) {
      this.snap.phase = 'unauthenticated';
      await this.tokenStorage.clearRefreshToken();
      return this.opResponse(true, null);
    }
    try {
      await this.api.requestValidated('authLogout', {});
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
      await this.api.requestValidated('authLock', {});
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
      await this.api.requestValidated('authChangePassword', input);
      // Server revoked every session on success. Re-login required.
      this.snap.account = null;
      this.snap.pair = null;
      this.snap.lastActivityAt = null;
      this.snap.phase = 'unauthenticated';
      await this.tokenStorage.clearRefreshToken();
      return this.opResponse(true, null);
    } catch (e) {
      return this.opResponse(false, apiErrorToReason(e, 'change_password_failed'));
    }
  }

  async revokeAll(): Promise<AuthOperationResponse> {
    if (!this.snap.pair) return this.opResponse(true, null);
    try {
      await this.api.requestValidated('authRevokeAll', {});
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
      const raw = await this.api.requestValidated('authRefresh', { refreshToken });
      const parsed = OperatorRefreshServerResponseSchema.parse(raw);
      this.snap.pair = parsed.tokens;
      this.snap.lastActivityAt = this.now().toISOString();
      await this.tokenStorage.saveRefreshToken(parsed.tokens.refreshToken);
      return { ok: true, newAccessToken: parsed.tokens.accessToken };
    } catch (e) {
      // Semantic-preserving mapping of the pre-RESET behavior:
      //   - `already_rotated_family_revoked` → session_revoked
      //   - `absolute_expired` / `refresh_expired` → session_expired
      //   - 401 ApiCallError → session_expired
      //   - anything else → return the reason without transitioning
      const reason = apiErrorToReason(e, 'refresh_failed');
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
      } else if (e instanceof ApiCallError && e.status === 401) {
        this.snap.pair = null;
        this.snap.account = null;
        this.snap.phase = 'session_expired';
      }
      return { ok: false, reason };
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

/**
 * Stage 3C-CI-RESET Part 2 §1 (Checkpoint A.1): typed-error →
 * failure-reason projection. Maps DesktopApiHttpError /
 * DesktopApiContractMismatchError / DesktopApiInvalidJsonError /
 * DesktopApiTransportError to short reason strings the manager can
 * embed in AuthOperationResponse.reason. Falls back to the legacy
 * ApiCallError / Error path via describeError.
 */
function apiErrorToReason(e: unknown, fallback: string): string {
  if (e instanceof DesktopApiHttpError) {
    const reason = e.reason === 'unspecified' ? `status_${e.status}` : e.reason;
    return reason.slice(0, 120);
  }
  if (e instanceof DesktopApiContractMismatchError) {
    return `contract_${e.kind}:${e.route}:${e.issuePath}`.slice(0, 120);
  }
  if (e instanceof DesktopApiInvalidJsonError) {
    return `invalid_json:${e.route}`.slice(0, 120);
  }
  if (e instanceof DesktopApiTransportError) {
    return `transport:${e.route}`.slice(0, 120);
  }
  if (e instanceof ApiCallError) return `api_${e.status}`;
  if (e instanceof Error) {
    const m = e.message.slice(0, 120);
    return m.length > 0 ? m : fallback;
  }
  const s = String(e).slice(0, 120);
  return s.length > 0 ? s : fallback;
}
