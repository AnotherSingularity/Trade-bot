# Runbook 01 — Desktop installation

## Trigger
New operator machine or fresh install of Horizon Trade Desktop on Windows.

## Symptoms
- No `Horizon Trade` entry in the Start Menu.
- No `%LOCALAPPDATA%\Programs\Horizon Trade` install directory.

## Immediate containment
None required — installation is a fresh action.

## Diagnostic commands
```
powershell -c "Get-Command 'Horizon Trade' -ErrorAction SilentlyContinue"
powershell -c "Test-Path '%LOCALAPPDATA%\Programs\Horizon Trade'"
```

## Recovery procedure
1. Download `Horizon Trade Setup.exe` and its `.sha256` from the release page.
2. Verify: `certutil -hashfile "Horizon Trade Setup.exe" SHA256` matches.
3. Launch the installer as the current user (per-user install; no admin required).
4. Accept the license (the enforced safety posture is stated in the license).
5. Choose the install directory; defaults to `%LOCALAPPDATA%\Programs\Horizon Trade`.
6. Complete the installer.
7. Launch `Horizon Trade`.
8. On the Overview screen, verify the persistent health bar shows
   `DRY_RUN = TRUE` and `LIVE ORDER SUBMISSION DISABLED`.

## Verification
- `Horizon Trade` present in Start Menu.
- Overview screen renders successfully.
- Safety screen lists `DRY_RUN`, `ORDER_SUBMISSION_ENABLED`,
  `Live order submission disabled` all with expected safe values.

## Escalation
- Installer refuses to launch → escalate to release owner with the
  installer log at `%LOCALAPPDATA%\Horizon Trade\logs\install.log`.
- Missing dependency (Docker Desktop, MariaDB) → run 04 or 05.

## Data preservation
- No existing data. Installer never overwrites `%APPDATA%\Horizon Trade`.

## Safety implications
- `DRY_RUN=true`, `ORDER_SUBMISSION_ENABLED=false` are enforced at
  boot. A fresh install cannot enable live trading.
