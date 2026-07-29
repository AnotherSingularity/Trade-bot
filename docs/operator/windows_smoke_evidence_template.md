# Windows operator smoke — evidence template

Fill this template while executing `windows_smoke_checklist.md`. Every field is required. Blank fields invalidate the smoke.

## Run identity

- Reviewer name (redact to initials if the evidence file is going into shared audit storage):
- Workstation OS + build (e.g. "Windows 11 23H2, build 22631.3958"):
- Workstation cleanliness: [ ] fresh VM  [ ] wiped physical  [ ] existing workstation (record why)
- Timestamp UTC (start):
- Timestamp UTC (end):
- Release-candidate commit SHA (40-hex):
- desktop-windows workflow run id:
- Installer artifact SHA-256:
- Published checksum (from `windows-installer-checksum.txt`):
- Checksums match: [ ] yes  [ ] no (STOP, record failure)

## Environment invariants (checked at end of run)

- `DRY_RUN` value observed on health bar: (must be "TRUE")
- `LIVE ORDER SUBMISSION DISABLED` visible on health bar: [ ] yes  [ ] no
- `provider: fixture` visible: [ ] yes  [ ] no
- `simulation: shadow` visible: [ ] yes  [ ] no
- Configuration screen `credentialStatus.coinbase`: (must be "absent")
- Configuration screen `championVersion`: (must be "observed")
- Safety screen `liveCapitalAuthorized`: (must be false)
- Safety screen `promotionEnabled`: (must be false)
- Safety screen `kellyEnabled`: (must be false)
- Create Order counters at end of run: functionInvocations= , attemptCount= , networkCount=  (all must be 0)

## Section 2 — install

- Install profile chosen (per-user | elevated):
- Elevated install required by installer default: [ ] yes  [ ] no
- Start Menu shortcut present: [ ] yes  [ ] no
- Install directory captured to `install-tree.txt` (attach): [ ] yes  [ ] no

## Section 3 — first launch + managed runtime

- Time to authenticated dashboard (seconds):
- Managed containers observed via `docker ps` after ready:
  - MariaDB image tag:
  - Redis image tag:
  - Server container image tag:
- Unexpected dialogs during launch: [ ] none  [ ] listed below
  - (if listed): 

## Section 4 — authentication

- Fixture username used (record the intentionally non-secret literal from the CI workflow's environment section, e.g. `smoke-operator`):
- Any credential entered that is NOT the CI-published fixture: [ ] none  [ ] listed → INVALIDATE
- Session established: [ ] yes  [ ] no

## Section 5 — critical screen tour

For each screen record `data-state` observed and any anomaly.

| Screen | data-state | notes |
|---|---|---|
| Overview |  |  |
| Shadow Portfolio |  |  |
| Positions |  |  |
| Decision Journal |  |  |
| Reports |  |  |
| Configuration |  |  |
| System |  |  |
| Safety |  |  |

## Section 6 — report export end-to-end

- Kind chosen: `safety_status`
- Format chosen: `json`
- Target folder: (record path)
- Job id returned:
- contentDigest returned:
- checksumSha256 returned:
- Size returned (bytes):
- Local SHA-256 of exported file:
- Local size (bytes):
- Checksum match: [ ] yes  [ ] no
- Bearer-shaped token scan of file bytes: [ ] no hits  [ ] hits (STOP)
- `password=` scan of file bytes: [ ] no hits  [ ] hits (STOP)
- Verify button result: (record `data-verification-state`)

## Section 7 — restart

- Application close clean: [ ] yes  [ ] no
- Post-close `docker ps -q` (should be empty): 
- Relaunch produced authenticated state (persisted OR re-login required): [ ] persisted  [ ] re-login  [ ] neither (INVALIDATE)
- Reports history contains the exported job: [ ] yes  [ ] no

## Section 8 — shutdown + uninstall

- Application close clean: [ ] yes  [ ] no
- Post-close leaked Horizon processes (`Get-Process horizon*`): [ ] none  [ ] list below
  - (if list):
- Uninstall completed: [ ] yes  [ ] no
- Install directory removed: [ ] yes  [ ] no  [ ] documented residual (attach explanation)
- Docker container leak (`docker ps -a --filter label=owner=horizon`): [ ] none  [ ] list
- Docker volume leak (`docker volume ls --filter label=owner=horizon`): [ ] none  [ ] list
- Docker network leak (`docker network ls --filter label=owner=horizon`): [ ] none  [ ] list

## Attachments

- `install-tree.txt`
- `process-tree-before.txt`
- `process-tree-after.txt`
- `docker-ps-before.txt`
- `docker-ps-after.txt`
- `docker-networks-before.txt`
- `docker-networks-after.txt`
- `docker-volumes-before.txt`
- `docker-volumes-after.txt`
- `exported-artifact.checksum`

Do NOT attach the exported artifact itself unless it is confirmed to contain zero private substrings; the deterministic checksum + digest are enough to prove identity.

Do NOT attach any credential, environment dump, database dump, cookie jar, or session token.

## Verdict recorded

- Every checkbox above ticked and every invariant held: [ ] yes → claim `windows_human_operator_smoke_verified`
- Any failure OR invariant violation: [ ] yes → smoke invalidated; open a follow-up defect; do NOT claim the verdict

Reviewer signature (initials + UTC timestamp): ______________________
