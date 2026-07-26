import { ScreenLayout, EmptyState } from '../components/ScreenLayout';
import { useSafeConfiguration } from '../hooks/useHorizon';

export function ContextScreen() {
  const { config } = useSafeConfiguration();
  return (
    <ScreenLayout
      title="Context"
      subtitle="Contextual risk + veto observer. Provider health, signals, ensemble decisions."
      banner={{ kind: 'info', text: 'Context observer is advisory. Vetos apply to the observer ensemble, never to live capital.' }}
    >
      <div className="observer-label">observer-only</div>
      <h2>Context observer version</h2>
      <div className="card">
        <div className="k">Version</div>
        <div className="v">{config?.observerPolicyVersions?.context ?? '—'}</div>
      </div>
      <h2>Provider health</h2>
      <EmptyState message="Provider health is surfaced from Phase 2E provider tables." />
      <h2>Signal families</h2>
      <EmptyState message="Signal results and ensemble decisions surface as fixtures replay." />
    </ScreenLayout>
  );
}
