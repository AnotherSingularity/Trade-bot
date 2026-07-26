# Stage 1-FIX — report

Corrects the Stage 1 review's 5 blocking issues + 7 required
corrections. No new migration; no live capital.

## 1. Blocking issue → resolution

| # | Blocking issue | Resolution |
|---|---|---|
| 1 | Compose swapped MariaDB → MySQL | `docker-compose.prod.yml` + `docker-compose.yml` restored to `mariadb:10.11.6`. Volumes renamed to `mariadb_data`. Healthcheck uses `mariadb-admin ping`. |
| 2 | Managed Docker labeled `integration_verified` | Downgraded to `managed_docker_contract_verified` + `managed_docker_runtime_verification_pending`. The compose service names and the CLI invocations are unit-tested; whether Docker actually executes them is a separate certification that requires a real Docker engine. |
| 3 | Runtime chain not wired (endpoints absent) | Added `apps/server/src/routes/desktop.ts` with 6 endpoints. See §B below. |
| 4 | Server health check too shallow | Added `/api/system/readiness` (dependency-aware). `ServerProcessManager.checkHealth` now parses the readiness body and returns `not_ready` when `ready=false` — HTTP-200 alone does not establish operational readiness. |
| 5 | Test-count reporting inconsistent | Reconciled below. |

## 2. Corrections A–G

### A. MariaDB restored + probe enforcement

- `docker-compose.prod.yml`: `image: mariadb:10.11.6`, `MARIADB_ROOT_PASSWORD`,
  `MARIADB_DATABASE`, `mariadb-admin ping`, volume `mariadb_data`.
- `docker-compose.yml`: same treatment; `redis:7.4-alpine` + `appendonly yes` + healthcheck.
- `apps/desktop/src/main/mariadbProbe.ts`:
  - New failure reason `engine_not_mariadb`.
  - `engineEnforcement: 'strict_mariadb' | 'accept_both'` — default is
    `strict_mariadb`. Every production call site (`serviceAdapters.ts`) uses
    strict. `accept_both` exists solely for a future documented
    database-portability certification and is not used by production paths.
  - `serverEngine` field on `MariadbProbeResult` records `mariadb`/`mysql`/`unknown`.
- Migration verification: the existing 21 `*_mariadb_fingerprint.json` files
  are correct against the MariaDB engine and did not change. The Stage 1-FIX
  external-services integration test ran `drizzle-kit migrate` on a fresh
  `horizon_stage1_fix_ext` MariaDB database and confirmed applied count = 21.

### B. Authoritative server-status endpoints

Added `apps/server/src/routes/desktop.ts`:

- `GET /api/system/readiness` — dependency-aware; returns
  `{ready, components: {process, mariadb, redis, migration, fingerprint,
  reconciliation, createOrderBarrier}, safeFlags, version, timestamp}`.
  Bootstrap-safe (localhost only).
- `GET /api/desktop/create-order-counters` — reads live counters from
  `fetchBarrier.httpCounters()`. `{known, source, values}`; `known=true`
  when the process itself is the source (never a hardcoded value).
- `GET /api/desktop/observer-policy-versions` — compiled-in version pins.
- `GET /api/desktop/champion-configuration` — championVersion (from
  `STRATEGY_VERSION`), strategyVersion, dryRun, orderSubmissionEnabled.
- `GET /api/desktop/scanner-readiness` — derived; blocking reasons
  enumerated from reconciliation snapshot + barrier counters.
- `GET /api/desktop/reconciliation/status` — reconciliation snapshot
  (`unresolvedActions`, `nonterminalIntentCount`, `unknownOrderLocks`,
  `pendingFills`, `accountingDiscrepancy`, `entryBlockState`, `lastRunAt`).

Access control: every endpoint is gated to `127.0.0.1`. External requests
are refused with 403. This satisfies the bootstrap requirement: the
desktop supervisor reads these endpoints before user authentication;
non-loopback callers never can.

Contract semantics: `known + values` on success; `known:false + reason`
on failure. **Zero is never substituted for unavailable instrumentation.**

### C. Reconciliation + scanner-readiness integration

`queryReconciliationSnapshot()` on the server reads real values from:

- `reconciliation_runs.MAX(startedAt)` — lastRunAt
- `bot_config.reconciliationStatus` — ok/failed/in_progress/pending/degraded
- `order_intents` where state NOT IN ('filled','cancelled','rejected','expired') — nonterminalIntentCount
- `reconciliation_actions` where resolvedAt IS NULL — unresolvedActions
- `execution_fences` where resourceKey LIKE 'unknown_order:%' — unknownOrderLocks
- `fills` orphaned from `order_intents.exchangeOrderId` — pendingFills
- `SUM(ABS(cost_attribution.unexplainedAmount))` — accountingDiscrepancy
- Derived `entryBlockState` ∈ `{allowed, blocked, unknown}`

Ownership documented in `docs/audit/runtime_path_map.md`:

- `reconciliation` — **server-internal loop** (`reconcileOnStartup()` in `apps/server/src/index.ts` at boot; continuous reconciler is scheduled server-side).
- `scanner_worker` — **BullMQ worker** (`createScanWorker()` in `apps/server/src/jobs/scanJob.ts`; server-owned).
- `market_data` — **not implemented** (deferred to Phase 3C).
- `reporting` — **not implemented** (deferred to Stage 4).

The desktop's `scanner_worker`, `market_data`, and `reporting` adapters
return `not_implemented`; the server owns their runtime.

### D. Real external-services integration test

`apps/desktop/tests/stage1fix_external_services_integration.test.ts`:

1. Picks a free port via `node:net.createServer(0)`.
2. Ensures a fresh `horizon_stage1_fix_ext` database.
3. Runs `drizzle-kit migrate` via `spawnSync` (not `InMemoryCommandRunner`).
4. Spawns the actual server via `child_process.spawn('npx', ['tsx', 'src/index.ts'], …)`.
5. Waits for `/api/system/readiness.ready === true`.
6. Asserts each readiness component (mariadb, redis, migration, fingerprint,
   createOrderBarrier) is ok, and safeFlags = DRY_RUN:true / ORDER_SUBMISSION_ENABLED:false.
7. Reads counters from `/api/desktop/create-order-counters` — all zero,
   `known: true`.
8. Reads `/api/desktop/reconciliation/status` — `known: true`.
9. Reads `/api/desktop/scanner-readiness` — derived state + blocking reasons.
10. Reads `/health` — legacy shape confirmed for backward compat.
11. Kills the server via SIGTERM (up to 5s, then SIGKILL).
12. Restarts the server, waits for ready, confirms reconciliation runs
    before readiness.

This test uses `ChildProcessCommandRunner`-equivalent primitives
(`spawn`/`spawnSync`) directly. No `InMemoryCommandRunner`.

### E. Managed Docker reclassification

- Was: `managed_docker_integration_verified` (overclaim).
- Now: `managed_docker_contract_verified` +
  `managed_docker_runtime_verification_pending`.

The compose service-name contract test (`stage1fix_compose_contract.test.ts`)
proves the checked-in `docker-compose.prod.yml` defines `db`, `redis`, `server`,
that images are pinned MariaDB + Redis, and that the adapter's canonical
service names match the compose service names. What is NOT proven: that
`docker compose up` succeeds on a real Docker daemon.

### F. Server health semantics tests

`apps/desktop/tests/stage1fix_readiness_semantics.test.ts` (7 tests) uses
stub HTTP servers to prove:

- HTTP 200 with `ready=false` and mariadb component failed → `not_ready`
- HTTP 200 with `ready=false` and redis component failed → `not_ready`
- HTTP 200 with `ready=false` and fingerprint mismatch → `not_ready`
- HTTP 200 with `ready=false` and reconciliation failure → `not_ready`
- HTTP 200 with `ready=false` and non-zero barrier counter → `not_ready`
- HTTP 200 with `ready=true` and all components ok → ok, readiness body
  captured
- HTTP 200 with legacy `/health` body (no readiness envelope) → accepted
  as generic ok for backward compat

**HTTP-200 alone does not establish scanner readiness.**

### G. Audit record corrections

Updated in this commit:

- `docs/audit/scope_matrix.json` — added the corrections block + accurate maturity
  labels
- `docs/audit/stage1_report.md` — original Stage 1 report retained;
  `stage1_fix_report.md` (this file) supersedes its maturity claims
- `docs/audit/runtime_path_map.md` — worker ownership updated
- `docs/audit/blocking_gaps.md` — categories A, B, C, D closed at
  contract_verified or external_services_integration_verified level
- `docs/audit/revised_roadmap.md` — Stage 1 marked complete-pending-Docker

## 3. Exact test counts

Vitest run at commit head:

```
Test Files  32 passed (32)
      Tests  190 passed (190)
```

Breakdown by author:

| Batch | Files | Tests |
|---|---|---|
| Phase 3A retained | 12 (`phase3a_*.test.ts`, `phase3a_*.test.tsx`) | 74 |
| Phase 3B final certification | 1 (`phase3b_final_certification.test.ts`) | 24 |
| Stage 1 | 14 (`stage1_*.test.ts`) | 72 |
| Stage 1-FIX | 4 (`stage1fix_*.test.ts`) | 20 |
| Total | 31 test files (32 with subdir) | 190 |

(The prior report's inconsistent 77+24+69=170 vs 74+24+72=170 came from
this commit's addition of 20 new Stage 1-FIX tests plus a correction in
the Phase 3A count from 77 to 74 — three tests were removed with the
obsolete `phase3a_service_adapters.test.ts` file when Stage 1 replaced
the stub adapters.)

## 4. Verification surface

- `apps/desktop` typecheck: green (`tsc` main + preload + renderer).
- `apps/desktop` tests: 190/190 pass. External-services integration test
  requires local MariaDB (`127.0.0.1:3306`, root/password) + Redis
  (`127.0.0.1:6379`) — automatically skipped if unavailable.
- `apps/server` lint (`tsc --noEmit`): green.
- `packages/shared` typecheck: green.
- `drizzle-kit generate`: no schema change since Stage 1 (unchanged snapshot).

## 5. Verdict

Per the Stage 1 review's target after correction:

```
desktop_runtime_core_wiring_complete
external_services_integration_verified
managed_docker_contract_verified
managed_docker_runtime_verification_pending
authentication_pending
desktop_screen_binding_pending
windows_packaging_pending
operational_validation_not_started
live_capital_prohibited
```

**Not claimed** (Stage 1 review's forbidden list):

- `desktop_service_supervision_integration_verified` — reserved for after
  real managed Docker + Electron startup have been exercised.
- `desktop_operator_console_complete`.
- `desktop_code_frozen`.
- `windows_installer_verified`.
- `operationally_validated`.
- `ready_for_live_capital`.

## 6. Known limitations

- **No Docker in this container**: the managed_docker adapter's runtime
  path is exercised via the InMemoryCommandRunner scripting the exact
  commands; a real end-to-end `docker compose up` requires an operator
  machine with Docker.
- **No Electron launch**: the desktop shell has still not been launched
  under Electron on any platform. Deferred to Stage 5 (Windows packaging)
  or an earlier operator smoke test.
- **Server endpoints require the server to be running**: the external
  integration test starts the server via `spawn`; unit tests do not
  require a server. When the desktop supervisor is bootstrapping (server
  not yet up), status source returns `known: false` — not zero.
- **Mobile workspace**: deferred, unchanged.
