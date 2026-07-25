/**
 * Byte-stable JSON serialization (Phase 1.1 Gate 1).
 *
 * Drizzle-kit snapshots are checked into the repository and diffed by CI.
 * The reconstruction tool must produce byte-identical output on every run
 * so `git diff` and drift-detection tests never spuriously trigger. That
 * requires:
 *   - Deterministic key ordering
 *   - Deterministic array ordering (preserved from the source; do NOT
 *     re-sort arrays whose element order carries meaning, e.g. index
 *     column order)
 *   - Two-space indentation matching drizzle-kit's own writer
 *   - Newline-terminated file
 *
 * Object keys ARE sorted lexicographically here because drizzle-kit's
 * own writer serializes objects in an insertion-ordered manner that we
 * cannot reproduce from JS objects (property enumeration order depends
 * on how the object was constructed). Since the KEYS themselves are the
 * schema element names and drizzle-kit accepts any key order at read
 * time, alphabetical is safe and stable.
 *
 * WARNING: drizzle-kit's OWN writer does NOT sort keys — its output is
 * insertion-order-dependent. Our reconstruction output will not be
 * byte-identical to a drizzle-kit-produced snapshot, but IT WILL be
 * byte-identical across our own re-runs. The Gate 1 validation step
 * relies on drizzle-kit CONSUMING our snapshot cleanly (semantic
 * equality), not on it being byte-identical to a drizzle-kit-produced
 * one. If drizzle-kit ever refuses to consume our snapshot format, that
 * is the "false diff" the user's hard-fallback rule addresses — stop
 * for review, do not commit.
 */

/**
 * Serialize `value` to a byte-stable JSON string.
 *
 * `preserveArrays` is the array of dot-paths whose array elements MUST
 * remain in their original order (e.g. `tables.*.indexes.*.columns` —
 * an index on (a,b) is a different index from one on (b,a)). Every
 * OTHER array is left as-is; no re-sorting.
 */
export function canonicalStringify(value: unknown): string {
  return stringify(value, 0) + '\n';
}

function stringify(v: unknown, indent: number): string {
  if (v === null) return 'null';
  if (v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite number: ${v}`);
    return String(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return stringifyArray(v, indent);
  if (typeof v === 'object') return stringifyObject(v as Record<string, unknown>, indent);
  throw new Error(`unsupported value type: ${typeof v}`);
}

function stringifyArray(a: unknown[], indent: number): string {
  if (a.length === 0) return '[]';
  const inner = indent + 1;
  const pad = '  '.repeat(inner);
  const outerPad = '  '.repeat(indent);
  const parts = a.map((x) => pad + stringify(x, inner));
  return '[\n' + parts.join(',\n') + '\n' + outerPad + ']';
}

function stringifyObject(o: Record<string, unknown>, indent: number): string {
  const keys = Object.keys(o);
  if (keys.length === 0) return '{}';
  // Sort keys lexicographically for byte stability across re-runs.
  keys.sort();
  const inner = indent + 1;
  const pad = '  '.repeat(inner);
  const outerPad = '  '.repeat(indent);
  const parts = keys.map((k) => pad + JSON.stringify(k) + ': ' + stringify(o[k], inner));
  return '{\n' + parts.join(',\n') + '\n' + outerPad + '}';
}
