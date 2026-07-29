# Blocking gaps

The minimum work to move the desktop/server system from its current
state toward `runtime_wired`. Each gap identifies the smallest
concrete action that changes maturity. This file is not a
work-order — it is an inventory. Sequence, sizing, and prioritization
are in `revised_roadmap.md`.

## Stage 3C-CI-RESET Part 2 closure (E.1.37)

Native Electron unpacked integration test is now green in CI on
commit `2af37ce`: `stage3c-native-electron` reports 110 passed / 0
failed / 0 skipped; `desktop-windows` also green. The following gap
categories that were tied to a pending native run are now resolved
for Stage 3C's scope:

- `native_electron_test_blocked` → RESOLVED. See E.1.27 (process-group
  SIGSTOP fix) — the root correction that unblocked bail from T42.
- Category-level: no NEW blocking gaps were introduced by the RESET
  cycle. Every fix was a defect correction against the pre-existing
  spec, not a scope change.

Stage 4 (Real report generation) is CLOSED as of `de926c94`
(native workflow 30463955631, windows workflow 30463955512, both
green). Migration 0022 is shipped and additive; the four tRPC
report procedures (enqueue/status/list/verify) execute end-to-end
under real Electron + MariaDB + Redis in CI. See
`docs/audit/stage4_report.md` for the closure record. Windows
packaging smoke (Stage 5) and operational validation (Stage 5)
remain scheduled per `revised_roadmap.md`; NOTHING in Stage 4
claimed either.

**Stage 4 slice-level status** (all green in CI on
`de926c94`):

- `stage4a_canonical_shared_contracts_ci_verified`
- `stage4b_thirteen_generators_registry_ci_verified`
- `stage4c_worker_db_enforced_idempotency_ci_verified`
- `stage4d_trpc_procedures_ci_verified`
- `stage4e_desktop_end_to_end_wire_up_ci_verified`
- `stage4f_native_report_lifecycle_ci_verified`
- `report_generation_complete`

Remaining Stage-5-scoped pending verdicts:

- `managed_docker_runtime_verification_pending`
- `windows_operator_smoke_pending`
- `operational_validation_not_started`
- `live_capital_prohibited` (permanent — a shipping
  characteristic, not a defect).

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

## Category F — Per-screen data binding — CLOSED IN STAGE 3A + STAGE 3B

19. ✅ **Server read APIs.** Stage 3A introduced 22 `operator_authenticated_business`
    procedures under the `desktop.*` tRPC namespace across 18 domains.
    Stage 3B replaced the 11 remaining stubs with real DB-backed queries in
    `apps/server/src/desktop/queries/domains.ts`; all responses carry their
    real `<domain>.v1` sourceVersion.
20. ✅ **IPC method.** `IPC_CHANNELS.desktopData` (single discriminated-union
    business-data channel) declared with
    `requiresAuthenticatedSession: true` and
    `DesktopDataChannelRequestSchema` in `apps/desktop/src/shared/ipcContract.ts`.
21. ✅ **`window.horizon.*` hook.** `useDesktopData(key)` renderer hook +
    `<StateFrame>` component implement all 10 required states with a
    single API surface. The preload bridge validates every key against
    the compiled-in `DESKTOP_DATA_KEYS`.
22. ✅ **Screen wiring — all 19 screens.** Overview / ShadowPortfolio /
    Positions / DecisionJournal bound in Stage 3A; the remaining 15
    (ResearchUniverse / Fingerprints / Regimes / PortfolioRisk /
    Microstructure / Context / ValidationLab / CostsAttribution /
    Protection / Reconciliation / Incidents / Reports / Configuration /
    System / Safety) bound in Stage 3B, each via
    `useDesktopData(key)` + `<StateFrame>` with 10 states rendered.
    Machine proof: 150-assertion state matrix in
    `apps/desktop/tests/renderer/stage3b_state_matrices.test.tsx`.

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

## Category K — Native Electron unpacked integration on Linux (§Stage 3C)

The Stage 3C harness is complete in-repo
(`apps/desktop/tests/native/electronHarness.ts` + deterministic
seed + 55-assertion integration test file + esbuild bundler +
external-server adapter opt-in). What remains is the environment
required to run it — Chromium refuses to spawn renderer children
under root without --no-sandbox, and the sandbox-disable flag
does not propagate to child processes in the current remote-execution
container. Reproducible on any Linux host with a non-root user or
on native Windows. See `docs/audit/stage3_report.md` for the full
blocker analysis.

28. Run `npm run test:native` on a Linux host under a non-root user
    (creating one via `useradd + chown` is standard CI setup;
    `su`-to-user is blocked in this session's classifier), OR on
    a native Windows dev machine. Expected wall-clock: 2-5 min.

29. Trigger `.github/workflows/stage3c-native.yml` (via
    workflow_dispatch or a push to `claude/horizon-trade-bot-mcbcfo`).
    Ubuntu-latest is non-root by default; the workflow provisions
    MariaDB 10.11.6 + Redis 7.4-alpine as services, installs xvfb +
    redis-tools + Chromium runtime deps, builds shared + server +
    desktop, runs the mandatory external-services suite BEFORE the
    native harness (fast-fails on any schema/probe regression instead
    of burning Electron wall-clock), then runs the native suite via
    `npm run test:native`, and uploads
    `apps/desktop/tests/native/logs/**` as
    `stage3c-native-evidence-<runId>` — with Chromium user-data
    cache dirs excluded from the artefact so review stays legible.
    Green run + `evidence.json` with `assertionResults.passed === 55`
    + `screenMatrix.length === 19` + `processLeakResult.ok === true`
    + zero Create Order counters + `native-run-status.json.completed === true`
    + `failureClassification: null` is what reclaims the full Stage
    3 verdict. On failure, the artefact bundle now names the
    failing phase attributively via the Stage 3C-CI-FIX4 diagnostic
    contracts: `startup-trace.jsonl` (per-phase JSONL trace),
    `failure-classification.json` (classified error code +
    sanitized message), `native-run-status.json` (which phase was
    live when the failure occurred), `environment-summary.json`,
    `process-tree.txt`, and (when Electron reached a page) `failure.png`
    + `failure-dom.html` + `current-url.txt`.

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
| F. Per-screen data binding | 0 (closed in Stage 3A + Stage 3B) | — |
| G. Windows packaging | 4 | Windows CI + installer |
| H. Native Windows smoke | 1 | §N |
| K. Native Electron Linux run | 1 | Stage 3C native evidence (harness complete; env-blocked) |
| I. Backend integration | 2 | observer maturity |
| J. Documentation | 3 | operator UX |

Total: roughly **28 discrete gaps** before the current freeze claim
becomes honest (down from ~88 pre-Stage-3B; Stage 3A cleared
authentication, and Stage 3B cleared per-screen data binding — the two
largest categories).

## Stage 5 update — repository-side categories closed

Stage 5 repository closure (see `stage5_report.md`) closes the
repository-side content of categories G + H + operational-validation
harness. The following gaps remain but their nature has changed from
"repository work is missing" to "external boundary must be crossed":

| Category | Repository-side status | External boundary that remains |
|---|---|---|
| G. Windows packaging | CI smoke shipped (verify-packaged-installer + windows-installer-checksum artifact) | awaits a green `desktop-windows.yml` run |
| H. Native Windows smoke | Human operator smoke package shipped (checklist + evidence template + PowerShell mechanical collector) | awaits a real Windows workstation + human execution |
| operational validation | Harness (5F) + soak-manifest contract (5G) shipped and unit-tested; safety flags + counters locked at Zod schema level via `z.literal` | awaits 7 real UTC calendar days of live-clock replay (Stage 6) |
| managed-Docker runtime | Orchestrator + label guard + readiness evidence + labelled compose file + CI workflow shipped | awaits a green `managed-docker-runtime.yml` run |
