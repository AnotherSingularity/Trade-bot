/**
 * Stage 3C-CI-RESET Part 2 Checkpoint D.1 §D.3 — response
 * interception helper for the induction controller.
 *
 * `applyNativeInduction({ routeKey, normal })` returns either the
 * unmodified normal response (mode=none / not active for this
 * route) or a schema-valid induced response corresponding to the
 * currently-active mode. The five modes correspond 1:1 with the
 * shared `NativeInductionMode` enum. The induced shapes are
 * intentionally deterministic so the native test can pin exact
 * observations.
 *
 * Every branch preserves the shape the desktop client's Zod
 * response schema requires — the point is to induce STATE, not to
 * break the wire contract. `contract_mismatch` is the sole
 * exception: its returned JSON is deliberately schema-invalid so
 * the client's `desktop_api_response_contract_mismatch` typed
 * error is exercised end-to-end.
 */

import { readActiveInductionFor } from '../routes/nativeInduction';
import type { NativeInductionRouteKey, NativeInductionMode } from '@horizon/shared';

// A stable "old" authoritative timestamp used by the stale response
// so the client sees a value that would trip any freshness gate.
const STALE_AUTHORITATIVE_TIMESTAMP = '2020-01-01T00:00:00.000Z';
const STALE_REASON = 'authoritative_timestamp_expired_via_induction';
const DEGRADED_REASON = 'observer_source_unavailable_via_induction';
const UNAVAILABLE_REASON = 'endpoint_unreachable_via_induction';

// Induced-response shapes. Each shape stays valid against the
// desktop client's Zod response schema for the corresponding route
// EXCEPT for `contract_mismatch`, which is deliberately invalid.
// The schemas live in packages/shared/src/desktopApiRoutes.ts:
//   ReconciliationStatusServerResponseSchema (union of known / unknown)
//   ScannerReadinessServerResponseSchema     (union of known / unknown)
//   ObserverPolicyVersionsServerResponseSchema
// The unknown branches are the natural stale/degraded/unavailable
// carriers.

function reconciliationStale(): unknown {
  return {
    known: true,
    ok: true,
    lastRunAt: STALE_AUTHORITATIVE_TIMESTAMP,
    inducedMode: 'stale',
    inducedReason: STALE_REASON,
  };
}

function reconciliationDegraded(): unknown {
  return {
    known: false,
    reason: DEGRADED_REASON,
    detail: 'induced degraded: reconciliation snapshot partial',
    inducedMode: 'degraded',
  };
}

function reconciliationUnavailable(): unknown {
  return {
    known: false,
    reason: UNAVAILABLE_REASON,
    detail: 'induced unavailable: reconciliation endpoint offline',
    inducedMode: 'unavailable',
  };
}

function reconciliationContractMismatch(): unknown {
  // Deliberately schema-invalid: `known` must be a literal boolean per
  // ReconciliationStatusServerResponseSchema; a string trips Zod's
  // union discriminant.
  return { known: 'nope', shape: 'contract_mismatch_induced' };
}

function scannerStale(): unknown {
  return {
    known: true,
    state: 'ready',
    blockingReasons: [],
    reconciliation: null,
    computedAt: STALE_AUTHORITATIVE_TIMESTAMP,
    inducedMode: 'stale',
    inducedReason: STALE_REASON,
  };
}

function scannerDegraded(): unknown {
  return {
    known: false,
    state: 'unknown',
    reason: DEGRADED_REASON,
    detail: 'induced degraded: scanner partial observer',
    inducedMode: 'degraded',
  };
}

function scannerUnavailable(): unknown {
  return {
    known: false,
    state: 'blocked',
    reason: UNAVAILABLE_REASON,
    detail: 'induced unavailable: scanner endpoint offline',
    inducedMode: 'unavailable',
  };
}

function scannerContractMismatch(): unknown {
  // `known` must be literal true/false; a number is invalid.
  return { known: 42, state: 'ready', inducedMode: 'contract_mismatch_induced' };
}

function observerStale(): unknown {
  return {
    known: true,
    source: `induced_stale@${STALE_AUTHORITATIVE_TIMESTAMP}`,
    values: {
      universe: 'stale-p2a-1',
      regime: 'stale-p2b-1',
      risk: 'stale-p2c-1',
      microstructure: 'stale-p2d-1',
      context: 'stale-p2e-1',
      validation: 'stale-p2f-1',
      __inducedReason: STALE_REASON,
    },
  };
}

function observerDegraded(): unknown {
  return {
    known: false,
    source: 'induced_degraded',
    values: { __inducedReason: DEGRADED_REASON },
  };
}

function observerUnavailable(): unknown {
  return {
    known: false,
    source: 'induced_unavailable',
    values: { __inducedReason: UNAVAILABLE_REASON },
  };
}

function observerContractMismatch(): unknown {
  // ObserverPolicyVersionsServerResponseSchema requires `values` to
  // be `z.record(z.string(), z.string())`. A number value trips it.
  return {
    known: true,
    source: 'induced_contract_mismatch',
    values: { universe: 12345 },
  };
}

// ---------------------------------------------------------------------------
// Dispatch. Returns null if no induction is active for this route.
// Callers use the returned object verbatim in `res.json(...)`.
// ---------------------------------------------------------------------------

export interface InducedResponse {
  readonly body: unknown;
  readonly mode: NativeInductionMode;
}

export function applyNativeInduction(routeKey: NativeInductionRouteKey): InducedResponse | null {
  const active = readActiveInductionFor(routeKey);
  if (active == null) return null;
  const map: Record<NativeInductionMode, () => unknown> = {
    none: () => null,
    stale_response:
      routeKey === 'reconciliationStatus' ? reconciliationStale
      : routeKey === 'scannerReadiness' ? scannerStale
      : observerStale,
    degraded_response:
      routeKey === 'reconciliationStatus' ? reconciliationDegraded
      : routeKey === 'scannerReadiness' ? scannerDegraded
      : observerDegraded,
    unavailable_response:
      routeKey === 'reconciliationStatus' ? reconciliationUnavailable
      : routeKey === 'scannerReadiness' ? scannerUnavailable
      : observerUnavailable,
    contract_mismatch:
      routeKey === 'reconciliationStatus' ? reconciliationContractMismatch
      : routeKey === 'scannerReadiness' ? scannerContractMismatch
      : observerContractMismatch,
  };
  const producer = map[active.mode];
  const body = producer();
  if (body == null) return null;
  return { body, mode: active.mode };
}
