/**
 * Stage 4 §S4.1c — serializer determinism + format checksum
 * distinctness.
 *
 * Covers the Stage 4 exit criterion "JSON, CSV, and HTML
 * serialization pass" and "format-specific checksums are verified".
 * Every format's bytes MUST be deterministic — same envelope +
 * sections → same bytes → same sha256.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CanonicalReportEnvelope } from '@horizon/shared';
import { REPORT_SPEC_VERSIONS } from '@horizon/shared';
import {
  serializeCsv,
  serializeHtml,
  serializeJson,
  type ReportSerializationInput,
  type CsvSection,
} from '../src/reports/serialize';

function sha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function makeInput(): ReportSerializationInput<'safety_status'> {
  const envelope: CanonicalReportEnvelope<'safety_status'> = {
    reportKind: 'safety_status',
    reportSpecVersion: REPORT_SPEC_VERSIONS.safety_status,
    sourceHighWaterMark: { safety: 100 },
    sourceQueryVersions: ['safety.v1'],
    redactionsApplied: [],
    payload: {
      DRY_RUN: true,
      ORDER_SUBMISSION_ENABLED: false,
      liveCapitalAuthorized: false,
      championVersion: 'observed',
    },
  };
  const csvSections: CsvSection[] = [
    {
      title: 'Safe flags',
      columns: ['flag', 'value'],
      rows: [
        ['DRY_RUN', 'true'],
        ['ORDER_SUBMISSION_ENABLED', 'false'],
        ['liveCapitalAuthorized', 'false'],
      ],
    },
  ];
  return {
    envelope,
    humanReadableTitle: 'Safety status · safety_status.v1',
    csvSections,
  };
}

describe('serializeJson — determinism', () => {
  it('produces byte-identical bytes across two calls', () => {
    const a = serializeJson(makeInput());
    const b = serializeJson(makeInput());
    expect(a).toBe(b);
    expect(sha(a)).toBe(sha(b));
  });

  it('output is valid JSON', () => {
    const s = serializeJson(makeInput());
    expect(() => JSON.parse(s)).not.toThrow();
  });

  it('emits key-sorted objects (canonicalStringify base)', () => {
    // Pretty-print output still starts with sorted keys.
    const s = serializeJson(makeInput());
    // First non-brace non-newline non-space char sequence should
    // begin with "payload" (alphabetically first? no — order is
    // "payload", "redactionsApplied", "reportKind", ...).
    const parsed = JSON.parse(s) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });
});

describe('serializeCsv — determinism + shape', () => {
  it('same input → same bytes', () => {
    const a = serializeCsv(makeInput());
    const b = serializeCsv(makeInput());
    expect(a).toBe(b);
  });

  it('starts with a `#` header carrying kind + spec version', () => {
    const s = serializeCsv(makeInput());
    expect(s.startsWith('# horizon report v1 · safety_status · safety_status.v1\n')).toBe(true);
  });

  it('contains an envelope metadata section with sourceHighWaterMark (CSV-escaped)', () => {
    const s = serializeCsv(makeInput());
    expect(s).toContain('## envelope');
    expect(s).toContain('sourceHighWaterMark');
    // sourceHighWaterMark value {"safety":100} contains a quote, so
    // csvCell RFC-4180-escapes it (double-quote quotes, wrap in
    // outer quotes). Assert on the escaped form.
    expect(s).toContain('"{""safety"":100}"');
  });

  it('escapes commas + quotes per RFC-4180', () => {
    const input = makeInput();
    const scary: CsvSection = {
      title: 'Escapes',
      columns: ['field', 'value'],
      rows: [
        ['comma', 'a,b'],
        ['quote', 'has "quotes"'],
        ['newline', 'line1\nline2'],
      ],
    };
    const s = serializeCsv({ ...input, csvSections: [scary] });
    expect(s).toContain('"a,b"');
    expect(s).toContain('"has ""quotes"""');
    expect(s).toContain('"line1\nline2"');
  });
});

describe('serializeHtml — determinism + XSS-safety', () => {
  it('same input → same bytes', () => {
    const a = serializeHtml(makeInput());
    const b = serializeHtml(makeInput());
    expect(a).toBe(b);
  });

  it('has no <script> tags', () => {
    const s = serializeHtml(makeInput());
    expect(s.toLowerCase()).not.toContain('<script');
  });

  it('escapes < > & " in the payload title', () => {
    const input = makeInput();
    const s = serializeHtml({ ...input, humanReadableTitle: '<h1>xss</h1> & "quotes"' });
    expect(s).not.toContain('<h1>xss</h1>');
    expect(s).toContain('&lt;h1&gt;xss&lt;/h1&gt; &amp; &quot;quotes&quot;');
  });

  it('escapes cell contents that contain < > &', () => {
    const input = makeInput();
    const scary: CsvSection = {
      title: 'x',
      columns: ['field', 'value'],
      rows: [['injection', '<img src=x onerror=alert(1)>']],
    };
    const s = serializeHtml({ ...input, csvSections: [scary] });
    expect(s).not.toContain('<img src=x onerror=alert(1)>');
    expect(s).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('contains the DRY_RUN banner (safety marker on every artifact)', () => {
    const s = serializeHtml(makeInput());
    expect(s).toContain('DRY_RUN');
  });

  it('renders the canonical envelope pre block', () => {
    const s = serializeHtml(makeInput());
    expect(s).toContain('Canonical envelope');
    expect(s).toContain('&quot;reportKind&quot;');
    expect(s).toContain('safety_status');
  });
});

describe('cross-format — checksums are distinct while contentDigest is shared', () => {
  it('three formats produce three different sha256 checksums for the same envelope', () => {
    const input = makeInput();
    const j = sha(serializeJson(input));
    const c = sha(serializeCsv(input));
    const h = sha(serializeHtml(input));
    expect(j).not.toBe(c);
    expect(c).not.toBe(h);
    expect(h).not.toBe(j);
    // All 64-hex.
    for (const x of [j, c, h]) expect(x).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changing the payload changes JSON + HTML checksums (CSV is driven by csvSections)', () => {
    const inputA = makeInput();
    const inputB = {
      ...inputA,
      envelope: { ...inputA.envelope, payload: { ...(inputA.envelope.payload as object), extra: 1 } as unknown },
    };
    expect(sha(serializeJson(inputA))).not.toBe(sha(serializeJson(inputB)));
    expect(sha(serializeHtml(inputA))).not.toBe(sha(serializeHtml(inputB)));
    // CSV is intentionally driven by the generator's tabular projection
    // (csvSections), not by the raw payload — a payload-only change
    // that isn't reflected in csvSections MUST NOT invalidate the CSV
    // artifact. The Stage 4 verify contract distinguishes contentDigest
    // (data identity) from checksumSha256 (byte identity).
    expect(sha(serializeCsv(inputA))).toBe(sha(serializeCsv(inputB)));
  });

  it('changing csvSections changes CSV checksum', () => {
    const inputA = makeInput();
    const inputB = {
      ...inputA,
      csvSections: [{
        title: 'Different',
        columns: ['a', 'b'],
        rows: [['x', 'y']],
      }],
    };
    expect(sha(serializeCsv(inputA))).not.toBe(sha(serializeCsv(inputB)));
  });

  it('changing sourceHighWaterMark changes all three checksums', () => {
    const inputA = makeInput();
    const inputB = {
      ...inputA,
      envelope: { ...inputA.envelope, sourceHighWaterMark: { safety: 999 } },
    };
    expect(sha(serializeJson(inputA))).not.toBe(sha(serializeJson(inputB)));
    expect(sha(serializeCsv(inputA))).not.toBe(sha(serializeCsv(inputB)));
    expect(sha(serializeHtml(inputA))).not.toBe(sha(serializeHtml(inputB)));
  });
});
