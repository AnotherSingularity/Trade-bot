/**
 * Stage 3 §5 / §18 — renderer hook for the desktop-data bridge.
 *
 * Every screen consumes envelopes through this hook. The hook maintains
 * the exhaustive state machine required by §18:
 *   loading | healthy | empty | stale | degraded | unavailable |
 *   unauthorized | session_expired | api_failure | contract_mismatch.
 *
 * On authentication loss the hook CLEARS its business data (§18 rule:
 * "no screen may silently retain old data after authentication loss").
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopDataEnvelope, DesktopDataRequestKey, DesktopDataResponse } from '@horizon/shared';
import { useAuth } from './useAuth';

export type ScreenState =
  | 'loading'
  | 'healthy'
  | 'empty'
  | 'stale'
  | 'degraded'
  | 'unavailable'
  | 'unauthorized'
  | 'session_expired'
  | 'api_failure'
  | 'contract_mismatch';

export interface UseDesktopDataOptions {
  /** Poll interval in ms. Omit for on-demand only. */
  refreshMs?: number;
  /** Skip the initial call — useful for optional detail queries. */
  skip?: boolean;
}

export interface UseDesktopDataResult<K extends DesktopDataRequestKey> {
  state: ScreenState;
  envelope: DesktopDataResponse<K> | null;
  error: { code: string; detail: string | null } | null;
  refresh: () => void;
  loadingCount: number;
}

interface WindowWithHorizon {
  horizon?: {
    desktopData<K extends DesktopDataRequestKey>(
      key: K,
      input?: unknown,
    ): Promise<
      | { ok: true; key: K; envelope: DesktopDataResponse<K> }
      | { ok: false; key: K; error: { code: string; detail: string | null } }
    >;
  };
}

function envelopeStatusToScreenState<K extends DesktopDataRequestKey>(env: DesktopDataResponse<K>): ScreenState {
  // The envelope is typed as `{ status, ... }`; the discriminant is safe.
  const e = env as unknown as DesktopDataEnvelope<unknown>;
  switch (e.status) {
    case 'healthy': return 'healthy';
    case 'degraded': return 'degraded';
    case 'stale': return 'stale';
    case 'empty': return 'empty';
    case 'unavailable': return 'unavailable';
    default: return 'contract_mismatch';
  }
}

function errorCodeToScreenState(code: string): ScreenState {
  if (code === 'unauthenticated' || code === 'session_expired') return 'unauthorized';
  if (code === 'contract_mismatch') return 'contract_mismatch';
  if (code === 'timeout' || code === 'network_error') return 'api_failure';
  if (code.startsWith('server_')) return 'api_failure';
  return 'api_failure';
}

/**
 * Hook that binds a screen to a single desktop-data key. Cancels in-flight
 * requests when the component unmounts or the auth phase transitions away
 * from `authenticated`. When the auth phase leaves `authenticated`, the
 * envelope is cleared so the renderer cannot retain old business data.
 */
export function useDesktopData<K extends DesktopDataRequestKey>(
  key: K,
  input?: unknown,
  opts: UseDesktopDataOptions = {},
): UseDesktopDataResult<K> {
  const auth = useAuth();
  const authPhase = auth.state.phase;
  const [state, setState] = useState<ScreenState>('loading');
  const [envelope, setEnvelope] = useState<DesktopDataResponse<K> | null>(null);
  const [error, setError] = useState<{ code: string; detail: string | null } | null>(null);
  const [loadingCount, setLoadingCount] = useState(0);
  const activeReqRef = useRef(0);

  const run = useCallback(async () => {
    if (opts.skip) return;
    const win = window as unknown as WindowWithHorizon;
    const api = win.horizon?.desktopData;
    if (!api) {
      setState('api_failure');
      setError({ code: 'bridge_unavailable', detail: null });
      return;
    }
    const myReq = ++activeReqRef.current;
    setLoadingCount((c) => c + 1);
    try {
      try {
        const res = await api(key, input);
        if (myReq !== activeReqRef.current) return; // superseded
        if (res.ok) {
          setEnvelope(res.envelope);
          setError(null);
          setState(envelopeStatusToScreenState(res.envelope));
        } else {
          setEnvelope(null);
          setError(res.error);
          setState(errorCodeToScreenState(res.error.code));
        }
      } catch (thrown) {
        // Stage 3C-E.1.15 — the preload rejects on auth-loss codes so
        // direct callers (behavioral tests) can distinguish a gate
        // from a business error. Inside the hook the auth-loss effect
        // has already superseded this request and set the correct
        // screen state; a superseded request is a no-op. Surface any
        // other throw as api_failure with a sanitized code.
        if (myReq !== activeReqRef.current) return;
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        const code = message.split(':', 1)[0] || 'bridge_error';
        setEnvelope(null);
        setError({ code, detail: message.slice(0, 200) });
        setState(errorCodeToScreenState(code));
      }
    } finally {
      setLoadingCount((c) => Math.max(0, c - 1));
    }
  }, [key, JSON.stringify(input), opts.skip]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear business data on auth loss (§18).
  useEffect(() => {
    if (authPhase !== 'authenticated') {
      activeReqRef.current++; // supersede any in-flight
      setEnvelope(null);
      setError(null);
      setState(authPhase === 'session_expired' ? 'session_expired' : 'unauthorized');
    }
  }, [authPhase]);

  // Initial + reactive fetch when key/input/auth changes.
  useEffect(() => {
    if (authPhase !== 'authenticated') return;
    void run();
  }, [run, authPhase]);

  // Stage 3C-E.1.19 — default poll interval of 1500ms so screens
  // pick up server-side state transitions (native induction
  // activate/clear, session-revoke on the server, etc.) without
  // requiring an operator re-navigation. Callers can still opt in
  // to a shorter or longer cadence via opts.refreshMs, or opt out
  // by passing 0. Poll only while authenticated so a locked/
  // expired session does not keep hammering the server.
  useEffect(() => {
    const effectiveMs = opts.refreshMs ?? 1_500;
    if (effectiveMs <= 0 || authPhase !== 'authenticated') return;
    const timer = setInterval(() => { void run(); }, effectiveMs);
    return () => clearInterval(timer);
  }, [run, opts.refreshMs, authPhase]);

  return { state, envelope, error, refresh: () => { void run(); }, loadingCount };
}
