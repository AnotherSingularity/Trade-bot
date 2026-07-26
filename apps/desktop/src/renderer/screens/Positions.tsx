import { ScreenLayout, EmptyState } from '../components/ScreenLayout';

export function PositionsScreen() {
  return (
    <ScreenLayout
      title="Positions"
      subtitle="Per-position lifecycle, protection state, and outcome tracking. Observer view — no controls."
      banner={{ kind: 'info', text: 'Positions are read-only. Entry, exit and protection are decided by the shadow runtime.' }}
    >
      <h2>Active positions</h2>
      <EmptyState message="No active positions in the current session." />
      <h2>Recent lifecycle transitions</h2>
      <EmptyState message="Lifecycle transitions are surfaced from the Gate 3A lifecycle enum + protection state." />
    </ScreenLayout>
  );
}
