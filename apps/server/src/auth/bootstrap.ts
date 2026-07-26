/**
 * Stage 2 §2 — Bootstrap channel authorization.
 *
 * The desktop's supervisor issues a 256-bit token when spawning the
 * server, then presents it on every bootstrap-scoped request through
 * the `X-Horizon-Bootstrap-Token` header. This token is scoped to a
 * single server lifecycle: rotated at spawn, invalidated when the
 * server exits, never persisted to disk. Loopback binding alone is
 * insufficient — another local process on the same machine could
 * otherwise reach the surface. The token closes that gap.
 *
 * Verification uses `crypto.timingSafeEqual` on equal-length buffers
 * so an attacker cannot mount a byte-by-byte timing oracle.
 */

import { timingSafeEqual } from 'node:crypto';

export const BOOTSTRAP_HEADER = 'x-horizon-bootstrap-token';

let expectedTokenHex: string | null = null;

/** Called at server boot with the token supplied via env. Idempotent. */
export function configureBootstrapToken(hex: string | undefined): void {
  if (!hex) {
    expectedTokenHex = null;
    return;
  }
  if (!/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('HORIZON_BOOTSTRAP_TOKEN must be hex-encoded');
  }
  if (hex.length < 64) {
    // 32 bytes hex = 64 chars; require at least 256 bits.
    throw new Error('HORIZON_BOOTSTRAP_TOKEN must be at least 256 bits (64 hex chars)');
  }
  expectedTokenHex = hex.toLowerCase();
}

export function isBootstrapConfigured(): boolean {
  return expectedTokenHex !== null;
}

export function verifyBootstrapToken(candidate: string | undefined): boolean {
  if (!expectedTokenHex || !candidate) return false;
  const lower = candidate.toLowerCase();
  if (!/^[0-9a-f]+$/i.test(lower)) return false;
  if (lower.length !== expectedTokenHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(lower, 'hex'), Buffer.from(expectedTokenHex, 'hex'));
  } catch {
    return false;
  }
}

/** TEST ONLY: reset. */
export function _resetBootstrapToken(): void {
  expectedTokenHex = null;
}
