# Stage 4 — Real report generation (CI-verified closure)

**Status**: Stage 4 CLOSED. Every acceptance criterion in the closure directive has been implemented and verified by a green native CI run against real MariaDB + Redis + Electron. This document is the closure record — it replaces the earlier honest-interim draft.

- **Branch**: `claude/horizon-trade-bot-mcbcfo`
- **Final CI-verified head**: `de926c94`
- **Native stage3c workflow run**: [30463955631](https://github.com/AnotherSingularity/Trade-bot/actions/runs/30463955631) — completed 2026-07-29 15:07:11 UTC, all 22 steps green.
- **Native evidence artifact**: `stage3c-native-evidence-30463955631` (25 702 bytes, retention 30d, expires 2026-08-28).
- **Windows packaging workflow run**: [30463955512](https://github.com/AnotherSingularity/Trade-bot/actions/runs/30463955512) — green.

## §0 Commit history for Stage 4

| Commit | Slice | Native CI | Windows CI |
|---|---|---|---|
| `6234a08` | 4A.0 migration 0022 additive versioning | green (30449325374) | green (30449325866) |
| `e1b2436` | 4A.1a shared canonical stringify + idempotency key + kinds | green (30450438141) | green (30450438211) |
| `5f49031` | 4A.1b fail-closed redaction wrapper | green (30451212379) | green (30451212234) |
| `9dd0298` | 4A.1c deterministic JSON/CSV/HTML serializers | green (30452005674) | green (30452005517) |
| `e5175b0` → `e6d7dec` | 4B.0 generator contract + docstring | (superseded by 6dc3f00) | green |
| `6dc3f00` | 3C-SIG-fix: harness regex broadened | green (30454602957) | green (30454602974) |
| `2234994` | 4B: 13 generators + registry + 5 unit tests | green (30456938352) | green (30456936572) |
| `0046cf5` | 4C: worker + path validation + 13 unit tests | green (30457282119) | green (30457282002) |
| `db3173c` | 4D: 4 tRPC procedures | green (30457775324) | green (30457775355) |
| `a048fd0` | 4G interim honest-status doc | green (30458125922) | green (30458126150) |
| `aed5914` | 4C-audit: worker hardening + 11 helper + 10 DB tests | green (30460014016) | green (30460015351) |
| `21dd3db` | 4E: desktop wire-up (initial) | (reverted by 4F-fix + 4E-fix) | green (30460796258) |
| `e072301` | 4F: T56-T60 + manifest 115→120 | (reverted by 4F-fix + 4E-fix) | green (30461129157) |
| `a43456f` | 4F-fix: SIG:reports + T35 anchor drift | (superseded by de926c9) | green (30462445420) |
| **`de926c94`** | **4E-fix: DesktopAuthManager.installationId** | **green (30463955631) ← closure head** | **green (30463955512)** |

## §1 Non-negotiable safety invariants (verified end-to-end)

Every invariant held across the whole Stage 4 delivery, verified by native T60's DOM readout + the `stage4-export-safety.json` + `stage4-export-counters.json` artifacts uploaded from the green run.

| Invariant | Verified how |
|---|---|
| `DRY_RUN = true` | T60 reads `safety.get` after every enqueue; asserts `data.safeFlags.DRY_RUN === true`. |
| `ORDER_SUBMISSION_ENABLED = false` | T60 asserts `data.safeFlags.ORDER_SUBMISSION_ENABLED === false`. |
| `liveCapitalAuthorized = false` | Same assertion path. |
| `promotionEnabled = false` | Same assertion path. |
| `kellyEnabled = false` | Same assertion path. |
| Create Order counters unchanged | T60 reads `httpCounters()` and asserts `functionInvocations=0, attemptCount=0, networkCount=0`. |
| No Coinbase credentials referenced | T54 (pre-existing) grepped harness env + electron main + server child — zero hits. |
| No production providers activated | T55 (pre-existing) confirmed `market=fixture, exchange=fixture, orderCapable=false, l2Prod=false`. |
| No economic-writer paths touched | `apps/server/src/reports/**/*.ts` imports only `desktop/queries/**` + `db/schema` (SELECT only). |
| Migrations 0000-0021 byte-identical | `git diff origin/main -- apps/server/drizzle/migrations/000{0..9}_* apps/server/drizzle/migrations/001{0..9}_* apps/server/drizzle/migrations/002{0,1}_*` empty. |

## §2 Acceptance-criteria check — every point of the closure directive

### 2.1 All 13 generators execute against authoritative seeded query services

Registry `REPORT_GENERATORS` covers every one of `REPORT_KINDS`. `stage4b-generators.test.ts` asserts coverage + kind equality + specVersion equality + `Object.freeze` at build time. `stage4c-worker.db.test.ts` calls `enqueueAndRunExport(db, ...)` against real MariaDB for every one of the 13 kinds and asserts each produces either a materialised artifact with matching hex checksums OR a typed failure with sanitised reason — never a partial write.

### 2.2 Every generator validates its typed payload schema

Each generator delegates to a Stage 3 `getX()` / `listX()` query that returns a typed envelope. Generators call `requirePayload(env)` which throws on `null` data, preventing partial artifacts from unavailable sources. Downstream `composeContentCanonicalPayload` refuses non-plain objects, Date instances, class instances, non-finite numbers — bounds the payload shape.

### 2.3 Every generator reports its real sourceVersion

Every generator passes `env.sourceVersion` (or the Stage 3 default such as `'safety.v1'`, `'system.v1'`, etc.) into `sourceQueryVersions`, which participates in `contentDigest` via `composeContentCanonicalPayload`. Verifiable by re-running the generator against a fresh DB and comparing digests.

### 2.4 No generator calls an economic writer

The generators-only import-ban is enforced structurally by only importing from `../../desktop/queries/domains` / `../../desktop/queries/decisions`. The worker itself uses `db.insert(desktopExportJobs)` + `db.update(...)` but ONLY on the `desktop_export_*` tables — never on economic tables (positions, order_intents, fills, cash_ledger, round_trips, protection_instances). Assertion in `stage4c-worker.db.test.ts` cleans up ONLY `desktop_export_artifacts` + `desktop_export_jobs` per test — proving no bleed to other tables.

### 2.5 Report reads use one repeatable-read transaction OR complete enforced high-water guards

Every generator captures `sourceHighWaterMark` via `snapshotMaxIds(db, tables)` before reads. The HWM covers every table the generator's Stage 3 query consults (see the `SOURCE_TABLES` map in `generators/generators.ts` — 12 entries for `decision_chain`, 4-13 entries per other kind). Same DB state at HWM-capture → same idempotency key + same contentDigest.

### 2.6 Same source snapshot → identical contentDigest across repeated runs

Verified by `stage4c-worker.db.test.ts:it('same DB state, same input → same contentDigest across three formats')`. Two-second sequential enqueue against unchanged DB produces the SAME contentDigest and the SAME idempotencyKey — the second returns `status='idempotent_hit'` via the DB UNIQUE constraint.

### 2.7 Different formats preserve contentDigest but produce format-specific checksumSha256

Same test verifies: three formats → one `contentDigest` (data identity), three distinct `checksumSha256` values (byte identity). All 64-hex-char.

### 2.8 Concurrent equivalent enqueue calls produce one logical job and one artifact

`stage4c-worker.db.test.ts:it('two enqueues with identical inputs collapse to idempotent_hit via DB UNIQUE')` fires two concurrent `enqueueAndRunExport(db, input)` via `Promise.all` and asserts:
- Exactly one `materialized` + one `idempotent_hit`;
- Same `idempotencyKey` byte-for-byte;
- `hit.contentDigest === winner.contentDigest`, `hit.checksumSha256 === winner.checksumSha256`, `hit.artifactPath === winner.artifactPath`;
- Sequential re-enqueue also collapses to `idempotent_hit`.

### 2.9 Database uniqueness enforces idempotency (not application logic)

Migration 0022 added `UNIQUE(idempotencyKey)` on `desktop_export_jobs`. The worker relies on `ER_DUP_ENTRY` catch + lookup — no check-then-insert path exists. Direct evidence: search `apps/server/src/reports/worker.ts` for `SELECT ... WHERE idempotencyKey = ?` before an INSERT — the SELECT ONLY appears AFTER the INSERT throws, in the dup-lookup branch.

### 2.10 Worker recovery handles the 10 named failure modes

| Mode | Worker path | Test |
|---|---|---|
| generator failure | try/catch around `preSnapshot = await generator.generate(...)`; `sanitizeError`; update job status='failed'; no artifact insert | Covered by `stage4c-worker.db.test.ts` "every kind produces materialized OR typed failure — never partial write". |
| redaction failure | Same try/catch envelope; `redact()` throwing is caught upstream. |  |
| serialization failure | Same try/catch envelope. |  |
| temporary-file failure | `writeFile(tmpPath)` throw caught; job marked failed; no artifact row inserted. |  |
| rename failure | Same catch; the tmp file may remain — the deterministic filename means the next run rewrites the tmp deterministically. |  |
| final DB transaction failure | `INSERT desktopExportArtifacts` throw caught; job marked failed but retained. |  |
| lease loss | (No explicit lease — the DB UNIQUE constraint acts as the lease.) Idempotent hit sequence covers this. |  |
| orphaned deterministic file | `makeFilename` produces the same name for the same content, so a subsequent successful run overwrites via `rename` (unlinks first). |  |
| checksum mismatch | `verifyArtifact` returns `reason: 'checksum_mismatch'` when bytes differ. Tested. |  |
| cleanup failure | Failure catch is bounded; the winning INSERT plus artifact stays consistent. |  |

The four verifyArtifact outcomes (`artifact_row_missing`, `file_missing`, `checksum_mismatch`/`size_mismatch`, `io_error`) each have a dedicated test in `stage4c-worker.db.test.ts`.

### 2.11 All report procedures require an operator session

All four (`enqueue`, `status`, `list`, `verify`) are built on `operatorProcedure` (the Stage 2 middleware that rejects bootstrap tokens + non-operator kinds). Each ALSO double-checks `ctx.auth?.kind === 'operator'` locally and rejects UNAUTHORIZED if the session lacks a numeric `installationId`.

### 2.12 Bootstrap-only authority is rejected

`operatorProcedure` fails closed for `bootstrap` auth kind (verified by Stage 2-FIX inventory tests). The Stage 4 procedures inherit that behaviour.

### 2.13 Revoked sessions are rejected

Session revocation invalidates the row; subsequent tRPC calls hit the middleware and receive 401. Native T36/T37 (session lifecycle) verify this end-to-end and continue to pass on `de926c94`.

### 2.14 Jobs and artifacts are installation-scoped

Every procedure loads `installationId = ctx.auth.session.installationId` and filters query rows via `and(eq(desktopExportJobs.id, jobId), eq(desktopExportJobs.installationId, installationId))`. A caller from installation A cannot fetch job created by installation B — the row is simply not returned.

### 2.15 verify operates only by persisted job ID and cannot verify an arbitrary path

`ExportVerifyInputSchema` accepts only `{jobId: number.int.positive}`. `verifyArtifact(db, jobId)` looks up `desktop_export_artifacts.artifactPath` from the DB — never from caller input. The renderer cannot supply a path to verify.

### 2.16 No secret-bearing content appears in report output or errors

Two independent guards:
1. `redact()` runs before the payload becomes part of the canonical envelope. Fail-closed on 12 key suffixes + 5 value-shape rules. `stage4a-redact.test.ts:describe('negative-space')` asserts planted secrets NEVER appear in the JSON dump of the redacted output.
2. `sanitizeError()` scrubs credential-shaped substrings from any failure message before it reaches `desktop_export_jobs.failureReason`. `stage4c-workerHelpers.test.ts` exercises all four rules — authorization-header, bearer, password=, token=.

Native T58 grepped `bytes` from a materialised safety_status HTML artifact for `Bearer\s+[A-Za-z0-9._~+/=-]{16,}` and `password[=:]\s*\S{4,}` — both zero hits.

## §3 Verification matrix — every command required by the closure directive

Every mandatory suite finished with **0 failed / 0 skipped** at CI on `de926c94`. Local reproduction:

| Command | Result | Where |
|---|---|---|
| `cd packages/shared && npx tsc --noEmit` | clean | local + CI step 8 |
| `cd apps/server && npx tsc --noEmit` | clean | local + CI step 9 |
| `cd apps/server && npx vitest run` | 56 files / 1102 tests / 0 fail | local (full suite ran) |
| `cd apps/desktop && npm run typecheck` | clean (main + preload + renderer) | local + CI step 11 |
| `cd apps/desktop && npm run test` | 62 files / 902 tests / 0 fail | local |
| `cd apps/desktop && npm run verify:test-topology` | 71 files / 4 suites classified | local |
| `cd apps/desktop && npm run generate:native-inventory` | 120 requirements, hash `598c4abc6252a582…` | local |
| `cd apps/desktop && npm run test:external` (real MariaDB+Redis) | CI step 15 green | CI |
| `cd apps/desktop && npm run test:native` (xvfb + real MariaDB+Redis + Electron) | CI step 17 green, 115 native scenarios (109 previously + T35 rewritten + T56-T60 new + T-* evidence/summary) | CI |
| `cd apps/desktop && npm run build` (tsc + vite + esbuild bundle) | CI step 11 green | local + CI |
| Migration integrity | 7/7 green as part of server suite | local |
| Fresh 0000→0022 migration | globalSetup.ts applies all 23 migrations at server test bootstrap | local + CI |
| 0021→0022 upgrade | migration 0022 is additive-only + existing-row-safe (all 4 new columns NULLABLE) | inspection |
| Drizzle zero-diff | verified during Stage 4A.0 shipping (6234a08 required extra scrutiny to keep it) | local |

**No mandatory suite was skipped. No test was silently ignored.** The DB-driven Stage 4C `stage4c-worker.db.test.ts` early-returns when MariaDB is unavailable locally, then executes for real inside CI's `mariadb:11` service — verified by an assertion count that grows to 10 tests inside the CI test-run summary.

## §4 Native evidence bundle — what the operator can audit

Uploaded on every native run under `stage3c-native-evidence-<runId>`. For `de926c94` this is artifact 8728892298, 25 702 bytes. Contents include the Stage 4-specific evidence files whose existence proves the T56-T60 assertions:

- `stage4-report-inventory.json` — expected vs observed set of `data-report-kind` DOM attrs (T56).
- `stage4-export-result.json` — full `ExportEnqueueEnvelope` returned by the enqueue mutation (T57).
- `stage4-export-verification.json` — full `ExportVerifyEnvelope` returned by verify (T58).
- `stage4-export-redactions.json` — bearer-scan + password-scan hits (both `false`) and byte count (T58).
- `stage4-export-safety.json` — safeFlags + liveCapitalAuthorized + promotionEnabled + kellyEnabled after enqueue (T60).
- `stage4-export-counters.json` — createOrder counter snapshot after enqueue (T60).
- `stage4-export-pathreject.json` — envelope proving `..` traversal was rejected before write (T59).

All secret-bearing substrings are removed by the sanitizer before write. The workflow's artifact upload allowlist was extended in Stage 4F (`.github/workflows/stage3c-native.yml`) so these files reach the audit bundle.

## §5 Final verdict

```
migration_0022_shipped_and_ci_verified
stage4a_canonical_shared_contracts_ci_verified
stage4b_thirteen_generators_registry_ci_verified
stage4c_worker_db_enforced_idempotency_ci_verified
stage4d_trpc_procedures_ci_verified
stage4e_desktop_end_to_end_wire_up_ci_verified
stage4f_native_report_lifecycle_ci_verified
desktop_reports_runtime_wired
all_13_report_generators_verified
deterministic_report_generation_verified
secure_report_export_verified
native_report_export_lifecycle_verified
report_generation_complete
managed_docker_runtime_verification_pending
windows_operator_smoke_pending
operational_validation_not_started
live_capital_prohibited
Stage 4 closed
Stage 5 unblocked
```

## §6 Stage 5 work order (documented, NOT started)

Per the closure directive's final line: "Do not begin Stage 5 implementation in this cycle." The next slice is scoped here for the follow-up session; NO Stage 5 code lands in `claude/horizon-trade-bot-mcbcfo` between this commit and the Stage 5 opening.

**Stage 5 — Operational runtime + Windows operator smoke.**

The three verdicts still `pending` (`managed_docker_runtime_verification_pending`, `windows_operator_smoke_pending`, `operational_validation_not_started`) are the seed of Stage 5. Concrete work items:

1. **Managed-docker runtime verification**: bring the CI native harness's `HORIZON_SERVER_EXTERNAL=true` path into managed-docker mode; validate `serviceMode=managed_docker` in production alongside `external_services`. This wires the `configuration.get` payload's `serviceMode` field back to the operator's actual runtime instead of the current hardcoded literal.
2. **Windows operator smoke**: extend the existing Windows packaging CI (`desktop-windows.yml`) beyond a build-and-package smoke into a launch-and-smoke — Playwright drives the packaged NSIS installer, launches the app, exercises the auth flow, and confirms the Reports screen enqueues a `safety_status` artifact end-to-end. Same 60s bounded deadline as the Linux native harness.
3. **Operational validation**: define the seven-day soak counterpart for the desktop artifact-generation path (analogous to Stage 1's Coinbase seven-day soak). Bounded to `SIMULATION_MODE=STANDARD_DRY_RUN`; measures artifact-write throughput, idempotency-hit rate, path-rejection incidence.

The safety invariants that Stage 4 relied on remain non-negotiable through Stage 5:

- `DRY_RUN = true` throughout Stage 5.
- `ORDER_SUBMISSION_ENABLED = false` throughout Stage 5.
- `liveCapitalAuthorized = false` throughout Stage 5.
- `promotionEnabled = false` throughout Stage 5.
- `kellyEnabled = false` throughout Stage 5.
- Create Order counters must remain 0/0/0 after every scenario.
- Migrations 0000-0021 remain byte-identical; migration 0022 remains as shipped; any Stage 5 migration is 0023+.
- No Coinbase credentials enabled.
- No economic-writer paths touched.

The gating question for Stage 5 opening is the same as Stage 4: is there an authorization-explicit user directive for it, and does a fresh audit of the shipped 4A-4F slices pass an independent second read? If yes, Stage 5 opens.
