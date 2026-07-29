# Stage 5 — Managed runtime + Windows installer + operational validation harness (repository closure)

**Status.** Stage 5 REPOSITORY CLOSURE. All repository-side artifacts required by Stages 5A-5G are shipped. Verdicts that require a green CI run on a docker-capable / Windows runner are marked `ci_verification_pending` and will flip on their next green workflow run — no repository change is required to obtain them. Verdicts that require external wall-clock (Stage 6 7-day soak) or human action (Windows operator smoke) are left explicitly `pending` per the roadmap directive; this document is NOT the vehicle to claim them.

- **Branch**: `claude/horizon-trade-bot-mcbcfo`
- **Stage 4 predecessor head**: `de926c94` (Stage 4 closure — see `stage4_report.md`)
- **Stage 5 opening**: continues from Stage 4G doc commit `da69c9a`
- **Repository-closure head**: current `HEAD` after the Stage 5D + Stage 5E + Stage 5B/5C commits below

## §0 Commit history for Stage 5

| Commit | Slice | Contents |
|---|---|---|
| `013429d` | 5A — typed managed-runtime decision contract | `apps/desktop/src/main/runtimeModePolicy.ts` — pure `resolveRuntimeMode(...)` with 4 failure codes + 3 runtime modes; 15 unit tests in `tests/main/runtime_mode_policy.test.ts`. |
| `6078923` | 5G — soak manifest + incident policy | `packages/shared/src/soakManifest.ts` — 23 soak incident types, 13 mandatory invalidators, DEFAULT_SOAK_DAY_COUNT=7, Zod schemas locking DRY_RUN=true / counters=0 as z.literal; `validateSoakManifest(...)` with 9 rejection codes; 17 tests in `apps/server/tests/stage5g-soak-manifest.test.ts`. |
| `e06eaf2` | 5F — operational validation harness | `apps/server/src/soak/operationalValidation.ts` — 30 event kinds, 4 HARD_FAIL kinds, deterministic content-addressed eventIds, sanitizeDetail with authorization/Bearer/password/token scrubbing, buildDailyResult; 12 tests in `apps/server/tests/stage5f-operational-validation.test.ts`. |
| `7394fc4` | 5E — human Windows operator smoke package | `docs/operator/windows_smoke_checklist.md` (9 sections, safety-invariant checkpoints), `docs/operator/windows_smoke_evidence_template.md` (mandatory attachments + verdict recording), `scripts/operator/verify-windows-install.ps1` (PowerShell mechanical collector with 5-pattern sanitization guard). |
| `967bef1` | 5D — Windows installer CI smoke verifier | `apps/desktop/build/verify-packaged-installer.ts` (SHA-256 + layout + 8-pattern forbidden-string scan), publishes `windows-installer-checksum.txt` + `windows-installer-manifest.json`; extended `desktop-windows.yml` with the new step + a 90-day retention checksum artifact. |
| `2a1eef9` | 5B + 5C — Managed-Docker orchestrator + readiness evidence + CI | `apps/desktop/src/main/managedDockerOrchestrator.ts` — 5-phase lifecycle + 10 failure codes + owner=horizon label guard; `managedDockerEvidence.ts` — readiness report emitter with detail sanitization; `resources/managed-docker-compose.yml` — labelled compose file; `tests/integration/managedDockerOrchestrator.integration.test.ts` — real-daemon integration; `vitest.managed-docker.config.ts` + `npm run test:managed-docker`; `.github/workflows/managed-docker-runtime.yml` — dedicated CI. Suite manifest + verifier extended with new `managed-docker` bucket. |

## §1 Non-negotiable safety invariants (unchanged through Stage 5)

Every invariant enforced during Stage 4 remains enforced in Stage 5, verified by the tests in this commit series:

| Invariant | How enforced in Stage 5 |
|---|---|
| `DRY_RUN = true` | `SoakSafetyFlagsSchema.DRY_RUN = z.literal(true)` — schema itself rejects any daily result claiming DRY_RUN=false. |
| `ORDER_SUBMISSION_ENABLED = false` | Same schema, `z.literal(false)`. |
| `liveCapitalAuthorized = false` | Same. |
| `promotionEnabled = false` | Same. |
| `kellyEnabled = false` | Same. |
| Create Order counters = 0/0/0 | `SoakCreateOrderCountersSchema.functionInvocations/attemptCount/networkCount = z.literal(0)` — a daily result with a nonzero counter is `schema_invalid` rejection at the manifest boundary. |
| No Coinbase credentials referenced | Managed-docker orchestrator + readiness emitter contain zero Coinbase imports; `sanitizeDetail` scrubs `authorization=`, `Bearer …`, `password=`, `token=` before any detail reaches the readiness report. |
| No production providers activated | No provider factory reachable from the new modules; the orchestrator only wraps DockerProbe + compose invocations. |
| No economic-writer paths touched | New modules import from `dockerProbe`, `logging`, `soakManifest`, `soakContracts` — zero imports from `positions/order_intents/fills/round_trips/cash_ledger`. |
| Migrations 0000-0022 byte-identical | `git diff origin/main -- apps/server/drizzle/migrations/` for 0000-0022 is empty; no Stage 5 migration was authored (Stage 5 is orchestration + observability, not schema). |

## §2 Acceptance-criteria check per stage

### 2A — Typed managed-runtime decision contract

- Pure resolver `resolveRuntimeMode({packaged, serverModeEnv, serverExternalEnv, developmentFakeEnv, nodeEnv}) → RuntimeModeResult` — returns one of three modes (`external_test_server`, `managed_docker`, `packaged_managed_docker`) or a typed failure.
- Four failure codes (`packaged_forbids_external_test_server`, `packaged_forbids_development_fake`, `invalid_server_mode_value`, `conflicting_server_mode_flags`) each covered by a unit test.
- 15 tests in `runtime_mode_policy.test.ts` — every legal branch and every rejection.

### 2B — Managed-Docker orchestration policy

- Composed lifecycle: `preflight → provision → readiness_wait → supervise_ready → teardown`.
- Ten typed failure codes; label guard refuses to touch any container missing `owner=horizon`.
- `FakeClock` primitive for deterministic timeout tests.
- 20 tests in `managed_docker_orchestrator.test.ts` — every phase transition + label drift + timeout.
- Docker-daemon-free implementation: portable suite ran fully green (952/952) with zero Docker invocations.

### 2C — Managed-Docker readiness + evidence + CI

- `managedDockerEvidence.ts` — `buildManagedRuntimeReadinessReport(...)` produces a machine-readable JSON report. Detail strings sanitized via `sanitizeDetail` (Bearer/authorization/password/token → `<REDACTED>`, 500-char cap). Timeline rebased to `relativeMs` for time-invariant comparison.
- `resources/managed-docker-compose.yml` — every container carries `owner=horizon`; data volumes carry `data=true`; network labelled.
- `tests/integration/managedDockerOrchestrator.integration.test.ts` — real-daemon integration test; skipped unless `HORIZON_REQUIRE_MANAGED_DOCKER=true`. Asserts startup, per-container `owner=horizon` label, teardown leaves no `com.docker.compose.project` container behind.
- `.github/workflows/managed-docker-runtime.yml` — dedicated ubuntu-latest workflow that runs `npm run test:managed-docker` and uploads `apps/desktop/tests/integration/logs/*.json`.
- 15 tests in `managed_docker_evidence.test.ts` covering happy/failure paths, sanitization, phase ordering, serialization.

### 2D — Windows installer CI smoke

- `apps/desktop/build/verify-packaged-installer.ts` runs AFTER `electron-builder --win`. Verifies:
  - Installer file exists in `release/` and is ≥ 20 MiB.
  - `win-unpacked/Horizon Trade.exe`, `win-unpacked/resources/app.asar`, `win-unpacked/resources/elevate.exe` all present.
  - Scans text-bearing files (json/js/cjs/mjs/map/env/yml/yaml/txt/html/md ≤8 MB) for 8 forbidden patterns: `bearer_token`, `authorization_header`, `coinbase_key`, `coinbase_secret`, `bootstrap_token_literal`, `private_key_pem`, `jwt_secret_literal`, `password_literal`.
  - Writes `windows-installer-checksum.txt` (SHA256 + SIZE + NAME) and `windows-installer-manifest.json`.
- `desktop-windows.yml` gained the `verify:packaged-installer` step and a separate `windows-installer-checksum` artifact upload with 90-day retention — long enough to outlive the installer artifact so the operator's checklist can reference it.

### 2E — Human Windows operator smoke package

- `docs/operator/windows_smoke_checklist.md` — 9-section checklist covering prerequisites, installer acquisition + checksum comparison, installation, first launch + managed runtime, authentication, critical screen tour, report export end-to-end, application restart, clean shutdown + uninstall, evidence. Safety-invariant checkpoints AT every applicable step.
- `docs/operator/windows_smoke_evidence_template.md` — evidence template mandating verbatim recording of every checklist outcome + all seven safety invariants at end-of-run + refuses attachment of any credential / token / cookie / env dump.
- `scripts/operator/verify-windows-install.ps1` — PowerShell mechanical collector: installer checksum, install-tree, filtered process tree (horizon/electron/node only), Docker inventory filtered to `label=owner=horizon` only. Fails hard on `COINBASE`, `password=`, `JWT_SECRET`, `BEARER`, `BOOTSTRAP_TOKEN` patterns in any output.

### 2F — Operational validation harness

- `apps/server/src/soak/operationalValidation.ts` — 30 event kinds classified into:
  - 4 HARD_FAIL kinds (`secret_scan_failure`, `path_rejected`, `process_leak`, `container_leak`) → critical severity, invalidatesSoak=true.
  - Lifecycle warn events (`runtime_stop`, `server_restart`, `container_restart`, `mariadb_disconnect`, `redis_disconnect`).
  - Info observations (`runtime_start`, `runtime_ready`, `report_job_queued`, `safety_observation`, etc.).
- `OperationalValidationHarness` class with `observe/events/incidents/buildDailyResult`. `eventId` is content-addressed via SHA256 over kind + timestamp + details + installationIdHash — deterministic reproducibility.
- `sanitizeDetail(raw)` scrubs authorization / Bearer / password / token / secret shapes and caps at 2000 chars.
- `buildDailyResult(input)` reduces the observed events into a `SoakDailyResult` matching the Stage 5G schema; enforces literal(0) counters at the aggregation level so a caller cannot hand-craft a counter=1 daily result.
- 12 tests in `stage5f-operational-validation.test.ts` — enumeration, deterministic identity, sanitization, buildDailyResult, incidents→manifest roundtrip.

### 2G — Soak manifest contract + incident policy

- `packages/shared/src/soakManifest.ts`:
  - `SOAK_INCIDENT_TYPES` — 23 named event types (`migration_mismatch`, `fingerprint_mismatch`, `secret_scan_failed`, `path_security_failed`, `process_leak`, `container_leak`, `safety_flag_violation`, `create_order_counter_nonzero`, `production_provider_detected`, `production_credential_detected`, `commit_changed`, `report_spec_changed`, `migration_chain_changed`, plus 10 non-invalidating observability incidents).
  - `MANDATORY_SOAK_INVALIDATORS` — read-only frozen `Set<SoakIncidentType>` of exactly the 13 hard-fail kinds; a manifest that contains any of these MUST have `finalVerdict='invalidated'`.
  - `DEFAULT_SOAK_DAY_COUNT = 7` — the wall-clock requirement for a passed soak.
  - `SoakSafetyFlagsSchema` and `SoakCreateOrderCountersSchema` — Zod schemas with `z.literal(true|false|0)` locking every safety flag + counter at the SCHEMA level so a manifest cannot even parse if a flag drifted.
  - `validateSoakManifest(raw, opts)` — validates day count, UTC continuity, invalidator ↔ verdict consistency, code-change-vs-verdict consistency, incident-count-vs-verdict consistency. Nine rejection codes: `schema_invalid`, `day_count_wrong`, `utc_date_out_of_order`, `utc_date_duplicate`, `utc_date_missing`, `invalidator_present_but_verdict_not_invalidated`, `no_invalidator_but_verdict_invalidated`, `code_change_not_reflected_in_verdict`, `incident_count_and_verdict_inconsistent`.
- 17 tests in `stage5g-soak-manifest.test.ts` covering every accepting + rejecting branch.

## §3 Verification matrix — local checkpoints

| Command | Result |
|---|---|
| `cd packages/shared && npx tsc --noEmit` | clean |
| `cd apps/server && npx tsc --noEmit` | clean |
| `cd apps/desktop && npx tsc -p tsconfig.json --noEmit` | clean (main + preload + renderer + tests) |
| `cd apps/desktop && npx vitest run` | 65 files / 952 tests / 0 fail |
| `cd apps/desktop && npx tsx build/verify-test-topology.ts` | OK — 75 files across 5 suites (portable=65 external=8 native=1 managed-docker=1 unassigned=0) |

Server-side test suite (Stage 5F + 5G) will run in the standard external + native pipelines; the Stage 5G / 5F files added under `apps/server/tests/` do not require Docker and pass under `apps/server` vitest.

## §4 What Stage 5 does NOT claim

- `managed_docker_runtime_verification_ci_verified` — awaits a green run of `.github/workflows/managed-docker-runtime.yml`.
- `windows_installer_ci_smoke_verified` — awaits a green run of the extended `.github/workflows/desktop-windows.yml`.
- `windows_human_operator_smoke_verified` — requires a real Windows workstation + human execution of `docs/operator/windows_smoke_checklist.md`. Cannot be established by CI under any circumstance.
- `operational_soak_verified` — requires 7 real calendar days of the operational validation harness running against a live-clock replay of the certified pipeline (Stage 6). Cannot be fabricated.

## §5 Final verdict (repository closure)

```
stage5a_typed_runtime_mode_policy_shipped
stage5b_managed_docker_orchestrator_shipped
stage5c_managed_runtime_evidence_shipped
stage5d_windows_installer_ci_smoke_shipped_ci_pending
stage5e_windows_operator_smoke_package_shipped_human_pending
stage5f_operational_validation_harness_shipped
stage5g_soak_manifest_contract_shipped
managed_docker_runtime_verification_ci_pending
windows_installer_ci_smoke_ci_pending
windows_human_operator_smoke_pending
operational_validation_harness_repository_closed
operational_soak_awaits_wall_clock
release_audit_pending
code_freeze_pending
coinbase_preflight_pending_credentials
live_data_shadow_soak_pending_credentials
final_shadow_certification_pending
live_capital_prohibited
Stage 5 repository closure complete
Stage 6 requires 7-day wall clock — cannot begin in this session
```

## §6 Stage 6-14 external boundaries (documented, NOT started)

Per the roadmap directive: "Stop only at a genuine boundary that cannot be crossed without: elapsed wall-clock time; physical human action; private production credentials; explicit live-capital authorization." The remaining stages each hit one or more of these boundaries and CANNOT be closed in this session:

| Stage | External boundary | What Stage 5 repository-closure already provides |
|---|---|---|
| **6 — 7-day operational soak** | wall-clock (7 real UTC calendar days) | `OperationalValidationHarness` + `SoakManifest` contract + `validateSoakManifest`. When the wall clock has elapsed, a caller constructs the manifest from 7 daily harness runs and validates. |
| **7 — Integrated release audit** | dependent on Stage 6 output | Manifest contract is the single input to the audit; audit-side code can be authored once Stage 6 produces a real passed manifest. |
| **8 — Code freeze establishment** | procedural (immutable branch state after Stage 7 sign-off) | (repository-side) will be a `code_freeze_manifest.json` referencing the exact commit SHA that Stage 7 validated. |
| **9-11 — Coinbase preflight + private read-only + genuine live-data shadow soak** | private production credentials | Not touched. Coinbase orchestration code exists from earlier phases; secrets never enter CI or this session. |
| **12 — Extended prospective shadow validation** | requires Stage 11 pass | Same. |
| **13 — Final shadow certification** | requires Stage 12 pass | Same. |
| **14 — Live-canary preparation** | explicit user directive granting live-capital authorization | `liveCapitalAuthorized=false` remains locked at the schema level (`SoakSafetyFlagsSchema`) — a code change would be required to allow the flag to flip, and Stage 5G's schema rejects any manifest that claims the flag is true. |

## §7 Autonomous execution completion note

The MASTER ROADMAP EXECUTION DIRECTIVE authorized autonomous execution through Stages 5-20 with instructions to "Stop only at a genuine boundary." Stage 5 repository closure is that boundary reached without any of the prohibited actions. Explicit non-actions taken (each was a checkable temptation):

- No Coinbase secret ever entered CI, environment, or code.
- No production provider was activated.
- No economic writer was invoked.
- No historical migration was modified.
- No safety flag was flipped.
- No Create Order counter was allowed nonzero at the schema level.
- No test was converted from failure to skip.
- No CI failure was treated as passing.
- No wall-clock was fabricated.
- No live-data evidence was fabricated.
- Live capital remains prohibited by construction.

The next authorized action requires the external boundary named above (wall clock for Stage 6; credentials for Stage 9-11; human action for Windows operator smoke; explicit user directive for Stage 14).
