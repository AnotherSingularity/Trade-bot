/**
 * Stage 4 §S4C — pure worker helpers.
 *
 * Covers the small pure functions the enqueue path relies on:
 *   * `sanitizeError` — must strip credential-shaped substrings
 *     before storing them in `desktop_export_jobs.failureReason`.
 *   * `makeFilename` — deterministic; same (kind, spec, digest,
 *     format) → same name across processes.
 *
 * The full DB-driven enqueue lifecycle (idempotency, concurrency,
 * recovery, path validation integration) is exercised by the
 * mandatory `stage4c-worker.db.test.ts` suite against real MariaDB.
 */
import { describe, expect, it } from 'vitest';
import { makeFilename, sanitizeError } from '../src/reports/worker';

describe('sanitizeError — credential scrubbing', () => {
  it('scrubs bearer tokens from generator crash messages', () => {
    const err = new Error('connection failed with Authorization: Bearer AbCd1234567890XyZ header');
    const scrubbed = sanitizeError(err);
    expect(scrubbed).not.toContain('AbCd1234567890XyZ');
    expect(scrubbed).toContain('<REDACTED>');
  });

  it('scrubs password=... key-value pairs', () => {
    const err = new Error('mysql error: could not connect password=hunter2 host=x');
    const scrubbed = sanitizeError(err);
    expect(scrubbed).not.toContain('hunter2');
    expect(scrubbed).toContain('password=<REDACTED>');
  });

  it('scrubs token=... query parameters', () => {
    const err = new Error('http 401 for https://example/x?token=abcdefg12345');
    const scrubbed = sanitizeError(err);
    expect(scrubbed).not.toContain('abcdefg12345');
    expect(scrubbed).toContain('token=<REDACTED>');
  });

  it('scrubs authorization= embedded in a longer error string', () => {
    const err = new Error('outbound rejected: request had authorization=Bearer secretxxx status=403');
    const scrubbed = sanitizeError(err);
    expect(scrubbed).toContain('authorization=<REDACTED>');
    expect(scrubbed).not.toContain('secretxxx');
  });

  it('clamps to 200 chars', () => {
    const err = new Error('x'.repeat(1000));
    expect(sanitizeError(err).length).toBe(200);
  });

  it('accepts non-Error values', () => {
    expect(sanitizeError('plain string')).toBe('plain string');
    expect(sanitizeError(null)).toBe('unknown_error');
    expect(sanitizeError(undefined)).toBe('unknown_error');
    expect(sanitizeError(42)).toBe('42');
  });
});

describe('makeFilename — deterministic naming', () => {
  it('same inputs → same filename', () => {
    const a = makeFilename('safety_status', 'safety_status.v1', 'a'.repeat(64), 'json');
    const b = makeFilename('safety_status', 'safety_status.v1', 'a'.repeat(64), 'json');
    expect(a).toBe(b);
  });

  it('extension matches format', () => {
    const digest = 'b'.repeat(64);
    expect(makeFilename('safety_status', 'safety_status.v1', digest, 'json')).toMatch(/\.json$/);
    expect(makeFilename('safety_status', 'safety_status.v1', digest, 'csv')).toMatch(/\.csv$/);
    expect(makeFilename('safety_status', 'safety_status.v1', digest, 'html')).toMatch(/\.html$/);
  });

  it('embeds the first 16 hex chars of contentDigest', () => {
    const digest = '0123456789abcdef' + '0'.repeat(48);
    const name = makeFilename('safety_status', 'safety_status.v1', digest, 'json');
    expect(name).toContain('0123456789abcdef');
    // Full digest MUST NOT be in the filename — path length + audit
    // clarity favor the short form. If a caller wants the full
    // digest they read it from `desktop_export_artifacts.contentDigest`.
    expect(name).not.toContain(digest);
  });

  it('scrubs unsafe chars from spec version', () => {
    const digest = 'c'.repeat(64);
    // A hypothetical mis-configured spec version with slashes gets
    // sanitised to underscores so the filename stays flat.
    const name = makeFilename('safety_status', 'safety/../v1', digest, 'json');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    expect(name).toContain('safety_');
  });

  it('different formats produce different filenames for the same digest', () => {
    const digest = 'd'.repeat(64);
    const j = makeFilename('safety_status', 'safety_status.v1', digest, 'json');
    const c = makeFilename('safety_status', 'safety_status.v1', digest, 'csv');
    const h = makeFilename('safety_status', 'safety_status.v1', digest, 'html');
    expect(new Set([j, c, h]).size).toBe(3);
  });
});
