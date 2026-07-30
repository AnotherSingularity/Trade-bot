/**
 * Correction 2 §image-digests — unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  formatImageReference,
  MANAGED_IMAGES,
  MANAGED_MARIADB,
  MANAGED_REDIS,
  verifyAllPinnedImages,
  verifyPinnedImage,
  type PinnedImage,
} from '../../src/main/managedRuntimeImageDigests';

describe('managed image digest registry', () => {
  it('MANAGED_IMAGES enumerates MariaDB and Redis', () => {
    expect(MANAGED_IMAGES).toHaveLength(2);
    expect(MANAGED_IMAGES).toContain(MANAGED_MARIADB);
    expect(MANAGED_IMAGES).toContain(MANAGED_REDIS);
  });

  it('MariaDB pin declares the LTS semantic version 10.11.6', () => {
    expect(MANAGED_MARIADB.repository).toBe('mariadb');
    expect(MANAGED_MARIADB.semanticVersion).toBe('10.11.6');
    expect(MANAGED_MARIADB.immutableDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('Redis pin declares the 7.4-alpine semantic version', () => {
    expect(MANAGED_REDIS.repository).toBe('redis');
    expect(MANAGED_REDIS.semanticVersion).toBe('7.4-alpine');
    expect(MANAGED_REDIS.immutableDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('verifyPinnedImage', () => {
  const goodDigest = 'sha256:' + '1'.repeat(64);
  const good: PinnedImage = {
    repository: 'mariadb',
    semanticVersion: '10.11.6',
    immutableDigest: goodDigest,
    placeholder: false,
  };

  it('accepts a well-formed non-placeholder pin', () => {
    expect(verifyPinnedImage(good).ok).toBe(true);
  });

  it('rejects a placeholder digest (production must pin real digests)', () => {
    const v = verifyPinnedImage(MANAGED_MARIADB);
    expect(v.ok).toBe(false);
    expect(v.failureCode).toBe('digest_placeholder');
  });

  it('rejects a placeholder-flagged pin even with a good-looking digest', () => {
    const v = verifyPinnedImage({ ...good, placeholder: true });
    expect(v.ok).toBe(false);
    expect(v.failureCode).toBe('digest_placeholder');
  });

  it('rejects a digest missing the sha256: prefix', () => {
    const v = verifyPinnedImage({ ...good, immutableDigest: '1'.repeat(64) });
    expect(v.ok).toBe(false);
    expect(v.failureCode).toBe('digest_shape_invalid');
  });

  it('rejects a digest with the wrong hex length', () => {
    const v = verifyPinnedImage({ ...good, immutableDigest: 'sha256:1' });
    expect(v.ok).toBe(false);
    expect(v.failureCode).toBe('digest_shape_invalid');
  });

  it('rejects an empty repository', () => {
    const v = verifyPinnedImage({ ...good, repository: '' });
    expect(v.ok).toBe(false);
    expect(v.failureCode).toBe('repository_missing');
  });

  it('rejects an empty semanticVersion', () => {
    const v = verifyPinnedImage({ ...good, semanticVersion: '' });
    expect(v.ok).toBe(false);
    expect(v.failureCode).toBe('semantic_version_missing');
  });
});

describe('verifyAllPinnedImages', () => {
  it('reports every current placeholder as a failure (production gate)', () => {
    const r = verifyAllPinnedImages();
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.image.repository).sort()).toEqual(['mariadb', 'redis']);
    for (const f of r.failures) {
      expect(f.verdict.failureCode).toBe('digest_placeholder');
    }
  });

  it('accepts a hypothetical set with real digests', () => {
    const real: PinnedImage[] = [
      { repository: 'mariadb', semanticVersion: '10.11.6', immutableDigest: 'sha256:' + 'a'.repeat(64), placeholder: false },
      { repository: 'redis', semanticVersion: '7.4-alpine', immutableDigest: 'sha256:' + 'b'.repeat(64), placeholder: false },
    ];
    expect(verifyAllPinnedImages(real).ok).toBe(true);
  });
});

describe('formatImageReference', () => {
  it('formats repository:semver@sha256:...', () => {
    const s = formatImageReference({
      repository: 'mariadb',
      semanticVersion: '10.11.6',
      immutableDigest: 'sha256:' + 'a'.repeat(64),
      placeholder: false,
    });
    expect(s).toBe(`mariadb:10.11.6@sha256:${'a'.repeat(64)}`);
  });
});
