/**
 * Stage 4 §S4.1c — deterministic report serializers.
 *
 * Three formats. Each is a pure function from
 * `ReportSerializationInput` to a UTF-8 string, deterministic given
 * the same input. Byte-identical inputs MUST produce byte-identical
 * outputs, so the format-specific checksum (`checksumSha256`) is
 * stable and re-runs are idempotent at both the digest and file
 * level.
 *
 * The three formats emit the SAME data (they share
 * `input.envelope.payload`) — their `contentDigest` (SHA256 of the
 * canonical envelope) is identical, and their `checksumSha256`
 * (SHA256 of the emitted bytes) differs only because the byte
 * encoding differs. That distinction is the Stage 4 verify contract:
 * `contentDigest` identifies the DATA; `checksumSha256` identifies
 * the ARTIFACT bytes.
 *
 * CSV consumes generator-supplied tabular sections rather than
 * mechanically flattening arbitrary JSON — the generator knows the
 * meaningful columns and their order; a flatten of a payload of
 * nested objects would produce an unreadable long-string column
 * for every non-leaf value.
 *
 * HTML is a fixed template with inline CSS. No <script> tags, no
 * external assets — an operator can open the file in any browser
 * without network access, and the artifact contains no code paths
 * that could execute.
 */

import type { CanonicalReportEnvelope, ReportKind } from '@horizon/shared';
import { canonicalStringify } from '@horizon/shared';

// ---------------------------------------------------------------------------
// Serializer input
// ---------------------------------------------------------------------------

export type CsvCell = string | number | boolean | null;

export interface CsvSection {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<ReadonlyArray<CsvCell>>;
}

export interface ReportSerializationInput<K extends ReportKind = ReportKind> {
  readonly envelope: CanonicalReportEnvelope<K>;
  /**
   * Human-readable title shown at the top of HTML + as the first
   * comment line of CSV. Not part of the canonical envelope, does
   * not affect contentDigest. Recommended: `<Report Kind> · <spec version>`.
   */
  readonly humanReadableTitle: string;
  /**
   * Generator-supplied tabular projection. Empty array is allowed —
   * the CSV output for that case is only the header comment plus
   * an "envelope-metadata" section.
   */
  readonly csvSections: readonly CsvSection[];
}

// ---------------------------------------------------------------------------
// JSON serializer
// ---------------------------------------------------------------------------

/**
 * Pretty-printed JSON of the canonical envelope. Uses
 * `canonicalStringify` under the hood then re-parses + re-emits
 * with 2-space indent so the output is human-readable while the
 * key order stays deterministic.
 */
export function serializeJson<K extends ReportKind>(input: ReportSerializationInput<K>): string {
  const canonical = canonicalStringify(input.envelope);
  const parsed = JSON.parse(canonical) as unknown;
  return JSON.stringify(parsed, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// CSV serializer (RFC-4180-ish, unquoted numeric cells, LF line endings)
// ---------------------------------------------------------------------------

const CSV_HEADER_PREFIX = '# horizon report v1';

/**
 * Emit a CSV document with:
 *   - a leading `#`-comment header carrying kind, spec version,
 *     content digest of the canonical envelope, and the title;
 *   - one section per generator-supplied `CsvSection`, prefixed
 *     with `## <title>` on its own line;
 *   - a final envelope-metadata section showing
 *     sourceHighWaterMark, sourceQueryVersions, redactionsApplied.
 *
 * Every cell is escaped per RFC-4180 (double-quote quotes + wrap in
 * quotes when a comma, quote, or newline is present). Line ending
 * is LF (deterministic across platforms).
 */
export function serializeCsv<K extends ReportKind>(input: ReportSerializationInput<K>): string {
  const lines: string[] = [];
  const env = input.envelope;
  lines.push(`${CSV_HEADER_PREFIX} · ${env.reportKind} · ${env.reportSpecVersion}`);
  lines.push(`# title: ${input.humanReadableTitle}`);
  for (const section of input.csvSections) {
    lines.push('');
    lines.push(`## ${section.title}`);
    lines.push(section.columns.map(csvCell).join(','));
    for (const row of section.rows) {
      lines.push(row.map(csvCell).join(','));
    }
  }
  // Envelope metadata section — always present, ensures every CSV
  // artifact carries the audit trail even if csvSections is empty.
  lines.push('');
  lines.push('## envelope');
  lines.push(csvCell('field') + ',' + csvCell('value'));
  lines.push(csvCell('reportKind') + ',' + csvCell(env.reportKind));
  lines.push(csvCell('reportSpecVersion') + ',' + csvCell(env.reportSpecVersion));
  lines.push(csvCell('sourceHighWaterMark') + ',' + csvCell(canonicalStringify(env.sourceHighWaterMark)));
  lines.push(csvCell('sourceQueryVersions') + ',' + csvCell([...env.sourceQueryVersions].sort().join('; ')));
  lines.push(csvCell('redactionsApplied') + ',' + csvCell([...env.redactionsApplied].sort().join('; ')));
  return lines.join('\n') + '\n';
}

function csvCell(v: CsvCell | string): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ---------------------------------------------------------------------------
// HTML serializer (fixed template, inline CSS, no scripts)
// ---------------------------------------------------------------------------

/**
 * Escape XML-significant characters. Fail-closed on control
 * characters (they become `&#xNN;`) so a malicious upstream string
 * cannot inject a `<` sequence or break out of an attribute.
 */
function htmlEscape(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x26) out += '&amp;';
    else if (c === 0x3c) out += '&lt;';
    else if (c === 0x3e) out += '&gt;';
    else if (c === 0x22) out += '&quot;';
    else if (c === 0x27) out += '&#x27;';
    else if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
      out += '&#x' + c.toString(16).padStart(2, '0') + ';';
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * Emit an HTML document. Fixed template, inline `<style>`, no
 * `<script>`, no remote assets. The body shows:
 *   1. title + kind + spec version;
 *   2. one `<table>` per generator-supplied `CsvSection` (headers +
 *      rows escaped per htmlEscape);
 *   3. envelope metadata table (source HWM, source query versions,
 *      redactions applied);
 *   4. a `<pre>` block with the pretty-printed canonical envelope
 *      so an operator can eyeball the exact bytes that participated
 *      in `contentDigest`.
 */
export function serializeHtml<K extends ReportKind>(input: ReportSerializationInput<K>): string {
  const env = input.envelope;
  const title = htmlEscape(input.humanReadableTitle);
  const sections = input.csvSections.map((s) => renderSection(s)).join('\n');
  const envelopeTable = renderEnvelopeMeta(env);
  const canonical = JSON.stringify(JSON.parse(canonicalStringify(env)), null, 2);
  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    `<meta charset="utf-8"><title>${title}</title>`,
    '<style>',
    'body{font-family:system-ui,sans-serif;margin:2rem;color:#1a1a1a;background:#fff;}',
    'h1{margin-bottom:0.25rem;} .meta{color:#555;font-size:0.9rem;}',
    'section{margin-top:2rem;} h2{border-bottom:1px solid #ccc;padding-bottom:0.25rem;}',
    'table{border-collapse:collapse;margin-top:0.75rem;font-size:0.9rem;}',
    'th,td{border:1px solid #ddd;padding:0.3rem 0.6rem;text-align:left;vertical-align:top;}',
    'th{background:#f5f5f5;} td.num{text-align:right;font-variant-numeric:tabular-nums;}',
    'pre{background:#f7f7f7;padding:1rem;overflow-x:auto;font-size:0.85rem;}',
    '.banner{background:#fff3cd;border:1px solid #ffe58f;padding:0.5rem 0.75rem;margin:1rem 0;color:#5a4400;}',
    '</style></head><body>',
    `<h1>${title}</h1>`,
    `<div class="meta">${htmlEscape(env.reportKind)} · ${htmlEscape(env.reportSpecVersion)}</div>`,
    '<div class="banner">DRY_RUN — this artifact reports desktop console state only. No trading authorization changes.</div>',
    sections,
    envelopeTable,
    '<section><h2>Canonical envelope (verbatim payload participating in contentDigest)</h2>',
    `<pre>${htmlEscape(canonical)}</pre></section>`,
    '</body></html>',
    '',
  ].join('\n');
}

function renderSection(s: CsvSection): string {
  const head = s.columns.map((c) => `<th>${htmlEscape(c)}</th>`).join('');
  const body = s.rows
    .map((row) => '<tr>' + row.map((cell) => `<td${typeof cell === 'number' ? ' class="num"' : ''}>${htmlEscape(cell === null ? '' : String(cell))}</td>`).join('') + '</tr>')
    .join('\n');
  return `<section><h2>${htmlEscape(s.title)}</h2><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
}

function renderEnvelopeMeta(env: CanonicalReportEnvelope): string {
  const rows: Array<[string, string]> = [
    ['reportKind', env.reportKind],
    ['reportSpecVersion', env.reportSpecVersion],
    ['sourceHighWaterMark', canonicalStringify(env.sourceHighWaterMark)],
    ['sourceQueryVersions', [...env.sourceQueryVersions].sort().join('; ')],
    ['redactionsApplied', [...env.redactionsApplied].sort().join('; ') || '(none)'],
  ];
  const body = rows.map(([k, v]) => `<tr><th>${htmlEscape(k)}</th><td>${htmlEscape(v)}</td></tr>`).join('');
  return `<section><h2>Envelope metadata</h2><table><tbody>${body}</tbody></table></section>`;
}
