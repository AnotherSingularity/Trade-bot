# Claim reconciliation

Every published claim reclassified against direct evidence. Prior
documents remain in the repository as historical claims; this file
appends the corrected status. Nothing is deleted.

Status legend: **supported** | **partially_supported** | **unsupported** | **superseded** | **operationally_unverified**

## PHASE3A.md — "Windows Desktop Operator Console"

| Claim | Actual status | Correction |
|---|---|---|
| `desktop_operator_console_complete` | **partially_supported** | The Electron shell + IPC allowlist + 19 route stubs are complete. 15 of 19 screens are `ui_shell` (no server request). Authentication is disabled at boot. Values displayed on Overview/Safety/Configuration are hardcoded. |
| `windows_packaging_ready` | **unsupported** | The `build.files` allowlist is materially incomplete (server, migrations, compose files, most node modules absent). Windows CI has never produced a green build. |
| "77 desktop tests / 77 pass" | **supported (in-container)** | Under Vitest in the Linux container the suite passes. It proves the unit and static-source contracts, NOT runtime completion. |
| "compose service names match" | **unsupported** | Adapter says `mariadb`; docker-compose files define `db`. |
| "migration 0020 applied" | **supported at server test level** | Migration file + snapshot exist; `drizzle-kit generate` returns empty diff on server tests. `ServerAdapter.migrate()` in the desktop returns `ok:true` without running the migration. |
| "safe flags enforced at boot" | **supported** | `validateDesktopEnvironment` refuses to launch with DRY_RUN=false / ORDER_SUBMISSION_ENABLED=true / providerMode=external. |
| "createOrderCounters zero" | **partially_supported** | Server counter mechanism (fetchBarrier) is real. Desktop displays a hardcoded `0` regardless of the real counter row. |

## PHASE3B.md — "Integrated audit + code-freeze"

| Claim | Actual status | Correction |
|---|---|---|
| `desktop_agenda_code_complete` | **unsupported** | Renderer bindings absent for 15/19 screens; auth disabled; reports return hardcoded failure; supervisor uses InMemoryRunner. |
| `desktop_code_frozen (provisional)` | **superseded** | The word "frozen" implies a runtime baseline. What actually exists is a code baseline that has never run end-to-end. Superseded by "scope_reconciliation_required". |
| `windows_installer_verified` (explicitly withheld) | **honest** | Correctly withheld. |
| "isolation report: 0 violations across 10 rules" | **supported** | Static import scan is accurate; the 10 rules are correctly encoded. |
| "35/35 desktop security checks pass" | **supported (static)** | Static scans of `windows.ts`, `ipcContract.ts`, `authentication.ts`, `logging.ts` produce the expected regex matches. They do NOT prove Electron applies those settings at runtime — that requires a real launch. |
| "unexplained accounting difference = 0.00000000" | **partially_supported** | True at the SERVER test-suite level. Not true at the desktop-runtime level (the desktop has never accounted for anything). |
| "code-freeze manifest is complete" | **partially_supported** | Manifest exists with all required fields; the `windowsInstallerHash` + `windowsInstallerRunId` are null; `status=pending_windows_verification` is honest. |
| "Docker/service audit — all 20 items pass" | **partially_supported** | The audit describes the intent of the compose files. It did not catch the `mariadb` vs `db` service-name defect that the desktop adapter would immediately hit. |
| "numerical audit — 193 hits recorded for manual sign-off" | **partially_supported** | The audit script is real. The disposition column is missing — no per-hit review was actually done. |
| "Q1-Q50 certification: 101/101 pass" | **partially_supported** | The tests pass. Most of them assert artifact-existence and file-content patterns rather than runtime behavior. |
| "27 runbooks written" | **supported (as documents)** | All 27 exist with the required sections. **operationally_unverified** — none has been exercised against a real system. |

## CHANGELOG.md

No entries added in Phase 3A/3B. **partially_supported** — the
changelog is not maintained; commit messages are the actual record.

## README.md

Documentation still describes the mobile app and does not mention the
desktop workspace. **partially_supported** — the desktop shell exists;
the README does not describe how to install/build/run it.

## code_freeze_manifest.json

- `commit`, `branch`, `desktopVersion`, `serverVersion`,
  `sharedVersion`, `buildArtifactHashes`, `migrationVersion`,
  `lockfileHash`, `championVersion`, `strategyVersion`, `cost*`,
  `protectionPolicyVersion`, `featureVersions`, `regimeVersions`,
  `riskPolicyVersion`, `microstructurePolicyVersion`,
  `contextPolicyVersion`, `validationPolicyVersion`,
  `desktopConfigurationVersion` — **supported** as pointers into the
  code tree. Version *values* (`champ-1`, `p2a-1` etc.) are
  arbitrary labels, not signed values.
- `safeFlags` — **supported** as the compiled-in intent.
- `productionAdapterIdentities` — **partially_supported**;
  described as "committed-inactive". Confirmed inactive.
- `windowsInstallerHash`, `windowsInstallerRunId` — **null**;
  honestly labeled.
- `guarantees` — **supported**: preflight not started, soak not
  started, no genuine credentials, no live capital.

## audit reports (phase3b_audit/reports/)

- `isolation_report.json` — **supported**.
- `create_order_audit.json` — **supported** after classifier update.
- `db_migration_audit.json` — **supported** for filename + hash
  integrity; **unsupported** for "fresh-from-zero migration
  succeeds" (that requires actual `drizzle-kit migrate` run).
- `numerical_audit.json` — **partially_supported** as noted.
- `desktop_security_audit.json` — **supported (static)**.
- `accounting_certification.md` — **partially_supported** (server
  test level; not desktop-runtime level).
- `statistical_audit.md` — **supported**.
- `docker_service_audit.md` — **partially_supported** (missed the
  `mariadb` vs `db` mismatch).
- `dependency_sbom_report.md` — **supported**.
- `desktop_screen_audit.md` — **unsupported**: the table asserts
  loading/empty/healthy states pass for 19 screens; only 4 screens
  actually query anything.
- `export_redaction_audit.md` — **unsupported**: the export handler
  returns hardcoded failure. Nothing has ever been redacted or
  written to disk.
- `code_freeze_manifest.json` — **partially_supported** as noted.

## release-surface manifest

`phase3b_audit/reports/release_surface_manifest.json` — **supported**
as an enumeration of files. The "verified" reporting label is
**unsupported** at the runtime level; it only means the files exist.

## Consequence

Two prior verdicts must be downgraded:

- Phase 3A's `desktop_operator_console_complete` →
  **desktop_shell_complete + desktop_operational_wiring_incomplete**
- Phase 3B's `desktop_code_frozen` → **scope_reconciliation_required**

The historical documents remain intact as evidence of what was
claimed. This file is the corrected record.
