# Scope Reconciliation Gate — baseline

**Commit under audit:** `0a1d76f` (Phase 3B head)
**Branch:** `claude/horizon-trade-bot-mcbcfo`
**Auditor:** self-audit
**Rule:** every capability receives the *highest* status proven by
direct evidence. It cannot skip levels. Phase documentation is not
evidence.

## Maturity states

    absent
    schema_only
    contract_only
    fixture_only
    unit_verified
    integration_verified
    runtime_wired
    packaged
    operator_verified
    prospectively_validated
    live_authorized
    deferred

## Corrected project verdict

    execution_integrity_framework_substantial
    quantitative_observer_frameworks_complete
    desktop_shell_complete
    desktop_operational_wiring_incomplete
    windows_installer_absent
    scope_reconciliation_required (this gate)
    operational_validation_not_started
    live_capital_prohibited

The previous Phase 3A verdict (`desktop_operator_console_complete +
windows_packaging_ready`) and Phase 3B verdict (`desktop_code_frozen
(provisional)`) are downgraded here. See `claim_reconciliation.md`.

## Ground-truth evidence collected in this gate (Linux container,
`0a1d76f`)

Each of the following is a direct read of the actual source, not
inference from a phase doc.

### 1. Desktop production boot uses the test runner

`apps/desktop/src/main/index.ts:77` binds `runner: InMemoryRunner()`.
The comment on the same line acknowledges "production build should
swap for a real runner." No real `DockerCommandRunner` /
`ExternalServiceProbe` implementation exists in the repo.

Consequence: `docker compose up` / `probeMariadb` / `probeRedis` /
`ping` never run any command. Every service transitions to `healthy`
without touching a container, database, or network socket. Runtime
maturity of the service supervisor is **unit_verified**, not
**runtime_wired**.

### 2. Compose service names do not match adapter commands

- `docker-compose.yml` (root): services are `db` + `redis`. No
  `mariadb`. No `server`.
- `docker-compose.prod.yml`: services are `db` + `redis` + `server`.
  Still `db`, not `mariadb`.
- `apps/desktop/src/main/serviceAdapters.ts:51,80,110`:
  `compose(['up', '-d', 'mariadb'])`, `compose(['up', '-d', 'redis'])`,
  `compose(['up', '-d', 'server'])`.
- The desktop never selects which compose file to use.

Consequence: even with a real `DockerCommandRunner`, the first
`compose up -d mariadb` would fail with "no such service." Managed
Docker maturity is **absent**.

### 3. Migration and synchronize are stubbed

`apps/desktop/src/main/serviceAdapters.ts:113,114`:

    migrate: async () => ({ ok: true, detail: 'migrations_applied_via_server_boot' }),
    synchronize: async () => ({ ok: true, detail: 'sync_stub' }),

Neither function runs `drizzle-kit migrate`, connects to MariaDB, or
verifies a schema fingerprint. Migration verification maturity is
**absent** on the desktop side.

### 4. Authentication is disabled at boot

`apps/desktop/src/main/index.ts:165-166`:

    isAuthenticated: () => authManager.hasAdmin(),
    authenticationRequired: false,

Consequence: every IPC channel that declared
`requiresAuthenticatedSession: true` in `ipcContract.ts` is currently
open. `hasAdmin()` returns `false` until an admin is set up — but
because `authenticationRequired: false`, the check is never
consulted. No renderer login flow exists.

Authentication maturity: **unit_verified** (library works
in-process); **absent** as a runtime gate.

### 5. Safety values are hardcoded

`apps/desktop/src/main/index.ts:115-120`:

    createOrderCounters: async () => ({ functionInvocations: 0, attemptCount: 0, networkCount: 0 }),
    observerPolicyVersions: async () => ({ universe: 'p2a-1', ... }),
    championConfigurationView: async () => ({ championVersion: 'champ-1' }),

`apps/desktop/src/main/localEnvironment.ts:39`:

    schemaVersion: '0019',

The desktop displays "CreateOrder counter = 0" regardless of the
actual server state; migration 0020 exists but the default schema
version is still 0019.

Safety-values maturity: **contract_only** (screens render the
shape); **absent** as a true representation.

### 6. Renderer uses 4 of 11 IPC methods

`grep -Rn "window.horizon\." apps/desktop/src/renderer` returns 5
call sites, all in `hooks/useHorizon.ts` (4) and `Reports.tsx` (1):

- `getDesktopStatus`
- `readSafeConfiguration`
- `getServiceHealth`
- `getApplicationVersion`
- `selectExportFolder` (folder picker only — export is not invoked)

The other 15 screens (Shadow Portfolio, Positions, Decision Journal,
Research Universe, Fingerprints, Regimes, Portfolio Risk,
Microstructure, Context, Validation Lab, Costs & Attribution,
Protection, Reconciliation, Incidents, and most cards on
Configuration/System) render `EmptyState` copy such as "materialize
once the runtime shadow service records" and "surfaced from
Phase 2C portfolio_snapshots" — no API request is made.

Screen maturity (per screen): 4 of 19 = **contract_only**; 15 of 19 =
**ui_shell** (a maturity level the work order did not enumerate;
below `contract_only`). See `desktop_api_coverage.json`.

### 7. Reports export is intentionally nonfunctional

`apps/desktop/src/main/index.ts:133-144`:

    exportReport: async (input) => {
      ...
      return {
        ok: false,
        artifactPath: null,
        checksum: null,
        reportVersion: 'p3a-report-1',
        generatedAt: new Date().toISOString(),
        redactionsApplied: ['coinbase_api_key', ...],
        failureReason: 'export_deferred_operator_action_required',
      };
    },

The Reports screen never calls `exportReport` — it only calls
`selectExportFolder`. Even if it did, the handler returns a hardcoded
failure.

Report maturity: **contract_only** (shape defined); **absent** as
executable behavior.

### 8. Installer packaging is under-inclusive

`apps/desktop/package.json` `build.files`:

    dist/**/*
    !node_modules/**/*
    node_modules/electron-log/**/*
    node_modules/electron-store/**/*
    node_modules/keytar/**/*

Not included:

- `zod` (imported by `dist/main/ipc.js` and `dist/preload/index.js` —
  the app would crash on launch without it)
- `apps/server` (server build output)
- `apps/server/drizzle/migrations/*`
- `apps/server/drizzle/fingerprints/*`
- `docker-compose*.yml`
- `apps/server/Dockerfile`
- Report templates
- Runbooks
- Any Node runtime for the server (electron ships Node for main
  process only)

The `asar: true` setting means the actual packaged closure is
determined by electron-builder's `node-file-trace`, which follows
`require`/`import` from `dist/main/index.js`. `zod` would likely be
included by that trace; the other omissions are structural.

Packaging maturity: **absent** for the full installable system;
**configured** for a bare Electron shell.

### 9. Windows CI has never produced a green build

- Run #1 (`3f5b6c4`, Phase 3A): failed. `apps/desktop/build/` was
  gitignored so `phase3a_build_manifest.test.ts` couldn't resolve
  `../build/generate-build-manifest`.
- Run #2 (`0a1d76f`, Phase 3B): failed. `npx ts-node
  build/generate-build-manifest.ts` under Node 20 hits
  `ERR_UNKNOWN_FILE_EXTENSION` because ts-node's ESM loader isn't
  configured.

The `windows_packaging_ready` verdict at the end of Phase 3A was
issued without ever having seen the Windows CI succeed. Windows
build maturity: **absent**.

### 10. Phase 3B audit artifacts are static scans, not proofs

The Phase 3B `numerical_audit.json` records "185 non-comment hits …
manually confirmed" — but the artifact does not contain a per-item
disposition. That's an assertion, not evidence.

The Phase 3B `accounting_certification.md` describes 18 scenarios;
the file is narrative and points at server tests that DO exist
(`phase3a_gate3d_integrated.test.ts` etc.). Those server tests are
real and passed under Phase 2F verification. The narrative is honest
about which tests back which claim, but the "unexplained difference =
0.00000000" line is a claim about server tests, not about desktop
runtime.

The Phase 3B `code_freeze_manifest.json` correctly marks itself
`pending_windows_verification`. That is the only fully honest label
in Phase 3B; the top-line verdict on the commit overstated it.

## Complete audit surface

See:

- `scope_matrix.json` — machine-readable, one entry per capability
- `runtime_path_map.md` — end-to-end runtime path with per-arrow
  status
- `desktop_api_coverage.json` — per-screen API coverage
- `packaging_inventory.json` — what needs to be packaged vs what
  is packaged
- `claim_reconciliation.md` — every published claim reclassified
- `blocking_gaps.md` — the minimum work to move from `absent` /
  `contract_only` toward `runtime_wired`
- `revised_roadmap.md` — corrected sequence to code freeze

## Audit rules honored

- No new migration.
- No implementation fixes.
- Prior commits preserved.
- Live trading prohibited.
- Phase documentation not used as sole evidence — every §-numbered
  observation above is anchored to a specific file + line read
  during this gate.
- No inference from imports/tables/routes.
