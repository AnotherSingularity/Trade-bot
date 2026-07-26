# Phase 3B §J — Docker + service audit

Static review of `docker-compose.yml`, `docker-compose.prod.yml` and
the desktop `serviceAdapters.ts` / `serviceSupervisor.ts` against
the Phase 3B managed-Docker requirements.

## Managed Docker (`docker-compose.yml`, `docker-compose.prod.yml`)

| Requirement | Status | Notes |
|---|---|---|
| MariaDB has persistent storage | pass | named volume `mariadb_data` mapped to `/var/lib/mysql` |
| Redis persistence policy explicit | pass | `appendonly yes` in redis args + volume mount |
| Health checks exist | pass | `mysqladmin ping` for mariadb, `redis-cli ping` for redis |
| Server waits for dependencies | pass | `depends_on.condition: service_healthy` for mariadb + redis |
| Restart policies are bounded | pass | `restart: on-failure:5` |
| Ports bind only where required | pass | mariadb bound to `127.0.0.1:3306` in prod compose; not public |
| Database not exposed publicly by default | pass | localhost-only binding in prod |
| Redis not exposed publicly by default | pass | localhost-only binding in prod |
| Credentials not hardcoded | pass | Env-vars read from `.env`; example file only ships placeholders |
| Volumes survive desktop upgrades | pass | Named volumes are preserved across `compose down` without `-v` |
| Uninstall does not silently remove data | pass | NSH include documents that `deleteAppDataOnUninstall=false` |
| Shutdown is graceful | pass | `stop_grace_period: 30s` on mariadb + server; supervisor calls `stop()` before `stopped` transition |
| Recovery after unclean shutdown runs reconciliation first | pass | Server boot triggers reconciler gate before scanner start |
| Scanner blocked until integrity restored | pass | Reconciler's fence prevents scanner lease acquisition |

## External-services mode (managed by operator)

The desktop `serviceAdapters.ts` implements external-mode probes that
fail closed on:

- Invalid database version (schema-fingerprint check on server boot)
- Missing schema (drizzle-kit migrate exits non-zero → supervisor transitions to `failed`)
- Unreachable Redis (`probeRedis` returns `{ok:false, detail:'redis_unreachable'}`)
- Unsafe network binding (server refuses to start when detected on 0.0.0.0 with no auth)
- Invalid credentials (Coinbase adapters refuse to initialize without valid keytar entries)
- Schema fingerprint mismatch (server refuses to start; incident recorded)

## Result

All 20 checked items pass. No high-severity gap. Recovery and
shutdown behavior match §J requirements.
