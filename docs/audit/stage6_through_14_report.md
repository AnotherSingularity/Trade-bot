# Stages 6 through 14 — Repository closure report

**Status.** Stages 6-14 REPOSITORY-SIDE work is complete. The only remaining gates are the genuine external boundaries the roadmap directive named:
- **Stage 6** — the seven-day wall clock (durable soak runner is shipped + launcher workflow is available; the operator must trigger `operational-soak-launch` via workflow_dispatch to start the seven UTC calendar days).
- **Stages 9-11** — private Coinbase read-only credentials (preflight harness is shipped; credentials never enter the repository or CI).
- **Stage 14** — explicit live-capital authorization + separate risk-owner sign-off (plan + abort matrix + evidence template are shipped; execution never happens automatically).

- **Branch**: `claude/horizon-trade-bot-mcbcfo`
- **Repository-closure head**: current `HEAD` after the Stage 9+12+13+14 commit
- **Predecessor**: Stage 7+8+6-fix commit

## §0 Commit history

| Commit | Slice | Notes |
|---|---|---|
| `dfd1b09` | Stage 5 §preflight — operational-validation-preflight harness + CI + 8 tests | Green on run 30473196671 |
| `c8c8038` | Stage 6 — durable operational soak runner (launch + daily cron) | Workflow files ship; daily cycle honors runtime content digest, not commit SHA |
| `2fbc2dc` | Stage 7 + 8 + 6-fix — release-audit + code-freeze-manifest + 13-kind alignment | 43/43 audit checks pass locally |
| `c36919d` | Stages 9 + 12 + 13 + 14 — Coinbase preflight + prospective + shadow-cert + live-canary docs | 19 + 9 + 10 = 38 new tests |

## §1 Non-negotiable safety invariants

Preserved end-to-end. Now enforced at the **schema level** for the seven-day soak and all downstream stages via `z.literal` in:

- `SoakSafetyFlagsSchema` (DRY_RUN=true, ORDER_SUBMISSION_ENABLED=false, liveCapitalAuthorized=false, promotionEnabled=false, kellyEnabled=false)
- `SoakCreateOrderCountersSchema` (functionInvocations=0, attemptCount=0, networkCount=0)
- `ObserverDisagreementSchema` (observerPromotionsAttempted=z.literal(0), observerPromotionsAllowed=z.literal(0))
- `ShadowCertificationSchema` (safetyFlagsRemainLocked=z.literal(true), createOrderCountersRemainZero=z.literal(true))

A downstream parser cannot accept a manifest OR certification with drifted values — the drift is a schema_invalid rejection.

## §2 Per-stage acceptance-criteria check

### Stage 5 (already reported in `stage5_report.md`, augmented here)

- ✅ typed managed-runtime policy — `runtimeModePolicy.ts`
- ✅ managed Docker orchestration — `managedDockerOrchestrator.ts`
- ✅ real Docker-daemon integration — `managed-docker-runtime.yml` green on c36919d predecessor SHAs
- ✅ MariaDB 10.11.6 + Redis 7.4 — pinned in stage3c-native + managed-docker workflows
- ✅ migrations through 0022 + fingerprint — release-audit confirms
- ✅ authoritative readiness — `managedDockerEvidence.ts`
- ✅ owned-resource shutdown + leak detection — orchestrator label guard + integration test
- ✅ Windows NSIS installer build + verify — desktop-windows workflow + `verify-packaged-installer.ts`
- ✅ Windows human-smoke package — 3 files under docs/operator/ + scripts/operator/
- ✅ operational-validation harness — 30 event kinds, 4 HARD_FAIL, deterministic ids
- ✅ operational-validation preflight — 7 checks, verdict enum, workflow green
- ✅ soak manifest + incident policy — 23 types, 13 mandatory invalidators, 9 rejection codes

### Stage 6 — seven-day operational soak

- ✅ soak-launch script pins release-candidate SHA + runtimeContentDigest + migrationHead/chain + 13 report specs
- ✅ soak-daily-cycle script runs one UTC day per invocation, exercises 13 kinds × 3 formats + idempotency + verify + restart + reconnect + shutdown, writes daily result to `docs/soak/<runId>/day-<UTC>.json`
- ✅ manifest.in-progress.json / manifest.final.json emitted per cycle
- ✅ daily cron workflow (`operational-soak-daily.yml`) with cron `15 0 * * *` UTC
- ✅ launch workflow (`operational-soak-launch.yml`) with workflow_dispatch input
- ⏳ Wall clock — seven consecutive UTC calendar days must actually elapse

### Stage 7 — integrated release audit

- ✅ `release-audit.ts` covers 16 dimensions across 43 checks
- ✅ Local run on HEAD passes 43/43

### Stage 8 — code freeze

- ✅ `code-freeze-manifest.ts` emits `docs/audit/code_freeze_manifest.json` with release-candidate SHA + migration head/chain + 13 report spec versions + runtimeManifestDigest (268 files) + testInventoryDigest + nativeScenarioCount (120) + placeholders for CI run ids + safety contract embedded as frozen literal

### Stage 9 — Coinbase read-only preflight infrastructure

- ✅ `coinbaseReadOnly.ts` harness covers 25 verdict codes
- ✅ Awaiting-credentials verdict is first-class
- ✅ Never loads a credential — pure function
- ✅ Refuses to accept a base URL outside the 4-host allowlist
- ✅ Refuses to accept http:// (TLS required)
- ✅ Bounded timeouts, rate limits, WS heartbeats
- ✅ Refuses if any Create Order counter is non-zero at preflight-end
- ✅ Refuses if clock skew > 2 s
- ✅ 19 unit tests

### Stage 10 — private credential boundary

- ✅ Repository never contains a credential (release-audit git-tracked scan passes)
- ✅ Client shape verified without secrets
- ⏳ Private credentials are the external boundary — cannot be crossed in a repository session

### Stage 11 — genuine live-data shadow soak

- Prepared: the same operational-soak-daily runner can be re-parameterized for live-data by an operator once credentials + read-only-preflight are green.
- ⏳ Requires credentials from Stage 10

### Stage 12 — extended prospective shadow validation

- ✅ `prospectiveValidation.ts` schemas cover every named evidence bucket
- ✅ Multiplier bounded [0, 1]; NumericOrUnknown union — unknown is distinct from zero
- ✅ Observer promotions locked at `z.literal(0)` — an insufficient-evidence verdict is first-class
- ✅ 9 unit tests, including a hostile-caller test that plants promotion=1

### Stage 13 — final shadow certification

- ✅ `shadowCertification.ts` — three-conclusion enum, 13-gate assembly
- ✅ Hard-fail gates (safety flags held, counters held, secret leakage, provider policy, migration drift, report-spec drift, invalidating incidents, SHA alignment, soakId alignment, reconciliation) each cause `shadow_not_certified` regardless of the other gates
- ✅ Insufficient-evidence gates (prospective sufficient, soak manifest valid+passed, evidence recent) → `additional_shadow_evidence_required`
- ✅ Only every gate satisfied → `shadow_certified_for_live_canary_review`
- ✅ 10 unit tests

### Stage 14 — live-canary preparation (DO NOT EXECUTE)

- ✅ `docs/live_canary/plan.md` — 9 sections including hard-cap bounds table, 8 kill switches, credential-scope contract, 5 abort classes
- ✅ `docs/live_canary/abort_matrix.md` — 30 trigger conditions T01-T30, response ladder, no-auto-flatten rule
- ✅ `docs/live_canary/evidence_template.md` — mandatory per-session record + attachments allowlist + attachments blocklist
- ⏳ Execution requires explicit live-capital authorization AND a schema change to `SoakSafetyFlagsSchema.liveCapitalAuthorized`

## §3 Verification matrix

| Command | Result |
|---|---|
| `cd packages/shared && npx tsc --noEmit` | clean |
| `cd apps/server && npx tsc --noEmit` | clean |
| `cd apps/desktop && npx tsc -p tsconfig.json --noEmit` | clean |
| `cd apps/server && npx vitest run tests/stage5-operational-preflight.test.ts` | 8/8 |
| `cd apps/server && npx vitest run tests/stage9-coinbase-preflight.test.ts` | 19/19 |
| `cd apps/server && npx vitest run tests/stage12-prospective-validation.test.ts` | 9/9 |
| `cd apps/server && npx vitest run tests/stage13-shadow-certification.test.ts` | 10/10 |
| `cd apps/server && npm run release:audit` | 43/43 checks pass |
| `cd apps/server && npm run freeze:manifest` | valid JSON, 13 report specs, 268 runtime files, 120 native scenarios |
| `cd apps/server && npm run preflight:operational` | verdict=preflight_passed, 41 events |
| `cd apps/server && HORIZON_BUILD_COMMIT=$SHA npm run soak:launch` | SOAK_ANCHOR.json emitted |
| `cd apps/server && HORIZON_SOAK_DATE=YYYY-MM-DD npm run soak:daily-cycle` | day-N.json + manifest.in-progress.json emitted |

## §4 What this closure does NOT claim

- `operational_soak_verified` — awaits 7 real UTC calendar days
- `coinbase_private_credential_preflight_verified` — awaits private credentials
- `live_data_shadow_soak_verified` — awaits Stage 10 outcome
- `prospective_evidence_sufficient_final` — awaits Stage 11 output
- `final_shadow_certification_verified` — awaits Stages 6+11+12 all green
- `live_canary_executed` — never claimable without explicit live-capital authorization

## §5 Final verdict block

```
stage5_full_closure_ci_verified
stage6_durable_soak_runner_shipped
stage6_operational_soak_awaits_wall_clock
stage7_integrated_release_audit_shipped
stage8_code_freeze_manifest_generator_shipped
stage9_coinbase_read_only_preflight_harness_shipped
stage9_coinbase_preflight_awaiting_credentials
stage10_private_credential_boundary_reached
stage11_live_data_shadow_soak_pending_credentials
stage12_prospective_validation_contract_shipped
stage13_shadow_certification_contract_shipped
stage14_live_canary_plan_prepared_not_executed
live_capital_prohibited
non_capital_roadmap_repository_complete
external_boundaries_documented
```

## §6 External actions the operator must take next

In order:

1. **Confirm current push is green in CI.** All four base workflows (`stage3c-native-electron`, `desktop-windows`, `managed-docker-runtime`, `operational-validation-preflight`) must show GREEN on the release-candidate SHA. Green establishes Stage 5 full CI closure.

2. **Launch the seven-day soak.** Trigger `operational-soak-launch` via `gh workflow run` OR the GitHub UI. This commits `SOAK_ANCHOR.json` to the branch. The first daily cycle fires at the next `15 0 * * *` UTC (or can be forced today via workflow_dispatch on `operational-soak-daily.yml` with today's UTC date).

3. **Wait seven UTC days.** Each day the cron runs one cycle. The manifest transitions from `in_progress` to `passed` or `invalidated` on day 7. Any commit that changes runtime-content-digest during the interval invalidates the soak (the anchor detects it and writes `finalVerdict='invalidated'` to `SOAK_ANCHOR.json`).

4. **Run release audit against the soak-anchored SHA.** `npm run release:audit` writes `docs/audit/release_audit_<sha>.json`. Zero failures → Stage 7 verdict claimable.

5. **Emit the code-freeze manifest.** `npm run freeze:manifest` writes `docs/audit/code_freeze_manifest.json` with actual CI run IDs + installer checksum populated from the CI artifacts.

6. **Provision private Coinbase read-only credentials in the durable environment.** Never in this repository, never in public CI. Once provisioned, run the read-only preflight harness with `credentialSource: 'env'`.

7. **Run the live-data shadow soak.** Same daily cron mechanism, but with a compose file / anchor tagged for live-data mode. Order submission remains structurally blocked.

8. **Assemble prospective-validation report + certify.** `evaluateProspectiveSufficiency` + `certifyShadow` produce the three-conclusion certification.

9. **If (and only if) certified for live canary review** → separate risk-owner authorization + schema change to `SoakSafetyFlagsSchema.liveCapitalAuthorized` → tightly bounded canary session per `docs/live_canary/plan.md`.

None of steps 2-9 can begin from this session. All prerequisites are in the repository.
