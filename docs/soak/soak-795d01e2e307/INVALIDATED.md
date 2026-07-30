# Soak `soak-795d01e2e307` — INVALIDATED

## Verdict

`finalVerdict = "invalidated"`

## When

- Started: `2026-07-29T22:20:25.707Z`
- Invalidated: `2026-07-30T00:00:00Z`
- Anchor commit: `da1a81908a4c797cf117fb25f2f8d6a410ff9209`

## Preserved evidence

- `INVALIDATED_ANCHOR.json` — the original anchor with `finalVerdict='invalidated'` and full context.
- `day-2026-07-29.json` — the sole day-result that ran (day-0, via manual workflow_dispatch).
- `manifest.in-progress.json` — the running manifest at the point of invalidation.

These files are retained per the invalidation contract: **do NOT delete or overwrite.**

## Reason (mechanical)

### 1. Anchored workflow was structurally invalid

The anchored SHA `da1a819` shipped `.github/workflows/operational-soak-daily.yml` with:

```yaml
jobs:
  daily-cycle:
    if: hashFiles('SOAK_ANCHOR.json') != ''   # <-- rejected at parse time
```

GitHub Actions rejects `hashFiles()` at a job-level `if:` with HTTP 422
`Unrecognized function: 'hashFiles'`. The anchored workflow was therefore
structurally incapable of executing a single cron cycle.

The follow-up commit `034008b` moved the check to a step-level `anchor_check`
step that gates each subsequent step via `if: steps.anchor_check.outputs.skip != 'true'`.
This fix was necessary just to make the daily cron runnable. Day-0's cycle
(2026-07-29) therefore executed against the workflow at `034008b`, not
against the workflow at the anchored SHA.

### 2. runtimeContentDigest coverage gap

The digest at anchor time (`96c660a9`) was computed over:

- `packages/shared/src/**/*.ts`
- `apps/server/src/**/*.ts`
- `apps/desktop/src/**/*.{ts,tsx}`
- Drizzle migrations
- three workspace `package.json` files + root `package-lock.json`

Workflow YAML was **excluded by design** — the header explicitly documented
that "workflow YAML" would not invalidate. That policy was wrong for the two
soak-critical workflows: those are exactly the files whose behavior the soak
is designed to observe.

### 3. Wall-clock finalization guard missing

The daily-cycle logic set `finalVerdict='passed'` as soon as
`dayResults.length >= 7`. Given the launch time
`2026-07-29T22:20:25.707Z`, that condition would be met on the
`2026-08-04T00:15Z` cron — roughly 42 hours before the required
`expectedEndAt = 2026-08-05T22:20:25.707Z`.

## Fixes applied in the successor soak's implementation

All three gaps are closed by the changes committed in the same commit
that lands this invalidation record:

- `apps/server/scripts/lib/runtime-content-digest.ts`
  — `RUNTIME_PATH_PATTERNS` extended to cover:
    - `.github/workflows/operational-soak-launch.yml`
    - `.github/workflows/operational-soak-daily.yml`
    - `apps/server/scripts/soak-launch.ts`
    - `apps/server/scripts/soak-daily-cycle.ts`
    - `apps/server/scripts/lib/runtime-content-digest.ts` (self-reference)

- `apps/server/scripts/soak-launch.ts`
  — writes `finalizationEligibleAt = expectedEndAt` into the new anchor.
    A separate field, so an external auditor sees the guard explicitly.

- `apps/server/scripts/soak-daily-cycle.ts`
  — wall-clock guard added to `assembleAndValidateManifest`: verdict may
    only leave `in_progress` once BOTH `days.length >= 7` AND
    `Date.now() >= finalizationEligibleAt`.
  — post-window cycles (`dayIdx >= 7`) no longer fail; they run
    finalization-only so the first cron firing after
    `finalizationEligibleAt` can transition the anchor.
  — `awaiting_wall_clock` state is logged explicitly.

## What this invalidation does NOT do

- Does not delete the preserved evidence.
- Does not change the `SoakSafetyFlagsSchema` z.literal locks:
  `DRY_RUN=true`, `ORDER_SUBMISSION_ENABLED=false`,
  `liveCapitalAuthorized=false`, `promotionEnabled=false`,
  `kellyEnabled=false` remain enforced.
- Does not permit fabrication of the elapsed wall clock.
- Does not shorten the seven-day interval for the successor soak.
