import { ScreenLayout, EmptyState } from '../components/ScreenLayout';

export function ReconciliationScreen() {
  return (
    <ScreenLayout
      title="Reconciliation"
      subtitle="Continuous reconciliation runs and actions against exchange state."
      banner={{ kind: 'info', text: 'The reconciler operates in DRY_RUN mode; recoveries route through applyExitEconomicStateTx.' }}
    >
      <h2>Recent reconciliation runs</h2>
      <EmptyState message="Reconciliation runs are surfaced from §I observability tables." />
      <h2>Actions taken</h2>
      <EmptyState message="Actions are recorded per run with the resolved intent identity." />
    </ScreenLayout>
  );
}
