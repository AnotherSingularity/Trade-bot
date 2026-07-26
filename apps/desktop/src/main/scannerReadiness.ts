/**
 * Stage 1 §11 — Scanner readiness as a derived state.
 *
 * `scanner_ready` iff:
 *   - MariaDB healthy
 *   - Redis healthy
 *   - Server healthy
 *   - Schema fingerprint verified
 *   - Reconciliation ok (unresolved_actions = 0)
 *   - Accounting discrepancy = 0
 *   - Unknown intent count within policy
 *
 * Never hardcoded. Operators cannot bypass it.
 */

import type { FingerprintState } from './schemaFingerprint';

export type ScannerReadyState = 'ready' | 'blocked' | 'unknown';

export interface ReconciliationSnapshot {
  ok: boolean;
  unresolvedActions: number;
  unknownIntentCount: number;
  accountingDiscrepancy: number;
  lastRunAt?: string;
}

export interface ScannerReadinessInput {
  mariadbHealthy: boolean;
  redisHealthy: boolean;
  serverHealthy: boolean;
  fingerprintState: FingerprintState;
  reconciliation: ReconciliationSnapshot | null;
  unknownIntentPolicyThreshold: number;
}

export interface ScannerReadinessResult {
  state: ScannerReadyState;
  blockingReasons: string[];
  computedAt: Date;
}

export function deriveScannerReadiness(input: ScannerReadinessInput, now: Date = new Date()): ScannerReadinessResult {
  const reasons: string[] = [];
  if (!input.mariadbHealthy) reasons.push('mariadb_not_healthy');
  if (!input.redisHealthy) reasons.push('redis_not_healthy');
  if (!input.serverHealthy) reasons.push('server_not_healthy');
  if (input.fingerprintState !== 'verified') reasons.push(`fingerprint_${input.fingerprintState}`);
  if (!input.reconciliation) {
    reasons.push('reconciliation_unknown');
    return { state: 'unknown', blockingReasons: reasons, computedAt: now };
  }
  if (!input.reconciliation.ok) reasons.push('reconciliation_failed');
  if (input.reconciliation.unresolvedActions > 0) reasons.push(`unresolved_actions=${input.reconciliation.unresolvedActions}`);
  if (Math.abs(input.reconciliation.accountingDiscrepancy) > 0) reasons.push(`accounting_discrepancy=${input.reconciliation.accountingDiscrepancy}`);
  if (input.reconciliation.unknownIntentCount > input.unknownIntentPolicyThreshold) {
    reasons.push(`unknown_intents=${input.reconciliation.unknownIntentCount}`);
  }
  return {
    state: reasons.length === 0 ? 'ready' : 'blocked',
    blockingReasons: reasons,
    computedAt: now,
  };
}
