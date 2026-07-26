import { ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

export function FingerprintsScreen() {
  const { state, envelope, error, refresh } = useDesktopData('fingerprints.list');
  return (
    <ScreenLayout
      title="Fingerprints"
      subtitle="Phase 2A fingerprint evidence, class, and confidence."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — read-only observer view.' }}
    >
      <StateFrame label="fingerprints.list" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(payload) => (
          <table className="data">
            <thead>
              <tr>
                <th>Product</th><th>Class</th><th>Confidence</th>
                <th>Supporting</th><th>Conflicting</th><th>Missing</th>
                <th>Quality penalty</th><th>Liquidity penalty</th>
                <th>Input hash</th><th>Observed</th><th>Available</th>
              </tr>
            </thead>
            <tbody>
              {payload.items.map((r) => {
                const lowConfidence = r.confidence !== null && Number(r.confidence) < 0.5;
                const unclassified = r.fingerprintClass === 'UNCLASSIFIED';
                return (
                  <tr key={r.fingerprintId}>
                    <td>{r.product}</td>
                    <td>
                      {r.fingerprintClass}
                      {unclassified && <span className="state-badge warn"> UNCLASSIFIED</span>}
                    </td>
                    <td>
                      {r.confidence ?? 'unknown'}
                      {lowConfidence && <span className="state-badge warn"> LOW</span>}
                    </td>
                    <td>{r.supportingEvidence.length}</td>
                    <td>{r.conflictingEvidence.length}</td>
                    <td>{r.missingFeatures.length}</td>
                    <td>{r.qualityPenalty ?? '—'}</td>
                    <td>{r.liquidityPenalty ?? '—'}</td>
                    <td><code>{r.inputHash ? r.inputHash.slice(0, 12) : '—'}</code></td>
                    <td>{r.observedAt ?? '—'}</td>
                    <td>{r.availableAt ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </StateFrame>
    </ScreenLayout>
  );
}
