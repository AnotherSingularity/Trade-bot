# Windows operator smoke checklist

**Purpose.** Prove that the CI-produced NSIS installer works on a real, clean Windows workstation, end-to-end, without any human touching Coinbase credentials or authorizing live capital. This is the ONLY way `windows_human_operator_smoke_verified` can be claimed. Automated CI (workflow `desktop-windows`) can only claim `windows_installer_ci_smoke_verified`.

**Do not skip any step.** If any step fails, record the failure in `windows_smoke_evidence_template.md` and stop. Do not "retry" a failing step and pretend it passed the first time.

**Safety invariants — verify they hold at every applicable checkpoint below.** If any of these ever becomes untrue during the smoke, the run is invalidated:

- `DRY_RUN = true`
- `ORDER_SUBMISSION_ENABLED = false`
- `liveCapitalAuthorized = false`
- `promotionEnabled = false`
- `kellyEnabled = false`
- Create Order counters: `functionInvocations=0, attemptCount=0, networkCount=0`

## 0. Prerequisites

- [ ] Clean Windows workstation (fresh VM or newly reset physical machine).
- [ ] Docker Desktop installed and running (managed_docker mode requires it).
- [ ] Administrator access to Task Manager for process inspection.
- [ ] `scripts/operator/verify-windows-install.ps1` copied to the workstation.
- [ ] No prior Horizon install artefact present.

## 1. Installer acquisition

- [ ] Download `Horizon Trade Setup.exe` from the CI artifact of the exact release-candidate `desktop-windows` workflow run. Record the workflow run ID.
- [ ] Compute SHA-256 of the downloaded installer: `Get-FileHash .\Horizon-Trade-Setup.exe -Algorithm SHA256`.
- [ ] Compare against the checksum published in the workflow's `windows-installer-checksum.txt` artifact. **Must be byte-identical.**

## 2. Installation

- [ ] Run the installer with the documented default profile (per-user install unless a signed elevated install is the release contract).
- [ ] Wait for "Installation complete" without accepting elevated permissions that were not required by the default profile.
- [ ] Confirm Start Menu shortcut exists.
- [ ] Confirm installed layout under `%LOCALAPPDATA%\Programs\Horizon Trade\` (or the documented default) — capture directory tree with `Get-ChildItem -Recurse -Name`.

## 3. First launch + managed runtime

- [ ] Launch via Start Menu shortcut (NOT via `.exe` path — proves the shortcut works).
- [ ] Observe the health bar shows `DRY_RUN = TRUE` + `LIVE ORDER SUBMISSION DISABLED` + `simulation: shadow` + `provider: fixture`.
- [ ] Wait for the "authenticated" state (login screen appears, then main dashboard). Managed Docker's MariaDB + Redis + server bootstrap can take 30-60 seconds; if longer than 120 seconds, record diagnostics + fail.
- [ ] Confirm no unexpected Windows dialogs (no unsigned-driver warning, no unresolved dependency).

## 4. Authentication

- [ ] Enter the fixture operator credentials the CI workflow uses (documented in `docs/operator/windows_smoke_evidence_template.md`).
- [ ] Confirm session established (dashboard becomes active).
- [ ] Do NOT enter Coinbase credentials or any production credential.

## 5. Critical screen tour

- [ ] Overview: renders `data-state="healthy"`. Record the Safety Bar text.
- [ ] Shadow Portfolio: renders `data-state="healthy"` or `data-state="empty"`.
- [ ] Positions: renders without exposing any `apiKey` / `apiSecret` / `passwordHash` / `sessionToken`.
- [ ] Decision Journal: renders the Champion + Observer sections.
- [ ] Reports: renders the 13-report catalog table + 13 Generate buttons (one per kind).
- [ ] Configuration: shows `championVersion: observed`, `credentialStatus.coinbase: absent`.
- [ ] System: shows `runtimeMode: managed_docker`, `serviceOwnership` includes desktop_supervisor for mariadb + redis + server.
- [ ] Safety: shows all five safety flags at their non-negotiable values.

## 6. Report export end-to-end

- [ ] On Reports, select `safety_status` kind + `json` format.
- [ ] Click "Pick folder…". Choose a disposable folder under `%USERPROFILE%\Desktop\horizon-smoke-out\`.
- [ ] Click "Generate" for `safety_status`.
- [ ] Wait for the result column to show a job id + digest + checksum + size.
- [ ] Open the exported file (Notepad). Confirm it starts with valid JSON, contains `"DRY_RUN": true`, contains no bearer-shaped tokens, contains no `password=` sequences.
- [ ] Compute SHA-256 of the file. Compare against the checksum shown in the UI's result column. **Must match.**
- [ ] Click "Verify" for `safety_status`. Confirm `data-verification-state="ok"`.

## 7. Application restart

- [ ] Close the application via the window's close button (NOT via Task Manager kill).
- [ ] Wait for the managed containers to stop. Confirm with `docker ps -q` — no Horizon-owned containers running.
- [ ] Relaunch via Start Menu.
- [ ] Observe authentication persistence (per session-policy contract): either the app is still authenticated OR requires re-login. Both are legal — record which.
- [ ] Navigate to Reports. Confirm the previously-exported job appears in the job history table.

## 8. Clean shutdown + uninstall

- [ ] Close the application via window close.
- [ ] Wait 30 seconds. Confirm no Horizon process survives — `Get-Process horizon* -ErrorAction SilentlyContinue` returns empty.
- [ ] Uninstall via Settings → Apps → Horizon Trade → Uninstall (per-user install) OR Control Panel (elevated install).
- [ ] Confirm the install directory is removed OR the residual contract is documented (some installers legitimately keep user data).
- [ ] Confirm no Horizon-owned Docker container / network / volume remains: `docker ps -a --filter label=owner=horizon` and `docker network ls --filter label=owner=horizon` — both empty.
- [ ] Confirm no leaked process: `Get-Process | Where-Object {$_.Name -like 'horizon*' -or $_.Name -like 'electron*'}` returns empty.

## 9. Evidence

- [ ] Fill in every checkbox in `windows_smoke_evidence_template.md`.
- [ ] Attach the redacted process-tree captures + docker container listings + installer checksum.
- [ ] Do NOT attach any credential, token, cookie, database dump, or environment variable dump.
- [ ] Do NOT attach any real Coinbase credential.

## Verdict

- If every step passed AND every safety invariant held: `windows_human_operator_smoke_verified` may be claimed by the reviewer who ran + recorded the smoke.
- If any step failed OR any invariant was violated: the run is discarded. Fix the underlying defect, produce a new release-candidate SHA, and rerun from step 0.

**Under no circumstances does completing this smoke authorize live capital.** The only pathway to live capital is a separate explicit user directive after the final shadow certification succeeds.
