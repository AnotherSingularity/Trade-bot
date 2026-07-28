/**
 * Stage 3C-CI-RESET §2 — Shared operator-auth HTTP contract.
 *
 * The audit (Trade-bot Ruthless Audit §P1.1) established that
 * duplicated schemas across server / desktop / IPC / tests caused
 * the FIX9 (`error` vs `reason` drift) and FIX10 (`installationId:
 * null`) failures. Both regressions passed local tests because the
 * copied schema never disagreed with the server.
 *
 * This module is the SINGLE source of truth for every operator-auth
 * HTTP schema. Server routes, desktop request construction, IPC
 * contract, integration tests, and body-serialization unit tests all
 * import from here. A schema drift becomes a compile-time / parse-time
 * error, never a silent field-name typo.
 *
 * The module lives in @horizon/shared so both apps/server and
 * apps/desktop can consume it without a cross-workspace source
 * dependency. Package export tacked on in index.ts.
 *
 * Absolute secret boundaries (§2.2):
 *  - Renderer-facing schemas MUST NOT expose accessToken, refreshToken,
 *    bootstrap token, password, password hash, or raw server error body.
 *  - Only the SanitizedAuthState projection reaches the renderer.
 *  - The TokenPair projection is main-process only.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Machine-readable failure reasons — the closed set of values that
// `AuthOperationResponse.reason` may carry. Adding a new failure
// reason requires touching this list (and every downstream consumer
// forced to handle it exhaustively via z.enum().parse).
// ---------------------------------------------------------------------------

export const OPERATOR_AUTH_FAILURE_REASONS = [
  // From the server login route (apps/server/src/routes/auth.ts).
  'password_mismatch',
  'not_found',
  'locked',
  'disabled',
  'recovery_required',
  'rate_limited',
  'invalid_body',
  // Manager-side (network / envelope / infrastructure).
  'no_refresh_token',
  'unauthenticated',
  'already_rotated_family_revoked',
  'absolute_expired',
  'refresh_expired',
  'refresh_reuse_detected',
  'setup_failed',
  'accounts_already_exist',
] as const;

export const OperatorAuthFailureReasonSchema = z.union([
  z.enum(OPERATOR_AUTH_FAILURE_REASONS),
  // The server also emits `status_<N>` and `api_<status>` as
  // fallbacks when a response body is malformed. Keep them permissive
  // via a pattern rather than enumerating every HTTP code.
  z.string().regex(/^(status|api)_\d{3}$/),
]);

// ---------------------------------------------------------------------------
// Operator auth phase — the sanitized state phase enum.
// The renderer switches on this value; every phase is auditable.
// ---------------------------------------------------------------------------

export const OPERATOR_AUTH_PHASES = [
  'setup_required',
  'unauthenticated',
  'authenticated',
  'locked',
  'session_expired',
  'session_revoked',
  'account_locked',
  'password_change_required',
  'bootstrap_unavailable',
] as const;
export type OperatorAuthPhase = (typeof OPERATOR_AUTH_PHASES)[number];

// ---------------------------------------------------------------------------
// Sanitized auth state — the ONLY auth surface the renderer ever
// sees. No tokens, no hashes, no password bytes.
// ---------------------------------------------------------------------------

export const SanitizedAuthStateSchema = z.object({
  phase: z.enum(OPERATOR_AUTH_PHASES),
  username: z.string().nullable(),
  passwordChangedAt: z.string().nullable(),
  accessExpiresAt: z.string().nullable(),
  absoluteExpiresAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  failureReason: z.string().nullable(),
}).strict();
export type SanitizedAuthState = z.infer<typeof SanitizedAuthStateSchema>;

// ---------------------------------------------------------------------------
// Server-side account projection (sanitized) — what the server login
// response body carries in `account`. Not exposed to the renderer.
// ---------------------------------------------------------------------------

export const OPERATOR_ACCOUNT_STATUSES = [
  'active', 'locked', 'disabled', 'recovery_required',
] as const;

export const OperatorAccountSchema = z.object({
  id: z.number().int().positive(),
  username: z.string().min(1).max(64),
  status: z.enum(OPERATOR_ACCOUNT_STATUSES),
  credentialVersion: z.number().int().nonnegative(),
  passwordChangedAt: z.string(),
}).strict();
export type OperatorAccount = z.infer<typeof OperatorAccountSchema>;

// ---------------------------------------------------------------------------
// Server-side token pair — main-process ONLY. Never exposed via IPC.
// ---------------------------------------------------------------------------

export const IssuedTokenPairSchema = z.object({
  accessToken: z.string().min(1),
  accessExpiresAt: z.string(),
  refreshToken: z.string().min(1),
  refreshExpiresAt: z.string(),
  absoluteExpiresAt: z.string(),
  sessionId: z.number().int().positive(),
}).strict();
export type IssuedTokenPair = z.infer<typeof IssuedTokenPairSchema>;

// ---------------------------------------------------------------------------
// REQUEST schemas — server accepts, desktop constructs.
// ---------------------------------------------------------------------------

export const OperatorSetupRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  passwordConfirmation: z.string().min(1).max(256),
}).strict();
export type OperatorSetupRequest = z.infer<typeof OperatorSetupRequestSchema>;

export const OperatorLoginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  // `.optional()` accepts `undefined`, NOT `null`. This is the
  // structural gate that FIX10A wire-body normalization respects.
  installationId: z.union([z.number().int(), z.string().max(64)]).optional(),
  clientVersion: z.string().max(64).optional(),
}).strict();
export type OperatorLoginRequest = z.infer<typeof OperatorLoginRequestSchema>;

export const OperatorRefreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(256),
}).strict();
export type OperatorRefreshRequest = z.infer<typeof OperatorRefreshRequestSchema>;

export const OperatorChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
  newPasswordConfirmation: z.string().min(1).max(256),
}).strict();
export type OperatorChangePasswordRequest = z.infer<typeof OperatorChangePasswordRequestSchema>;

export const OperatorEmptyRequestSchema = z.object({}).strict();
export type OperatorEmptyRequest = z.infer<typeof OperatorEmptyRequestSchema>;

// ---------------------------------------------------------------------------
// SERVER response schemas — main-process consumes.
// ---------------------------------------------------------------------------

export const OperatorSetupServerResponseSchema = z.object({
  account: OperatorAccountSchema,
}).strict();
export type OperatorSetupServerResponse = z.infer<typeof OperatorSetupServerResponseSchema>;

export const OperatorLoginServerResponseSchema = z.object({
  account: OperatorAccountSchema,
  tokens: IssuedTokenPairSchema,
}).strict();
export type OperatorLoginServerResponse = z.infer<typeof OperatorLoginServerResponseSchema>;

export const OperatorRefreshServerResponseSchema = z.object({
  tokens: IssuedTokenPairSchema,
}).strict();
export type OperatorRefreshServerResponse = z.infer<typeof OperatorRefreshServerResponseSchema>;

// Generic HTTP failure body used by the server for 4xx auth
// responses. `reason` is populated for enumerated failures;
// `detail` is a short human-readable extra string.
export const OperatorAuthFailureBodySchema = z.object({
  error: z.string().min(1).max(64),
  reason: z.string().min(1).max(64).optional(),
  detail: z.string().max(400).optional(),
  lockedUntil: z.string().optional(),
  failedAttempts: z.number().int().nonnegative().optional(),
}).strict();
export type OperatorAuthFailureBody = z.infer<typeof OperatorAuthFailureBodySchema>;

// The bootstrap-safe /state endpoint (renderer boot).
export const OperatorAuthStateServerResponseSchema = z.object({
  known: z.boolean(),
  setupCompleted: z.boolean(),
  timestamp: z.string(),
}).strict();
export type OperatorAuthStateServerResponse = z.infer<typeof OperatorAuthStateServerResponseSchema>;

// ---------------------------------------------------------------------------
// IPC / renderer-facing sanitized response — { ok, state, reason }.
//
// This is the ONLY auth response shape the renderer sees. Tokens are
// filtered out in the main process; the phase/username/expiries here
// are all safe to display in a Chromium context.
// ---------------------------------------------------------------------------

export const AuthOperationResponseSchema = z.object({
  ok: z.boolean(),
  state: SanitizedAuthStateSchema,
  reason: z.string().nullable(),
}).strict();
export type AuthOperationResponse = z.infer<typeof AuthOperationResponseSchema>;

// ---------------------------------------------------------------------------
// Helper — validate a server response body against the appropriate
// schema. Returns { ok: true, value } or { ok: false, code } — never
// throws. The caller (AuthenticatedApiClient) turns the code into a
// typed `contract_mismatch` error.
// ---------------------------------------------------------------------------

export type ContractValidation<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'contract_mismatch'; detail: string };

export function validateAgainst<T>(schema: z.ZodType<T>, input: unknown): ContractValidation<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const first = parsed.error.issues[0];
  const detail = first
    ? `${first.path.join('.') || '<root>'}: ${first.message}`
    : 'schema_parse_failed';
  return { ok: false, code: 'contract_mismatch', detail };
}
