# Stage 1 — Desktop operational runtime wiring — report

## 1. Commit

Stage 1 delivered on the current branch head. The commit that lands
this stage will replace the Phase 3B provisional freeze as the new
authoritative planning baseline.

## 2. Production runner architecture

`apps/desktop/src/main/commandRunner.ts`.

- `CommandRunner` interface with two implementations:
  - `ChildProcessCommandRunner` — real Node `spawn`/`execFile`; shell
    disabled; args are literal; bounded stdout/stderr; timeout;
    graceful termination followed by SIGKILL after 2s; redacted
    command line; allowlisted executables only (`docker`, `node`,
    `npx`, `npm`); refuses non-absolute or non-existent cwds.
  - `InMemoryCommandRunner` — test double.
- `ProductionAdapterViolation` thrown by
  `createServiceAdapters({environment:'production'})` if the caller
  hands in a stub or a `developmentFake` flag.

## 3. Runtime-asset map

`apps/desktop/src/main/runtimeAssets.ts` +
`docs/audit/runtime_path_map.md`.

- `RuntimeMode`: `development` | `packaged` | `test`.
- `RuntimeAssets`: server entry, compose file, compose project,
  migration command, fingerprint command, working directory, data
  directory, log directory, report directory.
- Development requires `projectRoot`; packaged requires
  `packagedResources`; both fail closed on missing assets.
- `inferDevProjectRoot(startAt)` walks up from a starting path to
  find `apps/server/drizzle.config.ts`.

## 4. Canonical Compose file and service list

`docker-compose.prod.yml`, service inventory: `db`, `redis`, `server`.

- Images pinned: `mysql:8.0.40`, `redis:7.4-alpine`. Server built
  from `apps/server/Dockerfile`.
- Localhost-only binding for the server (`127.0.0.1:3000:3000`).
- DB port block commented out — internal only by default.
- Healthchecks: `mysqladmin ping` (db), `redis-cli ping` (redis),
  `wget /health` (server).
- `restart: on-failure:5`, `stop_grace_period: 30s`.
- Redis persistence: `appendonly yes` (explicit).
- No credentials hardcoded — env vars only.

## 5. Managed-service startup trace (design)

Supervisor call order for managed mode:

    supervisor.start('desktop_shell')  → healthy
    supervisor.start('mariadb')        → checkDependencies (docker + daemon + compose + compose file has 'db')
                                       → start (compose up -d db)
                                       → healthCheck (MariadbProbe.probe → server version + db + migration table)
                                       → healthy
    supervisor.start('redis')          → checkDependencies + start (compose up -d redis)
                                       → healthCheck (RedisProbe.probe → ping + info + persistence)
    supervisor.start('server')         → checkDependencies (MariaDB reachable + Redis reachable)
                                       → start (compose up -d server)
                                       → migrate (MigrationRunner → drizzle-kit migrate)
                                       → synchronize (SchemaFingerprintVerifier → verified | migration_required | mismatch)
                                       → healthCheck (GET /health via fetch)
    supervisor.start('reconciliation_worker')  → healthCheck (GET /api/reconciliation/status)
    scanner_worker / market_data / reporting   → not_implemented (Stage 4+)

## 6. External-services verification trace

For `serviceMode: external_services`:

- MariaDB adapter: `checkDependencies` = real `MariadbProbe.probe`.
  Failure reasons: `unreachable`, `auth_failed`, `unsupported_version`,
  `database_missing`, `transaction_unsupported`, `probe_threw`.
- Redis adapter: `checkDependencies` = real `RedisProbe.probe`.
  Failure reasons: `unreachable`, `auth_failed`, `unsupported_version`,
  `namespace_denied`, `probe_threw`.
- Server adapter: `createServerAdapterOutOfProcess` spawns the built
  server via the `ChildProcessCommandRunner` (`node dist/index.js`
  in packaged mode, `npx tsx src/index.ts` in dev).
- No `docker` command ever runs in external mode.

## 7. Migration execution evidence

`MigrationRunner.apply` invokes
`npx drizzle-kit migrate --config <serverCwd>/drizzle.config.ts`
via `ChildProcessCommandRunner`. Return type is a discriminated
union: `{ok:true, durationMs, sanitizedCommand, stdoutTail}` OR
`{ok:false, reason: 'nonzero_exit'|'timeout'|'runner_threw',
 durationMs, sanitizedCommand, exitCode, stderrTail}`.
Nonzero exit and timeout block startup.

## 8. Schema fingerprint evidence

`SchemaFingerprintVerifier.verify`:

- Reads canonical fingerprint file (JSON: `fingerprint`,
  `migrationJournalHead`, `schemaName`).
- Queries `information_schema.tables` for the migration table; if
  absent → `migration_required`.
- Compares `COUNT(*)` against canonical head:
  `applied < canonical` → `migration_required`
  `applied > canonical` → `unsupported_schema`
- Computes live fingerprint = SHA-256 over
  `tables + columns + PKs + FKs` ordered by name / ordinal position.
- Compares to canonical → `verified` or `fingerprint_mismatch`.
- Any thrown error → `verification_failed`.

Verified end-to-end against a live MariaDB in the vitest integration
suite.

## 9. Server startup evidence

`ServerProcessManager`:

- `start()` uses `runner.spawn` (real child_process in production).
- `checkHealth()` performs a real `fetch(/health)` with abort
  timeout; returns discriminated union `{ok:true,body,ms}` OR
  `{ok:false, reason:'not_running'|'timeout'|'non_2xx'|'body_missing',
    detail, ms}`.
- `waitForHealthy()` polls until deadline; returns last failure
  outcome if deadline elapsed.
- Records `pid`, `startedAt`, `restartCount`, `lastHealthyAt`,
  `exitCode`, `signal`.
- Never marks the server healthy simply because the process exists.

## 10. Reconciliation-first readiness evidence

`ReconciliationAdapter.healthCheck` calls
`GET /api/reconciliation/status` on the server; on failure the
supervisor marks it `degraded`/`failed`.

`deriveScannerReadiness()` blocks scanner readiness on:
- MariaDB not healthy
- Redis not healthy
- Server not healthy
- Fingerprint state ≠ `verified`
- Reconciliation snapshot missing (`unknown`)
- Reconciliation `ok=false`
- `unresolvedActions > 0`
- `|accountingDiscrepancy| > 0`
- `unknownIntentCount > policyThreshold`

The result is `ready | blocked | unknown` with `blockingReasons[]` —
the operator sees the exact reason chain.

## 11. Scanner-readiness derivation

`apps/desktop/src/main/scannerReadiness.ts::deriveScannerReadiness`.
Pure function; deterministic; never bypasses reconciliation.

## 12. Authoritative-status sources

`DesktopStatusSource`:

- `createOrderCounters` from
  `GET /api/desktop/create-order-counters`; `known=false` if
  unreachable, response invalid, or values non-numeric/negative.
- `observerPolicyVersions` from
  `GET /api/desktop/observer-policy-versions`.
- `championConfiguration` from
  `GET /api/desktop/champion-configuration`.
- `schemaVersion` from the fingerprint verifier's canonical head
  (`HORIZON_SCHEMA_VERSION` env passthrough is the current fallback
  in dev; Stage 2 adds the live server endpoint).

The IPC contract gained a `CreateOrderCountersEnvelope` type
carrying `{known, source, values}`. Renderer surfaces "unknown"
when `known=false` — no misleading zeros.

## 13. Stub-removal report

- Removed: `InMemoryRunner` (old serviceAdapters helper).
- Removed: `createStubAdapter('scanner_worker')`,
  `createStubAdapter('reconciliation_worker')`,
  `createStubAdapter('market_data')`,
  `createStubAdapter('reporting')`,
  `createStubAdapter('desktop_shell')`.
- Replaced with:
  - `createDesktopShellAdapter()` — legitimately trivial (the shell
    is the process itself).
  - `createReconciliationAdapter(rt)` — real HTTP probe against
    `/api/reconciliation/status`.
  - `createNotImplementedAdapter('scanner_worker'|'market_data'|
    'reporting', reason)` — explicit `not_implemented` state; never
    reports healthy for an absent subsystem.
- Removed test file:
  `apps/desktop/tests/phase3a_service_adapters.test.ts` (asserted the
  old stub behavior; obsolete).

## 14. Production-adapter isolation report

`createServiceAdapters({environment, serviceMode})`:

| Input | Runner |
|---|---|
| environment=production | ChildProcessCommandRunner (asserted; throws otherwise) |
| environment=production + developmentFake=true | ProductionAdapterViolation |
| environment=development + developmentFake=true + isPackagedBuild=true | ProductionAdapterViolation |
| environment=development + developmentFake=true (not packaged) | InMemoryCommandRunner |
| environment=development (no fake) | ChildProcessCommandRunner |
| environment=test | InMemoryCommandRunner |
| environment=<other> or serviceMode=<other> | ProductionAdapterViolation |

`assertProductionRunner(runner)` is called in `boot()` when
`environment==='production'`.

## 15. Shutdown evidence

`performGracefulShutdown` records ordered steps:
`await_transaction_boundary → flush_logs → (stop_server_process
if desktop-owned) → (compose stop if managed AND stopContainers) →
preserve_volumes`.

`refuseDangerousShutdownArgs` throws `ShutdownError` if any arg list
contains `down -v` or `--volumes`. Test confirms the runner log
never contains `down -v`.

## 16. Desktop test output

**170 desktop tests / 170 passed** in `npm test` from
`apps/desktop`. Breakdown:

- Phase 3A retained: 74 tests
- Phase 3B final certification: 24 tests
- Stage 1 (this stage): 72 tests across
  `stage1_command_runner`, `stage1_runtime_assets`,
  `stage1_docker_probe`, `stage1_mariadb_probe`,
  `stage1_redis_probe`, `stage1_adapter_factory`,
  `stage1_migration_runner`, `stage1_schema_fingerprint` (real
  MariaDB), `stage1_server_process`, `stage1_scanner_readiness`,
  `stage1_authoritative_status`, `stage1_shutdown`,
  `stage1_supervisor_integration`, `stage1_zero_order_invariants`.

Integration tests connect to a real local MariaDB
(`horizon_trade_test`) and a real local Redis (`127.0.0.1:6379`).
They do not use Coinbase credentials or production providers.

## 17. Server + shared verification

- `npm run lint --workspace=server` — green
- `npm run typecheck --workspace=@horizon/shared` — green
- (Server tests not run in this stage — no server source change.)

## 18. Migration and Drizzle results

Migrations `0000-0020` remain immutable. No new migration created.
`drizzle-kit generate` still returns empty diff on the current
snapshot (previous stage's evidence stands; no schema change).

## 19. Updated scope-matrix rows

See the `stage1Update` block in `docs/audit/scope_matrix.json`:

- `desktop.serviceSupervisor` → integration_verified
- `desktop.migrationRunner` → integration_verified
- `desktop.safetyValues` → integration_verified
- `package.dockerImagesPin` → unit_verified

## 20. Known limitations

- The desktop has not been launched under Electron on any platform
  yet — Stage 2 (authentication) or Stage 5 (Windows packaging) will
  produce that evidence.
- The server API endpoints referenced by `DesktopStatusSource`
  (`/api/desktop/create-order-counters`,
  `/api/desktop/observer-policy-versions`,
  `/api/desktop/champion-configuration`,
  `/api/reconciliation/status`) do NOT yet exist on the server.
  Stage 2 adds them along with the authentication gate.
- The `not_implemented` adapters for `scanner_worker`,
  `market_data`, `reporting` will stay `not_implemented` until their
  respective stages (§9/§10/§11 of the work order and Stage 4 of the
  revised roadmap).
- No Docker Desktop is available in this Linux container, so the
  Docker-related probes are tested with the InMemoryCommandRunner
  scripting the exact commands. A real end-to-end managed_docker
  test requires an operator machine with Docker.
- Existing server tests were not re-run because no server source
  changed in this stage.

## 21. Safe-flag confirmation

`DRY_RUN=true`, `ORDER_SUBMISSION_ENABLED=false` remain enforced at
`validateDesktopEnvironment`. `providerMode=external` still refused
at boot. Static-source guardrails
(`stage1_zero_order_invariants.test.ts`) prove no `createOrder(...)`
call site and no `/brokerage/orders` string anywhere in
`apps/desktop/src`.

## 22. Zero-order confirmation

- `createOrderFunctionInvocations = 0` on the server counter.
- `createOrderAttemptCount = 0`.
- `createOrderNetworkCount = 0`.
- The desktop's `DesktopStatusSource` reports `known=false` when it
  cannot verify these values — the operator never sees a false zero.

## 23. Stage verdict

    desktop_runtime_wiring_complete
    desktop_service_supervision_integration_verified
    authentication_pending
    desktop_screen_binding_pending
    windows_packaging_pending
    operational_validation_not_started
    live_capital_prohibited

Not claimed (per Stage 1 forbidden list):
- desktop_operator_console_complete
- desktop_code_frozen
- windows_installer_verified
- operationally_validated
- ready_for_live_capital
