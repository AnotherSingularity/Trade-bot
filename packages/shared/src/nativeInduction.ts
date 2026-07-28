/**
 * Stage 3C-CI-RESET Part 2 Checkpoint D.1 — native test-only fault
 * induction contract.
 *
 * The induction controller lets the native Electron integration
 * suite temporarily replace one allowlisted server response with a
 * controlled failure/degradation shape. This is the ONLY sanctioned
 * mechanism for the native T39/T40/T41/T43 tests to exercise
 * downstream renderer state without stubbing fetches at the client.
 *
 * Every gate is defence-in-depth (see server-side
 * `assertNativeInductionAllowed`):
 *
 *   1. NODE_ENV === 'test'
 *   2. HORIZON_NATIVE_DIAGNOSTICS === 'true'
 *   3. HORIZON_SERVER_EXTERNAL === 'true'
 *   4. bootstrap-token authorization (harness already owns this)
 *   5. nonce matches per activation
 *   6. mode + routeKey are allowlisted
 *
 * Any missing gate fails closed with HTTP 403. A packaged
 * production build has neither the env vars nor the route mounted;
 * the module returns 404 in that shape.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Modes + allowlisted routes
// ---------------------------------------------------------------------------

export const NATIVE_INDUCTION_MODES = [
  'none',
  'stale_response',
  'degraded_response',
  'unavailable_response',
  'contract_mismatch',
] as const;
export type NativeInductionMode = typeof NATIVE_INDUCTION_MODES[number];

/**
 * ONLY these routes may be induced. Every one is a read-only
 * business-data probe; NONE of them are auth, order, safety,
 * Coinbase, or configuration surfaces. Adding a new key here MUST
 * be paired with a request from the induction consumer test.
 */
export const NATIVE_INDUCTION_ROUTE_KEYS = [
  'reconciliationStatus',
  'scannerReadiness',
  'observerPolicyVersions',
] as const;
export type NativeInductionRouteKey = typeof NATIVE_INDUCTION_ROUTE_KEYS[number];

// ---------------------------------------------------------------------------
// Request/response schemas
// ---------------------------------------------------------------------------

export const NativeInductionActivateRequestSchema = z.object({
  mode: z.enum(NATIVE_INDUCTION_MODES).refine((m) => m !== 'none', {
    message: `activate mode cannot be 'none'`,
  }),
  routeKey: z.enum(NATIVE_INDUCTION_ROUTE_KEYS),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'nonce must be 16-64 url-safe chars'),
  ttlMs: z.number().int().min(1_000).max(300_000).optional(),
}).strict();
export type NativeInductionActivateRequest = z.infer<typeof NativeInductionActivateRequestSchema>;

export const NativeInductionClearRequestSchema = z.object({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
}).strict();
export type NativeInductionClearRequest = z.infer<typeof NativeInductionClearRequestSchema>;

export const NativeInductionStateSchema = z.union([
  z.object({
    kind: z.literal('inactive'),
  }).strict(),
  z.object({
    kind: z.literal('active'),
    mode: z.enum(NATIVE_INDUCTION_MODES),
    routeKey: z.enum(NATIVE_INDUCTION_ROUTE_KEYS),
    activatedAt: z.string(),
    expiresAt: z.string(),
    // The nonce is NEVER returned; the caller supplies it and must
    // remember it locally. The state endpoint reports whether an
    // induction is active, not who owns it.
  }).strict(),
]);
export type NativeInductionState = z.infer<typeof NativeInductionStateSchema>;

export const NativeInductionOkResponseSchema = z.object({
  ok: z.literal(true),
  state: NativeInductionStateSchema,
}).strict();

export const NativeInductionErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.enum([
    'policy_disabled_not_test_mode',
    'policy_disabled_diagnostics_off',
    'policy_disabled_server_not_external',
    'policy_disabled_packaged',
    'invalid_body',
    'nonce_mismatch',
    'mode_conflict_already_active',
    'unknown_route',
    'unknown_mode',
    'not_found',
  ]),
  detail: z.string().optional(),
}).strict();

// ---------------------------------------------------------------------------
// Pure policy gate — the SAME check runs on both the request-time
// authorization path AND the boot-time route-mount decision.
// ---------------------------------------------------------------------------

export interface NativeInductionPolicyInput {
  readonly nodeEnv: string | undefined;
  readonly nativeDiagnostics: string | undefined;
  readonly serverExternal: string | undefined;
  readonly isPackaged: boolean;
}

export type NativeInductionPolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'policy_disabled_not_test_mode' | 'policy_disabled_diagnostics_off' | 'policy_disabled_server_not_external' | 'policy_disabled_packaged' };

/**
 * Pure. Returns whether the induction route may be mounted / a
 * request may proceed. Every gate must independently pass.
 */
export function decideNativeInductionPolicy(input: NativeInductionPolicyInput): NativeInductionPolicyDecision {
  if (input.isPackaged) return { allowed: false, reason: 'policy_disabled_packaged' };
  if (input.nodeEnv !== 'test') return { allowed: false, reason: 'policy_disabled_not_test_mode' };
  if (input.nativeDiagnostics !== 'true') return { allowed: false, reason: 'policy_disabled_diagnostics_off' };
  if (input.serverExternal !== 'true') return { allowed: false, reason: 'policy_disabled_server_not_external' };
  return { allowed: true };
}
