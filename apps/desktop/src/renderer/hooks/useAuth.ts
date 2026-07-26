/**
 * Stage 2 §15 — Renderer auth hook.
 *
 * Reads SanitizedAuthState from the main process via the preload
 * bridge. The renderer never has access to the raw tokens — only the
 * sanitized state fields (phase, username, expiries).
 */

import { useCallback, useEffect, useState } from 'react';
import type { AuthOperationResponse, SanitizedAuthState } from '../../shared/ipcContract';
// The global `Window.horizon.auth` shape is declared once in ./useHorizon.ts.

const BOOTSTRAP_UNAVAILABLE: SanitizedAuthState = {
  phase: 'bootstrap_unavailable',
  username: null,
  passwordChangedAt: null,
  accessExpiresAt: null,
  absoluteExpiresAt: null,
  lastActivityAt: null,
  failureReason: 'preload_bridge_missing',
};

export interface UseAuthResult {
  state: SanitizedAuthState;
  loading: boolean;
  refresh: () => Promise<void>;
  actions: {
    setup: (username: string, password: string, passwordConfirmation: string) => Promise<AuthOperationResponse>;
    login: (username: string, password: string) => Promise<AuthOperationResponse>;
    logout: () => Promise<AuthOperationResponse>;
    lock: () => Promise<AuthOperationResponse>;
    changePassword: (currentPassword: string, newPassword: string, newPasswordConfirmation: string) => Promise<AuthOperationResponse>;
    revokeAll: () => Promise<AuthOperationResponse>;
  };
}

export function useAuth(pollMs = 5_000): UseAuthResult {
  const [state, setState] = useState<SanitizedAuthState>(BOOTSTRAP_UNAVAILABLE);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!window.horizon?.auth) {
      setState(BOOTSTRAP_UNAVAILABLE);
      setLoading(false);
      return;
    }
    try {
      const s = await window.horizon.auth.getState();
      setState(s);
    } catch (e) {
      setState({ ...BOOTSTRAP_UNAVAILABLE, failureReason: describeError(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  const wrap = <T extends AuthOperationResponse>(fn: () => Promise<T>): (() => Promise<T>) => async () => {
    const r = await fn();
    setState(r.state);
    return r;
  };

  const actions: UseAuthResult['actions'] = {
    setup: async (username, password, passwordConfirmation) => {
      if (!window.horizon?.auth) return { ok: false, state: BOOTSTRAP_UNAVAILABLE, reason: 'no_bridge' };
      const r = await window.horizon.auth.setup({ username, password, passwordConfirmation });
      setState(r.state);
      return r;
    },
    login: async (username, password) => {
      if (!window.horizon?.auth) return { ok: false, state: BOOTSTRAP_UNAVAILABLE, reason: 'no_bridge' };
      const r = await window.horizon.auth.login({ username, password });
      setState(r.state);
      return r;
    },
    logout: wrap(() => window.horizon!.auth!.logout()),
    lock: wrap(() => window.horizon!.auth!.lock()),
    changePassword: async (currentPassword, newPassword, newPasswordConfirmation) => {
      if (!window.horizon?.auth) return { ok: false, state: BOOTSTRAP_UNAVAILABLE, reason: 'no_bridge' };
      const r = await window.horizon.auth.changePassword({ currentPassword, newPassword, newPasswordConfirmation });
      setState(r.state);
      return r;
    },
    revokeAll: wrap(() => window.horizon!.auth!.revokeAll()),
  };

  return { state, loading, refresh, actions };
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message.slice(0, 120);
  return String(e).slice(0, 120);
}
