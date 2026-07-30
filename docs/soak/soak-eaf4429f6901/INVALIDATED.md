# Soak `soak-eaf4429f6901` — INVALIDATED

## Classification

- `synthetic_harness_calendar_run`
- `not_operational_validation`
- `not_runtime_soak`
- `not_release_evidence`

## Verdict

`finalVerdict = "invalidated"`

## When

- Started: `2026-07-30T12:10:47.239Z`
- Invalidated: `2026-07-30T12:30:00Z`
- Anchor commit: `2c1ea63f65294172c9bec6d3a436030aff17bcdc`
- Elapsed at invalidation: < 1 UTC day

## Preserved evidence (DO NOT delete or overwrite)

- `INVALIDATED_ANCHOR.json` — the anchor with `finalVerdict='invalidated'` + full metadata.
- `day-2026-07-30.json` — day-0 result from the synthetic runner.
- `manifest.in-progress.json` — manifest snapshot at invalidation.
- Workflow run IDs preserved: launch `30541406133`, day-0 daily `30541610293`.
- Evidence commits preserved: anchor `45b8259`, day-0 `0d6501f`.
- runtimeContentDigest preserved: `24f2da3e7788adda8306716f5f1ef17ce5b5bf5a6eb54006552f570d755b8756`.

## Reason — this was a certification-model defect, not a minor harness defect

The invalidation is triggered by the following mechanical findings from the
full-scope correction audit. All eight are true simultaneously.

### 1. `soak-daily-cycle.ts` synthesized event labels rather than observing executed operations

The daily runner instantiates `OperationalValidationHarness` and calls
`observe(kind, {...})` for a fixed set of event labels
(`runtime_started`, `report_generated`, `report_verified`,
`database_disconnected`, `redis_reconnected`, …). Each `observe()` call
appends a synthetic event with a deterministically-seeded clock. The
harness does not orchestrate the managed runtime, does not call the
report generator, does not open a database connection, does not open a
Redis connection, and does not measure any real process. The
"observations" are event labels, not measurements.

### 2. No real managed Docker lifecycle occurred

`ManagedDockerOrchestrator` was never invoked. No container was started
under the soak's session ownership. No image digest was verified. No
readiness poll was performed against a real MariaDB or Redis instance.

### 3. No real report generation or artifact verification occurred

The reported counts (`reportJobsQueued=39`, `reportJobsCompleted=39`,
`artifactVerificationPasses=39`) are hardcoded literals emitted by the
runner. No report worker was invoked; no artifact file was persisted;
no artifact was verified against a canonical content digest.

### 4. No real database/Redis disconnect or recovery occurred

The counts (`databaseDisconnects=1`, `databaseReconnects=1`,
`redisDisconnects=1`, `redisReconnects=1`) are synthetic. No connection
was ever opened, so no disconnect could be observed.

### 5. No real process or container cleanup was measured

The counts (`processLeaks=0`, `containerLeaks=0`,
`temporaryCleanupFailures=0`, `orphanReconciliations=0`) came from
synthetic events, not from `ps` inspection or `docker ps` inspection.

### 6. Evidence could be backfilled or overwritten

Daily evidence was committed to the same source branch as the anchor.
There was no cryptographic immutability. The `HORIZON_SOAK_DATE`
environment variable could be set to any past or future date. Nothing
prevented an operator from overwriting a day-*.json file directly on the
branch and re-running the reassembly.

### 7. The manifest did not independently prove 168 elapsed hours

`assembleAndValidateManifest` compared `days.length` to
`DEFAULT_SOAK_DAY_COUNT` and (after the soak-integrity fix) to a
wall-clock guard `Date.now() >= finalizationEligibleAt`, but did not
verify that observations came from **distinct workflow run IDs** at
**distinct real UTC timestamps**, nor that `actualEndAt` was derived
from the real final workflow completion time. The 7-day contract was
proven only by anchor timing, not by 7 independent evidence records
originating in 7 distinct real cron cycles.

### 8. Exact anchored source-tree execution was not enforced

`operational-soak-daily.yml` runs `actions/checkout@v4` at the branch
tip, not at the anchored commit SHA. `runtime-content-digest.ts`
verified file-content hashes but did not enforce a detached-HEAD
checkout at the certified commit. A future commit could land on the
branch tip mid-soak, and the runner would execute it (and only detect
drift via digest, not via SHA equality).

## Fixes required (implemented across Corrections 1-11 of the full-scope order)

The successor soak — if any — will be launched only after all of the
following are complete and green in CI:

1. **Correction 1** — real managed runtime wiring in `apps/desktop/src/main/index.ts`.
2. **Correction 2** — secure managed Docker contract (generated per-installation secrets, pinned image digests, session-owned resources, no `password` literal root credential).
3. **Correction 3** — packaged runtime assets (server bundle, migrations, fingerprint, compose file, checksums) inside the installer.
4. **Correction 4** — packaged secret scan that inspects `app.asar` contents rather than skipping it.
5. **Correction 5** — real managed-runtime end-to-end integration test in CI with real Docker daemon.
6. **Correction 6** — real Windows installed-package smoke on Windows CI (self-hosted runner if hosted Windows cannot provide the required environment).
7. **Correction 7** — real operational-cycle runner that observes actual operations (not synthetic events).
8. **Correction 8** — append-only evidence architecture (separate from source branch, cryptographic immutability, detached-HEAD checkout at certified SHA).
9. **Correction 9** — strengthened `SoakManifestSchema` validator with 27+ rejection tests that prove 168 real elapsed hours from distinct workflow executions.
10. **Correction 10** — real operational-validation preflight that exercises the full lifecycle once before starting the 7-day clock.

## What this invalidation does NOT do

- Does not delete preserved evidence.
- Does not change the `SoakSafetyFlagsSchema` z.literal locks:
  `DRY_RUN=true`, `ORDER_SUBMISSION_ENABLED=false`,
  `liveCapitalAuthorized=false`, `promotionEnabled=false`,
  `kellyEnabled=false` remain enforced.
- Does not permit fabrication of the elapsed wall clock.
- Does not shorten the seven-day interval for any successor soak.
- Does not authorize live capital.

## Honest current status

Per §2 of the full-scope correction order:

```
stage5_runtime_policy_contract_present_not_wired
stage5_managed_mariadb_redis_compose_health_test_present
managed_docker_desktop_runtime_not_verified
packaged_managed_runtime_assets_incomplete
windows_installer_build_static_layout_verified
windows_installed_application_smoke_not_verified
operational_validation_harness_synthetic_only
stage6_operational_soak_invalidated
seven_day_operational_soak_not_started
create_order_counters_held_zero
live_capital_prohibited
```
