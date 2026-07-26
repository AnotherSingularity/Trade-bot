# Runbook 06 — Database migration

## Trigger
A new Horizon Trade release includes a schema migration OR the
schema fingerprint check fails on desktop boot.

## Symptoms
- Overview `Schema version` differs from the release manifest.
- Server logs contain `schema_fingerprint_mismatch`.

## Immediate containment
- Do NOT touch the scanner or reconciler; they are already blocked
  by the schema-fingerprint gate.

## Diagnostic commands
```
mysql -u root -p -e "SELECT * FROM horizon_trade.drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 5"
```

## Recovery procedure
1. Take a database snapshot (runbook 07).
2. Open Horizon Trade → System screen → click "Apply migrations".
3. The server runs `drizzle-kit migrate` and reports the applied
   migrations in a Configuration incident.
4. Confirm the schema fingerprint on Overview matches the release
   manifest.

## Verification
- `drizzle-kit generate` reports "No schema changes, nothing to migrate".
- The migration table lists a new row for the applied migration.
- Scanner/reconciler leases can be acquired again.

## Escalation
- Migration fails → run runbook 08 (application rollback) with the
  snapshot from step 1.

## Data preservation
- Migrations are additive only (0000-0020 remain byte-identical).
- Never manually alter or drop a migration file.

## Safety implications
- Migrations do not affect safe flags. The desktop refuses to start
  the scanner if the schema fingerprint does not match.
