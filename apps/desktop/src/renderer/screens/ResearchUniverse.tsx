import { ScreenLayout, EmptyState } from '../components/ScreenLayout';
import { useSafeConfiguration } from '../hooks/useHorizon';

export function ResearchUniverseScreen() {
  const { config } = useSafeConfiguration();
  return (
    <ScreenLayout
      title="Research Universe"
      subtitle="Universe enumerator + hygiene gate output. Observer-only."
      banner={{ kind: 'info', text: 'Universe & hygiene are versioned; quarantines are immutable.' }}
    >
      <div className="observer-label">observer-only</div>
      <h2>Universe policy</h2>
      <div className="card">
        <div className="k">Universe observer version</div>
        <div className="v">{config?.observerPolicyVersions?.universe ?? '—'}</div>
      </div>
      <h2>Current universe</h2>
      <EmptyState message="Universe snapshots are surfaced from Phase 2A tables." />
      <h2>Hygiene rejections</h2>
      <EmptyState message="Hygiene rejections are recorded per version and never mutated." />
    </ScreenLayout>
  );
}
