import { ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

export function ProtectionScreen() {
  const { state, envelope, error, refresh } = useDesktopData('protection.get');
  return (
    <ScreenLayout
      title="Protection"
      subtitle="Protection policies, capability, validation, and per-instance state."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — protection is required for every candidate.' }}
    >
      <StateFrame label="protection.get" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(p) => (
          <>
            <h2>Policy version</h2>
            <div className="card"><div className="k">Version</div><div className="v">{p.policyVersion ?? '—'}</div></div>
            <h2>Protection instances</h2>
            <table className="data">
              <thead>
                <tr>
                  <th>Instance</th><th>Position</th><th>Policy</th>
                  <th>Capability</th><th>Validation</th>
                  <th>Required qty</th><th>Confirmed qty</th>
                  <th>Degradation</th><th>Recovery</th><th>Last event</th>
                </tr>
              </thead>
              <tbody>
                {p.instances.map((r) => (
                  <tr key={r.instanceId}>
                    <td>{r.instanceId}</td>
                    <td>{r.positionId ?? '—'}</td>
                    <td>{r.policyVersion ?? '—'}</td>
                    <td><span className={`state-badge ${r.capability}`}>{r.capability}</span></td>
                    <td><span className={`state-badge ${r.validation}`}>{r.validation}</span></td>
                    <td>{r.requiredQuantity ?? 'unknown'}</td>
                    <td>{r.confirmedQuantity ?? 'unknown'}</td>
                    <td><span className={`state-badge ${r.degradation}`}>{r.degradation}</span></td>
                    <td>{r.recoveryAttempts ?? '—'}</td>
                    <td>{r.lastEventAt ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="subtitle">
              Unknown protection is NEVER promoted to confirmed. Polling-only stays polling-only.
              Partial protection stays partial. Degraded protection remains prominent.
            </p>
          </>
        )}
      </StateFrame>
    </ScreenLayout>
  );
}
