# Revised roadmap

Corrected sequence from the current scope-reconciliation baseline to
genuine code freeze and (eventually) a certified live-capital
canary. Each stage lists its entry criteria (what must already be
proven), exit criteria (what maturity level the stage achieves), and
which `blocking_gaps.md` categories it consumes.

## Stage 0 — Scope Reconciliation Gate (this commit)

- **Entry**: none.
- **Exit**: baseline audit committed; every prior verdict
  reclassified; no implementation change.
- **Consumes**: none (audit only).
- **Verdict**: `scope_reconciliation_required` → `scope_reconciliation_complete`.

## Stage 1 — Desktop operational wiring

- **Entry**: Stage 0 committed.
- **Exit**:
  - Real `DockerCommandRunner` + `ExternalServiceProbe` (Cat A 1-2)
  - Compose service names reconciled (Cat A 3-4)
  - `main/index.ts` uses the real runner in production (Cat A 5)
  - Supervisor state persisted (Cat A 6)
  - Real migrate + fingerprint verification (Cat B 7-9)
  - Manual verification: on a Linux dev machine, launch the desktop
    against Docker → observe MariaDB + Redis actually start →
    observe migration actually run → observe schema fingerprint
    matches. Record the log in `docs/audit/stage1_smoke.md`.
- **Consumes**: Categories A + B.
- **Verdict**: `desktop_service_supervisor: runtime_wired` for
  MariaDB + Redis + server on Linux.

## Stage 2 — Authenticated desktop API integration ✅ COMPLETE

- **Entry**: Stage 1-FIX committed.
- **Delivered**:
  - `authenticationRequired: true` by default in production boot.
  - Cryptographic bootstrap channel — 256-bit token, constant-time
    verify. Bootstrap endpoints require BOTH loopback + header token.
  - Operator auth model: scrypt (versioned), composite rate limits,
    session model (15 min / 7 d / 30 d + family rotation on refresh
    with reuse-invalidation).
  - Nine `/api/operator-auth/*` REST endpoints + append-only auth
    event log.
  - Desktop main-process auth manager owns tokens (RAM + keytar for
    refresh). Renderer receives ONLY `SanitizedAuthState`.
  - Renderer `<AuthGate>` handles setup / login / locked / expired /
    revoked / password-change / bootstrap-unavailable.
  - Additive migration 0021 (`local_operator_accounts`,
    `operator_auth_sessions`, `operator_auth_events`,
    `operator_login_limits`, `operator_recovery_records`).
- **Not delivered** (Stage 3 scope): 19-screen data binding to
  authenticated business APIs; report generation (Stage 4); Windows
  installer (Stage 5).
- **Verdict achieved**: `desktop_authentication_complete +
  session_enforcement_integration_verified +
  bootstrap_channel_secured` (see `stage2_report.md`).
- **Old planned scope-binding**: was to bind 4 of 19 screens here.
  Deferred to Stage 3 per the Stage 2 work order — Stage 2 restricts
  the renderer to the auth flow.

## Stage 3 — Full screen binding ✅ COMPLETE

### Stage 3A — foundation + reference bindings (complete)

- **Delivered**: shared `DesktopDataEnvelope<T>` v3.0.0 contract + 22
  operator-authenticated tRPC procedures across 18 domains + main-process
  `DesktopDataClient` + `desktop.data` IPC channel with authenticated
  discriminated-union schema + `useDesktopData` hook + `<StateFrame>`
  10-state renderer + Overview / ShadowPortfolio / Positions /
  DecisionJournal bound end-to-end. See `stage3a_report.md` +
  `stage3a-fix-readonly-boundaries.test.ts` + Stage 3A-FIX corrections.

### Stage 3B — remaining 15 screens (complete)

- **Entry**: Stage 3A + Stage 3A-FIX committed.
- **Delivered**:
  - Replaced the 11 remaining stub query services with real DB-backed
    reads in `apps/server/src/desktop/queries/domains.ts`; every response
    envelope carries its real `<domain>.v1` sourceVersion. Isolated the
    incident-acknowledge audit-insert into
    `apps/server/src/desktop/audit/operatorActions.ts` (outside
    `desktop/queries/`) so the read-only boundary test enforces zero
    mutations in the query layer.
  - Rebuilt all 15 remaining renderer screens (ResearchUniverse /
    Fingerprints / Regimes / PortfolioRisk / Microstructure / Context /
    ValidationLab / CostsAttribution / Protection / Reconciliation /
    Incidents / Reports / Configuration / System / Safety) using
    `useDesktopData(key)` + `<StateFrame>`, preserving mandatory
    banners (LIVE ORDER SUBMISSION DISABLED on every screen; OBSERVER
    ENFORCEMENT DISABLED + KELLY DISABLED on PortfolioRisk; PRODUCTION
    LEVEL-2 PROVIDER INACTIVE + QUEUE POSITION NOT KNOWN on
    Microstructure; PROSPECTIVE EVIDENCE PENDING + MODEL PROMOTION
    DISABLED on ValidationLab).
  - Full 10-state matrix machine-checked for every remaining screen via
    the 150-assertion `apps/desktop/tests/renderer/stage3b_state_matrices.test.tsx`
    (15 screens × loading / healthy / empty / stale / degraded /
    unavailable / unauthorized / session_expired / api_failure /
    contract_mismatch).
  - Cursor pagination for the list domains (universe, fingerprints,
    validation, reconciliation, incidents) — all cursors are opaque
    base64url-encoded JSON; invalid cursors reject with unavailable.
  - Honesty proof in `apps/server/tests/stage3b-domain-honesty.test.ts`
    (13 assertions covering §21 items 2, 3, 4, 15, 18-24, 30-33).
- **Consumes**: Category F.
- **Verdict achieved**: `stage3b_screen_binding_complete +
  all_19_desktop_screens_bound +
  authenticated_desktop_data_integration_verified` (see
  `stage3b_report.md`). `desktop_screen_binding_complete_final` is NOT
  claimed — native Electron smoke, report generation, managed-Docker
  runtime verification, and Windows packaging remain pending.

### Stage 3C — native Electron unpacked integration (blocked in remote CI)

- **Entry**: Stage 3B committed.
- **Delivered**:
  - `apps/desktop/src/main/serviceAdapters.ts` —
    `createServerAdapterExternal(rt, fingerprintPath)` opt-in adapter
    (`HORIZON_SERVER_EXTERNAL=true`, packaged-build guard).
  - `apps/desktop/src/main/index.ts` — external-adapter selection +
    `HORIZON_ELECTRON_NO_SANDBOX` opt-in (Chromium sandbox flags
    for Xvfb-under-Linux CI).
  - `apps/desktop/build/bundle-main.mjs` — esbuild post-tsc bundler
    inlining `@horizon/shared` into `dist/main/main/index.js` +
    `dist/preload/preload/index.js`. Wired into `npm run build`.
  - `apps/desktop/tests/native/electronHarness.ts` — reusable
    Playwright `_electron` harness (real MariaDB scratch DB +
    real Redis namespace + real Horizon server + Xvfb Electron).
  - `apps/desktop/tests/native/deterministicSeed.ts` — raw-SQL
    seed covering 13 domains (never an economic write; no orders;
    no Coinbase calls); fixed timestamps + IDs.
  - `apps/desktop/tests/native/nativeElectron.integration.test.ts` —
    55-assertion suite covering every spec §12 item.
  - `apps/desktop/vitest.native.config.ts` + `npm run test:native`
    script.
- **Not delivered under this environment**: the native run itself.
  The Electron main process boots (IPC handlers register) but
  Chromium refuses to spawn renderer children under root without
  a propagating `--no-sandbox` flag. Standard CI workaround
  (non-root user) blocked by the session's classifier.
- **Verdict achieved**: `stage3b_screen_binding_complete +
  all_19_desktop_screens_bound +
  authenticated_desktop_data_integration_verified +
  native_electron_test_blocked` (see `docs/audit/stage3_report.md`).
- **Next**: run `npm run test:native` on a compatible host to
  produce the missing 55-assertion output; then reclaim
  `native_electron_unpacked_integration_verified`.

### Stage 3C-ENV — closure of Stage 3C reviewer-identified gaps

- **Entry**: Stage 3C committed (`8fde5cf`).
- **Delivered**:
  - `apps/desktop/src/main/localEnvironment.ts` —
    `resolveSandboxPolicy` pure resolver hardening the Xvfb sandbox
    opt-in (packaged builds always keep sandbox on; test-only
    accommodation requires strict NODE_ENV=test + envOptIn=='true'
    + !isDevelopmentFake triple; non-canonical env values rejected).
  - `apps/desktop/src/main/index.ts` — single call site consumes
    the resolver + logs the decision + reason.
  - `apps/desktop/tests/main/sandbox_policy.test.ts` — 8 pure unit
    tests locking every branch.
  - `apps/desktop/tests/native/deterministicSeed.ts` — seed
    expanded from 13 to 24 domains; `REQUIRED_MINIMUM_SEED_ROWS`
    (14, hard-fail) + `RECOMMENDED_SEED_ROWS` (10 Phase 2 observer
    tables, advisory); `assertSeedCoverageComplete` returns
    `SeedCoverageResult` for CI reporting.
  - `apps/desktop/tests/native/nativeElectron.integration.test.ts` —
    19 per-screen `T-sig[<key>]` assertions matching seeded
    signature strings + `T-coverage` hard gate + tightened `T36`
    (lock+re-nav asserts unauthorized state, not cached rows) +
    `T-evidence` writes `evidence.json`.
  - `apps/desktop/tests/native/electronHarness.ts` —
    `checkProcessLeak`, `sanitizeLog`, `writeEvidenceBundle`
    (contract `stage3c-native-evidence.v1`), `writeSanitizedLog`.
  - `.github/workflows/stage3c-native.yml` — CI job on
    `ubuntu-latest` (non-root) with MariaDB 11 + Redis 7 services,
    xvfb-run + Chromium runtime deps, native suite invocation,
    log artefact upload.
- **Not delivered under this environment**: the native run itself.
  Delegated to the CI workflow; local harness proceeds through the
  entire boot + seed pipeline until Chromium's root-sandbox refusal
  (documented in Stage 3C §2).
- **Verdict achieved**: `stage3c_native_harness_implemented +
  stage3c_native_harness_completeness_hardened +
  stage3c_native_runtime_verification_pending_ci_run +
  all_19_screens_unit_bound +
  authenticated_desktop_data_integration_unit_verified +
  native_electron_test_blocked_container_only`.
- **Next**: trigger `.github/workflows/stage3c-native.yml`; upon
  green + evidence.json manifest matching Stage 3C-ENV §21.8, reclaim
  `desktop_screen_binding_complete +
  native_electron_unpacked_integration_verified +
  all_19_screens_runtime_verified`.

### Stage 3C-CI-FIX4 — bounded native diagnostics + Windows test isolation

- **Entry**: Stage 3C-CI-FIX3 committed (`e6aa0c0`); Stage 3C-CI-FIX3
  CI showed the native workflow hitting a 15-minute Playwright
  `_electron.launch` hang with no attributable phase, and the
  Windows workflow failing on cross-platform path assertions +
  service-dependent tests running without provisioned services.
- **Exit criteria delivered**:
  - New diagnostics module `apps/desktop/tests/native/nativeDiagnostics.ts`
    with `NATIVE_STARTUP_PHASES`, `StartupTrace` (synchronous JSONL),
    `withNativeTimeout(phase, ms, promise)` (deterministic
    `native_startup_timeout:<phase>` error code), `NativeRunStatus`
    (`stage3c-native-run-status.v1`), `writeFailureClassification`
    (`stage3c-native-failure.v1`), `sanitizeDiagnosticMessage`
    (Bearer / mysql:// / hex-token redaction), and
    `nativeDiagnosticsEnabled` (strict test-only opt-in — packaged
    builds structurally cannot enable).
  - `electronHarness.launchElectron` split into three separately
    bounded phases: electron_launch 60s, first_window 60s,
    renderer_dom 45s. A hang in any phase produces a specific
    error code + a `failed` JSONL entry.
  - `nativeElectron.integration.test.ts` `beforeAll` wrapped in
    try/catch/finally; on failure emits
    `failure-classification.json` + `environment-summary.json` +
    `process-tree.txt` + `failure.png` / `failure-dom.html` /
    `current-url.txt` to both workflow-level and per-run log dirs
    before rethrowing. `ci-bootstrap.txt` overwritten at native
    entry so `native_test_started=true` reflects real state.
  - Test-suite scoping partitioned into three configs:
    portable (`vitest.config.ts`, excludes native + service-dependent
    tests), external (`vitest.external.config.ts`, service-dependent
    with `singleFork:true`), native (`vitest.native.config.ts`,
    xvfb + electron). Windows runs portable only.
  - Windows path portability fixed: `stage1_runtime_assets.test.ts`
    uses `path.normalize` equality helper instead of forward-slash
    substring assertions.
  - CI workflow: external-services suite runs BEFORE native harness
    with `HORIZON_REQUIRE_EXTERNAL_SERVICES=true`; Chromium
    user-data cache dirs excluded from artefact upload.
  - New unit tests: 13 in `nativeDiagnostics.test.ts` + 20 in
    `ci_test_isolation.test.ts`.
- **Verdict achieved**: `stage3c_native_bounded_diagnostics_landed +
  stage3c_windows_unit_isolation_landed +
  stage3c_native_runtime_verification_pending_ci_run`.
- **Next**: trigger `.github/workflows/stage3c-native.yml`; upon
  green + `native-run-status.json.completed=true` +
  `failureClassification:null` + `evidence.json` matching §21.8,
  reclaim the runtime verdicts. If the workflow fails, the artefact
  bundle now names the failing phase attributively.

### Stage 3C-CI-FIX5 — renderer-ready watchdog + Windows manifest tooling

- **Entry**: FIX4 CI runs at `edd9d04` proved two narrow failures:
  native #5 hung immediately after `renderer_dom_loaded` with no
  `renderer_ready` phase ever recorded (untraced post-DOM code
  consumed the workflow budget); Windows #17 broke at
  `npx ts-node build/generate-build-manifest.ts dist` (unpinned
  dynamic download + ESM loader mismatch).
- **Exit criteria delivered**:
  - `withNativeTimeout('renderer_ready', 60_000, initializeAndAwaitRendererReady(page))`
    wraps the entire post-DOM initialisation. Probe waits for
    `window.horizon` shape — the smallest observable proof preload
    ran and the IPC bridge is live.
  - Outer `withNativeTimeout('before_all', 180_000, ...)` watchdog
    prevents a future untraced hang from consuming the workflow
    budget.
  - `NativeRunStatus` split: new `startupComplete` field + new
    `markStartupComplete()` method. `completed:true` only flips
    in `afterAll` after full teardown succeeds. A hung run cannot
    leave `completed:true`.
  - `beforeAll` catch block writes failure-classification /
    environment-summary / process-tree / failure.png / failure-dom /
    current-url FIRST, then invokes `boundedPartialTeardown()`
    with 30s caps.
  - `sanitizeProcessTreeText` applies per-line redaction with no
    global slice; `spawnSync` uses 8MB `maxBuffer`. Process-tree
    files no longer truncate at 4096 bytes.
  - `ensureRequiredLogFilesExist(logsDir)` pre-creates the five
    diagnostic log sinks at native-test entry.
  - Native workflow artefact upload flipped from exclusion-glob
    to inclusion-allowlist. `electron-userdata/` never uploaded
    recursively; only named diagnostic files ship.
  - `apps/desktop/package.json` adds `build:manifest` script backed
    by `tsx` (declared devDep). `.github/workflows/desktop-windows.yml`
    replaces `npx ts-node ...` with `npm run build:manifest -- dist`.
  - New unit tests: 3 in `renderer_ready_watchdog.test.ts` +
    4 in `build_manifest.test.ts`.
- **Verdict achieved**: `stage3c_renderer_ready_watchdog_landed +
  stage3c_windows_manifest_tooling_landed +
  stage3c_native_runtime_verification_pending_ci_run +
  desktop_windows_portability_pending_ci_run`.
- **Next**: trigger `.github/workflows/stage3c-native.yml` +
  `.github/workflows/desktop-windows.yml`; upon green +
  native-run-status.completed=true + failureClassification:null
  + all 55 assertions + all 19 manifest screens, reclaim the
  runtime verdicts. If the native workflow fails, the artefact
  bundle now names the failing phase attributively AND leaves
  `completed=false` — no more false "completed:true" on a hang.

### Stage 3C-CI-RESET Part 2 — end-to-end native suite green ✅ COMPLETE

- **Entry**: Stage 3C-CI-FIX5 committed; native workflow reproducibly
  fails on a bail=1 stop at the first substantive test failure.
- **Delivered**: 33-commit correction cycle (E.1.1 → E.1.37) that
  drove the native suite from `native_electron_test_blocked` to a
  green 110/110 run in `stage3c-native-electron`. Both required
  workflows are green on commit `2af37ce`; every safety invariant is
  verified from an authoritative server-side source (DRY_RUN=true,
  ORDER_SUBMISSION_ENABLED=false, liveCapitalAuthorized=false,
  promotionEnabled=false, kellyEnabled=false, createOrder counters
  all zero). No assertion was weakened, no test was skipped, and no
  retry was added to mask flakiness. See `stage3_report.md` for the
  full ledger of individual corrections.
- **Verdict achieved**: `native_electron_unpacked_integration_verified
  + stage_4_unblocked`.
- **Next**: Stage 4 may begin.

## Stage 4 — Real report generation (CLOSED on de926c94)

- **Entry**: Stage 3 committed.
- **Exit** (all shipped + CI-verified on `de926c94`, native workflow
  30463955631 + windows workflow 30463955512, both green):
  - 13 per-kind report generators (Cat E 16) — `apps/server/src/reports/generators/generators.ts` + `REPORT_GENERATORS` registry (frozen), coverage + kind + specVersion + freeze verified by 5 unit tests
  - Fail-closed redaction wrapper (Cat E 17) — 12 key suffixes + 5 value rules, 23 unit tests, planted-secret negative-space guardrail
  - Reports screen binds to `desktop.reports.enqueue/status/list/verify` via `horizon.desktopData(...)` (Cat E 18) — 13 kinds × 3 formats × Generate + Verify buttons, every anchor carries `data-*` runtime attrs
  - `desktop_export_jobs` + `desktop_export_artifacts` populated by the `enqueueAndRunExport` worker; idempotency enforced by the `UNIQUE(idempotencyKey)` constraint on migration 0022
  - Fail-closed path validation (dual guard: main-process pre-check + server-side `validateOutputPath`) — 13 unit tests + native T59
  - Native T56-T60 exercise the full stack end-to-end under real Electron + MariaDB + Redis in CI
- **Consumes**: Category E.
- **Verdict**: `report_generation_complete`; `desktop_reports_runtime_wired`; `all_13_report_generators_verified`; `deterministic_report_generation_verified`; `secure_report_export_verified`; `native_report_export_lifecycle_verified`.
- **Closure record**: `docs/audit/stage4_report.md`.
- **Next**: Stage 5 may begin under an explicit user-directed opening.

## Stage 5 — Windows packaging correction

- **Entry**: Stage 4 committed.
- **Exit**:
  - `build.files` widened (Cat G 23)
  - Server distribution decision made + implemented (Cat G 24)
  - Manifest generator ES-module fix (Cat G 25)
  - Windows CI produces a green artifact (Cat G 26)
- **Consumes**: Category G.
- **Verdict**: `package.windowsInstaller: packaged`.

## Stage 6 — Native Windows smoke test (§N)

- **Entry**: Stage 5 committed and CI green.
- **Exit**:
  - Operator downloads the CI-produced `Horizon Trade Setup.exe`.
  - Verifies SHA-256 against the manifest.
  - Installs on clean Windows VM.
  - Executes the runbook 01 sequence + §N steps.
  - Pastes redacted outputs (startup log, service states,
    login result, screen-health report, exported safety report +
    checksum, shutdown, relaunch, uninstall).
  - Evidence is written to
    `docs/audit/stage6_windows_smoke_test.md`.
- **Consumes**: Category H.
- **Verdict**: `windows_installer_verified` becomes claimable.

## Stage 7 — Integrated Phase 3B audit (proper)

- **Entry**: Stage 6 committed with evidence.
- **Exit**:
  - Re-run every phase3b_audit script against the runtime-wired
    state. Every `partially_supported` or `unsupported` claim in
    `claim_reconciliation.md` is either upgraded to `supported` or
    the acceptance criteria are downgraded honestly.
  - `numerical_audit.json` gains a per-hit disposition column.
  - `desktop_screen_audit.md` gains per-screen state-matrix
    evidence (screenshots or DOM assertions).
  - `export_redaction_audit.md` gains actual exported bytes +
    checksums.
- **Consumes**: none (audit only).
- **Verdict**: Phase 3B audits become evidence-backed.

## Stage 8 — Genuine code freeze

- **Entry**: Stage 7 committed.
- **Exit**:
  - Code-freeze manifest regenerated with `status=verified`,
    populated `windowsInstallerHash`, `windowsInstallerRunId`,
    populated test counts and SBOM hash.
  - New freeze commit pushed. Runbook 26 (change control) becomes
    the only sanctioned path to modify anything after this commit.
- **Verdict**: `desktop_code_frozen` (unqualified).

## Stage 9 — Coinbase preflight (Phase 3C authorization required)

- **Entry**: Stage 8 committed + explicit risk-owner authorization.
- **Exit**: Two-hour operational preflight with genuine Coinbase
  read-only providers; no order submitted.
- **Verdict**: preflight `ok`.

## Stage 10 — Seven-day infrastructure soak

- **Entry**: Stage 9 preflight `ok`.
- **Exit**: 7 real calendar days; no critical incident; every
  observer runs; reconciliation stays green.
- **Verdict**: `phase1_2_pass_prospective` (the 7d bar).

## Stage 11 — Extended prospective shadow validation

- **Entry**: Stage 10 complete.
- **Exit**: Observer stack (Phase 2A-2F) runs against genuine data
  for a duration TBD. Validation experiments produce
  PBO/DSR/attribution numbers on real observations.
- **Verdict**: `prospectively_validated` (per capability).

## Stage 12 — Separate live-capital canary certification

- **Entry**: Stage 11 complete + explicit risk-owner authorization
  for a bounded live canary.
- **Exit**: A separate certification exercise, not covered by this
  roadmap.
- **Verdict**: `live_authorized` for the canary scope only.

## Compression

Stages 1-4 are the immediate priority. Stages 5-8 wrap up the
desktop side. Stages 9-12 are governed by the existing safety
posture (DRY_RUN, ORDER_SUBMISSION_ENABLED, provider-mode-external
refused at boot) — every entry criterion is explicit and
non-negotiable.

Nothing in stages 5-12 can begin until stages 1-4 are proven, and
"proven" means "an operator saw it happen on a real machine with
logs recorded to `docs/audit/`" — not "a test passed in a container".

## What this roadmap does NOT do

- It does not restart or invalidate the substantial work already in
  Phases 0-2F. That work is retained. It moves from `fixture_only`
  to `runtime_wired` in Stages 1 + 3.
- It does not restart Phase 3A. Phase 3A produced the Electron shell
  + IPC boundary + screen skeleton + navigation contract. All of
  that is kept.
- It does not restart Phase 3B. The audit scripts + runbooks + the
  general audit shape are kept. What is corrected: verdicts that
  claimed runtime completion when only unit + static evidence was
  produced.
