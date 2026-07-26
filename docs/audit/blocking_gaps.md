# Blocking gaps

The minimum work to move the desktop/server system from its current
state toward `runtime_wired`. Each gap identifies the smallest
concrete action that changes maturity. This file is not a
work-order — it is an inventory. Sequence, sizing, and prioritization
are in `revised_roadmap.md`.

## Category A — Desktop production runner (blocks arrows 3-8)

1. **Implement a real `DockerCommandRunner`.** Spawn the `docker`
   CLI (`child_process.spawn`), stream stdout/stderr, capture exit
   codes. Reject if `docker --version` fails.
2. **Implement a real `ExternalServiceProbe`.** Use `mysql2/promise`
   to run `SELECT 1` against `HORIZON_MARIADB_URL`. Use `ioredis`
   `PING` for `HORIZON_REDIS_URL`. Both must be `keytar`-backed for
   credentials.
3. **Reconcile compose service names.** Either rename `db`→`mariadb`
   in both compose files (breaks anyone using the current names) or
   change `serviceAdapters.ts` to say `db`. Recommendation: rename to
   `mariadb` for clarity + update tests.
4. **Select a compose file at runtime.** `AdapterConfig.composeDir`
   is set; nothing selects `docker-compose.prod.yml` vs
   `docker-compose.yml`. Add an env var
   `HORIZON_COMPOSE_FILE=docker-compose.prod.yml`.
5. **Wire main/index.ts to use the real runner.** Replace `new
   InMemoryRunner()` with the real implementation when
   `NODE_ENV=production` (retain InMemoryRunner for the vitest
   harness).
6. **Persist supervisor state.** `desktop_service_states` +
   `desktop_service_events` are schema-only. On every transition,
   insert a row (mediated by an authenticated internal API).

## Category B — Migration + schema fingerprint (blocks arrow 6-7)

7. **Implement real `ServerAdapter.migrate`.** Spawn
   `drizzle-kit migrate --config apps/server/drizzle.config.ts`.
   Capture output; on non-zero exit, transition supervisor to
   `failed`.
8. **Implement real `ServerAdapter.synchronize`.** Compute a live
   fingerprint (`INFORMATION_SCHEMA.COLUMNS` hash); compare to
   `apps/server/drizzle/fingerprints/<N>_mariadb_fingerprint.json`.
   Transition to `failed` on mismatch.
9. **Rev `localEnvironment.ts` schema default from `0019` to
   `0020`.** Stale default causes Overview to lie.

## Category C — Authentication (blocks safety-critical IPC) — CLOSED IN STAGE 2

10. ✅ **`authenticationRequired: true` in production boot.** Flipped to
    true by default in `apps/desktop/src/main/index.ts`; only overridable
    via `HORIZON_AUTH_REQUIRED=false` in non-packaged builds.
11. ✅ **Setup/login screens** — `AuthGate.tsx` renders Setup / Login /
    Locked / PasswordChange / SessionExpired / SessionRevoked. Renderer
    posts to typed IPC channels; passwords never appear in any IPC
    response or log.
12. ✅ **IPC contract carries auth phase.** Every IPC channel with
    `requiresAuthenticatedSession: true` is blocked when
    `authManager.sanitize().phase !== 'authenticated'`. Auth failure
    NEVER falls back to anonymous.
13. ✅ **Sessions persisted.** New tables via migration 0021
    (`operator_auth_sessions`, `operator_auth_events`,
    `operator_login_limits`, `operator_recovery_records`,
    `local_operator_accounts`) — separate from `desktop_sessions`
    (application-runtime scope).
14. ✅ **Bootstrap channel secured.** 256-bit
    `X-Horizon-Bootstrap-Token` header + constant-time verify.
    Loopback binding is a secondary control only.
15. ✅ **tRPC authorization coverage proven (Stage 2-FIX §3).** Every
    procedure carries `authScope` meta; unclassified procedures fail
    closed; anonymous callers rejected on protected procedures;
    bootstrap tokens cannot mint identity; renderer-controlled fields
    cannot forge identity.
16. ✅ **Privileged desktop IPC enforcement matrix (Stage 2-FIX §4).**
    103 assertions cover every enumerated action × every non-authenticated
    phase; handler fails closed when the auth manager is missing.
17. ✅ **Bootstrap scope narrowness (Stage 2-FIX §5).** 10 assertions
    prove response allowlist, token absence in DB / keytar / logs /
    events, and refusal of operator paths.
18. ✅ **Test-database isolation (Stage 2-FIX §1).** Server tests never
    drop the shared DB; desktop scratch DBs use unique names with
    hard-refusal for protected names; per-run Redis namespace; all
    spawned children terminated on afterAll.

## Category D — Real safety values (blocks Overview + Safety + Configuration)

14. **Add server endpoints for the values the desktop shows:**
    - `GET /desktop/createOrderCounters`
    - `GET /desktop/schemaFingerprint`
    - `GET /desktop/championConfiguration`
    - `GET /desktop/observerPolicyVersions`
15. **Replace hardcoded `createOrderCounters`, `championConfiguration`,
    `observerPolicyVersions`, `schemaVersion` in
    `apps/desktop/src/main/index.ts`** with real queries via a new
    `ServerApiClient`.

## Category E — Reports (blocks Reports screen)

16. **Implement per-kind report generators on the server.** 13
    endpoints returning deterministic bytes with checksum.
17. **Implement redaction wrapper.** Apply
    `apps/desktop/src/main/logging.ts::redact` (or equivalent) to
    every export before it's written to the operator-selected folder.
18. **Bind the Reports screen** — invoke `exportReport` when the
    operator clicks a kind + format; render the returned
    `artifactPath` + `checksum`; open the folder on success.

## Category F — Per-screen data binding (blocks 15 of 19 screens)

For each of the 15 non-bound screens, four things need to happen:

19. **Server read API** returning the data the screen would show.
20. **IPC method** in `ipcContract.ts` + `preload/index.ts` +
    `main/ipc.ts`.
21. **`window.horizon.*` hook** in `hooks/useHorizon.ts`.
22. **Screen wiring** in `renderer/screens/<Screen>.tsx` — replace
    `EmptyState` with real data + loading/empty/healthy/degraded/
    failed/stale/unauth/api-error states.

Per screen, roughly 3-6 hours of work. 15 screens → substantial.

## Category G — Windows packaging (blocks §M + §N)

23. **Widen `build.files`** to include every module needed by
    `dist/main` and `dist/preload`. Recommend switching to
    `asarUnpack: ['node_modules/keytar/**']` and letting
    node-file-trace assemble the rest, THEN audit the actual
    installer contents.
24. **Decide server distribution model.** Option A (bundle server
    into installer) vs Option B (require operator to run server via
    Docker separately). Update the installer accordingly.
25. **Fix the CI build-manifest step.** `npx ts-node
    build/generate-build-manifest.ts` fails on Node 20 with ESM. Fix
    by (a) compiling the manifest generator to `.js` before running,
    (b) using `--loader ts-node/esm`, or (c) rewriting the script
    in plain JS. Recommendation: (c) — it's a small utility.
26. **Achieve first green Windows CI build.** Not before Category A-C
    are functional enough that the packaged app is meaningful.

## Category H — Native Windows smoke test (§N)

27. Only after Category G produces an actual installer, execute the
    full §N sequence (install → launch → login → navigate → export →
    shutdown → relaunch → uninstall) on a clean Windows VM.

## Category I — Backend integration (unblocks observer maturity to `runtime_wired`)

28. Wire Phase 2A-2F observer harnesses into a real shadow tick.
    Today they run against fixtures only.
29. Attach a genuine market-data supervisor (Phase 3C precondition,
    not this scope).

## Category J — Documentation

30. Update `README.md` to document the desktop workspace, its
    dependencies, and how to run it in dev mode.
31. Extend `CHANGELOG.md` to record Phase 3A + 3B additions.
32. Mark each historical `PHASE*.md` as "historical claim; see
    `docs/audit/claim_reconciliation.md` for corrected status" at
    the top.

## Summary counts

| Category | Gap count | Blocking |
|---|---|---|
| A. Desktop production runner | 6 | arrows 3-8 |
| B. Migration + fingerprint | 3 | arrows 6-7 |
| C. Authentication | 4 | safety-critical IPC |
| D. Real safety values | 2 | Overview/Safety/Configuration |
| E. Reports | 3 | Reports screen |
| F. Per-screen data binding | 4 per screen × 15 = 60 | 15 screens |
| G. Windows packaging | 4 | Windows CI + installer |
| H. Native Windows smoke | 1 | §N |
| I. Backend integration | 2 | observer maturity |
| J. Documentation | 3 | operator UX |

Total: roughly **88 discrete gaps** before the current freeze claim
becomes honest.
