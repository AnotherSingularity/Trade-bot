# Runbook 05 — External services setup

## Trigger
Operator manages MariaDB + Redis outside of Docker (e.g. corporate DB).

## Symptoms
- Overview shows `serviceMode: external_services`.
- Service health shows `mariadb` or `redis` as `failed` with
  `detail: mariadb_unreachable` / `redis_unreachable`.

## Immediate containment
- Do not attempt to run scanner or reconciler until the external
  services are reachable.

## Diagnostic commands
```
mysqladmin ping -h <db-host> -P <db-port> -u <user> -p<password>
redis-cli -h <redis-host> -p <redis-port> PING
```

## Recovery procedure
1. Confirm the external MariaDB version is 10.11 or compatible.
2. Confirm the external Redis version is 7.x with `appendonly yes`.
3. Ensure the operator's account has GRANT privileges for the
   Horizon schema (see `apps/server/README.md`).
4. Set `HORIZON_MARIADB_URL` and `HORIZON_REDIS_URL` environment
   variables in the desktop launch shortcut.
5. Restart the desktop.
6. Verify the schema fingerprint matches the release manifest.

## Verification
- Overview `databaseMode = external_services`.
- Service health shows all services in `healthy` state.
- Schema fingerprint matches the code-freeze manifest.

## Escalation
- Schema fingerprint mismatch → run runbook 06 (database migration).
- Unauthorized user → escalate to DB admin.

## Data preservation
- External storage is owned by the operator. Horizon Trade never
  drops tables — migrations are additive only.

## Safety implications
- Safe flags unchanged. External services do not alter DRY_RUN policy.
