import { ScreenLayout, EmptyState } from '../components/ScreenLayout';
import { useSafeConfiguration } from '../hooks/useHorizon';

export function MicrostructureScreen() {
  const { config } = useSafeConfiguration();
  return (
    <ScreenLayout
      title="Microstructure"
      subtitle="Order-book, flow, execution cost and passive-fill observer output."
      banner={{ kind: 'info', text: 'Microstructure signals are observed against a deterministic book engine.' }}
    >
      <div className="observer-label">observer-only</div>
      <h2>Microstructure observer version</h2>
      <div className="card">
        <div className="k">Version</div>
        <div className="v">{config?.observerPolicyVersions?.microstructure ?? '—'}</div>
      </div>
      <h2>Latest features</h2>
      <EmptyState message="Features are surfaced from Phase 2D microstructure tables." />
      <h2>Trade aggressor classification</h2>
      <EmptyState message="Aggressor classifier + CVD policy output shown per top-N shortlist." />
    </ScreenLayout>
  );
}
