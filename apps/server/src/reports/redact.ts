/**
 * Stage 4 §S4.2 — fail-closed redaction wrapper.
 *
 * Every generator MUST pass its raw payload through `redact(...)`
 * BEFORE the payload becomes part of a canonical envelope. The
 * wrapper walks the payload in a single deterministic pass and:
 *
 *   1. Scrubs value-shaped secrets by regex (Bearer tokens, 32+-char
 *      hex, base64 blobs, `password:`/`token:`/`authorization:`
 *      key-value pairs embedded in strings).
 *   2. Removes keys whose name matches the forbidden path rule
 *      (case-insensitive suffix match on `password`, `passwordHash`,
 *      `token`, `refreshToken`, `accessToken`, `apiKey`, `apiSecret`,
 *      `sessionId`, `bootstrapToken`, `nonce`, `secret`) unless the
 *      caller's per-kind allowlist explicitly permits that path.
 *
 * The wrapper is FAIL-CLOSED — anything it cannot classify is
 * treated as sensitive: unknown-shaped strings that look like keys
 * are redacted; unknown paths that match a forbidden suffix are
 * dropped even without a regex match on the value.
 *
 * Returns a `{redactedPayload, redactionsApplied}` pair. Callers
 * store `redactionsApplied` on `desktop_export_artifacts.
 * redactionsApplied` byte-for-byte so an auditor can rebuild the
 * exact rule-application trace.
 *
 * Determinism guarantees:
 *   - Same input → same output byte-for-byte (used inside
 *     contentDigest via composeContentCanonicalPayload).
 *   - `redactionsApplied` is sorted before return.
 *   - Insertion order of the input object does not change the
 *     order of items in `redactionsApplied`.
 */

// ---------------------------------------------------------------------------
// Rule catalogue
// ---------------------------------------------------------------------------

/**
 * Forbidden path suffixes (case-insensitive). Any object key whose
 * lowercased suffix matches one of these is dropped unless the
 * caller's per-kind allowlist includes the full path.
 */
/**
 * Order matters: `find` returns the first match, and we want the
 * MOST specific suffix reported in `redactionsApplied` for audit
 * clarity ("apiKey#apikey" is more useful than "apiKey#key").
 * More-specific rules therefore come first.
 */
export const FORBIDDEN_KEY_SUFFIXES: readonly string[] = [
  'passwordsalthex',
  'passwordhash',
  'password',
  'bootstraptoken',
  'refreshtoken',
  'accesstoken',
  'apisecret',
  'apikey',
  'sessionid',
  'nonce',
  'secret',
  'token',
];

/**
 * Value-shape regexes. Applied to every string emitted anywhere in
 * the payload. Ordering matters — earlier rules run first; the
 * first rule that matches records its label and replaces the value.
 */
export interface ValueRule {
  readonly label: string;
  readonly regex: RegExp;
  readonly replacement: string;
}

export const VALUE_RULES: readonly ValueRule[] = [
  {
    label: 'bearer_token',
    regex: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    replacement: 'Bearer <REDACTED>',
  },
  {
    // Consumes both `Authorization: <scheme> <token>` and the bare
    // `authorization=<token>` form. The `(?:Bearer\s+)?` allows the
    // full header + Bearer scheme + token to be redacted as one
    // unit — otherwise the trailing token would survive because it
    // no longer sits next to the word "Bearer" after the header
    // replacement.
    label: 'authorization_header',
    regex: /authorization[=:]\s*(?:Bearer\s+)?[^\s"&,;]+/gi,
    replacement: 'authorization=<REDACTED>',
  },
  {
    label: 'password_kv',
    regex: /password[=:]\s*[^\s"&,;]+/gi,
    replacement: 'password=<REDACTED>',
  },
  {
    label: 'token_kv',
    regex: /token[=:]\s*[^\s"&,;]+/gi,
    replacement: 'token=<REDACTED>',
  },
  {
    label: 'hex_secret',
    regex: /(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])/g,
    replacement: '<HEX_REDACTED>',
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RedactionOptions {
  /**
   * Full paths (`"a.b.c"`) that survive even if their key matches
   * `FORBIDDEN_KEY_SUFFIXES`. Used only where the schema demands a
   * public hash-shaped identifier — e.g. `checksumSha256` is a
   * public content-address, not a secret.
   */
  readonly pathAllowlist?: readonly string[];
}

export interface RedactionResult {
  readonly redactedPayload: unknown;
  /**
   * Sorted list of applied rules. Format: `key:<path>` for path
   * drops, `value:<label>@<path>` for value scrubs.
   */
  readonly redactionsApplied: readonly string[];
}

export function redact(input: unknown, opts: RedactionOptions = {}): RedactionResult {
  const allow = new Set((opts.pathAllowlist ?? []).map((p) => p.toLowerCase()));
  const applied: string[] = [];
  const out = walk(input, '', allow, applied);
  applied.sort();
  return { redactedPayload: out, redactionsApplied: applied };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function walk(v: unknown, path: string, allow: ReadonlySet<string>, applied: string[]): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'boolean' || typeof v === 'number') return v;
  if (typeof v === 'string') return scrubString(v, path, applied);
  if (Array.isArray(v)) {
    return v.map((item, i) => walk(item, `${path}[${i}]`, allow, applied));
  }
  if (typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec)) {
      const childPath = path === '' ? k : `${path}.${k}`;
      const lowerKey = k.toLowerCase();
      const lowerPath = childPath.toLowerCase();
      const forbiddenSuffix = FORBIDDEN_KEY_SUFFIXES.find((s) => lowerKey.endsWith(s));
      if (forbiddenSuffix && !allow.has(lowerPath)) {
        applied.push(`key:${childPath}#${forbiddenSuffix}`);
        continue; // drop the key entirely
      }
      out[k] = walk(rec[k], childPath, allow, applied);
    }
    return out;
  }
  // Fail-closed: unknown types (functions, symbols, class instances,
  // bigint) get dropped and the drop is recorded.
  applied.push(`unknown_type:${path}#${typeof v}`);
  return null;
}

function scrubString(s: string, path: string, applied: string[]): string {
  let out = s;
  for (const rule of VALUE_RULES) {
    // Reset lastIndex for global regexes so multi-call runs stay
    // deterministic (regex objects are shared module state).
    rule.regex.lastIndex = 0;
    if (rule.regex.test(out)) {
      rule.regex.lastIndex = 0;
      out = out.replace(rule.regex, rule.replacement);
      applied.push(`value:${rule.label}@${path === '' ? '<root>' : path}`);
    }
  }
  return out;
}
