# Stage 3A — Foundation for authenticated desktop data binding

Continues from commit `d1a46e9` (Stage 2-FIX). Delivers the shared
contract surface, server query services, canonical `desktop.*` tRPC
namespace, main-process client, preload/IPC bridge, and full binding
for the four reference screens (Overview / Shadow Portfolio / Positions
/ Decision Journal).

Stage 3B will bind the remaining 15 screens; Stage 3C will run the
native Electron integration test, verify the full test matrix, and
deliver the final Stage 3 verdict.

`DRY_RUN=true` and `ORDER_SUBMISSION_ENABLED=false` unchanged. No
Coinbase credentials, no production providers, no Kelly, no promotion,
no observer enforcement. Migrations `0000-0021` immutable — Stage 3A
adds **no** migration.

## 1. Canonical API map

One namespace: `appRouter.desktop.*` in `apps/server/src/routers/desktop.ts`,
22 procedures across 18 domains. Every procedure declares
`authScope: 'operator_authenticated_business'` via `operatorProcedure`.
Bootstrap tokens cannot mint operator identity and are rejected by the
context creator; unclassified procedures continue to fail closed via
the Stage 2-FIX inventory audit.

| Domain | Procedure | Kind |
|---|---|---|
| overview | `desktop.overview.get` | query |
| portfolio | `desktop.portfolio.get` | query |
| positions | `desktop.positions.list` | query |
| positions | `desktop.positions.get` | query |
| decisions | `desktop.decisions.list` | query |
| decisions | `desktop.decisions.get` | query |
| universe | `desktop.universe.list` | query |
| fingerprints | `desktop.fingerprints.list` | query |
| regimes | `desktop.regimes.get` | query |
| risk | `desktop.risk.get` | query |
| microstructure | `desktop.microstructure.get` | query |
| context | `desktop.context.get` | query |
| validation | `desktop.validation.get` | query |
| costs | `desktop.costs.get` | query |
| protection | `desktop.protection.get` | query |
| reconciliation | `desktop.reconciliation.list` | query |
| incidents | `desktop.incidents.list` | query |
| incidents | `desktop.incidents.acknowledge` | mutation |
| reports | `desktop.reports.get` | query |
| configuration | `desktop.configuration.get` | query |
| system | `desktop.system.get` | query |
| safety | `desktop.safety.get` | query |

## 2. Shared contract inventory (`packages/shared/src/desktopContracts.ts`)

- `DESKTOP_CONTRACT_VERSION = '3.0.0'` — single version pinned to every
  envelope. Response schemas literal-check it.
- `DesktopDataEnvelope<T>` — `{contractVersion, status, data, generatedAt, observedAt?, dataAvailableAt?, staleAt?, sourceVersion?, policyVersions?, reasonCode?, diagnostics?}`.
- Primitive schemas: `DecimalStringSchema` (rejects scientific notation
  + `NaN` + numeric types), `IsoTimestampSchema` (requires trailing `Z`),
  `CursorSchema` (opaque, bounded), `OpaqueIdSchema`.
- Discriminated union: `DesktopDataRequestSchema` — 22 typed keys,
  every unknown key rejected before the IPC boundary.
- Central map: `DESKTOP_DATA_RESPONSE_SCHEMAS` — for a given key, the
  authoritative response envelope. Used by the main-process client to
  validate outbound payloads before they cross to the renderer.
- Per-domain payload schemas: `OverviewPayload`, `PortfolioPayload`,
  `PositionListRow`, `PositionDetailPayload`, `DecisionListRow`,
  `DecisionDetailPayload`, `DecisionRecord` (with provenance flags),
  `UniverseRow`, `FingerprintRow`, `RegimePayload`, `RiskPayload`,
  `MicrostructurePayload`, `ContextPayload`, `ValidationPayload`,
  `CostAttributionRow`, `ProtectionInstance`, `ReconciliationRunRow`,
  `IncidentRow`, `ReportCatalogEntry`, `ReportHistoryEntry`,
  `ConfigurationPayload`, `SystemPayload`, `SafetyPayload`.
- Envelope factories: `healthyEnvelope`, `emptyEnvelope`,
  `unavailableEnvelope`, `degradedEnvelope`, `unknownMeasurement`.
- Pagination: `PaginationInputSchema`, `paginatedList`, `MAX_PAGE_SIZE=100`,
  `DEFAULT_PAGE_SIZE=25`, `encodeCursor`/`decodeCursor` helpers on the
  server side.

## 3. Query-service inventory (`apps/server/src/desktop/queries/`)

Read-only. Cannot mutate economic state, cannot create plans/intents/
fills/positions/ledger events/promotions/policy versions. DB failures
return an `unavailable` envelope with a reason code — never a fabricated
empty payload.

| File | Function(s) | Backed by | Status |
|---|---|---|---|
| `common.ts` | `envelope`, `healthy`, `degraded`, `empty`, `unavailable`, `encodeCursor`, `decodeCursor`, `withTimeout`, `nowIso`, `toDecimalStringNullable`, `toIsoNullable` | — | Stage 3A |
| `overview.ts` | `getOverview` | `bot_config`, `reconciliation_runs`, `reconciliation_actions`, `positions`, `cost_attribution`, `decision_chains`, `forecast_vs_realized_attributions`, `protection_instances`, `httpCounters`, `__drizzle_migrations` | Stage 3A ✅ real |
| `portfolio.ts` | `getPortfolio` | `portfolio_risk_snapshots` (latest) | Stage 3A ✅ real |
| `positions.ts` | `listPositions`, `getPositionDetail` | `positions`, `fills`, `order_intents`, `protection_instances`, `reconciliation_actions`, `cash_ledger`, `round_trips` | Stage 3A ✅ real |
| `decisions.ts` | `listDecisions`, `getDecisionDetail` | `decision_chains`, `scan_runs`, `market_observations`, `eligibility_decisions`, `setup_evaluations`, `strategy_routing_decisions`, `execution_cost_forecasts`, `quantitative_decisions`, `outcome_labels` | Stage 3A ✅ real |
| `stubs.ts` | `listUniverse`, `listFingerprints`, `getRegimes`, `getRisk`, `getMicrostructure`, `getContext`, `getValidation`, `getCosts`, `getProtection`, `listReconciliation`, `listIncidents`, `acknowledgeIncident`, `getReports`, `getConfiguration`, `getSystem`, `getSafety` | — | Stage 3A stubs (Stage 3B will replace with real DB queries) |

Every stubbed query returns a `degraded` (or `empty`) envelope with an
explicit `stage3b_pending` reason code — no fabricated data. The
`getConfiguration`, `getSystem`, `getSafety`, `getReports` stubs are
functional in Stage 3A (they surface fixed policy versions, sanitized
process info, and the report catalog + `generationImplemented: false`).

## 4. Main-process client (`apps/desktop/src/main/desktopDataClient.ts`)

- `DesktopDataClient.call(key, input?)`: single entry point. Validates
  the request against the shared discriminated union; rejects unknown
  keys before touching `fetch`.
- Compiled-in procedure path map (`PROCEDURE_PATHS`) — never a
  renderer-supplied path or method. `mutation` vs `query` chosen from
  the compiled-in spec.
- Owns the operator access token; never exposes it to the renderer.
- Bounded refresh retry: on `401` (or a tRPC `UNAUTHORIZED` code) it
  invokes the caller-supplied refresh callback once; a second `401`
  fails as `unauthenticated`.
- Timeout via `AbortController` (default 8 s).
- Response validation: parses `result.data` against
  `DESKTOP_DATA_RESPONSE_SCHEMAS[key]`. A mismatch is `contract_mismatch`
  — the renderer never sees a raw invalid payload.
- Business errors sanitized (`sanitizeError`): bearer tokens and
  password fragments redacted before crossing to the renderer.

## 5. Preload / IPC map (`apps/desktop/src/shared/ipcContract.ts`,
   `apps/desktop/src/preload/index.ts`,
   `apps/desktop/src/main/ipc.ts`)

- Single new IPC channel: `desktop.data` (`IPC_CHANNELS.desktopData`).
- Request schema: shared `DesktopDataRequestSchema` — 22 typed keys.
  Unknown keys fail closed with `invalid_payload`.
- Response schema: `{ok: true, key, envelope: DesktopDataEnvelope} | {ok: false, key, error: {code, detail}}`.
- Requires an authenticated operator session
  (`requiresAuthenticatedSession: true`) — the Stage 2-FIX auth
  boundary rejects the channel for every non-authenticated phase and
  falls back to `authentication_manager_unavailable` if the auth manager
  is missing.
- Renderer bridge: `window.horizon.desktopData(key, input?)`. Rejects
  unknown keys BEFORE crossing the bridge as a defense-in-depth layer.
- IPC handler routes valid requests to the main-process client and
  returns the sanitized envelope or error.

## 6. Screen bindings (Stage 3A: 4 of 19)

- `Overview.tsx` → `desktop.overview.get`. Shows: version rows, safe
  flags, provider mode, schema fingerprint, service health,
  scanner+reconciliation readiness, open-position count, unprotected
  exposure, broken lineage counts, missing-attribution counts, champion
  version, observer policy versions, CreateOrder counters. Schema
  mismatch renders a prominent alert banner.
- `ShadowPortfolio.tsx` → `desktop.portfolio.get`. Each measurement
  renders `{status, value, unit, observedAt, policy, reason}` — unknown
  values render `unknown` (never `0`).
- `Positions.tsx` → `desktop.positions.list` + `desktop.positions.get`
  (detail on selection). Preserves partial-exit as OPEN, dust as
  explicit, unknown protection as UNKNOWN.
- `DecisionJournal.tsx` → `desktop.decisions.list` + `desktop.decisions.get`.
  Separates champion-influence records from observer-only records,
  separates decision-time from post-decision + post-outcome evidence.
  Broken-lineage markers rendered visibly.

The other 15 screens continue to render their Stage 2 placeholder
content. Stage 3B will rebind them.

## 7. Screen-state matrix (`apps/desktop/src/renderer/components/StateFrame.tsx`
   + `apps/desktop/src/renderer/hooks/useDesktopData.ts`)

- `useDesktopData(key, input, opts)` handles all 10 states:
  `loading | healthy | empty | stale | degraded | unavailable |
   unauthorized | session_expired | api_failure | contract_mismatch`.
- On auth-phase transition away from `authenticated`, the hook
  supersedes in-flight requests and clears business data (§18 rule).
- Optional `refreshMs` polling; `skip: true` for lazy detail fetches.
- `<StateFrame>` renders each state:
  - `loading` — spinner + label
  - `healthy` — payload only
  - `degraded` — payload + warning banner with reason
  - `stale` — payload + stale-age banner
  - `empty` — banner + `data !== null` payload for partial rendering
  - `unavailable` — banner + retry
  - `unauthorized` / `session_expired` — no payload, sign-in banner
  - `api_failure` — banner + retry
  - `contract_mismatch` — blocking display error with sanitized detail

## 8. Renderer isolation

- Renderer cannot import server modules (structural — server modules
  are outside the desktop workspace's TypeScript project).
- Renderer never receives raw MariaDB rows, Redis credentials, bearer
  tokens, or file paths. Every response passes through the envelope
  schema on the main side.
- The renderer's `desktopData` bridge rejects unknown keys via the
  compiled-in `DESKTOP_DATA_KEYS` list before invoking IPC.

## 9. Verification

- `packages/shared` `tsc --noEmit`: **green**
- `apps/server` `tsc --noEmit`: **green**
- `apps/server` `tsup` build: **green**
- `apps/desktop` main `tsc --noEmit -p tsconfig.main.json`: **green**
- `apps/desktop` preload `tsc --noEmit -p tsconfig.preload.json`: **green**
- `apps/desktop` renderer `tsc --noEmit -p tsconfig.renderer.json`: **green**
- `drizzle-kit generate`: **"No schema changes, nothing to migrate 😴"**
- `apps/desktop` `vitest run` (full suite): **42/42 files · 363/363 tests passed** (24.40s, from clean state).
- `apps/server` `vitest run` (full suite): counts filled in by the
  Stage 3A-FIX rerun (§15 below) — the initial Stage 3A commit was
  reviewed against a targeted 19/19 Stage 3A pass only, which the
  reviewer correctly rejected as insufficient. The FIX rerun uses a
  clean `horizon_trade_test` bootstrapped by the server globalSetup.

## 10. Stage 3A tests

New test files:

- `apps/server/tests/stage3-desktop-contracts.test.ts` (11 assertions)
  covering §21.4, §21.5, §21.6, §21.7, §21.8, §21.9, §21.10, §21.11.
- `apps/server/tests/stage3-desktop-router-authorization.test.ts` (8
  assertions) covering §21.1, §21.2, §21.3, §21.11 across the desktop
  namespace + safe-flag integrity of `desktop.safety.get`.
- `apps/desktop/tests/stage3_desktop_data_client.test.ts` (8 assertions)
  covering §21.4, §21.11, plus refresh-retry, timeout, and bearer-token
  redaction (§21.19).
- `apps/desktop/tests/stage3_desktop_data_ipc.test.ts` (5 assertions)
  covering §5 boundary — non-authenticated phases blocked, unknown keys
  refused, arbitrary path smuggling rejected, valid requests routed,
  missing client fails closed.

## 11. Known limitations (Stage 3A)

- Screen binding is 4/19; Stage 3B binds the remaining 15.
- 11 of the 18 query domains are **placeholder stubs** that return
  degraded/empty envelopes with `stage3b_pending` reasons — no
  fabricated data (see stage3a-fix-deferred-domain-honesty.test.ts).
- 4 domains have **functional query services** (configuration, system,
  safety, reports) but their **renderers are not yet rebound** to
  useDesktopData — Stage 3B fixes this.
- Count reconciliation:
  - 18 desktop.* domains (18 tRPC sub-routers) vs 19 screens —
    `positions` is one domain producing both the list and detail view;
    `incidents` is one domain producing both `list` and `acknowledge`
    procedures but still corresponds to a single screen.
  - 11 stubbed query services + 4 functional-but-unbound query services
    = **15 screens still needing renderer rewrite in Stage 3B**.
- Native Electron integration test not run (Stage 3C).
- `desktop_native_runtime` maturity remains `not_exercised` until
  Stage 3C runs Playwright + Xvfb.

## 12. Safe-flag confirmation

- `DRY_RUN=true` unchanged.
- `ORDER_SUBMISSION_ENABLED=false` unchanged.
- `desktop.safety.get` returns `observerEnforcementActive=false`,
  `kellyEnabled=false`, `promotionEnabled=false`,
  `liveCapitalAuthorized=false` — all fixed literals.
- CreateOrder counters render `known: true, {functionInvocations, attemptCount, networkCount} = 0` from the in-process fetch barrier
  (Phase 1.1 Gate 3D-FIX §A source of truth).

## 13. Zero-order confirmation

Full desktop + Stage-3A-scoped server test runs: CreateOrder function
invocation, attempt, and network counts remain `0`.

## 14. Verdict (Stage 3A only — corrected format)

```
stage3a_data_foundation_complete
four_reference_screens_bound
authenticated_data_boundary_integration_verified
remaining_screen_binding_pending
native_electron_test_pending
report_generation_pending
managed_docker_runtime_verification_pending
windows_packaging_pending
operational_validation_not_started
live_capital_prohibited
```

`desktop_screen_binding_complete` is NOT claimed and will not be
claimed until Stage 3C. Stage 3 verdict is NOT claimed here — that
arrives after Stage 3C.

## 15. Stage 3A-FIX corrections (continues from `e18037c`)

The Stage 3A review flagged that the initial commit was pushed with
only a 19/19 Stage 3A-scoped server run and deferred the full-suite
verification to Stage 3C. This section documents the corrections.

### 15.1 Full server suite verification (§1 of the correction)

Run against a fresh `horizon_trade_test` on the reference environment:

```
DROP DATABASE IF EXISTS horizon_trade_test;
cd apps/server && npx vitest run --reporter=default
```

Reproducible-run results (from the actual background completion, not
projected):

- Test Files: **52 passed (52)**
- Tests: **1028 passed (1028)**
- Failed: **0**
- Skipped: **0**
- Duration: **1367.63s** (`transform 2.95s, setup 0ms, collect 6.76s,
  tests 1358.13s, environment 0ms, prepare 65ms`)
- Start: 22:27:05 UTC
- Unhandled rejections observed by vitest: **0**
- Leaked child processes at afterAll: **0** (globalSetup + per-file
  spawn tracking; no processes survived teardown)
- Open-handle warnings / timeouts: **0**

The 52 file count is Stage 2-FIX's 48 files + Stage 3A's 4 new server
test files: `stage3-desktop-contracts.test.ts` (11 tests),
`stage3-desktop-router-authorization.test.ts` (8 tests),
`stage3a-fix-deferred-domain-honesty.test.ts` (10 tests),
`stage3a-fix-readonly-boundaries.test.ts` (12 tests). The 1028 test
count is Stage 2-FIX's 987 + 41 new Stage 3A + Stage 3A-FIX tests.
No existing test file was modified.

**Reliability note.** The very first Stage 3A-FIX full-suite attempt
surfaced 9 failures in `tests/research/phase2f_validation.test.ts`
starting with `unifiedChallengerDecision !== null` followed by 8
cascade `Lock wait timeout exceeded` errors on `TRUNCATE`. When
re-run in isolation, `phase2f_validation.test.ts` passed 90/90, and
the immediate full-suite rerun from a clean `horizon_trade_test`
passed 52/52 files · 1028/1028 tests as recorded above. Diagnosis:
pre-existing sensitivity of `tests/setup/db.ts::resetDatabase` to
`innodb_lock_wait_timeout=50s` under sustained suite load. Not a
Stage 3A regression — Stage 3A's new tests run alphabetically AFTER
`phase2f_validation.test.ts` and are therefore not on its execution
critical path. Documented here so a future run that hits the same
flake has an established diagnosis and reproducible workaround
(rerun once from clean scratch).

### 15.2 Re-run the active verification surface (§2 of the correction)

- `apps/server` `tsc --noEmit`: **green**
- `apps/server` `tsup` build: **green**
- `apps/desktop` main `tsc --noEmit -p tsconfig.main.json`: **green**
- `apps/desktop` preload `tsc --noEmit -p tsconfig.preload.json`: **green**
- `apps/desktop` renderer `tsc --noEmit -p tsconfig.renderer.json`: **green**
- `packages/shared` `tsc --noEmit`: **green**
- `apps/desktop` `vitest run` (full suite): 42 files · 363 tests · 0
  failed (unchanged since Stage 3A commit).
- `drizzle-kit generate`: "No schema changes, nothing to migrate 😴"
- Migration integrity (gate1-migration-integrity.test.ts) 7/7 green
  from clean scratch DB.
- Migrations 0000-0021 byte-identical to pre-Stage-2 tree.

### 15.3 Deferred-domain honesty proof (§3 of the correction)

New test `apps/server/tests/stage3a-fix-deferred-domain-honesty.test.ts`
(10 assertions):

- Every Stage 3B-deferred domain returns `status ∈ {degraded, empty,
  unavailable}` — NEVER `healthy`.
- Every deferred domain carries a `reasonCode` prefixed by the domain
  name and ending in `_stage3b_pending`.
- Every deferred domain carries a `<domain>.v0-stub` sourceVersion.
- List domains return empty items — no fabricated sample rows.
- Measurement-carrying stubs (`risk`, `context`) have `status:
  'unknown'` measurements with `value: null` and reason codes.
- Safety literals preserved in every stub: `kellyEnabled=false`,
  `promotionEnabled=false`, `observerEnforcementActive=false`,
  `productionLevel2Active=false`, `queuePositionKnown=false`.
- `incidents.acknowledge` mutation refuses in Stage 3A with `status:
  'unavailable'` + `stage3b_pending` reason.
- `reports.get` returns the catalog with `generationImplemented=false`
  and every catalog entry `generationAvailable=false` + `stage4_pending`.
- `configuration`, `system`, `safety` functional stubs render only
  safe-flag literals; system stub contains no `DATABASE_URL`,
  `mysql://`, or `password` substring.
- Every deferred domain envelope passes its published schema.

### 15.4 Read-only-boundary proof (§4 of the correction)

New test `apps/server/tests/stage3a-fix-readonly-boundaries.test.ts`
(12 assertions):

- Every query file in `apps/server/src/desktop/queries/` is loaded.
- No query service imports an economic writer or execution module
  (forbidden-pattern scan across `execution/`, `executor/`, `scanner/`,
  `coinbase/`, `reconciliation/`, `protection/`, `promotion/`,
  `mode/`, `shadow/runtimeService`, `entryExecutor`, `exitExecutor`,
  `lib/economicState`).
- No query service uses `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`,
  `DROP`, `ALTER`, or `REPLACE INTO` SQL verbs.
- No query service calls drizzle mutation helpers (`db.insert`,
  `db.update`, `db.delete`, `.insert(schema.…)`, etc.) or
  economic-writer functions (`applyEntryEconomicStateTx`,
  `applyExitEconomicStateTx`, `createPlan`, `recordFill`,
  `recordLedger`, `promoteChallenger`, `publishPolicyVersion`, etc.).
- `DesktopDataClient` defines an exhaustive `PROCEDURE_PATHS` map
  keyed by every `DesktopDataRequestKey`.
- `DesktopDataClient` rejects unknown request keys via
  `DesktopDataRequestSchema.safeParse` before touching `fetch`.
- `DesktopDataClient` constructs URLs only from the compiled-in
  `spec.path` — never from renderer input.
- The preload bridge validates the desktop-data key against
  `DESKTOP_DATA_KEYS` before invoking IPC.
- The IPC allowlist declares `desktop.data` as
  `requiresAuthenticatedSession: true` with `DesktopDataChannelRequestSchema`.
- The preload bridge never exposes raw `ipcRenderer`.
- Every `DESKTOP_DATA_KEYS` entry has a matching `desktop.*` tRPC
  procedure; no `desktop.*` procedure is missing from
  `DESKTOP_DATA_KEYS`.

### 15.5 Documentation corrections (§5 of the correction)

- `docs/audit/desktop_api_coverage.json` — replaced. Now records
  per-screen coverage matrix (route / contract / server query /
  operator-auth / main-client / preload / renderer / healthy /
  empty / stale / failure / native Electron evidence), classifies
  each screen `integration_verified` (4 screens) or
  `contract_present_binding_pending` (15 screens), and includes a
  `countReconciliation` block explaining the 14-domains vs 15-screens
  arithmetic.
- `docs/audit/scope_matrix.json` — added `stage3aFix` block.
- `docs/audit/stage3a_report.md` — this section (§15).

### 15.6 Corrected Stage 3A verdict (accepted format)

```
stage3a_data_foundation_complete
four_reference_screens_bound
authenticated_data_boundary_integration_verified
remaining_screen_binding_pending
native_electron_test_pending
report_generation_pending
managed_docker_runtime_verification_pending
windows_packaging_pending
operational_validation_not_started
live_capital_prohibited
```

Stage 3B binds the remaining fifteen screens with real DB-backed query
services (11 stubs to replace + 4 functional-stub renderer rewrites).
Stage 3C delivers the native Electron integration test, the full
Stage 3 verification matrix, and the final Stage 3 verdict.
