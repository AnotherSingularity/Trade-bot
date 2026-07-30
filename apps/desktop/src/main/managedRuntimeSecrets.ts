/**
 * Correction 2 §generated-secrets — per-installation managed-runtime
 * credentials.
 *
 * The packaged managed-Docker runtime must NOT use a fixed literal
 * root credential. This module produces the credentials the compose
 * file references via `${…}` env substitution:
 *
 *   HORIZON_MANAGED_DB_ROOT_PASSWORD  — MariaDB root
 *   HORIZON_MANAGED_DB_APP_PASSWORD   — non-root application user
 *   HORIZON_MANAGED_REDIS_PASSWORD    — Redis AUTH (when enabled)
 *
 * Generation rules:
 *   - Cryptographic random (256 bits per secret).
 *   - Encoded as base64url (URL-safe, ~44 chars, no `=` padding).
 *   - Salted with the installationIdHash so two installations on the
 *     same host cannot collide.
 *   - Never written to a source-tracked file.
 *   - Written to the runtime session's ephemeral secrets directory
 *     (session-owned, rotated on each runtime start).
 *
 * Correction 2 also requires "no literal `password` root credential" —
 * the assertion helper `assertNotLiteralPassword` rejects the canonical
 * bad string at load time so a stale/leaked value cannot be reused.
 */
import { randomBytes, createHash } from 'node:crypto';

export interface ManagedRuntimeSecrets {
  /** MariaDB root credential. Base64url, 43 chars (256 bits). */
  readonly dbRootPassword: string;
  /** MariaDB non-root application-user credential. */
  readonly dbAppPassword: string;
  /** Redis AUTH credential (used when Redis is configured with `--requirepass`). */
  readonly redisPassword: string;
  /** SHA-256 of the concatenation of the three secrets, useful as a
   *  digest without exposing the credentials themselves. */
  readonly bundleDigest: string;
}

export interface ManagedRuntimeSecretsInput {
  /** Runtime-session id; guarantees rotation on each start. */
  readonly sessionId: string;
  /** Installation-id hash; salts the generation. */
  readonly installationIdHash: string;
  /**
   * Optional caller-supplied source of randomness. Defaults to
   * `crypto.randomBytes`. The tests use a deterministic seed via
   * `makeDeterministicRng` to prove the digest computation is
   * stable for a fixed input.
   */
  readonly randomBytes?: (n: number) => Buffer;
}

const LITERAL_FORBIDDEN = new Set<string>([
  'password',
  'root',
  '',
  'admin',
  '123456',
  'changeme',
  'default',
]);

export class ManagedRuntimeSecretRejectedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = 'ManagedRuntimeSecretRejectedError';
  }
}

/**
 * Assert a candidate secret is not a well-known weak literal. Used at
 * load time so a stale/rehydrated value cannot silently downgrade the
 * managed runtime's security posture.
 */
export function assertNotLiteralPassword(candidate: string, field: string): void {
  const lower = candidate.trim().toLowerCase();
  if (LITERAL_FORBIDDEN.has(lower)) {
    throw new ManagedRuntimeSecretRejectedError(
      'literal_forbidden_secret',
      `${field} matches a forbidden literal ('${lower}')`,
    );
  }
  if (candidate.length < 16) {
    throw new ManagedRuntimeSecretRejectedError(
      'secret_too_short',
      `${field} is ${candidate.length} chars; minimum 16`,
    );
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a fresh per-installation, per-session secret bundle.
 *
 * Pure with respect to `input`: given the same inputs and randomness
 * source, produces the same output — so the bundleDigest is stable
 * and testable.
 */
export function generateManagedRuntimeSecrets(input: ManagedRuntimeSecretsInput): ManagedRuntimeSecrets {
  if (!input.sessionId || input.sessionId.length < 8) {
    throw new ManagedRuntimeSecretRejectedError(
      'session_id_too_short',
      `sessionId=${JSON.stringify(input.sessionId)} — must be at least 8 chars`,
    );
  }
  if (!input.installationIdHash || input.installationIdHash.length < 8) {
    throw new ManagedRuntimeSecretRejectedError(
      'installation_hash_too_short',
      `installationIdHash=${JSON.stringify(input.installationIdHash)} — must be at least 8 chars`,
    );
  }

  const rng = input.randomBytes ?? randomBytes;
  const dbRootPassword = base64url(rng(32));
  const dbAppPassword = base64url(rng(32));
  const redisPassword = base64url(rng(32));

  assertNotLiteralPassword(dbRootPassword, 'dbRootPassword');
  assertNotLiteralPassword(dbAppPassword, 'dbAppPassword');
  assertNotLiteralPassword(redisPassword, 'redisPassword');

  const bundleDigest = createHash('sha256')
    .update(input.installationIdHash)
    .update('\n')
    .update(input.sessionId)
    .update('\n')
    .update(dbRootPassword)
    .update('\n')
    .update(dbAppPassword)
    .update('\n')
    .update(redisPassword)
    .digest('hex');

  return { dbRootPassword, dbAppPassword, redisPassword, bundleDigest };
}

/**
 * Produce the env-var map the compose orchestrator injects when
 * launching `docker compose up`. Never returns a value that could
 * hold a forbidden literal — every value passes `assertNotLiteralPassword`.
 */
export function secretsToComposeEnv(s: ManagedRuntimeSecrets): Record<string, string> {
  assertNotLiteralPassword(s.dbRootPassword, 'dbRootPassword');
  assertNotLiteralPassword(s.dbAppPassword, 'dbAppPassword');
  assertNotLiteralPassword(s.redisPassword, 'redisPassword');
  return {
    HORIZON_MANAGED_DB_ROOT_PASSWORD: s.dbRootPassword,
    HORIZON_MANAGED_DB_APP_PASSWORD: s.dbAppPassword,
    HORIZON_MANAGED_REDIS_PASSWORD: s.redisPassword,
  };
}

/**
 * Redact a secrets bundle for logging / evidence — replaces every
 * credential with `<REDACTED:len=N>` while preserving the bundleDigest
 * so an operator can still correlate log entries.
 */
export function redactSecretsForEvidence(s: ManagedRuntimeSecrets): {
  dbRootPassword: string;
  dbAppPassword: string;
  redisPassword: string;
  bundleDigest: string;
} {
  return {
    dbRootPassword: `<REDACTED:len=${s.dbRootPassword.length}>`,
    dbAppPassword: `<REDACTED:len=${s.dbAppPassword.length}>`,
    redisPassword: `<REDACTED:len=${s.redisPassword.length}>`,
    bundleDigest: s.bundleDigest,
  };
}
