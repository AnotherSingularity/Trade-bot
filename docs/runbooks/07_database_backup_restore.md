# Runbook 07 — Database backup and restore

## Trigger
Before any migration, upgrade, or destructive action; or after an
incident that requires point-in-time restore.

## Symptoms
None (proactive) or "the database is corrupt" (reactive).

## Immediate containment
- If reactive, stop the server via System → "Stop local services".

## Diagnostic commands
```
mysqldump -u root -p horizon_trade > backup-YYYYMMDD-HHMM.sql
gzip backup-YYYYMMDD-HHMM.sql
```

## Recovery procedure

### Backup
1. Stop the server.
2. Run `mysqldump` above.
3. Move the compressed dump to a separate physical drive.

### Restore
1. Stop the server.
2. `gunzip backup-YYYYMMDD-HHMM.sql.gz`
3. `mysql -u root -p horizon_trade < backup-YYYYMMDD-HHMM.sql`
4. Verify the migration table matches the release.
5. Start the server.

## Verification
- Row counts in critical tables (fills, positions, round_trips, ledger)
  match the pre-backup expected counts.
- The reconciler runs its first cycle and produces zero unresolved actions.

## Escalation
- Restore fails midway → escalate to DBA. Do NOT start the server
  in a half-restored state.

## Data preservation
- Never overwrite an existing dump. Rotate by date.
- Encrypt off-machine dumps at rest.

## Safety implications
- Backups do not affect safe flags.
