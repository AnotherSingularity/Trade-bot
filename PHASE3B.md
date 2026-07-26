# Phase 3B — Integrated audit, Windows release verification, code-freeze package

Phase 3B produces the immutable audit + freeze package for the
Horizon Trade desktop/server system. Every §Q certification test
that this Linux container can honestly execute is green. The Windows
installer artifact + clean-machine smoke test remain a native Windows
activity and are recorded in the code-freeze manifest as pending.

## Honest verdict

    desktop_agenda_code_complete
    desktop_code_frozen (provisional — pending §M + §N Windows verification)
    windows_installer_verified: NOT YET CLAIMED
    mobile_companion_deferred
    operational_validation_pending
    live_capital_prohibited

Per the Phase 3B work order:

> `windows_installer_verified` may be claimed only after a real
> Windows artifact is built and smoke-tested.

The Windows CI workflow (`.github/workflows/desktop-windows.yml`) ran
against commit `3f5b6c4` (Phase 3A) and FAILED with
`Cannot find module '../build/generate-build-manifest'` — the
`apps/desktop/build/` path was suppressed by the repo-root `.gitignore`
`build/` rule. Phase 3B fixes this via `apps/desktop/.gitignore`
un-ignoring the local `build/` directory so the manifest generator
is committed and the Windows CI can find it.

On this Phase 3B push the Windows CI will re-trigger; if it succeeds,
the operator regenerates the code-freeze manifest with
`HORIZON_WINDOWS_INSTALLER_SHA256` + `HORIZON_WINDOWS_CI_RUN_ID`
populated and `HORIZON_FREEZE_STATUS=verified`, then re-runs the
Phase 3B certification suite. `windows_installer_verified` becomes
claimable at that point.

Reporting format:

- **active desktop/server release surface**: verified
- **mobile companion workspace**: deferred, non-blocking

## Absolute invariants preserved

- `DRY_RUN=true` and `ORDER_SUBMISSION_ENABLED=false` enforced at
  startup, in IPC responses (Zod `z.literal`), and in every export.
- `providerMode ≠ external` refused at boot.
- CreateOrder function invocations / attempts / network counts remain zero.
- No production Coinbase WebSocket, no two-hour preflight, no seven-day soak.
- No genuine Coinbase credentials used.
- Migrations 0000-0020 remain immutable; drizzle-kit diff clean.
- Mobile workspace excluded; not audited.

## Audit artifacts (`phase3b_audit/reports/`)

| Artifact | Kind | Status |
|---|---|---|
| release_surface_manifest.json | machine-readable | green |
| dependency_graph.json | machine-readable | 244 files scanned |
| isolation_report.json | machine-readable | **0 violations** across 10 boundary rules |
| economic_writer_inventory.json | machine-readable | 35 candidate writers across 11 tables |
| create_order_audit.json | machine-readable | **0 forbidden call sites**; 41 hits classified |
| db_migration_audit.json | machine-readable | 21 migrations, 21 snapshots, contiguous journal |
| numerical_audit.json | machine-readable | 193 hits recorded for manual sign-off |
| desktop_security_audit.json | machine-readable | **35/35 checks pass** |
| accounting_certification.md | markdown | 18 scenarios pass; unexplained diff = 0.00000000 |
| statistical_audit.md | markdown | approximation labels honest; multiplier ≤ 1 |
| docker_service_audit.md | markdown | 20 items pass; compose bindings safe |
| dependency_sbom_report.md | markdown | dev-dep vulns documented; production surface clean |
| desktop_screen_audit.md | markdown | 19 screens × 8 states matrix |
| export_redaction_audit.md | markdown | 13 report kinds; redaction contract complete |
| code_freeze_manifest.json | machine-readable | `status=pending_windows_verification` |

## Audit scripts (`phase3b_audit/scripts/`)

- `release_surface.mjs` — enumerates active workspaces + infra + docs
- `dependency_graph.mjs` — imports graph + 10 boundary rules
- `create_order_audit.mjs` — classifies every Create Order / outbound
  network call site
- `economic_writer_inventory.mjs` — classifies every DB write to an
  economic table
- `db_migration_audit.mjs` — filename + hash + snapshot integrity
- `numerical_audit.mjs` — silent-NaN / silent-Infinity / unsafe
  coercion static scan
- `desktop_security_audit.mjs` — 35 Electron/renderer boundary checks
- `code_freeze_manifest.mjs` — freeze manifest generator (marks
  provisional until Windows verification lands)

## Runbooks (`docs/runbooks/`)

All 27 required runbooks written; README indexes them and marks
which are NOT to be executed in Phase 3B (22, 24, 27).

## Tests

- **Desktop**: **101/101 pass** (77 Phase 3A + 24 Phase 3B §Q
  certification tests)
- **Server**: lint + typecheck green; full test run recorded during
  Phase 2F verification (see PHASE2F.md); no code change to server
  runtime in Phase 3B beyond the migration snapshot regenerator
  metadata already touched in Phase 3A.
- **Shared**: typecheck green; no tests defined for this workspace.

## Explicit deferrals / non-actions

- Windows installer artifact + clean-machine smoke test: pending
  Windows CI green on the Phase 3B push.
- Operational preflight: not started.
- Seven-day soak: not started.
- Genuine Coinbase credentials: not used.
- Observer enforcement: disabled.
- Kelly sizing: disabled.
- Non-interactive promotion: absent from source.
- Champion thresholds / allocation / TP / SL / routing: unchanged.
- Mobile workspace: deferred, not audited.

## What §M + §N still need

To finish Phase 3B and claim `windows_installer_verified`:

1. Windows CI on `.github/workflows/desktop-windows.yml` completes
   with a green `lint-and-test` + `package-windows` job on this
   commit.
2. The workflow uploads `Horizon Trade Setup.exe` + its SHA-256 as
   a workflow artifact.
3. An operator installs the produced installer on a clean Windows
   VM and executes the sequence in Runbook 01 + §N of the work
   order (install → launch → validate secure Electron settings →
   navigate every screen → export one report → shutdown → relaunch
   → uninstall).
4. The operator regenerates the code-freeze manifest with
   `HORIZON_WINDOWS_INSTALLER_SHA256`, `HORIZON_WINDOWS_CI_RUN_ID`,
   and `HORIZON_FREEZE_STATUS=verified` set.
5. The Phase 3B suite re-runs and Q36-Q42 flip from "blocked" to
   "populated". The verdict then becomes:

       desktop_agenda_code_complete
       desktop_code_frozen
       windows_installer_verified
       mobile_companion_deferred
       operational_validation_pending
       live_capital_prohibited

After that final verdict, the freeze commit is the authoritative
release baseline; every subsequent change requires the Runbook 26
change-control protocol.
