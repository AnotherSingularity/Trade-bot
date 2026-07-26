import { ScreenLayout, EmptyState } from '../components/ScreenLayout';

export function DecisionJournalScreen() {
  return (
    <ScreenLayout
      title="Decision Journal"
      subtitle="Immutable decision chain audit — signals, thresholds, gates and observer verdicts."
      banner={{ kind: 'info', text: 'Chains are sourced from the Gate 2 lineage tables and are strictly append-only.' }}
    >
      <h2>Recent decision chains</h2>
      <EmptyState message="Decision chains materialize once the scanner + shadow runtime produce entries in this session." />
      <h2>Filter</h2>
      <p className="subtitle">Filter by product, outcome, gate outcome, or observer verdict.</p>
    </ScreenLayout>
  );
}
