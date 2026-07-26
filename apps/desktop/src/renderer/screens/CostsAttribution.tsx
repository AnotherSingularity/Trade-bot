import { ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

export function CostsAttributionScreen() {
  const { state, envelope, error, refresh } = useDesktopData('costs.get');
  return (
    <ScreenLayout
      title="Costs and Attribution"
      subtitle="Gate 3B cost-component attribution against shadow fills."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — attribution is computed against shadow fills only.' }}
    >
      <StateFrame label="costs.get" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(p) => (
          <>
            <h2>Attribution version</h2>
            <div className="card"><div className="k">Version</div><div className="v">{p.attributionVersion ?? '—'}</div></div>
            <h2>Entries</h2>
            <table className="data">
              <thead>
                <tr>
                  <th>ID</th><th>Position</th><th>Attr ver</th>
                  <th>Forecast fees</th><th>Realized fees</th>
                  <th>Forecast spread</th><th>Effective spread</th>
                  <th>Forecast impact</th><th>Simulated impact</th>
                  <th>Forecast latency cost</th>
                  <th>Total forecast error</th><th>Net outcome</th>
                  <th>Recorded</th>
                </tr>
              </thead>
              <tbody>
                {p.entries.map((r) => (
                  <tr key={r.attributionId}>
                    <td>{r.attributionId}</td>
                    <td>{r.positionId ?? '—'}</td>
                    <td>{r.attributionVersion ?? '—'}</td>
                    <td>{r.forecastFees ?? '—'}</td>
                    <td>{r.realizedFees ?? '—'}</td>
                    <td>{r.forecastSpread ?? '—'}</td>
                    <td>{r.effectiveSpread ?? '—'}</td>
                    <td>{r.forecastImpact ?? '—'}</td>
                    <td>{r.simulatedImpact ?? '—'}</td>
                    <td>{r.forecastLatencyCost ?? '—'}</td>
                    <td>{r.totalForecastError ?? '—'}</td>
                    <td>{r.netOutcome ?? '—'}</td>
                    <td>{r.recordedAt ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="subtitle">
              Gross outcomes are never shown without their net counterpart — every row surfaces both
              forecast and realized (or explicit unknown) so the operator can see the difference.
            </p>
          </>
        )}
      </StateFrame>
    </ScreenLayout>
  );
}
