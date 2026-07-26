import { ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

export function MicrostructureScreen() {
  const { state, envelope, error, refresh } = useDesktopData('microstructure.get');
  return (
    <ScreenLayout
      title="Microstructure"
      subtitle="Phase 2D top-N shortlist microstructure — observer-only."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — read-only microstructure view.' }}
    >
      <div className="banner warn" role="status" data-testid="l2-inactive-banner">PRODUCTION LEVEL-2 PROVIDER INACTIVE</div>
      <div className="banner warn" role="status" data-testid="queue-unknown-banner">QUEUE POSITION NOT KNOWN</div>
      <StateFrame label="microstructure.get" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(p) => (
          <>
            <table className="data">
              <thead>
                <tr>
                  <th>Product</th><th>Session</th><th>Book health</th><th>Continuity</th>
                  <th>Best bid</th><th>Best ask</th><th>Spread</th>
                  <th>Midprice</th><th>Microprice</th>
                  <th>Queue</th><th>Observed</th>
                </tr>
              </thead>
              <tbody>
                {p.shortlist.map((r) => {
                  const invalid = r.bookHealth === 'invalid';
                  return (
                    <tr key={r.product}>
                      <td>{r.product}</td>
                      <td>{r.bookSessionId ?? '—'}</td>
                      <td><span className={`state-badge ${r.bookHealth}`}>{r.bookHealth}</span></td>
                      <td>{r.continuityState}</td>
                      <td>{invalid ? 'suppressed' : (r.bestBid ?? 'unknown')}</td>
                      <td>{invalid ? 'suppressed' : (r.bestAsk ?? 'unknown')}</td>
                      <td>{invalid ? 'suppressed' : (r.spread ?? 'unknown')}</td>
                      <td>{invalid ? 'suppressed' : (r.midprice ?? 'unknown')}</td>
                      <td>{invalid ? 'suppressed' : (r.microprice ?? 'unknown')}</td>
                      <td><span className="state-badge unknown">{r.queueUncertainty}</span></td>
                      <td>{r.observedAt ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="subtitle">
              Observer recommendation: {p.observerRecommendation ?? '—'} · policy {p.policyVersion ?? '—'}
            </p>
          </>
        )}
      </StateFrame>
    </ScreenLayout>
  );
}
