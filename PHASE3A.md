# Phase 3A — Windows Desktop Operator Console

Phase 3A delivers the Windows-first desktop operator console for the
Horizon Trade system. It ships an Electron application that observes
the shadow runtime, surfaces the safe-flag posture at all times, and
exposes read-only research/operations screens for the observer stack
built out in Phases 2A–2F.

## Verdict

    desktop_operator_console_complete
    + windows_packaging_ready
    + operational_validation_pending
    + live_execution_disabled
    + mobile_companion_deferred

Reporting format:

- **active desktop/server release surface**: green
- **mobile companion workspace**: deferred, non-blocking

### What Phase 3A does NOT claim

- `desktop_operationally_validated` — no long-running soak on Windows
- `windows_installer_verified` — the NSIS installer is produced by the
  CI workflow; an actual native Windows install/run has not been
  performed in this phase
- `ready_for_live_capital` — every safe-flag invariant remains hard-locked
- `mobile_complete` — mobile workspace is deferred by the current policy
- `strategy_profitable` — strategy behavior is unchanged in this phase

## Absolute invariants preserved

The Phase 3A build enforces the safety posture required by the work order:

- `DRY_RUN = true` — validated at desktop startup and again on every
  IPC read of the sanitized configuration snapshot
- `ORDER_SUBMISSION_ENABLED = false` — hard-coded literal in
  `ipcContract.ts` (`z.literal(false)`); an IPC response that violated
  this would fail response-side schema validation
- `providerMode ≠ external` — desktop refuses to boot with the external
  provider selected (§E invariant violation)
- No `createOrder(...)` call site anywhere in the desktop source
  (guardrail test §A/§I)
- No live Coinbase order endpoint (`/brokerage/orders`) referenced
  anywhere in the desktop source
- No non-interactive promotion identifier (`promoteAutomatically`,
  `autoPromoteChallenger`, `autoPromoteExperiment`) reachable from the
  desktop
- Renderer never imports `electron`, `node:fs`, `node:child_process`
  or `keytar` — enforced by a static-source test
- Coinbase credentials + admin password + session tokens are redacted
  before any log entry is written (§F redaction test)
- CreateOrder function invocations, attempts and network counters
  remain zero and are surfaced in the persistent health bar + Overview
  + Safety screens

## Deliverables

### 3A.1 — Desktop workspace scaffolding
- New workspace `apps/desktop` — Electron 33 + React 19 + Vite 6 + TypeScript 5.9
- Three-tsconfig split: `main` (CJS), `preload` (CJS), `renderer` (ESM/JSX)
- Vitest configured with jsdom for `tests/renderer/**`
- npm workspace wired via the root `package.json`

### 3A.2 — Electron security boundary + IPC allowlist
- `src/main/windows.ts` — `buildSafeWindowConfig` + `validateWindowConfig`
  enforcing `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, `webSecurity: true`, no experimental features
- `src/shared/ipcContract.ts` — exhaustive `IPC_CHANNELS` enumeration
  with 11 typed channels, Zod request AND response schemas, and an
  `IPC_ALLOWLIST` registry (`isAllowlistedChannel` gate)
- `src/main/ipc.ts` — validates BOTH request payload and response
  payload against the registered schema; unallowlisted channels drop
  with `channel_not_allowlisted`
- `src/preload/index.ts` — `contextBridge.exposeInMainWorld('horizon',
  api)` exposes only the 11 typed methods

### 3A.3 — Service supervisor + local service strategy
- `src/main/serviceSupervisor.ts` — deterministic 11-state FSM with a
  `LEGAL_TRANSITIONS` matrix, crash-loop detection over a 60s window,
  bounded `maxRestartAttempts=5`, and per-service snapshot immutability
- `src/main/serviceAdapters.ts` — MariaDB / Redis / server adapters
  with both `managed_docker` and `external_services` posture, plus a
  memory-only `InMemoryRunner` used in tests

### 3A.4 — Migration 0020: desktop-specific persistence
Additive-only. Existing 0000–0019 migrations remain byte-identical.
Ten new tables:

- `desktop_installations`, `desktop_sessions`, `desktop_service_states`,
  `desktop_service_events`, `desktop_configuration_versions`,
  `desktop_operator_actions`, `desktop_export_jobs`,
  `desktop_export_artifacts`, `desktop_incidents`,
  `desktop_build_manifests`

`drizzle-kit generate` on the current schema reports:

    No schema changes, nothing to migrate 😴

### 3A.5 — Secrets architecture + authentication
- `src/main/secrets.ts` — `SecretsAdapter` interface with a
  keytar-backed production implementation and a memory-only test
  implementation. Credentials are NEVER returned to the renderer;
  only the `CredentialStatus` enum is exposed
- `src/main/authentication.ts` — scrypt password hashing
  (N=16384, r=8, p=1), `timingSafeEqual` verification, NIST-inspired
  password policy (`MIN_PASSWORD_LENGTH=12`, common-password rejection,
  product-name rejection), session expiry + revocation, rate-limited
  logins (5 attempts / 10 min window)
- `src/main/logging.ts` — reserved key list of secret-shaped fields
  (`password`, `apiKey`, `apiSecret`, `coinbaseKey`, `coinbaseSecret`,
  `authorization`, `cookie`, `sessionToken`, `refreshToken`,
  `accessToken`) recursively redacted before writing to any sink

### 3A.6 — Renderer, navigation, safety bar, 19 screens
- Persistent `HealthBar` — always renders `DRY_RUN = TRUE`,
  `LIVE ORDER SUBMISSION DISABLED`, current SIMULATION_MODE, provider
  mode, and CreateOrder counters
- Persistent `Sidebar` — four navigation groups (operations, research,
  ops, safety), 19 screens
- 19 screens: Overview, Shadow Portfolio, Positions, Decision Journal,
  Research Universe, Fingerprints, Regimes, Portfolio Risk,
  Microstructure, Context, Validation Lab, Costs & Attribution,
  Protection, Reconciliation, Incidents, Reports, Configuration,
  System, Safety
- Safety-critical screens (Overview, Safety, System, Configuration)
  render the danger banner + safety copy independent of IPC load state
- Hash-router bootstrap in `src/renderer/app/App.tsx`

### 3A.7 — Windows packaging + CI workflow
- `installer/installer.nsh` — minimal NSIS include; per-user install;
  writes an install manifest recording the safe-flag posture
- `installer/license.txt` — states the enforced safety posture and
  disclaims live capital use for this build
- `build/generate-build-manifest.ts` — deterministic bundle checksum,
  build commit, build timestamp, safe-flag snapshot; written to
  `dist/build-manifest.json`
- `.github/workflows/desktop-windows.yml` — Windows CI job that lints,
  tests, builds, generates the build manifest, and produces the
  per-user NSIS installer artifact. Sets `DRY_RUN=true` and
  `ORDER_SUBMISSION_ENABLED=false` in the workflow environment
- `package.json` `build.nsis` wired to `installer/installer.nsh` +
  `installer/license.txt` with `warningsAsErrors: true`
- `signAndEditExecutable: false` — no code signing performed

### 3A.8 — Desktop tests (60 required, 77 shipped)

All under `apps/desktop/tests/`:

- `phase3a_environment.test.ts` (T1–T6) — invariant validation
- `phase3a_window_security.test.ts` (T7–T11) — window config
- `phase3a_ipc_contract.test.ts` (T12–T18) — Zod schema + allowlist
- `phase3a_ipc_handler.test.ts` (T19–T25) — handler behavior
- `phase3a_service_supervisor.test.ts` (T26–T35) — FSM + crash loop
- `phase3a_service_adapters.test.ts` (T36–T40) — dependency checks
- `phase3a_secrets.test.ts` (T41–T45) — credential surface
- `phase3a_authentication.test.ts` (T46–T53) — scrypt, session, rate limit
- `phase3a_logging.test.ts` (T54–T57) — redaction depth + no-leak
- `phase3a_navigation.test.ts` (T58–T60) — nav contract
- `phase3a_build_manifest.test.ts` (T61–T63) — deterministic checksum
- `tests/renderer/phase3a_screens.test.tsx` (T64–T69) — safety banner
  + safety copy present in Overview/Safety/System/Configuration/
  Reports/ValidationLab
- `tests/renderer/phase3a_health_bar.test.tsx` (T70–T72) — persistent
  chrome + nav contract structure
- `phase3a_safety_invariants.test.ts` (T73–T77) — static-source
  guardrails: no `/brokerage/orders`, no `createOrder(...)` call, no
  non-interactive promotion identifiers, renderer never imports
  electron/node:fs/node:child_process/keytar

Result: **77 tests / 77 passed** in `npm test` from
`apps/desktop`.

### 3A.9 — Verification and documentation
- All three desktop tsconfigs typecheck clean (`npm run lint` from
  `apps/desktop`)
- Server workspace `npm run lint` clean
- Shared workspace `npm run typecheck` clean
- Migrations 0000–0019 byte-identical; 0020 additive-only
- `drizzle-kit generate` returns empty diff on the current snapshot

## Explicit deferrals

- **Operational validation on Windows**: no long-running desktop run
  on Windows has been performed. The installer artifact is produced
  by CI, not exercised. Any claim of `desktop_operationally_validated`
  is out of scope.
- **Native code signing**: `signAndEditExecutable: false`. Distributing
  an installer to third parties requires an EV signing certificate and
  an authenticated release process that is out of scope for Phase 3A.
- **Mobile companion workspace**: deferred, non-blocking. The mobile
  workspace is excluded from the active-phase acceptance surface per
  the current policy directive.
- **Live capital**: prohibited. Every invariant in this phase enforces
  a shadow-only posture.

## Runtime posture summary

| Flag / value                     | Enforced value               |
|----------------------------------|------------------------------|
| DRY_RUN                          | true (literal)               |
| ORDER_SUBMISSION_ENABLED         | false (literal)              |
| providerMode                     | fixture (external refused)   |
| databaseMode                     | managed_docker / external_services |
| liveOrderSubmissionDisabled      | true (literal)               |
| CreateOrder function invocations | 0                            |
| CreateOrder attempts             | 0                            |
| CreateOrder network calls        | 0                            |
| Kelly sizing                     | disabled                     |
| Non-interactive promotion        | absent                       |
| Observer enforcement             | absent                       |
