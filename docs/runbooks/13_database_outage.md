# Runbook 13 — Database outage

## Trigger
MariaDB becomes unreachable — Docker crashed, external DB down,
network partition.

## Symptoms
- Overview shows `mariadb` in `failed`, and `server` in `failed`.
- Every screen shows API-error banners.

## Immediate containment
- Do NOT restart the desktop repeatedly (crash-loop escalates to
  `recovery_required`).

## Diagnostic commands
```
docker ps -f name=horizon-mariadb
docker logs horizon-mariadb --tail 100
mysqladmin ping -h 127.0.0.1
```

## Recovery procedure
1. Restore MariaDB (Docker: `docker start horizon-mariadb`; external:
   contact DBA).
2. Confirm reachable via `mysqladmin ping`.
3. Open Horizon Trade → System → "Restart mariadb".
4. Once healthy, restart `server` in the same way.
5. The reconciler runs its first cycle before scanner starts (Phase 1
   startup reconciliation gate).

## Verification
- Overview shows all services healthy.
- Reconciler cycle produces zero unresolved actions.
- CreateOrder counters remain zero.

## Escalation
- MariaDB refuses to start → run runbook 07 (restore from snapshot).

## Data preservation
- Never `docker volume rm mariadb_data`. Never truncate tables.

## Safety implications
- DB outage does not enable live trading. Every safety check is
  DB-independent (safe flags come from environment).
