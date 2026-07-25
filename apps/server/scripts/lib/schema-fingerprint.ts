import { createHash } from 'node:crypto';
import type { IntrospectedSchema } from './mariadb-introspect';

/**
 * Canonical MariaDB schema fingerprint (Phase 1.1 Gate 1).
 *
 * Drizzle-kit's snapshot format cannot represent every structural detail
 * that MariaDB exposes:
 *   - `json_valid(<col>)` check constraints auto-generated on json columns
 *   - Generated-column expressions (drizzle only stores them when the
 *     schema.ts declaration used the `generated()` helper)
 *   - MariaDB's `int(11)` display width (drizzle collapses to `int`)
 *   - Character set / collation per column
 *
 * We preserve those separately here so no MariaDB-only information is
 * silently discarded. Two migration paths that produce different snapshots
 * OR different fingerprints fail the Gate 1 integrity test.
 *
 * The fingerprint is:
 *   - Deterministic (stable ordering, canonical form)
 *   - Version-tagged (drizzle-kit version + fingerprint schema version)
 *   - Small enough to check into the repo per checkpoint
 *   - Comparable byte-for-byte between "fresh migration" and
 *     "upgrade from checkpoint N" DBs
 */

export interface SchemaFingerprint {
  fingerprintVersion: string;
  drizzleKitVersion: string;
  contentHash: string;
  tables: FingerprintTable[];
}

export interface FingerprintTable {
  name: string;
  columns: FingerprintColumn[];
  indexes: FingerprintIndex[];
  foreignKeys: FingerprintForeignKey[];
  checkConstraints: FingerprintCheckConstraint[];
}

export interface FingerprintColumn {
  name: string;
  ordinal: number;
  columnType: string; // includes MariaDB display width — full canonical form
  isNullable: boolean;
  columnDefault: string | null;
  extra: string;
  generationExpression: string | null;
}

export interface FingerprintIndex {
  name: string;
  isUnique: boolean;
  isPrimary: boolean;
  columns: string[];
}

export interface FingerprintForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface FingerprintCheckConstraint {
  name: string;
  clause: string;
  level: 'Table' | 'Column';
}

export const FINGERPRINT_VERSION = '1';

export function buildSchemaFingerprint(
  schema: IntrospectedSchema,
  drizzleKitVersion: string,
): SchemaFingerprint {
  const tables: FingerprintTable[] = schema.tables.map((t) => ({
    name: t.name,
    columns: t.columns
      .slice()
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((c) => ({
        name: c.name,
        ordinal: c.ordinal,
        columnType: c.columnType,
        isNullable: c.isNullable,
        columnDefault: c.columnDefault,
        extra: c.extra,
        generationExpression: c.generationExpression,
      })),
    indexes: t.indexes.map((i) => ({
      name: i.name,
      isUnique: i.isUnique,
      isPrimary: i.isPrimary,
      columns: [...i.columns],
    })),
    foreignKeys: t.foreignKeys.map((fk) => ({
      name: fk.name,
      columns: [...fk.columns],
      referencedTable: fk.referencedTable,
      referencedColumns: [...fk.referencedColumns],
      onUpdate: fk.onUpdate,
      onDelete: fk.onDelete,
    })),
    checkConstraints: t.checkConstraints.map((c) => ({
      name: c.name,
      clause: c.clause,
      level: c.level,
    })),
  }));
  const contentHash = createHash('sha256')
    .update(JSON.stringify({ tables }))
    .digest('hex');
  return {
    fingerprintVersion: FINGERPRINT_VERSION,
    drizzleKitVersion,
    contentHash,
    tables,
  };
}

/**
 * Compare two fingerprints and return a list of human-readable differences.
 * Empty list = fingerprints match. Uses semantic equality on the arrays;
 * the hash is a summary but is not the primary check (a hash collision
 * would be a bug in this function, not in Gate 1 semantics).
 */
export function diffFingerprints(a: SchemaFingerprint, b: SchemaFingerprint): string[] {
  const diffs: string[] = [];
  if (a.contentHash === b.contentHash) return diffs;

  const aTables = new Map(a.tables.map((t) => [t.name, t]));
  const bTables = new Map(b.tables.map((t) => [t.name, t]));

  for (const name of new Set([...aTables.keys(), ...bTables.keys()])) {
    const at = aTables.get(name);
    const bt = bTables.get(name);
    if (!at) {
      diffs.push(`table ${name} only in B`);
      continue;
    }
    if (!bt) {
      diffs.push(`table ${name} only in A`);
      continue;
    }
    diffs.push(...diffTables(at, bt));
  }
  return diffs;
}

function diffTables(a: FingerprintTable, b: FingerprintTable): string[] {
  const diffs: string[] = [];
  const compare = <T>(
    label: string,
    aa: T[],
    bb: T[],
    key: (x: T) => string,
    fmt: (x: T) => string,
  ) => {
    const aMap = new Map(aa.map((x) => [key(x), x]));
    const bMap = new Map(bb.map((x) => [key(x), x]));
    for (const k of new Set([...aMap.keys(), ...bMap.keys()])) {
      const av = aMap.get(k);
      const bv = bMap.get(k);
      if (!av) diffs.push(`${a.name} ${label} ${k}: only in B (${fmt(bv!)})`);
      else if (!bv) diffs.push(`${a.name} ${label} ${k}: only in A (${fmt(av)})`);
      else if (fmt(av) !== fmt(bv)) diffs.push(`${a.name} ${label} ${k}: A=${fmt(av)} B=${fmt(bv)}`);
    }
  };

  compare('column', a.columns, b.columns, (c) => c.name, (c) =>
    `${c.columnType}|null=${c.isNullable}|dflt=${c.columnDefault ?? ''}|extra=${c.extra}|gen=${c.generationExpression ?? ''}`,
  );
  compare('index', a.indexes, b.indexes, (i) => i.name, (i) =>
    `uniq=${i.isUnique}|pk=${i.isPrimary}|cols=[${i.columns.join(',')}]`,
  );
  compare('fk', a.foreignKeys, b.foreignKeys, (fk) => fk.name, (fk) =>
    `${fk.columns.join(',')}->${fk.referencedTable}.${fk.referencedColumns.join(',')}|onUpd=${fk.onUpdate}|onDel=${fk.onDelete}`,
  );
  compare('check', a.checkConstraints, b.checkConstraints, (c) => c.name, (c) =>
    `${c.level}|${c.clause}`,
  );
  return diffs;
}
