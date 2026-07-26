import { ScreenLayout, EmptyState } from '../components/ScreenLayout';
import { useSafeConfiguration } from '../hooks/useHorizon';

export function PortfolioRiskScreen() {
  const { config } = useSafeConfiguration();
  return (
    <ScreenLayout
      title="Portfolio Risk"
      subtitle="Risk observer output — exposures, correlations, ES and stress tests. Kelly disabled."
      banner={{ kind: 'warn', text: 'Kelly sizing is disabled by policy. Observer values are advisory.' }}
    >
      <div className="observer-label">observer-only</div>
      <h2>Risk observer version</h2>
      <div className="card">
        <div className="k">Version</div>
        <div className="v">{config?.observerPolicyVersions?.risk ?? '—'}</div>
      </div>
      <h2>Portfolio snapshots</h2>
      <EmptyState message="Snapshots are surfaced from Phase 2C portfolio_snapshots." />
      <h2>Limit breaches</h2>
      <EmptyState message="Breaches are recorded in the immutable breach journal." />
      <h2>Stress test summaries</h2>
      <EmptyState message="Stress tests are computed on schedule and stored per policy version." />
    </ScreenLayout>
  );
}
