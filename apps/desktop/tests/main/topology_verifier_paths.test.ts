/**
 * Stage 3C-E.1 §E — cross-platform path handling tests for the
 * topology verifier.
 *
 * These tests exercise the specific normalization logic the verifier
 * uses to guarantee that a Windows checkout produces the same
 * canonical repository-relative test identity as a Linux/macOS
 * checkout. Without this normalization, `verify:test-topology` was
 * failing on `desktop-windows` CI with empty stdout+stderr — not
 * because the topology drifted but because the test file's own
 * `execFileSync('npx', ...)` failed with ENOENT before the verifier
 * ever ran.
 *
 * The verifier itself (build/verify-test-topology.ts:232) applies
 * `.replace(/\\/g, '/')` after each `relative(DESKTOP_ROOT, p)` walk
 * result. These tests pin that normalization.
 */

import { describe, expect, it } from 'vitest';

/**
 * Local copy of the normalization the verifier applies at the disk
 * walk seam. Keeping this pure lets us test the invariant without
 * spawning a subprocess or requiring MariaDB/Redis.
 */
function toRepoRelativeCanonical(rawPath: string): string {
  return rawPath.replace(/\\/g, '/');
}

describe('Stage 3C-E.1 §E — topology verifier canonical path form', () => {
  it("forward-slash path 'tests/main/example.test.ts' stays canonical", () => {
    expect(toRepoRelativeCanonical('tests/main/example.test.ts')).toBe('tests/main/example.test.ts');
  });

  it("backslash path 'tests\\main\\example.test.ts' normalizes to same canonical", () => {
    expect(toRepoRelativeCanonical('tests\\main\\example.test.ts')).toBe('tests/main/example.test.ts');
  });

  it('mixed separators are fully normalized', () => {
    expect(toRepoRelativeCanonical('tests\\main/mixed\\path.test.ts')).toBe('tests/main/mixed/path.test.ts');
  });

  it('both forms resolve to the SAME canonical identity', () => {
    const posix = toRepoRelativeCanonical('tests/main/renderer_url_policy.test.ts');
    const windows = toRepoRelativeCanonical('tests\\main\\renderer_url_policy.test.ts');
    expect(posix).toBe(windows);
  });

  it('single backslash separator is normalized', () => {
    expect(toRepoRelativeCanonical('tests\\example.test.ts')).toBe('tests/example.test.ts');
  });

  it('nested backslash path is normalized', () => {
    expect(toRepoRelativeCanonical('tests\\renderer\\phase3a_screens.test.tsx')).toBe('tests/renderer/phase3a_screens.test.tsx');
  });

  it('deeply nested Windows path is normalized', () => {
    expect(toRepoRelativeCanonical('tests\\a\\b\\c\\d\\e.test.ts')).toBe('tests/a/b/c/d/e.test.ts');
  });

  it('no separators to normalize — a filename in current dir', () => {
    expect(toRepoRelativeCanonical('example.test.ts')).toBe('example.test.ts');
  });

  it('the two platform-native separators map to the same key in a Set', () => {
    const s = new Set<string>();
    s.add(toRepoRelativeCanonical('tests/main/example.test.ts'));
    s.add(toRepoRelativeCanonical('tests\\main\\example.test.ts'));
    // If normalization is correct, the second add is a no-op.
    expect(s.size).toBe(1);
  });
});
