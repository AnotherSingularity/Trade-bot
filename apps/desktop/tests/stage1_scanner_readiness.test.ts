import { describe, expect, it } from 'vitest';
import { deriveScannerReadiness } from '../src/main/scannerReadiness';

describe('stage1 §11 — reconciliation-first scanner readiness', () => {
  const okReconciliation = { ok: true, unresolvedActions: 0, unknownIntentCount: 0, accountingDiscrepancy: 0 };

  it('T-S1.24: reconciliation runs before scanner readiness', () => {
    const r = deriveScannerReadiness({
      mariadbHealthy: true, redisHealthy: true, serverHealthy: true,
      fingerprintState: 'verified',
      reconciliation: null,
      unknownIntentPolicyThreshold: 0,
    });
    expect(r.state).toBe('unknown');
    expect(r.blockingReasons).toContain('reconciliation_unknown');
  });

  it('T-S1.25: reconciliation failure blocks scanner readiness', () => {
    const r = deriveScannerReadiness({
      mariadbHealthy: true, redisHealthy: true, serverHealthy: true,
      fingerprintState: 'verified',
      reconciliation: { ...okReconciliation, ok: false },
      unknownIntentPolicyThreshold: 0,
    });
    expect(r.state).toBe('blocked');
    expect(r.blockingReasons).toContain('reconciliation_failed');
  });

  it('T-S1.26: accounting discrepancy blocks scanner readiness', () => {
    const r = deriveScannerReadiness({
      mariadbHealthy: true, redisHealthy: true, serverHealthy: true,
      fingerprintState: 'verified',
      reconciliation: { ...okReconciliation, accountingDiscrepancy: 0.01 },
      unknownIntentPolicyThreshold: 0,
    });
    expect(r.state).toBe('blocked');
    expect(r.blockingReasons.some((s) => s.startsWith('accounting_discrepancy'))).toBe(true);
  });

  it('T-S1.27: unknown intent above threshold blocks scanner readiness', () => {
    const r = deriveScannerReadiness({
      mariadbHealthy: true, redisHealthy: true, serverHealthy: true,
      fingerprintState: 'verified',
      reconciliation: { ...okReconciliation, unknownIntentCount: 3 },
      unknownIntentPolicyThreshold: 0,
    });
    expect(r.state).toBe('blocked');
    expect(r.blockingReasons.some((s) => s.startsWith('unknown_intents'))).toBe(true);
  });

  it('T-S1.24b: fingerprint not verified blocks scanner readiness', () => {
    const r = deriveScannerReadiness({
      mariadbHealthy: true, redisHealthy: true, serverHealthy: true,
      fingerprintState: 'migration_required',
      reconciliation: okReconciliation,
      unknownIntentPolicyThreshold: 0,
    });
    expect(r.state).toBe('blocked');
    expect(r.blockingReasons).toContain('fingerprint_migration_required');
  });

  it('T-S1.24c: all checks green → ready', () => {
    const r = deriveScannerReadiness({
      mariadbHealthy: true, redisHealthy: true, serverHealthy: true,
      fingerprintState: 'verified',
      reconciliation: okReconciliation,
      unknownIntentPolicyThreshold: 0,
    });
    expect(r.state).toBe('ready');
    expect(r.blockingReasons).toEqual([]);
  });

  it('T-S1.24d: MariaDB unhealthy blocks scanner readiness', () => {
    const r = deriveScannerReadiness({
      mariadbHealthy: false, redisHealthy: true, serverHealthy: true,
      fingerprintState: 'verified',
      reconciliation: okReconciliation,
      unknownIntentPolicyThreshold: 0,
    });
    expect(r.state).toBe('blocked');
    expect(r.blockingReasons).toContain('mariadb_not_healthy');
  });
});
