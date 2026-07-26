import { ScreenLayout, EmptyState } from '../components/ScreenLayout';

export function CostsAttributionScreen() {
  return (
    <ScreenLayout
      title="Costs and Attribution"
      subtitle="Cash-flow cost forecast, honest buffers, and forecast-vs-realized attribution."
      banner={{ kind: 'info', text: 'Attribution is computed against shadow fills only.' }}
    >
      <h2>Recent forecasts</h2>
      <EmptyState message="Cost forecasts materialize when the scanner + shadow runtime run." />
      <h2>Forecast vs realized</h2>
      <EmptyState message="Attribution report is surfaced from Gate 3B tables." />
      <h2>Component breakdown</h2>
      <EmptyState message="Component breakdown (fee, slippage, funding, timing) shown per round-trip." />
    </ScreenLayout>
  );
}
