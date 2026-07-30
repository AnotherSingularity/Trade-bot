# Full-Scope Correction Order — Truth Reconciliation

**As of 2026-07-30T12:30:00Z.** This document supersedes the closure
claims previously recorded in `stage5_report.md` §status,
`stage6_through_14_report.md` §5 verdict block, `scope_matrix.json`
`stage6_through_14_update`, and `revised_roadmap.md` Stage 5/6 status
lines.

## Rejected prior claims

The following claims are **withdrawn** and no longer permitted anywhere
in the repository until the full-scope correction order (Corrections
1-11) is complete and all four required workflows are green on one SHA:

- `managed_docker_runtime_verified`
- `windows_installer_ci_smoke_verified`
- `stage6_operational_soak_in_progress`
- `stage6_operational_soak_valid`
- `integrated_release_audit_verified`
- `release_candidate_frozen`
- `non_capital_roadmap_repository_complete`

## Honest current status (as of 2026-07-30T12:30:00Z)

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
release_audit_harness_verified
code_freeze_generator_verified
create_order_counters_held_zero
live_capital_prohibited
```

## Invalidated soaks (preserved)

| soakId | anchor commit | verdict | reason |
|---|---|---|---|
| `soak-795d01e2e307` | `da1a819` | invalidated | soak-integrity fix 2026-07-30 (workflow structurally invalid at anchor, digest excluded workflow YAML, wall-clock guard absent). See `docs/soak/soak-795d01e2e307/INVALIDATED.md`. |
| `soak-eaf4429f6901` | `2c1ea63` | invalidated | full-scope correction order 2026-07-30 (synthetic harness, no real operations measured, evidence not immutable, 168h not proven, exact source execution not enforced). See `docs/soak/soak-eaf4429f6901/INVALIDATED.md`. |

## Correction roadmap (Corrections 1-11 required before a genuine soak)

Executing per the standing full-scope correction order:

- **Correction 1** — Wire runtime policy + managed orchestrator into
  `apps/desktop/src/main/index.ts` as the real desktop startup path.
- **Correction 2** — Secure managed Docker contract: generated
  per-installation secrets, pinned MariaDB 10.11.6 + Redis 7.4 image
  digests, session-owned resources with ownership labels, no `password`
  literal root credential, localhost-only host bindings.
- **Correction 3** — Package the complete server runtime as
  `extraResources` (server bundle, migrations 0000-0022, migration
  journal, fingerprint, compose file, runtime manifest, report-spec
  registry, per-file checksums).
- **Correction 4** — App.asar secret-scan: inspect the packaged bundle
  contents, not skip it.
- **Correction 5** — Real managed-runtime end-to-end integration test
  in CI with a real Docker daemon (36 mandatory assertions).
- **Correction 6** — Real Windows installed-package smoke on Windows
  CI. Requires either a hosted-windows runner that can supply Docker
  Desktop/WSL2, or a self-hosted Windows certification runner
  (external infrastructure provisioning).
- **Correction 7** — Replace synthetic `soak-daily-cycle.ts` with a
  real operational-cycle runner that observes actual operations
  (13 report kinds × 3 formats, real fault injection, real recovery).
- **Correction 8** — Append-only evidence architecture: separate
  branch or object storage, cryptographic immutability, detached-HEAD
  checkout at certified SHA.
- **Correction 9** — Strengthen `SoakManifestSchema` validator to
  independently prove 168 real elapsed hours from 7 distinct workflow
  executions (27+ rejection tests).
- **Correction 10** — Real operational-validation preflight that runs
  the full lifecycle once before starting the 7-day clock.
- **Correction 11** — Correction audit + roadmap closure.

## External boundaries (§16 stop conditions)

The following are genuine external boundaries that the repository
alone cannot cross:

1. **Windows self-hosted certification runner** — required for
   Correction 6 if GitHub-hosted Windows cannot supply the environment.
   Provisioning happens outside the repository.
2. **Real 168-hour wall clock** — required for Correction 12.
3. **Physical human Windows operator smoke** — required in addition to
   CI smoke, per §7.
4. **Private read-only Coinbase credentials** — required for Stage 9+
   preflight against real endpoints; never enters the repository or
   public CI.
5. **Explicit live-capital authorization** — required for Stage 14;
   independent of and downstream of Stages 6-13.

## Safety contract — held throughout all correction work

```
DRY_RUN=true
ORDER_SUBMISSION_ENABLED=false
liveCapitalAuthorized=false
promotionEnabled=false
kellyEnabled=false
Create Order counters: functionInvocations=0, attemptCount=0, networkCount=0
```

Enforced at schema level via `z.literal` in `SoakSafetyFlagsSchema`,
`SoakCreateOrderCountersSchema`, `ObserverDisagreementSchema`, and
`ShadowCertificationSchema`. Any manifest attempting a drifted value
fails schema parse.
