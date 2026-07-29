/**
 * Stage 4 §S4.2 — fail-closed redaction rules + coverage.
 *
 * The wrapper's guarantees the DB uniqueness contract depends on:
 *   - deterministic (same input → same output, same
 *     redactionsApplied);
 *   - fail-closed on unknown value types;
 *   - key-suffix rules fire regardless of value shape;
 *   - value-shape rules fire on every string in the payload;
 *   - allowlist paths survive suffix drops but not value scrubs.
 *
 * Negative-space guardrails: intentionally-planted secrets in the
 * input MUST NOT appear anywhere in the redacted output.
 */
import { describe, expect, it } from 'vitest';
import { redact, FORBIDDEN_KEY_SUFFIXES, VALUE_RULES } from '../src/reports/redact';

describe('redact — key-suffix rules', () => {
  it('drops top-level password', () => {
    const r = redact({ user: 'op', password: 'hunter2' });
    expect(r.redactedPayload).toEqual({ user: 'op' });
    expect(r.redactionsApplied).toEqual(['key:password#password']);
  });

  it('drops nested passwordHash', () => {
    const r = redact({ auth: { username: 'op', passwordHash: 'abc' } });
    expect(r.redactedPayload).toEqual({ auth: { username: 'op' } });
    expect(r.redactionsApplied).toEqual(['key:auth.passwordHash#passwordhash']);
  });

  it('drops session/refresh/access token keys', () => {
    const r = redact({
      auth: {
        sessionId: 'sid',
        accessToken: 'at',
        refreshToken: 'rt',
        bootstrapToken: 'bt',
        apiKey: 'ak',
        apiSecret: 'as',
        nonce: 'n',
      },
    });
    expect(Object.keys(r.redactedPayload as Record<string, unknown>).length).toBe(1);
    expect((r.redactedPayload as { auth: Record<string, unknown> }).auth).toEqual({});
    expect(r.redactionsApplied.length).toBe(7);
  });

  it('is case-insensitive on the key', () => {
    const r = redact({ ApiKey: 'x', PASSWORD: 'y', RefreshToken: 'z' });
    expect(r.redactedPayload).toEqual({});
    expect(r.redactionsApplied.length).toBe(3);
  });

  it('matches key SUFFIX (bootstrapToken, adminPassword, mySecret)', () => {
    const r = redact({ bootstrapToken: 'b', adminPassword: 'a', mySecret: 's' });
    expect(r.redactedPayload).toEqual({});
    expect(r.redactionsApplied.length).toBe(3);
  });

  it('pathAllowlist survives suffix drops', () => {
    // checksumSha256 is a public artifact identifier — allow it
    // through even though it ends in "sha256" (not a forbidden
    // suffix, but useful sanity check that allowlist plumbing works).
    const r = redact(
      { artifact: { checksumSha256: 'aa', accessToken: 'x' } },
      { pathAllowlist: ['artifact.checksumsha256'] },
    );
    expect(r.redactedPayload).toEqual({ artifact: { checksumSha256: 'aa' } });
    expect(r.redactionsApplied).toEqual(['key:artifact.accessToken#accesstoken']);
  });

  it('allowlist path must include full dotted key (lowercased match)', () => {
    // Without an allowlist entry, a key ending in 'token' is dropped.
    const r = redact(
      { pub: { csrfToken: 'x' } },
      { pathAllowlist: ['pub.csrftoken'] },
    );
    expect(r.redactedPayload).toEqual({ pub: { csrfToken: 'x' } });
  });
});

describe('redact — value-shape rules', () => {
  it('scrubs Bearer tokens', () => {
    const r = redact({ hdr: 'Authorization: Bearer AbCd1234567890XyZ' });
    expect(r.redactedPayload).toEqual({ hdr: 'authorization=<REDACTED>' });
    // Both authorization_header (which matched first) and bearer_token
    // would apply, but the header rule consumed the substring first.
    expect(r.redactionsApplied.some((s) => s.includes('authorization_header'))).toBe(true);
  });

  it('scrubs bearer token when written alone', () => {
    const r = redact({ msg: 'Bearer ThisIsA20CharToken1234' });
    expect(r.redactedPayload).toEqual({ msg: 'Bearer <REDACTED>' });
    expect(r.redactionsApplied.some((s) => s.includes('bearer_token'))).toBe(true);
  });

  it('scrubs hex secrets ≥32 chars', () => {
    const r = redact({ blob: 'aa11bb22cc33dd44ee55ff66aa11bb22' });
    expect((r.redactedPayload as { blob: string }).blob).toBe('<HEX_REDACTED>');
  });

  it('does not scrub short hex (< 32 chars)', () => {
    const r = redact({ id: 'abc123def456' });
    expect((r.redactedPayload as { id: string }).id).toBe('abc123def456');
    expect(r.redactionsApplied).toEqual([]);
  });

  it('scrubs password=... kv pairs embedded in error messages', () => {
    const r = redact({ err: 'connection failed at password=hunter2 host=x' });
    expect((r.redactedPayload as { err: string }).err).toContain('password=<REDACTED>');
    expect((r.redactedPayload as { err: string }).err).not.toContain('hunter2');
  });

  it('scrubs token=... kv pairs', () => {
    const r = redact({ url: 'https://x/y?token=abcdefg12345&user=op' });
    expect((r.redactedPayload as { url: string }).url).toContain('token=<REDACTED>');
    expect((r.redactedPayload as { url: string }).url).not.toContain('abcdefg12345');
  });

  it('scrubs authorization=... kv pairs', () => {
    const r = redact({ log: 'req: authorization=Bearer xxx status=200' });
    expect((r.redactedPayload as { log: string }).log).toContain('authorization=<REDACTED>');
  });

  it('records each value-rule that fires per path', () => {
    const r = redact({
      lines: [
        'password=hunter2',
        'token=abcdef',
        'Bearer LongEnoughTokenXX1234',
      ],
    });
    expect(r.redactionsApplied.filter((s) => s.startsWith('value:')).length).toBeGreaterThanOrEqual(3);
  });
});

describe('redact — negative-space (planted secrets never appear in output)', () => {
  it('planted secrets are gone from JSON stringify of the output', () => {
    const secrets = [
      'hunter2',
      'AbCd1234567890XyZ_bearer',
      '0123456789abcdef0123456789abcdef',
      'sk-supersecretapikey12345678',
    ];
    const r = redact({
      hdr: 'Authorization: Bearer AbCd1234567890XyZ_bearer',
      err: 'password=hunter2 something',
      blob: '0123456789abcdef0123456789abcdef',
      auth: { apiKey: 'sk-supersecretapikey12345678' },
    });
    const dump = JSON.stringify(r.redactedPayload);
    for (const s of secrets) {
      expect(dump).not.toContain(s);
    }
  });
});

describe('redact — fail-closed on unknown types', () => {
  it('drops functions and records the drop', () => {
    const r = redact({ x: 1, callback: () => 42 } as unknown);
    expect((r.redactedPayload as { x: number }).x).toBe(1);
    expect(r.redactionsApplied.some((s) => s.startsWith('unknown_type:callback'))).toBe(true);
  });

  it('drops symbols', () => {
    const s = Symbol('foo');
    const r = redact({ sym: s });
    expect((r.redactedPayload as Record<string, unknown>).sym).toBeNull();
    expect(r.redactionsApplied.some((rr) => rr.startsWith('unknown_type:sym'))).toBe(true);
  });
});

describe('redact — determinism', () => {
  it('same input → identical redactedPayload and redactionsApplied', () => {
    const input = {
      auth: { password: 'p', apiKey: 'k' },
      msg: 'Bearer AbCd1234567890XyZLongToken',
    };
    const a = redact(input);
    const b = redact(input);
    expect(a.redactedPayload).toEqual(b.redactedPayload);
    expect(a.redactionsApplied).toEqual(b.redactionsApplied);
  });

  it('key insertion order in input does not change output', () => {
    const inA = { auth: { password: 'p', apiKey: 'k', user: 'op' } };
    const inB = { auth: { user: 'op', apiKey: 'k', password: 'p' } };
    const a = redact(inA);
    const b = redact(inB);
    expect(JSON.stringify(a.redactedPayload)).toBe(JSON.stringify(b.redactedPayload));
    expect(a.redactionsApplied).toEqual(b.redactionsApplied);
  });

  it('redactionsApplied is sorted', () => {
    const r = redact({
      b: { password: 'x' },
      a: { apiKey: 'y' },
    });
    const sorted = [...r.redactionsApplied].sort();
    expect(r.redactionsApplied).toEqual(sorted);
  });
});

describe('redact — rule catalogue coverage', () => {
  it('exports FORBIDDEN_KEY_SUFFIXES', () => {
    expect(FORBIDDEN_KEY_SUFFIXES.length).toBeGreaterThan(8);
    expect(FORBIDDEN_KEY_SUFFIXES).toContain('password');
    expect(FORBIDDEN_KEY_SUFFIXES).toContain('token');
    expect(FORBIDDEN_KEY_SUFFIXES).toContain('secret');
  });

  it('exports VALUE_RULES with a label + regex + replacement each', () => {
    expect(VALUE_RULES.length).toBeGreaterThan(3);
    for (const r of VALUE_RULES) {
      expect(r.label).toBeTypeOf('string');
      expect(r.regex).toBeInstanceOf(RegExp);
      expect(r.replacement).toBeTypeOf('string');
    }
  });
});
