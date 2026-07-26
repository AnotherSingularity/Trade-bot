import { KVCard, ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

export function ContextScreen() {
  const { state, envelope, error, refresh } = useDesktopData('context.get');
  return (
    <ScreenLayout
      title="Context"
      subtitle="Phase 2E provider health, signal families, ensemble multiplier."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — context observer is advisory.' }}
    >
      <StateFrame label="context.get" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(p) => (
          <>
            <h2>Ensemble multiplier</h2>
            <div className="grid grid-3">
              <KVCard label="Multiplier" value={p.ensembleMultiplier.value ?? 'unknown'} status={p.ensembleMultiplier.status} />
              <KVCard label="Observed at" value={p.ensembleMultiplier.observedAt ?? '—'} />
              <KVCard label="Policy" value={p.policyVersion ?? '—'} />
            </div>
            <p className="subtitle">Multiplier is contractually capped at 1 — supportive context can never boost a decision.</p>

            <h2>Providers</h2>
            {p.providers.length === 0 ? (
              <div className="empty">No context providers configured.</div>
            ) : (
              <table className="data">
                <thead><tr><th>Provider</th><th>Health</th><th>Staleness</th><th>Last observed</th></tr></thead>
                <tbody>
                  {p.providers.map((r) => (
                    <tr key={r.providerId}>
                      <td>{r.label}</td>
                      <td><span className={`state-badge ${r.health}`}>{r.health}</span></td>
                      <td>{r.staleness ?? '—'}</td>
                      <td>{r.lastObservedAt ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h2>Signals</h2>
            {p.signals.length === 0 ? (
              <div className="empty">No context signal values recorded.</div>
            ) : (
              <table className="data">
                <thead><tr><th>Signal</th><th>Family</th><th>Status</th><th>Value</th><th>Observed</th><th>Reason</th></tr></thead>
                <tbody>
                  {p.signals.map((r) => (
                    <tr key={r.signalId}>
                      <td>{r.signalId}</td><td>{r.family}</td>
                      <td><span className={`state-badge ${r.status}`}>{r.status}</span></td>
                      <td>{r.value ?? 'unknown'}</td>
                      <td>{r.observedAt ?? '—'}</td>
                      <td>{r.reasonCode ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h2>Warnings / vetoes / conflicts / missing</h2>
            <div className="grid grid-2">
              <div><h3>Warnings</h3>{p.warnings.length === 0 ? <div className="empty">None.</div> : <ul>{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}</div>
              <div><h3>Vetoes</h3>{p.vetoes.length === 0 ? <div className="empty">None.</div> : <ul>{p.vetoes.map((v) => <li key={v}>{v}</li>)}</ul>}</div>
              <div><h3>Missing signals</h3>{p.missingSignals.length === 0 ? <div className="empty">None.</div> : <ul>{p.missingSignals.map((m) => <li key={m}>{m}</li>)}</ul>}</div>
              <div><h3>Conflicts</h3>{p.conflicts.length === 0 ? <div className="empty">None.</div> : <ul>{p.conflicts.map((c) => <li key={c}>{c}</li>)}</ul>}</div>
            </div>

            <h2>Incidents</h2>
            {p.incidents.length === 0 ? <div className="empty">No open context incidents.</div> : <ul>{p.incidents.map((i) => <li key={i}>{i}</li>)}</ul>}
          </>
        )}
      </StateFrame>
    </ScreenLayout>
  );
}
