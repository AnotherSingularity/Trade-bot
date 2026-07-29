/**
 * Stage 4 §S4.1 — server-side digest wrappers.
 *
 * Wraps the pure canonical-string composers from @horizon/shared
 * with a Node SHA256. Kept out of the shared package so shared
 * remains importable from the desktop renderer bundle (Vite refuses
 * to inline `node:crypto`).
 */

import { createHash } from 'node:crypto';
import {
  composeContentCanonicalPayload,
  composeIdempotencyKeyCanonicalPayload,
  type CanonicalReportEnvelope,
  type IdempotencyKeyInput,
  type ReportKind,
} from '@horizon/shared';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Deterministic idempotency key. Format: `idem_<64-hex>`. Fits in
 * `desktop_export_jobs.idempotencyKey VARCHAR(128)`. Same tuple
 * → same key byte-for-byte across processes, machines, and re-runs.
 */
export function buildIdempotencyKey(input: IdempotencyKeyInput): string {
  const canonical = composeIdempotencyKeyCanonicalPayload(input);
  return `idem_${sha256Hex(canonical)}`;
}

/**
 * SHA256 of the canonical report payload. Populated on
 * `desktop_export_artifacts.contentDigest VARCHAR(64)`. Stable
 * across format=json|csv|html for the same source data.
 */
export function computeContentDigest<K extends ReportKind>(
  envelope: CanonicalReportEnvelope<K>,
): string {
  return sha256Hex(composeContentCanonicalPayload(envelope));
}
