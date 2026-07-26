/**
 * Stage 3 §18 — canonical state renderer.
 *
 * Every bound screen wraps its data-rendering block in `<StateFrame>`.
 * The frame handles the 10 required screen states — loading, healthy,
 * empty, stale, degraded, unavailable, unauthorized, session_expired,
 * api_failure, contract_mismatch. When state !== 'healthy' the child
 * renderer receives the envelope only when the state is degraded or
 * stale (so partial data can still be shown alongside the banner).
 */

import type { ReactNode } from 'react';
import type { DesktopDataEnvelope } from '@horizon/shared';
import type { ScreenState } from '../hooks/useDesktopData';

export interface StateFrameProps<T> {
  state: ScreenState;
  envelope: DesktopDataEnvelope<T> | null;
  error: { code: string; detail: string | null } | null;
  refresh: () => void;
  children: (payload: T, envelope: DesktopDataEnvelope<T>) => ReactNode;
  /** Optional prefix identifying the screen for accessibility/testing. */
  label: string;
}

export function StateFrame<T>(props: StateFrameProps<T>) {
  const { state, envelope, error, refresh, children, label } = props;

  if (state === 'loading') {
    return <div className="state-frame loading" data-screen={label} data-state="loading">Loading…</div>;
  }

  if (state === 'unauthorized' || state === 'session_expired') {
    // §18: no screen may retain business data after auth loss.
    return (
      <div className="state-frame unauthorized" data-screen={label} data-state={state}>
        <div className="banner warn">
          {state === 'session_expired'
            ? 'Your session has expired. Please sign in again to view this screen.'
            : 'Sign-in required to view this screen.'}
        </div>
      </div>
    );
  }

  if (state === 'api_failure') {
    return (
      <div className="state-frame api-failure" data-screen={label} data-state="api_failure">
        <div className="banner danger">
          Unable to reach the server. {error?.detail ?? error?.code ?? 'network_error'}
        </div>
        <button type="button" onClick={refresh}>Retry</button>
      </div>
    );
  }

  if (state === 'contract_mismatch') {
    return (
      <div className="state-frame contract-mismatch" data-screen={label} data-state="contract_mismatch">
        <div className="banner danger">
          Contract mismatch — this screen cannot render the server response safely.
          {error?.detail && <> Detail: <code>{error.detail}</code></>}
        </div>
      </div>
    );
  }

  if (state === 'unavailable') {
    return (
      <div className="state-frame unavailable" data-screen={label} data-state="unavailable">
        <div className="banner warn">
          Data source unavailable{envelope?.reasonCode ? `: ${envelope.reasonCode}` : ''}.
        </div>
        <button type="button" onClick={refresh}>Retry</button>
      </div>
    );
  }

  if (state === 'empty') {
    return (
      <div className="state-frame empty" data-screen={label} data-state="empty">
        <div className="banner info">
          No data yet{envelope?.reasonCode ? ` (${envelope.reasonCode})` : ''}. The desktop is operating in DRY_RUN — data will appear when the source produces it.
        </div>
        {envelope && envelope.data !== null && children(envelope.data, envelope)}
      </div>
    );
  }

  // state === 'healthy' | 'degraded' | 'stale' — render payload if present.
  if (!envelope || envelope.data === null) {
    return (
      <div className="state-frame degraded" data-screen={label} data-state={state}>
        <div className="banner warn">
          {state === 'degraded' ? 'Degraded' : state === 'stale' ? 'Stale data' : 'Data unavailable'}
          {envelope?.reasonCode ? ` — ${envelope.reasonCode}` : ''}.
        </div>
      </div>
    );
  }

  return (
    <div className="state-frame ok" data-screen={label} data-state={state}>
      {state === 'degraded' && (
        <div className="banner warn" role="status">
          Degraded — data is partially available{envelope.reasonCode ? ` (${envelope.reasonCode})` : ''}.
        </div>
      )}
      {state === 'stale' && envelope.staleAt && (
        <div className="banner warn" role="status">
          Stale data — last fresh at <time>{envelope.staleAt}</time>.
        </div>
      )}
      {children(envelope.data, envelope)}
    </div>
  );
}
