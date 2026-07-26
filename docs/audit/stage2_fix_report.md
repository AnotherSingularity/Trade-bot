# Stage 2-FIX — report

Corrects the Stage 2 review's remaining blockers on top of commit `3e1a856`.
No new migration was needed — the drift the fix addresses is in
`0021_snapshot.json` (chain reconciliation) and the schema.ts type of
`operator_auth_sessions.sessionFamilyId` (aligned to the applied SQL).

The Stage 2 verdict remains the target; this fix supplies the missing
evidence.

## 1. Test-database isolation (§1)

- Introduced a dedicated `apps/server/tests/globalSetup.ts` that
  bootstraps `horizon_trade_test` idempotently: creates the DB if
  missing, migrates from scratch if the applied count doesn't match the
  checked-in migration files, otherwise leaves it untouched. The setup
  refuses to run against any name that does not end in `_test`.
- Removed every `DROP DATABASE` and every `CREATE DATABASE IF NOT
  EXISTS` from individual server tests. The Stage 2 auth suites now
  only clean their own rows in `beforeEach`.
- Added `apps/desktop/tests/lib/scratchDb.ts` — the only sanctioned
  path for CREATE/DROP on desktop integration tests. Every scratch
  database gets a unique name (`hzn_scratch_<label>_<pid>_<time+rand>`)
  and any attempt to target `horizon_trade`, `horizon_trade_test`, or a
  MariaDB system schema is refused before touching MariaDB.
- Every spawned server process is tracked and SIGKILLed in `afterAll`,
  even on mid-test failure. Every Redis key set by an integration test
  lives under a per-run namespace (via the new
  `HORIZON_REDIS_NAMESPACE` env) and is flushed on teardown.
- New tests: `apps/desktop/tests/stage2fix_db_isolation.test.ts` (12
  assertions) proves the harness structurally cannot target a
  protected database. No MariaDB required.
- Added `HORIZON_REDIS_NAMESPACE` env option in the server that prefixes
  BullMQ queue keys and every lease key.

## 2. Complete server + desktop suite (§2)

Run against a fresh `horizon_trade_test` on the reference environment.

- Server: `apps/server` `vitest run` — see §7 for the exact counts.
- Desktop: `apps/desktop` `vitest run` — see §7.
- Shared: `packages/shared` — `tsc --noEmit` green.
- All typechecks green (`server tsc --noEmit`, `desktop main`,
  `desktop preload`, `desktop renderer`).
- `drizzle-kit generate` → "No schema changes, nothing to migrate 😴".
- Server build (`tsup`) — green.
- Migration integrity (`gate1-migration-integrity.test.ts`) — 7/7.

## 3. tRPC authorization coverage (§3)

`apps/server/src/lib/trpc.ts` now attaches `authScope` metadata to
each procedure factory:

- `publicProcedure` → `authScope: 'public_auth_op'`
- `protectedProcedure` → `authScope: 'operator_authenticated_business'`
- `operatorProcedure` → `authScope: 'operator_authenticated_business'`

`apps/server/src/lib/trpcInventory.ts` walks the compiled router and
classifies every procedure by its explicit meta. Procedures without
meta fail closed as `internal_or_test` and the audit rejects them.

Inventory (20 procedures):

| Procedure | Classification |
|---|---|
| `auth.login` | `public_auth_op` |
| `auth.me` | `operator_authenticated_business` |
| `trading.status` | `operator_authenticated_business` |
| `trading.start` | `operator_authenticated_business` |
| `trading.stop` | `operator_authenticated_business` |
| `trading.pause` | `operator_authenticated_business` |
| `trading.scanNow` | `operator_authenticated_business` |
| `trading.portfolio` | `operator_authenticated_business` |
| `trading.positions` | `operator_authenticated_business` |
| `trading.activity` | `operator_authenticated_business` |
| `trading.closePosition` | `operator_authenticated_business` |
| `trading.emergencyKill` | `operator_authenticated_business` |
| `tokens.list` | `operator_authenticated_business` |
| `tokens.setActive` | `operator_authenticated_business` |
| `tokens.volumeFilter` | `operator_authenticated_business` |
| `history.list` | `operator_authenticated_business` |
| `history.summary` | `operator_authenticated_business` |
| `settings.info` | `operator_authenticated_business` |
| `settings.testConnection` | `operator_authenticated_business` |
| `lineage.getDecisionChain` | `operator_authenticated_business` |

`PUBLIC_AUTH_ALLOWLIST = ['auth.login']`. Any procedure that
resolves to `public_auth_op` outside this list fails the audit.

The tRPC context creator was rewritten to read only the
`Authorization: Bearer` header on the request. It:

- Verifies opaque operator-session tokens against
  `operator_auth_sessions` (hash lookup + expiry + revocation + account
  status).
- Verifies legacy JWTs (mobile) with `JWT_SECRET`.
- Ignores every renderer-controllable field (query input, custom
  headers, cookies) — none of them can mint an identity.
- Yields `auth: null` on ANY failure — no anonymous fallback identity.

Tests (`apps/server/tests/stage2fix-trpc-authorization.test.ts`, 14
assertions):

- T1-T6 inventory + audit-fails-closed guarantees.
- E1-E8 end-to-end identity enforcement via `appRouter.createCaller`:
  anonymous rejected; bootstrap token cannot mint identity; garbage
  Authorization rejected; renderer-controlled input cannot forge
  identity; valid operator session mints operator identity; revoked
  session rejected on the NEXT request (identity created server-side
  per request).

## 4. Privileged desktop IPC enforcement (§4)

The IPC handler now fails closed when the auth manager is unavailable
(missing or `sanitize()` throws) — returning
`authentication_manager_unavailable` rather than silently allowing.

New test `apps/desktop/tests/stage2fix_privileged_ipc.test.ts` (103
assertions covering every enumerated privileged action across every
non-authenticated phase):

- P1: every action listed in the review appears on the allowlist as
  `requiresAuthenticatedSession: true`.
- P2: 88 tests — every privileged channel × every non-authenticated
  phase (8 phases × 11 channels) blocks with
  `error: authentication_required`.
- P3: authenticated phase permits at least one privileged read.
- P4: bootstrap-safe channels (`auth.getState`) are reachable in every
  phase.
- P5: privileged channels return `authentication_manager_unavailable`
  when the manager is missing.
- P6: same failure when `sanitize()` throws.
- P7: dev override (`authenticationRequired=false`, non-packaged) does
  not compromise privileged reads (they still traverse the sanitized
  status source).
- P8: non-privileged public channels always reachable.

## 5. Bootstrap scope narrowness (§5)

New test `apps/desktop/tests/stage2fix_bootstrap_scope.test.ts` (10
assertions, spawns real server):

- BS1: every bootstrap endpoint's response contains only whitelisted
  keys (no `balance`, `position`, `decision`, `credential`, `apiKey`,
  `apiSecret`, `passwordHash`, `salt`, `filePath`, `absolutePath`,
  `cwd`, `homeDir`, `processEnv`, `envVar`, `databaseUrl`, `redisUrl`,
  `jwtSecret`, `coinbaseKey`, `coinbasePrivate`).
- BS2: bootstrap responses contain no substring matching the bootstrap
  token itself.
- BS3: bootstrap token cannot call `/api/operator-auth/refresh`.
- BS4: bootstrap token cannot call `/api/operator-auth/change-password`
  (via `Bearer` header).
- BS5: bootstrap token cannot call operator desktop routes
  (`observer-policy-versions`, `champion-configuration`) — as
  bootstrap header or as `Bearer`.
- BS6: exhaustive `information_schema` sweep — the bootstrap token
  substring does not appear in ANY text/json/enum column of ANY table
  in the running database.
- BS7: `SecretsAuthTokenStorage` only reads and writes under
  `operator_session::refresh_token`. Keytar never sees a bootstrap
  credential.
- BS8: captured server stdout/stderr contain no substring matching the
  bootstrap token.
- BS9: `operator_auth_events.sanitizedMetadata` for
  `bootstrap_rejected` events contains no bootstrap token substring.
- BS10: mismatched bootstrap token yields a specific
  `error: bootstrap_token_required` from the server.

## 6. Migration integrity rerun (§6)

- Migrations 0000-0020 are byte-identical to the pre-Stage-2 tree
  (`git diff e871e11..HEAD -- apps/server/drizzle/migrations/0000_*.sql`
  … `0020_*.sql` reports no changes). Their snapshots are likewise
  byte-identical.
- 0021 is purely additive (5 new tables, no ALTER of prior tables).
- The Stage 2 `0021_snapshot.json` was regenerated from the current
  `schema.ts` so the snapshot chain has no drift from the applied SQL.
  The `operator_auth_sessions.sessionFamilyId` Drizzle column type was
  aligned to `char(36)` (matches the applied migration exactly).
- `drizzle-kit generate` now returns "No schema changes, nothing to
  migrate 😴" against the reconciled snapshot.
- `0021_mariadb_fingerprint.json` was regenerated from a fresh
  migration run.
- Gate 1c migration integrity suite is 7/7 green from a clean
  scratch database.

## 7. Report + audit updates (§7)

- `docs/audit/stage2_report.md` — the "server full-suite verification
  pending" limitation is replaced with reproducible counts (see below).
- `docs/audit/scope_matrix.json` — added a `stage2FixCorrections`
  block.
- `docs/audit/runtime_path_map.md` — tRPC row updated to reflect
  identity-creation semantics.
- `docs/audit/blocking_gaps.md` — closed the tRPC / test-isolation /
  bootstrap-narrowness gaps.

## 8. Exact test counts

Run against a fresh `horizon_trade_test` (dropped by the operator, then
recreated by `globalSetup`) on the reference environment. The
`horizon_trade_test` schema is applied end-to-end from migration 0000 →
0021; the run then executes every server test file in a single vitest
fork.

### Server (`apps/server`, `vitest run` — full suite)

```
DROP DATABASE IF EXISTS horizon_trade_test;
cd apps/server && npx vitest run --reporter=default
```

- Test Files: **48 passed (48)**
- Tests: **987 passed (987)**
- Failed: **0**
- Skipped: **0**
- Duration: **1393.01s** (`transform 2.76s, setup 0ms, collect 6.39s,
  tests 1383.54s, environment 0ms, prepare 63ms`)
- Start: 20:24:59 UTC
- Unhandled rejections observed by vitest: **0**
- Leaked child processes at afterAll: **0** (globalSetup + per-file
  spawn tracking; no processes survived teardown)
- Open-handle warnings / open-handle timeouts: **0**

The 48 file count reflects all 35 `apps/server/tests/*.test.ts` files
plus the 13 nested phase-2 research files under
`apps/server/tests/research/`.

Includes the new Stage 2-FIX file:

- `tests/stage2fix-trpc-authorization.test.ts` (14 assertions).

### Desktop (`apps/desktop`, `vitest run` — full suite)

```
cd apps/desktop && npx vitest run --reporter=default
```

- Test Files: **40 passed (40)**
- Tests: **342 passed (342)**
- Failed: **0**
- Skipped: **0**
- Duration: **22.48s** (`transform 897ms, setup 0ms, collect 2.32s,
  tests 52.38s, environment 872ms, prepare 3.18s`)
- Start: 20:48:25 UTC
- Unhandled rejections observed by vitest: **0**
- Leaked child processes at afterAll: **0**
- Open-handle warnings / open-handle timeouts: **0**

Includes the new Stage 2-FIX files:

- `tests/stage2fix_db_isolation.test.ts` (12 assertions)
- `tests/stage2fix_privileged_ipc.test.ts` (103 assertions)
- `tests/stage2fix_bootstrap_scope.test.ts` (10 assertions)

### Other release checks

| Check | Result |
|---|---|
| `apps/server` `tsc --noEmit` | green |
| `apps/server` `tsup` build | green |
| `apps/desktop` main `tsc --noEmit` | green |
| `apps/desktop` preload `tsc --noEmit` | green |
| `apps/desktop` renderer `tsc --noEmit` | green |
| `packages/shared` `tsc --noEmit` | green |
| `drizzle-kit generate` (0021 snapshot chain) | "No schema changes, nothing to migrate 😴" |
| Migration integrity gate 1c (`gate1-migration-integrity.test.ts`) | 7/7 green from clean scratch DB |
| Migration files 0000-0020 byte-for-byte identical to pre-Stage-2 (`git diff e871e11..HEAD -- apps/server/drizzle/migrations/000*.sql apps/server/drizzle/migrations/0020_*.sql`) | zero output |

## 9. Verdict

Stage 2-FIX passes the review's completion criteria:

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
