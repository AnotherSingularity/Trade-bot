import { ScreenLayout, EmptyState } from '../components/ScreenLayout';
import { useSafeConfiguration } from '../hooks/useHorizon';

export function ValidationLabScreen() {
  const { config } = useSafeConfiguration();
  return (
    <ScreenLayout
      title="Validation Lab"
      subtitle="Walk-forward, CPCV, PBO, DSR — anti-overfitting audit. Read-only in the desktop operator console."
      banner={{ kind: 'warn', text: 'Promotion is registry-driven. This console shows read-only validation results — it does not run promotions.' }}
    >
      <div className="observer-label">observer-only</div>
      <h2>Validation framework version</h2>
      <div className="card">
        <div className="k">Version</div>
        <div className="v">{config?.observerPolicyVersions?.validation ?? '—'}</div>
      </div>
      <h2>Recent experiment runs</h2>
      <EmptyState message="Experiment runs are surfaced from Phase 2F validation tables." />
      <h2>Champion vs challenger</h2>
      <EmptyState message="Unified challenger + attribution surfaces once experiments run." />
      <h2>PBO / DSR</h2>
      <EmptyState message="Bailey & López de Prado PBO + Deflated Sharpe surfaced from statistical audit." />
    </ScreenLayout>
  );
}
