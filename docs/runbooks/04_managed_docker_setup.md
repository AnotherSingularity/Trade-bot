# Runbook 04 — Managed Docker setup

## Trigger
Operator selects `managed_docker` for MariaDB + Redis in the
Configuration screen (or is doing a fresh install).

## Symptoms
- Docker Desktop is not installed / not running.
- Overview `Service Health` shows `mariadb` or `redis` in `failed`
  state with `detail: docker_not_installed`.

## Immediate containment
- Do not attempt to start services until Docker is running.

## Diagnostic commands
```
docker --version
docker info
docker compose ls
```

## Recovery procedure
1. Install Docker Desktop from https://www.docker.com/products/docker-desktop/.
2. Enable WSL 2 integration.
3. Reboot Windows.
4. Launch Docker Desktop and wait for the whale icon.
5. Open Horizon Trade → System screen → click "Refresh".
6. Click "Start local services" on the System screen.

## Verification
- `docker ps` shows `horizon-mariadb` and `horizon-redis` containers.
- Overview `Service Health` shows both in `healthy` state.

## Escalation
- Docker Desktop refuses to start after reboot → escalate to
  workstation admin; do not proceed until Docker is available.

## Data preservation
- Docker named volumes `mariadb_data` and `redis_data` persist
  across container restarts. Never remove them with `docker volume rm`.

## Safety implications
- No effect on safe flags. The compose file binds MariaDB + Redis to
  `127.0.0.1` only — the DB is never publicly reachable.
