import { useState } from 'react';
import { ScreenLayout, EmptyState } from '../components/ScreenLayout';

const REPORT_KINDS = [
  'decision_chain', 'daily_shadow', 'portfolio_risk', 'universe_and_hygiene',
  'fingerprints', 'regimes', 'microstructure', 'context', 'cost_attribution',
  'validation', 'incidents', 'safety_status', 'system_manifest',
] as const;

export function ReportsScreen() {
  const [status, setStatus] = useState<string | null>(null);

  async function pickFolder() {
    if (!window.horizon) { setStatus('Desktop bridge not available.'); return; }
    try {
      const r = await window.horizon.selectExportFolder();
      setStatus(r.folder ? `Selected folder: ${r.folder}` : 'Folder selection cancelled.');
    } catch (e) {
      setStatus(String(e));
    }
  }

  return (
    <ScreenLayout
      title="Reports"
      subtitle="Signed, versioned export bundles. Secrets are always redacted."
      banner={{ kind: 'info', text: 'Reports are exported only to an operator-selected folder. Never to the network.' }}
    >
      <h2>Report kinds</h2>
      <div className="grid grid-4">
        {REPORT_KINDS.map((k) => (
          <div key={k} className="card">
            <div className="k">Kind</div>
            <div className="v">{k}</div>
          </div>
        ))}
      </div>
      <h2>Choose export folder</h2>
      <button onClick={pickFolder}>Select export folder</button>
      {status && <p className="subtitle">{status}</p>}
      <h2>Recent exports</h2>
      <EmptyState message="Recent exports appear here with checksum, report version and applied redactions." />
    </ScreenLayout>
  );
}
