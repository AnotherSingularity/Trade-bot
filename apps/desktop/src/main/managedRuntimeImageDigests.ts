/**
 * Correction 2 §image-digests — pinned managed-runtime image contract.
 *
 * The managed Docker runtime declares the exact
 * (semantic version, immutable digest) tuple for every container image
 * it starts. Startup verifies the running container reports the pinned
 * digest; drift → the runtime is invalidated before any BrowserWindow
 * opens.
 *
 * Image digests below are placeholders until the CI managed-runtime
 * integration workflow pulls them from Docker Hub and pins them
 * mechanically. The `HAS_PLACEHOLDER_DIGEST` sentinel is checked by
 * production callers so a shipped installer with a placeholder digest
 * is a hard startup rejection, not a silent fallback to whatever the
 * daemon happens to pull.
 *
 * Two-image contract:
 *   - MariaDB 10.11.6 (LTS, matches the Drizzle migration target)
 *   - Redis 7.4-alpine (matches Stage 5F server config)
 *
 * A future correction will lock these digests to their pulled values;
 * this module is the single source of truth so a drift becomes a
 * compile-time constant change with clear provenance.
 */

export interface PinnedImage {
  readonly repository: string;
  readonly semanticVersion: string;
  readonly immutableDigest: string;
  /**
   * True whenever the digest is still a placeholder — production
   * callers refuse to start when this is true.
   */
  readonly placeholder: boolean;
}

/** Sentinel — matches the placeholder digest below by prefix. */
export const PLACEHOLDER_DIGEST_PREFIX = 'sha256:00000000000000000000000000000000';

export const MANAGED_MARIADB: PinnedImage = {
  repository: 'mariadb',
  semanticVersion: '10.11.6',
  immutableDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
  placeholder: true,
};

export const MANAGED_REDIS: PinnedImage = {
  repository: 'redis',
  semanticVersion: '7.4-alpine',
  immutableDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000002',
  placeholder: true,
};

export const MANAGED_IMAGES: readonly PinnedImage[] = Object.freeze([MANAGED_MARIADB, MANAGED_REDIS]);

export interface ImageDigestVerdict {
  readonly ok: boolean;
  readonly failureCode?:
    | 'digest_placeholder'
    | 'digest_shape_invalid'
    | 'repository_missing'
    | 'semantic_version_missing';
  readonly detail?: string;
}

/**
 * Verify a `PinnedImage` is production-usable. Rejects placeholder
 * digests, malformed digest strings, empty repository, or empty
 * semantic version. Called by the orchestrator during startup for
 * every image it intends to run.
 */
export function verifyPinnedImage(image: PinnedImage): ImageDigestVerdict {
  if (!image.repository || image.repository.trim() === '') {
    return { ok: false, failureCode: 'repository_missing', detail: 'repository is empty' };
  }
  if (!image.semanticVersion || image.semanticVersion.trim() === '') {
    return { ok: false, failureCode: 'semantic_version_missing', detail: 'semanticVersion is empty' };
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(image.immutableDigest)) {
    return { ok: false, failureCode: 'digest_shape_invalid', detail: `digest=${image.immutableDigest}` };
  }
  if (image.placeholder || image.immutableDigest.startsWith(PLACEHOLDER_DIGEST_PREFIX)) {
    return { ok: false, failureCode: 'digest_placeholder', detail: `${image.repository}:${image.semanticVersion} still uses a placeholder digest — pin the real digest before packaging for release` };
  }
  return { ok: true };
}

export interface AllImagesVerdict {
  readonly ok: boolean;
  readonly failures: readonly { image: PinnedImage; verdict: ImageDigestVerdict }[];
}

/**
 * Verify every pinned image is production-usable. Called during the
 * managed runtime's preflight phase — a single placeholder rejects
 * the entire startup.
 */
export function verifyAllPinnedImages(images: readonly PinnedImage[] = MANAGED_IMAGES): AllImagesVerdict {
  const failures: { image: PinnedImage; verdict: ImageDigestVerdict }[] = [];
  for (const img of images) {
    const v = verifyPinnedImage(img);
    if (!v.ok) failures.push({ image: img, verdict: v });
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Format an image reference in the exact form Docker CLI accepts
 * (`repository:tag@digest`). Used by the orchestrator when spawning
 * `docker create` / `docker compose up` so the daemon pulls the
 * exact digest, not whatever `:tag` currently points at.
 */
export function formatImageReference(image: PinnedImage): string {
  return `${image.repository}:${image.semanticVersion}@${image.immutableDigest}`;
}
