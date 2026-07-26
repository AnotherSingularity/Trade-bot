import { ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

export function ValidationLabScreen() {
  const { state, envelope, error, refresh } = useDesktopData('validation.get');
  return (
    <ScreenLayout
      title="Validation Lab"
      subtitle="Phase 2F walk-forward / CPCV / PBO / DSR — read-only observer view."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — validation results do not gate promotion.' }}
    >
      <div className="banner warn" role="status" data-testid="prospective-evidence-pending-banner">PROSPECTIVE EVIDENCE PENDING</div>
      <div className="banner warn" role="status" data-testid="model-promotion-disabled-banner">MODEL PROMOTION DISABLED</div>
      <StateFrame label="validation.get" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(p) => (
          <>
            <div className="grid grid-4">
              <div className="card"><div className="k">Policy version</div><div className="v">{p.policyVersion ?? '—'}</div></div>
              <div className="card"><div className="k">Promotion</div><div className="v">disabled</div></div>
              <div className="card"><div className="k">Kelly</div><div className="v">disabled</div></div>
              <div className="card"><div className="k">Claude attribution</div><div className="v">{p.claudeAttributionStatus}</div></div>
            </div>
            <h2>Experiments</h2>
            {p.experiments.items.length === 0 ? (
              <div className="empty">No experiment runs yet.</div>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Experiment</th><th>Dataset</th><th>Split</th><th>Status</th>
                    <th>PBO</th><th>Sharpe</th><th>DSR</th><th>Sortino</th><th>Calmar</th>
                    <th>Drawdown</th><th>ES</th><th>Promotion</th>
                  </tr>
                </thead>
                <tbody>
                  {p.experiments.items.map((r) => (
                    <tr key={r.experimentId}>
                      <td>{r.name}</td>
                      <td>{r.datasetId ?? '—'}</td>
                      <td>{r.splitPolicy ?? '—'}</td>
                      <td><span className={`state-badge ${r.status}`}>{r.status}</span></td>
                      <td>{r.metrics.pbo ?? '—'}</td>
                      <td>{r.metrics.sharpe ?? '—'}</td>
                      <td>{r.metrics.dsr ?? '—'}</td>
                      <td>{r.metrics.sortino ?? '—'}</td>
                      <td>{r.metrics.calmar ?? '—'}</td>
                      <td>{r.metrics.drawdown ?? '—'}</td>
                      <td>{r.metrics.expectedShortfall ?? '—'}</td>
                      <td><span className="state-badge disabled">ineligible</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </StateFrame>
    </ScreenLayout>
  );
}
