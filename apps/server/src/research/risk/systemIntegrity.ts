import type { PortfolioRiskInput } from './inputs';

/**
 * Phase 2C §T — System-integrity vetoes.
 *
 * These vetoes OUTRANK ordinary sizing measurements. No favorable
 * portfolio statistic may override an integrity failure.
 *
 * Possible states:
 *   - healthy
 *   - degraded
 *   - block_all_new_entries_recommended
 *   - reconciliation_required
 *   - invalid
 */

export type SystemIntegrityState =
  | 'healthy'
  | 'degraded'
  | 'block_all_new_entries_recommended'
  | 'reconciliation_required'
  | 'invalid';

export interface SystemIntegrityAssessment {
  state: SystemIntegrityState;
  reasons: string[];
}

export function assessSystemIntegrity(input: PortfolioRiskInput): SystemIntegrityAssessment {
  const reasons: string[] = [];
  // Highest severity → invalid
  if (input.portfolioLedgerState.hasUnresolvedLegacy) reasons.push('legacy_unresolved_records');
  if (!input.portfolioLedgerState.isConsistent) reasons.push('ledger_inconsistent');
  if (input.reconciliationState.accountingDiscrepancy) reasons.push('accounting_discrepancy');
  if (!input.productMetadata.isValid) reasons.push('product_metadata_invalid');
  if (
    !input.safeEnvironment.dryRun ||
    input.safeEnvironment.orderSubmissionEnabled
  )
    reasons.push('unsafe_environment_flag');
  const invalidReasons = new Set([
    'legacy_unresolved_records',
    'ledger_inconsistent',
    'accounting_discrepancy',
    'product_metadata_invalid',
    'unsafe_environment_flag',
  ]);
  const hasInvalid = reasons.some((r) => invalidReasons.has(r));

  // Reconciliation required
  const reconRequired: string[] = [];
  if (input.reconciliationState.state === 'unresolved') reconRequired.push('reconciliation_unresolved');
  if (input.currentPositions.some((p) => p.protectionState === 'unknown'))
    reconRequired.push('unknown_protection_state');
  if (input.pendingEntryIntents.some((i) => i.status === 'unknown'))
    reconRequired.push('unknown_pending_entry');
  if (input.pendingExitIntents.some((i) => i.status === 'unknown'))
    reconRequired.push('unknown_pending_exit');

  // Block-all-new-entries
  const blockReasons: string[] = [];
  if (input.reconciliationState.state === 'degraded') blockReasons.push('reconciliation_degraded');
  if (input.currentPositions.some((p) => p.protectionState === 'unprotected'))
    blockReasons.push('open_unprotected_position');

  if (hasInvalid) {
    return { state: 'invalid', reasons };
  }
  if (reconRequired.length > 0) {
    return { state: 'reconciliation_required', reasons: [...reasons, ...reconRequired] };
  }
  if (blockReasons.length > 0) {
    return {
      state: 'block_all_new_entries_recommended',
      reasons: [...reasons, ...blockReasons],
    };
  }
  if (reasons.length > 0) {
    return { state: 'degraded', reasons };
  }
  return { state: 'healthy', reasons: [] };
}
