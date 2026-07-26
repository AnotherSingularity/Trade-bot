import { useState } from 'react';
import { ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

export function ResearchUniverseScreen() {
  const [membership, setMembership] = useState<'any' | 'champion' | 'observer' | 'quarantined'>('any');
  const { state, envelope, error, refresh } = useDesktopData('universe.list', membership === 'any' ? undefined : { filter: { membership } });
  return (
    <ScreenLayout
      title="Research Universe"
      subtitle="Dynamic observer universe alongside the fixed champion universe."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — read-only universe view.' }}
    >
      <div className="filter-bar">
        <label>Membership:</label>
        {(['any', 'champion', 'observer', 'quarantined'] as const).map((m) => (
          <button key={m} type="button" className={membership === m ? 'active' : ''} onClick={() => setMembership(m)}>{m}</button>
        ))}
      </div>
      <StateFrame label="universe.list" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(payload) => (
          <table className="data">
            <thead>
              <tr>
                <th>Product</th><th>Membership</th><th>Eligibility</th><th>Hygiene</th>
                <th>Quarantine reason</th><th>Metadata freshness</th><th>Liquidity</th>
                <th>Confidence</th><th>Failure reason</th>
              </tr>
            </thead>
            <tbody>
              {payload.items.map((r) => (
                <tr key={r.product}>
                  <td>{r.product}</td>
                  <td>
                    {r.membership.includes('champion') && <span className="state-badge champion">CHAMPION</span>}{' '}
                    {r.membership.includes('observer') && <span className="state-badge observer">OBSERVER</span>}
                  </td>
                  <td><span className={`state-badge ${r.eligibility}`}>{r.eligibility}</span></td>
                  <td><span className={`state-badge ${r.hygieneState}`}>{r.hygieneState}</span></td>
                  <td>{r.quarantineReason ?? '—'}</td>
                  <td><span className={`state-badge ${r.metadataFreshness}`}>{r.metadataFreshness}</span></td>
                  <td><span className={`state-badge ${r.liquidityState}`}>{r.liquidityState}</span></td>
                  <td>{r.confidence ?? '—'}</td>
                  <td>{r.failureReason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </StateFrame>
    </ScreenLayout>
  );
}
