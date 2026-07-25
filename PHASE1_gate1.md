# Phase 1.1 Gate 1 — Migration Snapshot Integrity

> **DRY_RUN remains `true`.** **ORDER_SUBMISSION_ENABLED remains `false`.**
> **No Coinbase order was submitted at any point during Gate 1.**

Gate 1 is the small mandatory precursor that normalises the Drizzle
migration history and snapshots BEFORE any further schema expansion
(lineage tables, universe tables, risk tables) begins. Without this,
future migrations produce dishonest diffs and every schema change is
harder to audit.

## Exit criteria (from the roadmap)

| # | Requirement | Status |
|---|---|---|
| 1 | Runtime migration paths produce the same canonical database schema | ✅ 7 integrity tests |
| 2 | Latest checked-in snapshot makes future `drizzle-kit generate` trustworthy — no false diffs | ✅ verified (see below) |
| 3 | Fresh-database migration proof | ✅ `Gate 1c §A` |
| 4 | Upgrade-path proof from each prior milestone | ✅ `Gate 1c §B` (from 0000/0003/0004) |
| 5 | Repeat migration invocation is a no-op | ✅ `Gate 1c §C` |
| 6 | No manually applied SQL required | ✅ runtime migrator (`drizzle-orm/mysql2/migrator`) drives all paths |
| 7 | Existing migrations 0000–0004 remain immutable | ✅ (0005 unchanged) |
| 8 | CI test regenerates snapshots + fingerprints and fails on any checked-in difference | ✅ `tests/gate1-snapshot-regen.test.ts` |

## The blocker Gate 1 works around

`drizzle-kit v0.31.10` (latest stable) **hangs indefinitely** on
`drizzle-kit introspect` against MariaDB once any table has a `json`
column, because MariaDB auto-generates `json_valid(<col>)` check
constraints and drizzle-kit's check-constraint fetcher never completes.
This means the "reconstruct via introspect" path the roadmap originally
sketched isn't available with our current toolchain.

Full minimal reproduction: `apps/server/scripts/repro/mariadb-json-hang-repro.md`.

**Workaround (Option 1, per user approval):** We built a deterministic
reconstruction tool that reads `information_schema` directly and emits
the drizzle-kit snapshot format without invoking `drizzle-kit introspect`.
The tool is checked in; snapshots and fingerprints are regenerated
mechanically from real MariaDB databases at each checkpoint. **Nothing
is hand-authored or guessed.**

**Removal criterion:** when a future drizzle-kit ships that introspects
MariaDB `json` columns without hanging, delete
`apps/server/scripts/reconstruct-snapshots.ts` + `lib/*` and replace
with `drizzle-kit introspect`. The drift-detection test proves the
replacement produces the same snapshots.

## Deliverables

### 1. Reconstruction tool (checked in)

| Path | Purpose |
|---|---|
| `apps/server/scripts/reconstruct-snapshots.ts` | Orchestrator — for each checkpoint N in {0..5}, fresh DB → apply 0000..N SQL → introspect via `information_schema` → emit snapshot + fingerprint files |
| `apps/server/scripts/lib/mariadb-introspect.ts` | Reads `information_schema.{TABLES, COLUMNS, STATISTICS, KEY_COLUMN_USAGE, REFERENTIAL_CONSTRAINTS, CHECK_CONSTRAINTS}` — deterministic ordering by table + ordinal position + index sequence |
| `apps/server/scripts/lib/to-drizzle-snapshot.ts` | Converts the introspected schema to drizzle-kit v0.31.10 snapshot JSON — collapses `int(11)` → `int`, wraps generated-column expressions in outer parens to match drizzle-kit's format, maps `longtext + json_valid()` → `json`, filters FK-auto-indexes |
| `apps/server/scripts/lib/schema-fingerprint.ts` | MariaDB-authoritative fingerprint that preserves what drizzle-kit's snapshot format cannot represent (raw `int(11)` display widths, `json_valid()` check constraints, character sets); SHA-256 content hash + version-tag |
| `apps/server/scripts/lib/canonical-json.ts` | Byte-stable JSON writer — deterministic key ordering, `\n`-terminated, matches across re-runs |

Usage:

```bash
# Regenerate all snapshots + fingerprints
npx tsx scripts/reconstruct-snapshots.ts

# Verify without writing (fails on any change)
npx tsx scripts/reconstruct-snapshots.ts --verify
```

Every snapshot file records the drizzle-kit version it was generated
under (`drizzleKitVersion: "0.31.10"` in each `_mariadb_fingerprint.json`).

### 2. Snapshots + fingerprints (checked in)

| File | Source |
|---|---|
| `apps/server/drizzle/migrations/meta/0000_snapshot.json` | reconstructed |
| `apps/server/drizzle/migrations/meta/0001_snapshot.json` | reconstructed |
| `apps/server/drizzle/migrations/meta/0002_snapshot.json` | reconstructed |
| `apps/server/drizzle/migrations/meta/0003_snapshot.json` | reconstructed |
| `apps/server/drizzle/migrations/meta/0004_snapshot.json` | reconstructed |
| `apps/server/drizzle/migrations/meta/0005_snapshot.json` | reconstructed |
| `apps/server/drizzle/fingerprints/000N_mariadb_fingerprint.json` (×6) | authoritative MariaDB fingerprint, preserves details drizzle can't represent |

Snapshot files live under `drizzle/migrations/meta/` (where drizzle-kit
looks). Fingerprint files live under a separate `drizzle/fingerprints/`
directory so drizzle-kit does not attempt to parse them as snapshots.

### 3. Schema.ts updates

Migrations 0000–0005 remained immutable. `schema.ts` was updated to
declare structural details it had previously omitted — every change is
purely additive to keep the schema declaration in sync with what the
migrations actually built:

- **`positions.openTokenKey`** — added as `varchar(20).generatedAlwaysAs(sql\`(case when …)\`, { mode: 'virtual' })` + `uniqueIndex('positions_open_token_uq').on(table.openTokenKey)`. Migration 0003 added this column + constraint via ALTER TABLE.
- **`executionCostForecasts` FKs** — added `foreignKey({name, columns, foreignColumns}).onDelete('restrict').onUpdate('restrict')` for `candidateId → signal_candidates.id` and `feeTierSnapshotId → fee_tier_snapshots.id`. Migration 0002 declared these via `CONSTRAINT`.
- **`quantitativeDecisions` FKs** — same pattern for `candidateId → signal_candidates.id` and `costForecastId → execution_cost_forecasts.id`.

Named `foreignKey({name})` is required because drizzle-kit's automatic
FK naming produces the long form `<table>_<col>_<refTable>_<refCol>_fk`
which does NOT match the original migration-0002 names
(`<table>_<col>_fk`). Renaming the DB constraints would be an
unnecessary downtime; naming them explicitly in schema.ts keeps the
current DB names authoritative.

### 4. Migration-integrity test suite

`apps/server/tests/gate1-migration-integrity.test.ts` — 7 tests:

| # | Test | Verifies |
|---|---|---|
| A1 | fresh-from-zero applies cleanly | 0000..0005 apply in order; all expected tables exist |
| B1 | fresh vs upgrade-from-0000 fingerprints match | applying migrations one path or another yields identical schema |
| B2 | fresh vs upgrade-from-0003 fingerprints match | pre-1.1.a-FIX baseline upgrades cleanly |
| B3 | fresh vs upgrade-from-0004 fingerprints match | post-1.1.a-FIX baseline upgrades cleanly |
| C1 | re-invocation is a no-op | applying twice produces the same fingerprint |
| D1 | checked-in fingerprint matches live checkpoint | on-disk `0005_mariadb_fingerprint.json` matches a freshly-migrated DB |
| E1 | on-disk snapshots are in canonical byte-stable form | protects against hand-edits |

`apps/server/tests/gate1-snapshot-regen.test.ts` — 12 tests (2 per
checkpoint) that run the reconstruction tool and assert BYTE-IDENTICAL
output against every checked-in `_snapshot.json` + `_mariadb_fingerprint.json`.
This is the CI drift-detection test.

### 5. Drizzle-kit generate zero-diff proof

```
$ DATABASE_URL=... npx drizzle-kit generate --name gate1_check
Reading schema files:
/home/user/Trade-bot/apps/server/src/db/schema.ts

16 tables
...

No schema changes, nothing to migrate 😴
```

No SQL file emitted. No interactive rename prompt. Gate 1b exit
criterion met.

### 6. Hard fallback discipline

The user's explicit rule: *"if the mechanically generated snapshots
cannot be consumed by `drizzle-kit generate` without a false diff, do
not commit fabricated or hand-adjusted snapshots. Preserve the runtime
migration/fingerprint suite as the authoritative Gate 1 proof, document
native Drizzle snapshot generation as blocked by the pinned tooling
version, and stop for review."*

Gate 1 met the criterion: `drizzle-kit generate` produces zero SQL and
no rename prompt. If any future schema.ts change causes a diff, the
correct response is:

1. **Legitimate diff (new migration needed):** author the new
   migration SQL, apply it, then re-run
   `npx tsx scripts/reconstruct-snapshots.ts` to update the snapshot
   chain. Commit both together.
2. **Spurious diff (tooling change or drizzle-kit upgrade):** STOP.
   Do not commit falsified snapshots. Document the tooling issue,
   propose a bounded fix, wait for review.

Never edit migrations 0000–0005 again. Any schema correction is a
NEW forward migration (0006+).

## Snapshot format notes

Drizzle-kit v0.31.10's snapshot format captures:

- Column: `name, type, primaryKey (always false), notNull, autoincrement, default?, onUpdate?, generated?`
- Types: canonical form (`int` not `int(11)`, `boolean` for `tinyint(1)`, `json` for MariaDB `longtext + json_valid()`, `enum('a','b')`, `decimal(20,8)`)
- Generated columns: `{as: "<parenthesized-expression>", type: "virtual" | "stored"}`
- Primary keys: stored under `compositePrimaryKeys[name = <table>_<cols>]` even for single-column PKs (column-level `primaryKey` is always `false`)
- Indexes: `{name, columns, isUnique}` — no `using/algorithm/lock`
- Unique constraints: `.unique()` on a column → `uniqueConstraints[name = <table>_<col>_unique]`; `uniqueIndex('name').on(...)` → `indexes[name] with isUnique: true`
- Foreign keys: `{name, tableFrom, columnsFrom, tableTo, columnsTo, onUpdate, onDelete}` — auto-index skipped from `indexes`
- Check constraints: `checkConstraint: {}` (singular field name; MariaDB `json_valid()` constraints are recorded in the parallel fingerprint file, not here)
- Defaults: `(now())` for CURRENT_TIMESTAMP; unquoted `true`/`false` for booleans; unquoted numbers for integer defaults; SQL-quoted strings (`"'0'"`) for decimal defaults, with trailing zeros stripped to match schema.ts

## What Gate 1 does NOT do

- Doesn't add lineage tables (Gate 2)
- Doesn't fix reconciler exit recovery (Gate 3 / 1.1.c)
- Doesn't touch the token universe or strategy parameters
- Doesn't change any runtime behavior — `apps/server/src/db/schema.ts`
  additions are declarations of what already exists in the DB
- Doesn't upgrade drizzle-kit (blocker documented, workaround shipped)

## Test results

```
$ npx turbo run typecheck test build
Tasks:    9 successful, 9 total

Test Files  22 passed (22)
     Tests  247 passed (247)     ← up from 228 after 1.1.b
```

New tests this tranche:

- `tests/gate1-migration-integrity.test.ts` (7 tests)
- `tests/gate1-snapshot-regen.test.ts` (12 tests)

## Explicit confirmation

- `DRY_RUN=true` in `apps/server/.env` — unchanged
- `ORDER_SUBMISSION_ENABLED=false` in `apps/server/.env` — unchanged
- Phase 1 §Q killswitch inside `coinbase.createOrder` untouched
- No real Coinbase order was placed during Gate 1
- The reconstruction tool never contacts Coinbase — it only queries
  local MariaDB `information_schema`
- Migrations 0000, 0001, 0002, 0003, 0004, 0005 SQL files remain
  byte-identical to their pre-Gate-1 versions
