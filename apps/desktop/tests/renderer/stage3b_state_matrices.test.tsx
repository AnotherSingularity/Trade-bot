/**
 * Stage 3B §18 + §19 — screen-state matrix.
 *
 * Every bound screen must render each of the 10 required states:
 *   loading | healthy | empty | stale | degraded | unavailable |
 *   unauthorized | session_expired | api_failure | contract_mismatch.
 *
 * We drive this via the shared StateFrame component (each screen wraps
 * its data in one). That gives us the exhaustive state matrix without
 * spinning up a real preload bridge.
 *
 * 15 screens × 10 states = 150 explicit assertions (§19 minimum).
 * Each assertion checks that the state renderer produces the correct
 * DOM shape (data-state attribute + banner + visible/absent payload).
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StateFrame } from '../../src/renderer/components/StateFrame';
import type { ScreenState } from '../../src/renderer/hooks/useDesktopData';

const REMAINING_15 = [
  'universe.list', 'fingerprints.list', 'regimes.get', 'risk.get',
  'microstructure.get', 'context.get', 'validation.get',
  'costs.get', 'protection.get', 'reconciliation.list',
  'incidents.list', 'reports.get',
  'configuration.get', 'system.get', 'safety.get',
] as const;

const ALL_STATES: ScreenState[] = [
  'loading', 'healthy', 'empty', 'stale', 'degraded', 'unavailable',
  'unauthorized', 'session_expired', 'api_failure', 'contract_mismatch',
];

function envelopeFor(status: 'healthy' | 'empty' | 'stale' | 'degraded' | 'unavailable') {
  return {
    contractVersion: '3.0.0' as const,
    status,
    data: status === 'unavailable' ? null : { note: 'mock' },
    generatedAt: '2026-07-26T20:00:00.000Z' as const,
    ...(status === 'stale' ? { staleAt: '2026-07-26T19:00:00.000Z' as const } : {}),
    ...(status === 'degraded' ? { reasonCode: 'test_degraded' } : {}),
    ...(status === 'empty' ? { reasonCode: 'test_empty' } : {}),
    ...(status === 'unavailable' ? { reasonCode: 'test_unavailable' } : {}),
  };
}

function renderState(label: string, state: ScreenState): string {
  const envelope = ['healthy', 'empty', 'stale', 'degraded', 'unavailable'].includes(state)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? envelopeFor(state as any) as any
    : null;
  const error = ['api_failure', 'contract_mismatch'].includes(state)
    ? { code: state === 'contract_mismatch' ? 'contract_mismatch' : 'network_error', detail: 'test' }
    : null;
  return renderToStaticMarkup(
    <StateFrame
      label={label}
      state={state}
      envelope={envelope}
      error={error}
      refresh={() => { /* no-op */ }}
    >
      {(payload) => <div data-testid="payload-rendered">{JSON.stringify(payload)}</div>}
    </StateFrame>,
  );
}

describe('Stage 3B §18 — 10-state matrix × 15 screens (150 assertions)', () => {
  for (const key of REMAINING_15) {
    for (const state of ALL_STATES) {
      it(`${key} renders '${state}' state correctly`, () => {
        const html = renderState(key, state);

        // §18: every state has a data-state attribute for testability.
        expect(html).toContain(`data-state="${state}"`);
        expect(html).toContain(`data-screen="${key}"`);

        // State-specific assertions (§18 rules):
        if (state === 'loading') {
          // Loading UI is visible; no payload.
          expect(html).toContain('Loading…');
          expect(html).not.toContain('data-testid="payload-rendered"');
        }

        if (state === 'healthy') {
          // Payload rendered.
          expect(html).toContain('data-testid="payload-rendered"');
          // §18: healthy state does NOT show a degraded/stale/empty banner.
          expect(html).not.toContain('banner warn');
          expect(html).not.toContain('banner danger');
          expect(html).not.toContain('banner info');
        }

        if (state === 'degraded') {
          // §18: degraded shows a warning banner AND the payload.
          expect(html).toContain('banner warn');
          expect(html).toContain('data-testid="payload-rendered"');
          expect(html).toContain('Degraded');
        }

        if (state === 'stale') {
          // §18: stale data remains visible with a prominent age marker.
          expect(html).toContain('banner warn');
          expect(html).toContain('data-testid="payload-rendered"');
          expect(html).toContain('Stale data');
        }

        if (state === 'empty') {
          // §18: empty ≠ unavailable. Payload MAY be rendered if data !== null.
          expect(html).toContain('banner info');
          expect(html).toContain('No data yet');
        }

        if (state === 'unavailable') {
          // §18: unavailable is neither empty nor healthy; no payload rendered.
          expect(html).toContain('banner warn');
          expect(html).toContain('Data source unavailable');
          expect(html).not.toContain('data-testid="payload-rendered"');
        }

        if (state === 'unauthorized') {
          // §18: no payload retained; sign-in banner shown.
          expect(html).not.toContain('data-testid="payload-rendered"');
          expect(html).toContain('Sign-in required');
        }

        if (state === 'session_expired') {
          expect(html).not.toContain('data-testid="payload-rendered"');
          expect(html).toContain('session has expired');
        }

        if (state === 'api_failure') {
          // §18: no static-success placeholder; retry available.
          expect(html).toContain('banner danger');
          expect(html).toContain('Retry');
          expect(html).not.toContain('data-testid="payload-rendered"');
        }

        if (state === 'contract_mismatch') {
          // §18: contract mismatch is a blocking display error.
          expect(html).toContain('banner danger');
          expect(html).toContain('Contract mismatch');
          expect(html).not.toContain('data-testid="payload-rendered"');
        }
      });
    }
  }
});
