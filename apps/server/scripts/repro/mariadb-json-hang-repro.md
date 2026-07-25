# drizzle-kit v0.31.10 introspect hangs on MariaDB `json_valid()` check constraints

## Summary

`drizzle-kit introspect` (v0.31.10, latest as of 2026-07-25) hangs
indefinitely when the target database is MariaDB and any table has a
column of type `json`. MariaDB auto-generates a `json_valid(<col>)`
check constraint for every `json` column; drizzle-kit's check-constraint
fetch enters an infinite state at the "check constraints fetching" step
and never returns.

The hang is silent — no error is thrown, no output files are written,
the CLI exits with code 0 after the process is killed externally.

## Impact on this project

`drizzle-kit introspect` cannot be used to reconstruct historical
snapshots from live databases past migration `0002` (the first migration
that introduces a `json` column). We built a bespoke reconstruction tool
(`apps/server/scripts/reconstruct-snapshots.ts`) that reads
`information_schema` directly and emits the drizzle-kit snapshot format
without calling `introspect`.

The tool is a workaround, not a fix. When drizzle-kit ships a version
that introspects MariaDB `json` columns without hanging, the future
removal criterion is:

- **Remove:** `apps/server/scripts/reconstruct-snapshots.ts` and its
  `lib/` helpers.
- **Replace with:** `drizzle-kit introspect --url $DB_URL --out …`.
- **Verify:** the same drizzle-kit `generate` empty-diff test passes.

## Minimal reproduction

```bash
# Any MariaDB / MySQL server + a database with a json column.
mysql -h127.0.0.1 -uroot -ppassword -e "
  DROP DATABASE IF EXISTS repro; CREATE DATABASE repro;
  USE repro;
  CREATE TABLE t (id INT PRIMARY KEY, data JSON);
"

mkdir -p /tmp/repro-out
DATABASE_URL="mysql://root:password@127.0.0.1:3306/repro" \
  timeout 30 npx drizzle-kit introspect \
    --out=/tmp/repro-out \
    --dialect=mysql \
    --url="mysql://root:password@127.0.0.1:3306/repro"

# Expected: files under /tmp/repro-out/meta/
# Actual: [✓] 1 check constraints fetching   ← hangs until timeout
#         no files produced

ls /tmp/repro-out/meta/ 2>&1
# → ls: cannot access '/tmp/repro-out/meta/': No such file or directory
```

## Verified against

- drizzle-kit v0.31.10 (latest stable as of 2026-07-25)
- drizzle-orm v0.45.2
- MariaDB 10.11.14-MariaDB-0ubuntu0.24.04.1
- Node.js v22.22.2
- Ubuntu 24.04

The same schema on MySQL (not MariaDB) does NOT hang, because MySQL
does not materialize `json_valid()` check constraints on json columns —
they exist only as an implicit constraint in the storage engine. This
tells us the bug is in drizzle-kit's information_schema query for
MariaDB-specific check constraints.

## Related information_schema query that hangs

The hang appears to originate in drizzle-kit's check-constraints fetch,
which corresponds to a query similar to:

```sql
SELECT ... FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = ?
```

Our own `apps/server/scripts/lib/mariadb-introspect.ts` runs the same
query and returns in milliseconds — the hang is inside drizzle-kit's
subsequent processing, not in MariaDB. We have not root-caused which
line in drizzle-kit hangs; the bespoke tool is our workaround.

## Related files

- `apps/server/scripts/reconstruct-snapshots.ts` — the workaround
- `apps/server/scripts/lib/mariadb-introspect.ts` — proves the SQL query
  itself returns; the hang is in drizzle-kit's code path
- `PHASE1_gate1.md` — documents Gate 1's use of the workaround
