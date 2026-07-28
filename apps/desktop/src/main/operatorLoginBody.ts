/**
 * Stage 3C-CI-FIX10A §1 — operator-login request body builder.
 *
 * The server's login Zod schema (apps/server/src/routes/auth.ts:57-62)
 * declares:
 *
 *   installationId: z.union([z.number().int(), z.string().max(64)]).optional()
 *   clientVersion:  z.string().max(64).optional()
 *
 * `.optional()` accepts `undefined`, NOT `null`. Because `JSON.stringify`
 * serialises `null` (only `undefined` is dropped), constructing the body
 * with `{ installationId: this.installationId }` when `installationId`
 * is `null` produced `"installationId": null` on the wire — which the
 * server's Zod parse rejected with `invalid_body` (400) BEFORE
 * credential verification. That was the FIX10 native run's exact
 * failure signature.
 *
 * This helper builds a body that is:
 *   - typed to a discriminated shape (never `any`, never Record<string, unknown>);
 *   - free of `null` on optional fields — an absent value is omitted
 *     by not writing the key at all, so the JSON never carries it;
 *   - deterministic in field ordering (matches the schema declaration
 *     order) so a serialization audit can grep for the byte sequence.
 *
 * The helper is pure — no I/O, no logging, no dependency on network
 * or process state. It is unit-testable in isolation and its output is
 * a compile-time-known concrete type.
 */

/**
 * Caller input. Accepts the wider `number | string | null | undefined`
 * shape for `installationId` because several call sites carry the
 * value from row/column layers that use `null` (database contracts).
 * The helper normalizes at the HTTP boundary.
 */
export interface OperatorLoginInput {
  username: string;
  password: string;
  installationId?: number | string | null;
  clientVersion?: string;
}

/**
 * Canonical outbound body — a discriminated shape rather than an
 * inline object literal so the OMITTED-field invariant is expressed
 * in the type system. `installationId` and `clientVersion` are
 * marked optional with `?:` (their absence is meaningful: it means
 * "server, do not associate this login with any installation / client
 * version"). `null` is NOT a valid value for either optional field —
 * the type system rejects it at every call site.
 */
export interface OperatorLoginBody {
  readonly username: string;
  readonly password: string;
  readonly installationId?: number | string;
  readonly clientVersion?: string;
}

/**
 * Builds the exact body that the desktop main process sends to
 * POST /api/operator-auth/login. Fields whose input is `null`, `undefined`,
 * or (for `clientVersion`) an empty string are OMITTED — the returned
 * object simply has no such key, so `JSON.stringify` cannot emit them.
 *
 * Field order is fixed: username → password → installationId → clientVersion.
 * This makes serialization audits (grep for the exact byte sequence)
 * deterministic.
 *
 * Special validation:
 *   - username, password: pass through unchanged. Normalization
 *     (trim/case) is intentionally NOT done here — the server side
 *     owns credential canonicalization to keep a single source of
 *     truth. See apps/server/src/auth/accounts.ts.
 *   - installationId: numbers pass through. Non-empty strings pass
 *     through unchanged (server accepts numeric OR string per Zod
 *     union). Empty string is TREATED AS ABSENT — the server rejects
 *     `z.string().max(64)` with a min(1) implicit only if the caller
 *     forgot to unset; empty is semantically "no installation".
 *   - clientVersion: pass through unchanged unless empty.
 */
export function buildOperatorLoginBody(input: OperatorLoginInput): OperatorLoginBody {
  const installationId = normalizeInstallationId(input.installationId);
  const clientVersion = normalizeClientVersion(input.clientVersion);
  // Object.assign of conditionally-included keys — using `...` spread
  // with an empty object when the field is absent means the key is
  // never written into the result. Post-condition: hasOwnProperty
  // returns false for every omitted optional.
  const body: OperatorLoginBody = {
    username: input.username,
    password: input.password,
    ...(installationId === undefined ? {} : { installationId }),
    ...(clientVersion === undefined ? {} : { clientVersion }),
  };
  return body;
}

/**
 * Normalizes an installation ID to `number | string | undefined`.
 * Null → undefined. Empty string → undefined. Everything else passes
 * through, preserving the numeric-vs-string distinction the server
 * schema differentiates.
 */
function normalizeInstallationId(v: number | string | null | undefined): number | string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string' && v.length === 0) return undefined;
  return v;
}

/**
 * Normalizes a clientVersion to `string | undefined`. Undefined and
 * empty string are both treated as absent.
 */
function normalizeClientVersion(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (v.length === 0) return undefined;
  return v;
}
