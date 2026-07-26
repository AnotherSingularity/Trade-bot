import { ScreenLayout, EmptyState } from '../components/ScreenLayout';
import { useSafeConfiguration } from '../hooks/useHorizon';

export function RegimesScreen() {
  const { config } = useSafeConfiguration();
  return (
    <ScreenLayout
      title="Regimes"
      subtitle="Global market state + per-product regime observer output."
      banner={{ kind: 'info', text: 'Regimes are observer signals; they never gate live capital.' }}
    >
      <div className="observer-label">observer-only</div>
      <h2>Regime observer version</h2>
      <div className="card">
        <div className="k">Version</div>
        <div className="v">{config?.observerPolicyVersions?.regime ?? '—'}</div>
      </div>
      <h2>Latest regime snapshot</h2>
      <EmptyState message="Regime snapshots are surfaced from Phase 2B tables." />
      <h2>Change-point events (CUSUM + secondary)</h2>
      <EmptyState message="Change-point events are recorded in the transition journal." />
    </ScreenLayout>
  );
}
