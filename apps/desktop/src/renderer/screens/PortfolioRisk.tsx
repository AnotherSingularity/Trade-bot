import { KVCard, ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

export function PortfolioRiskScreen() {
  const { state, envelope, error, refresh } = useDesktopData('risk.get');
  return (
    <ScreenLayout
      title="Portfolio Risk"
      subtitle="Phase 2C risk observer — exposures, caps, breaches, and stress runs."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — observer values are advisory.' }}
    >
      <div className="banner warn" role="status" data-testid="observer-enforcement-disabled-banner">OBSERVER ENFORCEMENT DISABLED</div>
      <div className="banner warn" role="status" data-testid="kelly-disabled-banner">KELLY DISABLED</div>
      <StateFrame label="risk.get" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(p) => (
          <>
            <div className="grid grid-4">
              <KVCard label="Policy version" value={p.policyVersion ?? '—'} />
              <KVCard label="Observed at" value={p.observedAt ?? '—'} />
              <KVCard label="Kelly" value="disabled" status="disabled" />
              <KVCard label="Observer enforcement" value="disabled" status="disabled" />
            </div>
            <h2>Candidate</h2>
            <div className="grid grid-3">
              <KVCard label="Candidate stop risk" value={p.candidateStopRisk.value ?? 'unknown'} status={p.candidateStopRisk.status} />
              <KVCard label="Volatility multiplier" value={p.volatilityMultiplier.value ?? 'unknown'} status={p.volatilityMultiplier.status} />
              <KVCard label="Expected shortfall" value={p.expectedShortfall.value ?? 'unknown'} status={p.expectedShortfall.status} />
            </div>
            <h2>Caps</h2>
            {p.caps.length === 0 ? (
              <div className="empty">No caps defined for the current policy.</div>
            ) : (
              <table className="data">
                <thead><tr><th>Cap</th><th>Limit</th><th>Observed</th><th>Binding</th><th>Breach</th><th>Action</th></tr></thead>
                <tbody>
                  {p.caps.map((c) => (
                    <tr key={c.key}>
                      <td>{c.label}</td>
                      <td>{c.limit ?? '—'}</td>
                      <td>{c.observed ?? '—'}</td>
                      <td>{c.binding ? 'yes' : '—'}</td>
                      <td>{c.breach ? <span className="state-badge danger">breach</span> : '—'}</td>
                      <td>{c.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <h2>Breaches</h2>
            {p.breaches.length === 0 ? (
              <div className="empty">No breaches in the current snapshot.</div>
            ) : (
              <table className="data">
                <thead><tr><th>Breach</th><th>Limit</th><th>Magnitude</th><th>Observed</th><th>Detail</th></tr></thead>
                <tbody>
                  {p.breaches.map((b) => (
                    <tr key={b.breachId}>
                      <td>{b.breachId}</td><td>{b.limitKey}</td>
                      <td>{b.magnitude ?? '—'}</td><td>{b.observedAt ?? '—'}</td>
                      <td>{b.detail ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <h2>System integrity vetoes</h2>
            {p.systemIntegrityVetoes.length === 0 ? (
              <div className="empty">None.</div>
            ) : (
              <ul>{p.systemIntegrityVetoes.map((v) => <li key={v}>{v}</li>)}</ul>
            )}
            <h2>Stress runs</h2>
            {p.stressRuns.length === 0 ? (
              <div className="empty">No stress runs in the current snapshot.</div>
            ) : (
              <table className="data">
                <thead><tr><th>Scenario</th><th>Value</th><th>Run at</th></tr></thead>
                <tbody>
                  {p.stressRuns.map((s) => (
                    <tr key={s.scenarioId}>
                      <td>{s.scenarioName}</td>
                      <td>{s.measurement.value ?? 'unknown'}</td>
                      <td>{s.runAt ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <h2>Candidate decision</h2>
            <div className="grid grid-3">
              <KVCard label="Outcome" value={p.candidateDecision.outcome} />
              <KVCard label="Final size" value={p.candidateDecision.finalSize ?? '—'} />
              <KVCard label="Reason" value={p.candidateDecision.reasonCode ?? '—'} />
            </div>
          </>
        )}
      </StateFrame>
    </ScreenLayout>
  );
}
