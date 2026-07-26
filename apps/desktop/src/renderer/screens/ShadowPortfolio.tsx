import { ScreenLayout, EmptyState } from '../components/ScreenLayout';

export function ShadowPortfolioScreen() {
  return (
    <ScreenLayout
      title="Shadow Portfolio"
      subtitle="Shadow-mode positions, P&L and exposures — DRY_RUN accounting only. No live capital."
      banner={{ kind: 'info', text: 'All positions shown are simulated. Live order submission is disabled.' }}
    >
      <h2>Open shadow positions</h2>
      <EmptyState message="No open shadow positions in this session. Positions materialize when the runtime shadow service records an entry." />
      <h2>Realized P&L (shadow)</h2>
      <EmptyState message="No realized shadow trades yet." />
      <h2>Exposure by cluster</h2>
      <EmptyState message="Exposures are surfaced from portfolio-risk observer snapshots (§Phase 2C)." />
    </ScreenLayout>
  );
}
