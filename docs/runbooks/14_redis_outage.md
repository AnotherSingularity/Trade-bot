# Runbook 14 — Redis outage

## Trigger
Redis becomes unreachable.

## Symptoms
- Overview shows `redis` in `failed`, `server` may be `degraded`.
- Scanner/reconciler cannot acquire leases.

## Immediate containment
- Do NOT force new scanner runs; they will duplicate work.

## Diagnostic commands
```
docker ps -f name=horizon-redis
redis-cli -h 127.0.0.1 PING
```

## Recovery procedure
1. Restart Redis (Docker: `docker start horizon-redis`; external: contact operator).
2. Confirm reachable via `PING`.
3. On System → "Restart redis".
4. The supervisor transitions to `healthy`.
5. Scanner and reconciler resume; leases re-acquired.

## Verification
- `redis-cli KEYS 'horizon:lease:*'` shows the expected lease keys.
- Overview shows `redis` and `server` in `healthy` state.

## Escalation
- Redis crashes repeatedly → escalate to release owner.

## Data preservation
- Redis persistence is `appendonly yes` (Docker) or operator-defined
  (external). Never `FLUSHALL`.

## Safety implications
- Redis outage does not enable live trading.
