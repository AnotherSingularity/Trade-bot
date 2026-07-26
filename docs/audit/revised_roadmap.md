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

## Stage 4 — Real report generation

- **Entry**: Stage 3 committed.
- **Exit**:
  - 13 per-kind report generators (Cat E 16)
  - Redaction wrapper (Cat E 17)
  - Reports screen binds to `exportReport` (Cat E 18)
  - `desktop_export_jobs` + `desktop_export_artifacts` populated
- **Consumes**: Category E.
- **Verdict**: `desktop.reports: runtime_wired`.

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
