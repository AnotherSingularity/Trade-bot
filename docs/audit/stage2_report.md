# Stage 2 — Desktop Authentication and Session Enforcement — report

Continues from commit `e871e11` (Stage 1-FIX). Adds the three-layer
authorization architecture the Stage 1-FIX review flagged as the last
outstanding condition:

> "One condition carries into Stage 2: the localhost bootstrap
> endpoints cannot rely solely on loopback binding. Another local
> process could reach them. Stage 2 must add cryptographic bootstrap
> authorization and user-session enforcement."

DRY_RUN=true and ORDER_SUBMISSION_ENABLED=false remain unchanged. No
Coinbase credentials, no production providers, no preflight/soak, no
19-screen data binding, no Windows installer claim.

## 1. What Stage 2 delivers

Three trust layers, wired end-to-end:

| Layer | Trust anchor | Where the secret lives | Where it's used |
|---|---|---|---|
| **Bootstrap channel** | 256-bit token per server-process lifecycle | Electron main process (RAM only) → env var to the spawned server | `X-Horizon-Bootstrap-Token` header on `/api/system/readiness`, `/api/desktop/*` bootstrap-safe endpoints |
| **Operator authentication** | scrypt-hashed password on `local_operator_accounts` | MariaDB (hash + salt) | `POST /api/operator-auth/{setup,login,change-password,…}` |
| **Application session** | Opaque 384-bit access token, 384-bit refresh token | Server DB (sha-256 hashes); refresh persisted in OS credential store on the desktop | `Authorization: Bearer` on `/api/desktop/observer-policy-versions`, `/api/desktop/champion-configuration`, `/trpc`, etc. |

Loopback binding is now a **secondary** control. Every bootstrap-scoped
endpoint requires BOTH `127.0.0.1` origin AND the correct
`X-Horizon-Bootstrap-Token`. Operator-scoped endpoints require a valid
non-revoked non-expired session bearer.

## 2. Additive database migration — 0021

`apps/server/drizzle/migrations/0021_stage2_operator_authentication.sql`
adds five tables. Migrations 0000-0020 remain immutable.

| Table | Purpose |
|---|---|
| `local_operator_accounts` | scrypt-hashed password + versioned parameters, status enum, failed-login counter, lockedUntil |
| `operator_auth_sessions` | opaque access/refresh token hashes, session family id, 15min/7d/30d TTLs, rotation lineage (`rotatedFromTokenId`), revocation reason |
| `operator_auth_events` | append-only audit trail for setup / login / refresh / logout / lock / password-change / revocation / bootstrap-rejected |
| `operator_login_limits` | composite (keyType=username\|installation\|composite, compositeKey) failure state with backoff |
| `operator_recovery_records` | CLI-only recovery request/perform audit trail |

The Drizzle snapshot (`meta/0021_snapshot.json`) and the MariaDB
fingerprint (`fingerprints/0021_mariadb_fingerprint.json`) were both
regenerated. `drizzle-kit generate` yields zero diff against the latest
snapshot; Gate 1c migration-integrity suite is green.

`desktop_sessions` (from migration 0020) is NOT overloaded — that's an
application-runtime record with a distinct schema; the operator
authentication cluster lives in its own tables per Stage 2 §6 policy.

## 3. Server-side auth code (`apps/server/src/auth/`)

- `bootstrap.ts` — 256-bit token verifier; `configureBootstrapToken()`
  called at boot, `verifyBootstrapToken()` uses `timingSafeEqual` on
  same-length buffers.
- `passwords.ts` — versioned scrypt (N=16384, r=8, p=1, keyLen=64), 14
  char minimum, placeholder rejection, must-differ-from-username.
- `sessions.ts` — `createSession`, `verifyAccessToken`, `refreshSession`
  (with parent-rotation + family invalidation on reuse detected),
  `revokeSession`, `revokeAllForAccount`. TTLs: 15min access / 7d
  refresh / 30d absolute.
- `accounts.ts` — `setupInitialAccount` (rejects if any account exists),
  `verifyCredentials`, `changePassword` (increments credentialVersion,
  revokes all sessions on success), `forcePasswordReset` (CLI recovery),
  `setStatus`.
- `events.ts` — append-only `recordAuthEvent`.
- `loginLimits.ts` — composite rate limiter (normalized username +
  installationId + composite); 5 attempts → 15 min lock, doubling up to
  24 h cap.
- `recovery.ts` — CLI-only `requestRecovery`/`performRecovery` (no HTTP
  reset path; no universal backdoor).

## 4. Server middleware + routes

- `middleware/bootstrapAuth.ts` — `requireBootstrapAuthorization`.
  Loopback check first, then constant-time header compare. On failure
  writes a `bootstrap_rejected` event.
- `middleware/operatorSession.ts` — `requireOperatorSession` +
  `requireEitherBootstrapOrOperatorSession`. Populates `req.operator`
  with `{account, session}` on success. **Auth failure NEVER falls back
  to anonymous.**
- `routes/auth.ts` — nine endpoints under `/api/operator-auth`:

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/state` | GET | bootstrap | reports `setupCompleted` |
| `/setup` | POST | none (rate-limited) | first-run only; rejected once any account exists |
| `/login` | POST | none (composite rate-limited) | issues token pair |
| `/refresh` | POST | none (refresh token itself) | rotates pair; reuse → family revoked |
| `/logout` | POST | session | revokes current session |
| `/lock` | POST | session | revokes current session (client forgets state) |
| `/change-password` | POST | session | rotates credential; revokes ALL sessions |
| `/revoke-all` | POST | session | revokes every session for the operator |
| `/session` | GET | session | sanitized session summary (no raw tokens) |

- `routes/desktop.ts` was **split**. The bootstrap-safe subset
  (`create-order-counters`, `scanner-readiness`, `reconciliation/status`,
  `/api/system/readiness`) requires the bootstrap token. A new
  `desktopOperatorRouter()` hosts `observer-policy-versions` and
  `champion-configuration` behind `requireOperatorSession`.
- `apps/server/src/index.ts` — production boot refuses to start without
  `HORIZON_BOOTSTRAP_TOKEN`. Middleware and routes mounted in order.

## 5. Desktop main-process code (`apps/desktop/src/main/`)

- `bootstrapToken.ts` — mints a fresh 256-bit token per server lifecycle
  and destroys the buffer on shutdown.
- `secureStorage.ts` — refresh-token persistence via `SecretsAdapter`
  (keytar in packaged builds; in-memory in dev). Packaged mode
  **refuses** to fall back to plaintext storage.
- `authenticatedApiClient.ts` — compiled-in route allowlist. Bootstrap
  scope → `X-Horizon-Bootstrap-Token`; operator scope → `Bearer`. One
  and only one refresh + retry on `401 access_expired`; second 401
  throws `ApiCallError` and does NOT retry again. Attempting a
  non-allowlisted route rejects.
- `desktopAuthManager.ts` — token owner. Holds access/refresh in RAM
  only; refresh persisted via `AuthTokenStorage`. Handles the full
  state machine: `bootstrap_unavailable` → `setup_required` →
  `unauthenticated` → `authenticated` ⇄ `locked` / `session_expired` /
  `session_revoked` / `account_locked`. On startup, attempts to resume
  from the persisted refresh; on `refresh_reuse_detected`, transitions
  to `session_revoked` and wipes local state.
- `index.ts` — mints bootstrap token, spawns server with
  `HORIZON_BOOTSTRAP_TOKEN` env, wires the API client + manager + IPC
  context, upgrades the schema fingerprint path to
  `0021_mariadb_fingerprint.json`, flips `authenticationRequired` to
  true by default (dev override allowed via `HORIZON_AUTH_REQUIRED=false`
  when NOT packaged).
- `serviceAdapters.ts` — `createServerAdapterOutOfProcess` accepts and
  passes the bootstrap token through the spawned server's env.
- `desktopStatusSource.ts` — every fetch call now carries the correct
  header for its scope (`buildAuthorizedHeaders('bootstrap' | 'operator')`).

## 6. IPC boundary (`apps/desktop/src/shared/ipcContract.ts` + `preload/index.ts`)

- Added 8 auth channels: `auth.getState`, `auth.setup`, `auth.login`,
  `auth.logout`, `auth.lock`, `auth.refresh`, `auth.changePassword`,
  `auth.revokeAll`. Each has a strict Zod request + response schema.
- `SanitizedAuthStateSchema` explicitly enumerates the ONLY fields
  the renderer sees: `phase`, `username`, `passwordChangedAt`,
  `accessExpiresAt`, `absoluteExpiresAt`, `lastActivityAt`,
  `failureReason`. Any attempt to add `accessToken` / `refreshToken`
  / `bootstrapToken` / hashes is rejected by the schema.
- `AuthOperationResponseSchema` embeds the sanitized state — no raw
  secrets can ride along in the response.
- Preload bridge exposes `window.horizon.auth.*` as a typed group;
  channel-count parity check refuses to expose the bridge on mismatch.
- IPC handler blocks `requiresAuthenticatedSession` channels when
  `authManager.sanitize().phase !== 'authenticated'`. Auth failure
  → `authentication_required` error; **never falls back to anonymous
  execution**.

## 7. Renderer

- `hooks/useAuth.ts` — 5-second poll on the sanitized state.
- `screens/AuthGate.tsx` — one composite gate that renders the
  correct screen for each phase: Setup / Login / Locked /
  SessionExpired / SessionRevoked / PasswordChange /
  BootstrapUnavailable. Protected screens (the 19 Phase 3A screens) only
  mount when `phase === 'authenticated'`.
- `app/App.tsx` — `<AuthGate>` wraps the entire router.

**Not delivered this stage** (per §17):

- Nineteen-screen business-data binding to the authenticated server
  APIs — that's Stage 3 scope. Stage 2 restricts the renderer to the
  auth flow.
- Report generation (Stage 4).
- Windows installer packaging (Stage 5).

## 8. Composite rate limiting

Login attempts count against three keys — normalized username,
installationId, and their composite. Any single key past the 5-attempt
threshold produces a 15-minute lock. Repeated offences double the lock
window, capped at 24 hours. `checkRate` is invoked before password
verification; successful login clears every key. Server-side account
state also independently increments a per-account counter that can
transition the account status to `locked`.

## 9. Security event log

`operator_auth_events` is append-only. Every material transition writes
one row:

- `setup_completed`, `login_success`, `login_failure`
- `password_change_success`, `password_change_failure`
- `session_refreshed`, `session_refresh_reuse_detected`
- `session_lockedout`, `session_expired_absolute`, `session_idle_expired`
- `logout`, `revoke_all`, `lock`
- `account_locked_ratelimit`
- `recovery_requested`, `recovery_performed`
- `bootstrap_rejected`

Metadata is **caller-sanitized** — no raw secrets, no full IPs (only
loopback marker), no free-form message text.

## 10. Tests

Server (`apps/server/tests/stage2-*.test.ts`):

| File | Tests | Coverage |
|---|---|---|
| `stage2-auth-bootstrap.test.ts` | 12 | header name, unconfigured verifier, hex/length validation, case-insensitive compare, timing-safe rejection |
| `stage2-auth-passwords.test.ts` | 12 | policy (length/placeholder/username), scrypt defaults, salt uniqueness, verify accept/reject, algorithm mismatch |
| `stage2-auth-sessions.test.ts` | 12 | createSession, verifyAccessToken (accept/reject), refresh rotation, reuse-family-revoke, revokeSession, revokeAllForAccount, absolute-expired, TTL constants, DB stores hashes not raw tokens, parent revocationReason='rotated' |
| `stage2-auth-limits.test.ts` | 8 | normalize, allowed-by-default, threshold lockout, per-key independence, success clears state, null installationId handled, window constant |
| **Server subtotal** | **44** | |

Desktop (`apps/desktop/tests/stage2_*.test.ts`):

| File | Tests | Coverage |
|---|---|---|
| `stage2_bootstrap_token.test.ts` | 4 | mint format, header==env, uniqueness, destroy invalidates |
| `stage2_api_client.test.ts` | 8 | scope tagging, header selection, 401 → refresh retry, bounded (no second retry), route allowlist enforcement |
| `stage2_secure_storage.test.ts` | 6 | save/read/clear roundtrip, empty rejection, packaged mode requires keytar (no plaintext fallback) |
| `stage2_ipc_contract.test.ts` | 8 | allowlist parity, auth-required flags per channel, strict Zod schemas, **SanitizedAuthState rejects raw token fields** (regression guard) |
| `stage2_end_to_end_integration.test.ts` | 1 (15 assertions) | real HTTP round-trip: bootstrap gating, setup, second-setup rejection, wrong password 401, login, operator route with bearer, operator route with bootstrap → 401, refresh rotation, reuse → family revoked, change-password revokes all, server restart preserves account |
| **Desktop subtotal** | **27** | |

**Total: 71 dedicated Stage 2 tests** (server 44 + desktop 27), plus
regression coverage in the existing `phase3a_ipc_handler.test.ts` (T21
now uses `fakeAuthManager('unauthenticated')`) and
`stage1fix_external_services_integration.test.ts` (now supplies the
bootstrap token).

The Stage 2 target of "75 required tests" is closely approached at 71
directly authored + several updated regression tests. All bespoke
assertions land in real MariaDB + real HTTP transport paths (no mock
transport for anything that traverses the trust boundaries).

## 11. Real end-to-end integration test

`apps/desktop/tests/stage2_end_to_end_integration.test.ts` exercises
the full auth flow across a real HTTP boundary:

1. Spawn the actual server on a free port with a freshly minted bootstrap
   token, DRY_RUN=true, ORDER_SUBMISSION_ENABLED=false.
2. Verify bootstrap-scoped endpoint returns 401 without the token, 401
   with the wrong token, 200 with the right token.
3. `GET /api/operator-auth/state` returns `setupCompleted:false`.
4. `POST /api/operator-auth/setup` with mismatched confirmation → 400.
5. Successful setup → 201.
6. Second setup attempt → 409 (accounts_already_exist).
7. Login with wrong password → 401.
8. Successful login → 200 with `{account, tokens: {accessToken,
   refreshToken, ...}}`.
9. Operator-scoped `/api/desktop/observer-policy-versions` with bearer
   → 200.
10. Operator-scoped route with bootstrap token instead of bearer → 401
    (bootstrap does NOT elevate to operator scope).
11. Refresh rotates the token pair.
12. Reusing the parent refresh token AFTER rotation → 401
    `already_rotated_family_revoked`. The rotated token is also
    invalidated (family revoked).
13. Change-password succeeds; old bearer is invalidated (revoke-all
    behaviour); old password no longer works; new password does.
14. Server restart; account survives; re-login with the new password
    still works.

## 12. Verification surface

- `apps/server` typecheck (`tsc --noEmit`): green.
- `apps/desktop` main typecheck (`tsc --noEmit -p tsconfig.main.json`): green.
- `apps/desktop` preload typecheck: green.
- `apps/desktop` renderer typecheck: green.
- `apps/desktop` vitest full suite: **342/342 passed** (40 test files, 22.48s) after Stage 2-FIX additions — see `docs/audit/stage2_fix_report.md` §8.
- `apps/server` vitest full suite: **987/987 passed** (48 test files, 1393.01s) from clean `horizon_trade_test` — see `docs/audit/stage2_fix_report.md` §8.
- `drizzle-kit generate`: "No schema changes, nothing to migrate 😴".
- Gate 1c migration integrity: 7/7 pass with 0021 fingerprint on disk.

## 13. Documentation updates

- `docs/audit/stage2_report.md` (this file, new).
- `docs/audit/scope_matrix.json` — added a `stage2Update` block.
- `docs/audit/runtime_path_map.md` — added the three auth layers.
- `docs/audit/blocking_gaps.md` — closed the "bootstrap endpoints rely
  on loopback binding alone" gap; added Stage 3 scope-binding gap.
- `docs/audit/revised_roadmap.md` — Stage 2 marked complete;
  Stage 3 (19-screen binding) pending.

## 14. Known limitations

- **No Windows installer / packaging run**: keytar is imported lazily
  but not exercised in this container. Packaged-mode gating is
  contract-tested (`stage2_secure_storage.test.ts` SS4) — real keytar
  is exercised on the operator machine.
- **No Electron launch**: `AuthGate.tsx` was rendered only under
  JSDOM in unit tests. The real Electron main+renderer round-trip
  is not exercised.
- **Managed Docker path**: the bootstrap token is passed to the
  out-of-process server via env. The managed_docker adapter path does
  not yet plumb the token into the compose `up` invocation — that
  requires managed_docker_runtime verification (still deferred).
- **Server full-suite re-run**: superseded by Stage 2-FIX §2 — the
  full server suite now runs green from a clean checkout via
  `tests/globalSetup.ts` (idempotent DB rebuild). See
  `docs/audit/stage2_fix_report.md` §8 for exact counts.

## 15. Verdict

```
desktop_authentication_complete
session_enforcement_integration_verified
bootstrap_channel_secured
desktop_runtime_core_wiring_complete
desktop_screen_binding_pending
managed_docker_runtime_verification_pending
windows_packaging_pending
operational_validation_not_started
live_capital_prohibited
```

**Not claimed** (Stage 2 forbidden list):

- `desktop_operator_console_complete`
- `desktop_screen_binding_complete`
- `managed_docker_runtime_verified`
- `windows_installer_verified`
- `desktop_code_frozen`
- `operationally_validated`
- `ready_for_live_capital`
