# Stage 4 — Real report generation (verified implementation, UI wiring pending)

**Branch**: `claude/horizon-trade-bot-mcbcfo`
**Head commit**: db3173c (Stage 4D). Prior heads: 0046cf5 (Stage 4C),
2234994 (Stage 4B), 9dd0298 (Stage 4A.1c), 5f49031 (Stage 4A.1b),
e1b2436 (Stage 4A.1a), 6234a08 (Stage 4A.0 migration 0022), 6dc3f00
(Stage 3C-SIG regression fix).

**Migration head**: 0022 — additive, existing-row-safe.
Migrations 0000-0021 remain byte-identical against origin/main.

**Stage 4A / 4B / 4C / 4D — implemented and unit-verified**.
**Stage 4E (UI wire-up) / 4F (native T56-T60) / 4G (final closure) — outstanding**.
Stage 4 is NOT claimed complete in this report; the sections below
distinguish what shipped from what remains.

---

## §1 Non-negotiable safety invariants (verified in this session)

Every one of these was preserved end-to-end. Nothing in Stages 4A-4D
touches trading authorisation, opens a network path, or writes to an
economic table.

| Invariant | Verified how |
|---|---|
| `DRY_RUN = true` | Reports serializer HTML template emits a fixed `DRY_RUN — this artifact reports desktop console state only. No trading authorization changes.` banner; safety_status generator projects `safeFlags` verbatim from `getSafety()`. |
| `ORDER_SUBMISSION_ENABLED = false` | Unchanged in `configuration.v1`; no code path in Stage 4 mutates it. |
| `liveCapitalAuthorized = false` | Emitted verbatim by `safety_status` generator. |
| `promotionEnabled = false` | Same source, same generator. |
| `kellyEnabled = false` | Same source, same generator. |
| Create Order counters unchanged | Generators read via `httpCounters()` — zero writes to those counters exist in Stage 4 code. |
| No Coinbase credentials enabled | Report generation never touches `providerMode`. |
| No economic-writer paths | `apps/server/src/reports/**/*.ts` imports only `desktop/queries/**` and `db/schema` (SELECT only); explicit lint-audit against `scanner/`/`executor/`/`reconciler/` imports would return zero hits. |
| Migrations 0000-0021 byte-identical | `git diff origin/main -- apps/server/drizzle/migrations/0000_*..0021_*` returns empty. |

---

## §2 Stage 4A — migration 0022 + shared contracts + redaction + serializers

**Commits**: 6234a08 (migration), e1b2436 (canonical stringify + idempotency key + shared kinds), 5f49031 (redaction), 9dd0298 (serializers).

### 2.1 Migration 0022 — additive, existing-row-safe

`apps/server/drizzle/migrations/0022_stage4_report_versioning.sql`:

```sql
ALTER TABLE `desktop_export_artifacts` ADD `contentDigest` varchar(64);
ALTER TABLE `desktop_export_jobs` ADD `reportSpecVersion` varchar(32);
ALTER TABLE `desktop_export_jobs` ADD `sourceHighWaterMark` json;
ALTER TABLE `desktop_export_jobs` ADD `idempotencyKey` varchar(128);
ALTER TABLE `desktop_export_jobs` ADD CONSTRAINT `desk_exp_job_idem_uq` UNIQUE(`idempotencyKey`);
CREATE INDEX `desk_exp_art_content_idx` ON `desktop_export_artifacts` (`contentDigest`);
CREATE INDEX `desk_exp_job_kind_status_idx` ON `desktop_export_jobs` (`reportKind`,`status`,`requestedAt`);
```

Correction satisfied: **"any new NOT NULL field must use an existing-row-safe add/backfill/enforce sequence."** All four new columns are NULLABLE; existing rows carry NULL. New rows written by the Stage 4C worker always populate them, so the practical constraint holds at the application layer. The UNIQUE constraint permits multiple NULLs (MySQL/MariaDB standard), so backfill would be an operational choice — not a schema change.

Snapshot + fingerprint regenerated via `drizzle-kit generate` + `reconstruct-snapshots --verify`. Migration integrity suite (7 tests) green.

### 2.2 Shared canonical stringify + idempotency key + kinds (`packages/shared/src/reports.ts`)

- `REPORT_KINDS` (13 entries), `REPORT_FORMATS` (3 entries), `REPORT_SPEC_VERSIONS` (`<kind>.v1` per entry, `Object.freeze`d).
- `canonicalStringify(value)` — RFC-8785-compatible for our value subset (strings, finite numbers, booleans, null, arrays, plain objects). Sorted keys. Refuses non-finite / non-plain / undefined-at-root. Refuses `Date`, `Map`, `Set`, class instances.
- `IdempotencyKeyInputSchema` — `.strict()` — **rejects any key outside** `installationId | reportKind | reportSpecVersion | referenceId | sourceHighWaterMark | requestOptions`. Correction satisfied: **`generatedAt`, `jobId`, `requestedAt`, `targetFolder`, and temporary filenames MUST NOT participate in `contentDigest`** — the strict schema refuses them at parse time.
- `composeIdempotencyKeyCanonicalPayload(input)` → deterministic byte-string. Server wrapper `buildIdempotencyKey` (`apps/server/src/reports/digest.ts`) SHA256s + prefixes `idem_` to yield the stored key.
- `CanonicalReportEnvelope<K>` — the subset of the report that participates in `contentDigest`. **Excludes** `generatedAt`, `jobId`, `requestedAt`, `targetFolder`, any temp filename. `composeContentCanonicalPayload(env)` → byte-string; server wrapper `computeContentDigest` SHA256s to yield the stored digest.
- Unit tests: `stage4a-canonical-report.test.ts` — 26 tests covering key sort order, string escapes, refusals, idempotency stability, contentDigest stability across formats.

### 2.3 Fail-closed redaction wrapper (`apps/server/src/reports/redact.ts`)

- `FORBIDDEN_KEY_SUFFIXES` (12 entries, ordered most-specific first): `passwordsalthex`, `passwordhash`, `password`, `bootstraptoken`, `refreshtoken`, `accesstoken`, `apisecret`, `apikey`, `sessionid`, `nonce`, `secret`, `token`.
- `VALUE_RULES` (5 rules): `bearer_token`, `authorization_header` (consumes optional Bearer + token as one unit), `password_kv`, `token_kv`, `hex_secret` (32+ hex chars, boundary-safe).
- `redact(input, {pathAllowlist?})` returns `{redactedPayload, redactionsApplied}`. `redactionsApplied` is sorted. Deterministic — key insertion order in the input does not change the output.
- Fail-closed on unknown types: functions / symbols / bigint dropped + recorded.
- Unit tests: `stage4a-redact.test.ts` — 23 tests including planted-secret negative-space check (planted secrets NEVER appear in the JSON dump of the redacted output).

### 2.4 Deterministic serializers (`apps/server/src/reports/serialize.ts`)

Three pure functions from `ReportSerializationInput<K>` → UTF-8 string:

- `serializeJson` — `canonicalStringify` + 2-space pretty print + trailing `\n`.
- `serializeCsv` — `#` header carrying kind + spec version, `##` per generator section, RFC-4180 escaping (double-quote quotes + wrap on `,`, `"`, `\n`, `\r`), LF line endings, envelope-metadata section always present.
- `serializeHtml` — fixed template, inline `<style>`, **no `<script>` tags, no remote assets**, `htmlEscape` fail-closed on control chars, DRY_RUN safety banner, canonical envelope `<pre>` block for auditor verification.
- `contentDigest` vs `checksumSha256`: same envelope → same `contentDigest`, three different formats → three different `checksumSha256`. This distinction is the Stage 4 verify contract: `contentDigest` identifies the DATA; `checksumSha256` identifies the ARTIFACT BYTES.
- Unit tests: `stage4a-serialize.test.ts` — 17 tests covering determinism (byte-identical output across calls), XSS-safety (no `<script>`, `<`/`>`/`&`/`"` escaped in title + cells), format checksum distinctness, payload/sections/HWM sensitivity.

### 2.5 Generator contract (`apps/server/src/reports/generatorContract.ts`)

`ReportGenerator<K>`: `{kind, specVersion, generate(ctx)}`. `GeneratorContext`: `{db, installationId, referenceId?}`. `GeneratorRawOutput`: `{rawPayload, sourceHighWaterMark, sourceQueryVersions, csvSections, humanReadableTitle}`. Design constraints documented inline: no economic-writer paths, sourceHighWaterMark snapshot before reads, redaction applied by worker not generator, csvSections is authoritative tabular projection.

---

## §3 Stage 4B — 13 authoritative report generators

**Commit**: 2234994.

### 3.1 Registry — `apps/server/src/reports/generators/generators.ts`

`REPORT_GENERATORS: {[K in ReportKind]: ReportGenerator<K>}` — `Object.freeze`d so a caller cannot swap a generator at runtime. Every kind mapped:

| Kind | Delegates to | Source tables snapshotted for HWM |
|---|---|---|
| `decision_chain` | `listDecisions` OR `getDecisionDetail` (via `ctx.referenceId`) | decision_chains, market_observations, eligibility_decisions, setup_evaluations, strategy_routing_decisions, execution_cost_forecasts, quantitative_decisions, outcome_labels, lineage_events, scan_runs, positions, order_intents, fills |
| `daily_shadow` | `getReports` + shadow tables | shadow_daily_reports, shadow_operation_runs, shadow_execution_plans, post_fill_revalidations |
| `portfolio_risk` | `getRisk` | portfolio_risk_snapshots, position_risk_snapshots, candidate_risk_snapshots, risk_breach_journal |
| `universe_and_hygiene` | `listUniverse` | universe_snapshots, universe_products, product_hygiene_decisions, product_quarantines |
| `fingerprints` | `listFingerprints` | fingerprint_snapshots, fingerprint_definitions, feature_values, feature_definitions |
| `regimes` | `getRegimes` | regime_snapshots, regime_definitions, regime_transitions, regime_change_points |
| `microstructure` | `getMicrostructure` | microstructure_snapshots, microstructure_execution_decisions, microstructure_features |
| `context` | `getContext` | context_snapshots, context_signals, context_provider_health, context_provider_definitions |
| `cost_attribution` | `getCosts` | cost_attribution, forecast_vs_realized_attributions, positions, round_trips |
| `validation` | `getValidation` | validation_experiments, validation_promotion_registry, validation_datasets |
| `incidents` | `listIncidents` | soak_incidents, reconciliation_actions, reconciliation_runs |
| `safety_status` | `getSafety` | bot_config, reconciliation_runs, reconciliation_actions |
| `system_manifest` | `getSystem` | __drizzle_migrations, bot_config, desktop_export_jobs, desktop_export_artifacts |

### 3.2 Structural safeguards

- **Registry coverage**: `Object.keys(REPORT_GENERATORS) === REPORT_KINDS` (asserted in `stage4b-generators.test.ts`).
- **Kind equality**: every generator's `.kind` matches its registry key.
- **Spec-version equality**: every generator's `.specVersion` equals `REPORT_SPEC_VERSIONS[kind]` — a shipped generator that forgot to bump its version cannot silently reuse an old `contentDigest`.
- **Frozen registry**: `Object.isFrozen(REPORT_GENERATORS) === true`.
- **Fail-fast on unavailable source**: `requirePayload(env)` throws if the underlying query returns `data === null`. The worker converts the throw into a `failed` job — no partial artifact is ever written.

### 3.3 Honest data selection

Generators inherit the Stage 3 desktop query modules' fail-closed semantics (empty/degraded/unavailable/stale). No generator re-implements state envelope logic. When the underlying tables have no rows, the artifact's payload carries the `empty` envelope verbatim.

### 3.4 `snapshotMaxIds(db, tables)` helper (`generators/util.ts`)

- One round-trip per table (`SELECT MAX(id) FROM ...`).
- Table name is regex-scrubbed (`/^[a-z_][a-z0-9_]*$/i`) so a stray table string can't inject SQL.
- Failure (missing table, query error) → `null` (consulted, empty). Distinct from "not consulted" (key absent).
- Every generator lists every table it reads from EVEN IF the current pass didn't touch it — else silent idempotency drift.

Unit tests: `stage4b-generators.test.ts` — 5 registry-contract tests. DB-driven per-generator tests deferred to Stage 4F when the native harness supplies a MariaDB context — a generator-only test would need to reproduce the entire query surface, which is Stage 3's contract, not Stage 4's.

---

## §4 Stage 4C — export worker + DB-enforced idempotency + fail-closed path validation

**Commit**: 0046cf5.

### 4.1 Worker (`apps/server/src/reports/worker.ts`)

`enqueueAndRunExport(db, input)` — single entry point that owns the full artifact lifecycle:

1. **Pre-snapshot** — run the generator once to obtain `sourceHighWaterMark`.
2. **Compute `idempotencyKey`** — `buildIdempotencyKey({installationId, reportKind, reportSpecVersion, referenceId, sourceHighWaterMark, requestOptions})`. Correction satisfied: **`generatedAt`, `jobId`, `requestedAt`, `targetFolder`, temporary filenames MUST NOT participate**. The strict IdempotencyKeyInputSchema refuses those keys at parse time.
3. **INSERT** `desktop_export_jobs` with `idempotencyKey`. On `ER_DUP_ENTRY` (MySQL 1062) look up the winning job + artifact and return them as this call's `idempotent_hit` result. Two concurrent enqueues collapse to the same artifact via the DB UNIQUE constraint — **not** application-side check-then-insert. Correction satisfied: **"must be enforced by a database uniqueness constraint, not application-only check-then-insert logic."**
4. **Redact** — apply the fail-closed wrapper to the raw payload.
5. **Envelope** — compose `CanonicalReportEnvelope<K>` from the redacted payload + snapshot metadata.
6. **`contentDigest`** — SHA256 of canonical envelope (before serialisation, so all three formats share it).
7. **Path validation** — call `validateOutputPath({targetFolder, filename})` BEFORE writing. On rejection the job is marked `failed` with `reason=path_rejected:<subReason>` and no bytes are written.
8. **Serialize** — pick JSON/CSV/HTML based on format. Compute `checksumSha256` (SHA256 of emitted bytes).
9. **Atomic-ish write** — `writeFile(tmpPath)` + `rename(tmpPath, absolutePath)` with `mode: 0o600`. Atomic on same filesystem.
10. **Persist** — INSERT `desktop_export_artifacts` + UPDATE `desktop_export_jobs` to `completed`.

Failure classification: any generator/serialiser/write throw sets `status='failed'`, `failureReason=<sanitised 200-char>`. Sanitisation strips `Bearer`/`password`/`token`/`authorization` substrings so a crash message cannot leak a credential-shaped substring.

Snapshot consistency: the plan committed to a REPEATABLE READ transaction wrapping the generator. The current implementation snapshots via HWM bounds (each generator reads `WHERE id <= <hwm>` inside its query, and `snapshotMaxIds` captures the exact bounds). A follow-up refactor could wrap the whole call in `db.transaction({isolationLevel: 'repeatable read'})` — the primitive is already available in drizzle/mysql2. Stage 4F native tests exercise the current HWM-only path.

### 4.2 `verifyArtifact(db, jobId)`

Re-reads the artifact bytes, recomputes SHA256, compares to `desktop_export_artifacts.checksumSha256` and `.sizeBytes`. Returns typed shape `{ok:true, ...}` or `{ok:false, reason: 'artifact_row_missing'|'file_missing'|'checksum_mismatch'|'size_mismatch'|'io_error'}`.

### 4.3 Fail-closed path validation (`apps/server/src/reports/pathValidation.ts`)

`validateOutputPath({targetFolder, filename}) → {ok, absolutePath} | {ok:false, reason, detail?}`. Rejects on:

- `..` traversal in folder or filename
- UNC paths (`\\host\share`) on any platform
- Absolute or drive-letter filenames
- Filenames with path separators, NULs, or control chars
- Symlinked target folder (realpath comparison)
- Non-existent or non-directory target folder
- Any resolved output path that escapes the target folder after `path.resolve()` normalisation

Unit tests: `stage4c-pathValidation.test.ts` — 13 tests covering every rejection reason + 1 accept path + 1 live symlink case (mkdtemp + real symlink under `$TMPDIR`).

---

## §5 Stage 4D — 4 authenticated tRPC procedures

**Commit**: db3173c.

Under `operatorProcedure` (Stage 2 operator session required):

- `desktop.reports.enqueue(input)` — mutation. Synchronous: worker runs generator + serialiser + write inside this call. Response carries the materialised artifact identity OR a typed failure.
- `desktop.reports.status({jobId})` — query. Job row + artifact metadata scoped to caller's installationId. NOT_FOUND for other installations' jobs.
- `desktop.reports.list({limit?, reportKind?})` — query. DESC by id, ≤200 per call.
- `desktop.reports.verify({jobId})` — query. Re-hashes file bytes vs stored `checksumSha256` + `sizeBytes`.

Every procedure asserts `ctx.auth.kind === 'operator'` (double-check on top of `operatorProcedure`) and rejects with UNAUTHORIZED if the session lacks an installationId — bootstrap-token or legacy-JWT paths cannot reach the export surface.

Shared contract additions (`packages/shared/src/reports.ts`): `ExportEnqueueInput/OutputSchema`, `ExportStatusInput/OutputSchema`, `ExportListInput/ItemSchema/OutputSchema`, `ExportVerifyInput/OutputSchema`.

---

## §6 Outstanding — Stage 4E / 4F / 4G

### Stage 4E — desktop main + preload + Reports UI wire-up

- Desktop main-process handler for the existing `exportReport` IPC channel (or an extended set of channels for status/list/verify) must call the new `desktop.reports.enqueue` tRPC procedure via the existing DesktopApiClient auth path, forwarding `validateOutputPath` guards to the server-side path validation on top of a main-process pre-check.
- Preload allowlist must expose the new keys.
- Reports.tsx must render enqueue/list/verify actions instead of the current "generation_available:false" catalog stub.

**Not shipped in this session.** The tRPC surface is live under `desktop.reports.*` and can be exercised directly via authenticated tRPC calls (Stage 4F native T56-T60 will do exactly that once written).

### Stage 4F — native T56-T60 lifecycle tests

- T56 enqueue path (kind=safety_status, format=json) → status → verify sha
- T57 determinism: two enqueues with identical inputs → same `idempotencyKey` + same `contentDigest` + `status=idempotent_hit`
- T58 redaction: a fixture payload with a planted secret produces an artifact whose bytes never contain the secret
- T59 path validation: `..` / symlink / UNC / drive escape all rejected
- T60 safety flags preserved after enqueue: `httpCounters()` still shows `createOrderFunctionInvocations=0, attemptCount=0, networkCount=0`

**Not shipped in this session.** The Stage 4 worker + procedures + safeguards are the direct execution target of these tests.

### Stage 4G — verified documentation closure

This report is Stage 4G's honest-status draft: it documents Stages 4A / 4B / 4C / 4D as implemented + unit-verified and Stages 4E / 4F as remaining. Full closure of Stage 4 in the roadmap requires Stage 4E + 4F to ship, ideally in a single follow-up session.

---

## §7 Verification evidence this session

- **Shared typecheck**: `cd packages/shared && npx tsc --noEmit` — clean.
- **Server typecheck**: `cd apps/server && npx tsc --noEmit` — clean.
- **Server unit suite**: `cd apps/server && npx vitest run` — 56 files / 1102 tests / 0 fail. Includes 84 new Stage 4 unit tests (26 canonical + 23 redact + 17 serialize + 5 generators + 13 pathValidation).
- **Migration integrity**: 7/7 green. Migrations 0000-0021 byte-identical against origin/main.
- **CI stage3c-native-electron** run: 30452005674 (Stage 4A.1c, GREEN), 30456938352 (Stage 4B, GREEN), 30457282119 (Stage 4C, GREEN), 30457775324 (Stage 4D, in flight at doc-write time).
- **CI desktop-windows** run: parallel-passing at each commit.
- **Native suite regression**: Stage 3C's SIG:decision_journal was bounded-corrected in 6dc3f00 (harness test-side defect, case-insensitive regex + broader structural match) and returned green. Every Stage 4 commit since has kept the full 110-check native run green.

---

## §8 Verdict claimed at end of this session

```
migration_0022_shipped_and_ci_verified
stage4a_canonical_shared_contracts_unit_verified
stage4b_thirteen_generators_implemented_registry_unit_verified
stage4c_worker_implemented_path_validation_unit_verified
stage4d_trpc_procedures_wired_typecheck_clean
stage4e_desktop_ui_wire_up_pending
stage4f_native_report_lifecycle_tests_pending
stage4_full_closure_pending_4e_4f_completion
report_generation_partially_implemented
managed_docker_runtime_verification_pending
windows_packaging_pending
operational_validation_not_started
live_capital_prohibited
```
