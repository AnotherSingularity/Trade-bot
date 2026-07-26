import { KVCard, ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

export function RegimesScreen() {
  const { state, envelope, error, refresh } = useDesktopData('regimes.get');
  return (
    <ScreenLayout
      title="Regimes"
      subtitle="Global market state and per-product regime — observer signal only."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — regimes never gate live capital.' }}
    >
      <StateFrame label="regimes.get" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(p) => (
          <>
            <h2>Global regime</h2>
            <div className="grid grid-4">
              <KVCard label="Raw" value={p.globalRegime.raw ?? '—'} />
              <KVCard label="Smoothed" value={p.globalRegime.smoothed ?? '—'} />
              <KVCard label="Latent state (HMM)" value={p.globalRegime.latentState ?? '—'} status="observer-only" />
              <KVCard label="Semantic mapping" value={p.globalRegime.semanticMapping ?? '—'} status="observer-only" />
              <KVCard label="Confidence" value={p.globalRegime.confidence ?? 'unknown'} />
              <KVCard label="Baseline vote (rule)" value={p.globalRegime.baselineVote ?? '—'} status="observer-only" />
              <KVCard label="State duration" value={p.globalRegime.stateDuration ?? '—'} />
              <KVCard label="Observed" value={p.globalRegime.observedAt ?? '—'} />
            </div>

            <h2>Change-detector votes</h2>
            {Object.keys(p.globalRegime.changeDetectorVotes).length === 0 ? (
              <div className="empty">No change-point evidence for the current snapshot.</div>
            ) : (
              <table className="data">
                <thead><tr><th>Detector</th><th>Confidence</th></tr></thead>
                <tbody>{Object.entries(p.globalRegime.changeDetectorVotes).map(([k, v]) => (
                  <tr key={k}><td>{k}</td><td>{v}</td></tr>
                ))}</tbody>
              </table>
            )}

            <h2>Product regimes</h2>
            {p.productRegimes.length === 0 ? (
              <div className="empty">No product regime snapshots yet.</div>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Product</th><th>Raw</th><th>Smoothed</th>
                    <th>Latent (HMM)</th><th>Semantic</th>
                    <th>Confidence</th><th>Transition</th><th>State duration</th><th>Observed</th>
                  </tr>
                </thead>
                <tbody>
                  {p.productRegimes.map((r) => (
                    <tr key={r.product}>
                      <td>{r.product}</td>
                      <td>{r.raw ?? '—'}</td>
                      <td>{r.smoothed ?? '—'}</td>
                      <td>{r.latentState ?? '—'}</td>
                      <td>{r.semanticMapping ?? '—'}</td>
                      <td>{r.confidence ?? '—'}</td>
                      <td>{r.transitionState ?? '—'}</td>
                      <td>{r.stateDuration ?? '—'}</td>
                      <td>{r.observedAt ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h2>Challenger</h2>
            <div className="grid grid-2">
              <KVCard label="Challenger route" value={p.challengerRoute ?? '—'} status="observer-only" />
              <KVCard label="Policy version" value={p.policyVersion ?? '—'} />
            </div>
          </>
        )}
      </StateFrame>
    </ScreenLayout>
  );
}
