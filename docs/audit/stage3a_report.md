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
- `apps/server` `vitest run` (full suite): filled in after the reproducible run in Stage 3C once the desktop.* server tests are staged into the suite; Stage 3A adds 19 new server tests (11 contract + 8 authorization) that all pass in isolation.

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
- 14 of the 18 query domains are stubs that return degraded/empty
  envelopes with `stage3b_pending` reasons — no fabricated data.
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

## 14. Verdict (Stage 3A only)

```
desktop_data_foundation_complete
desktop_screen_binding_partial_4_of_19
authenticated_desktop_data_integration_verified_for_stage3a_scope
desktop_authentication_complete
desktop_runtime_core_wiring_complete
desktop_screen_binding_pending_15_screens (Stage 3B)
native_electron_integration_pending (Stage 3C)
report_generation_pending (Stage 4)
managed_docker_runtime_verification_pending
windows_packaging_pending
operational_validation_not_started
live_capital_prohibited
```

Stage 3 verdict is NOT claimed here — that arrives after Stage 3C.
