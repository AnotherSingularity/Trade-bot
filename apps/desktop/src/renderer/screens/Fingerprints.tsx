import { ScreenLayout, EmptyState } from '../components/ScreenLayout';
import { useSafeConfiguration } from '../hooks/useHorizon';

export function FingerprintsScreen() {
  const { config } = useSafeConfiguration();
  return (
    <ScreenLayout
      title="Fingerprints"
      subtitle="Product/market fingerprints composed from Stage 1 + Stage 2 features."
      banner={{ kind: 'info', text: 'Fingerprint evidence is immutable and lineage-linked.' }}
    >
      <div className="observer-label">observer-only</div>
      <h2>Universe observer version</h2>
      <div className="card">
        <div className="k">Version</div>
        <div className="v">{config?.observerPolicyVersions?.universe ?? '—'}</div>
      </div>
      <h2>Recent fingerprints</h2>
      <EmptyState message="Fingerprints are surfaced from Phase 2A evidence tables when Stage 2 features have run." />
    </ScreenLayout>
  );
}
