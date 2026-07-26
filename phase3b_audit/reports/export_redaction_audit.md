# Phase 3B §L — Reports + export redaction audit

Every export kind is enumerated in `apps/desktop/src/shared/ipcContract.ts`
(EXPORT_REPORT_KINDS). The main-process handler enforces:

- Every export response includes:
  - `reportVersion` (immutable per phase, e.g. `p3a-report-1`)
  - `generatedAt` (ISO timestamp)
  - `redactionsApplied` (explicit list of every redaction key)
  - `checksum` (SHA-256 of the emitted bytes)
  - `failureReason` (non-null iff `ok=false`)

## Export kinds

| Kind | Deterministic JSON | Stable CSV | Complete printable | Secrets absent | Auth headers absent | Path sanitized |
|---|---|---|---|---|---|---|
| decision_chain | pass | pass | pass | pass | pass | pass |
| daily_shadow | pass | pass | pass | pass | pass | pass |
| portfolio_risk | pass | pass | pass | pass | pass | pass |
| universe_and_hygiene | pass | pass | pass | pass | pass | pass |
| fingerprints | pass | pass | pass | pass | pass | pass |
| regimes | pass | pass | pass | pass | pass | pass |
| microstructure | pass | pass | pass | pass | pass | pass |
| context | pass | pass | pass | pass | pass | pass |
| cost_attribution | pass | pass | pass | pass | pass | pass |
| validation | pass | pass | pass | pass | pass | pass |
| incidents | pass | pass | pass | pass | pass | pass |
| safety_status | pass | pass | pass | pass | pass | pass |
| system_manifest | pass | pass | pass | pass | pass | pass |

## Redaction contract

The following keys are unconditionally redacted before an export
artifact is written or a report is shown in the renderer:

- `password`
- `apiKey`, `apiSecret`, `coinbaseKey`, `coinbaseSecret`
- `authorization`, `cookie`
- `sessionToken`, `refreshToken`, `accessToken`
- Home-directory prefix in operator-selected paths (replaced by
  `~/`) when the target folder is inside `%USERPROFILE%`

## Failure semantics

Failed exports create a `desktop_incidents` row (severity=warn) and
return `{ok:false, artifactPath:null, checksum:null, failureReason}`.
The renderer surfaces the failure and does not claim partial success.
