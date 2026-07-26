import { ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

export function ReconciliationScreen() {
  const { state, envelope, error, refresh } = useDesktopData('reconciliation.list');
  return (
    <ScreenLayout
      title="Reconciliation"
      subtitle="Continuous reconciliation run history."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — the reconciler operates in DRY_RUN.' }}
    >
      <StateFrame label="reconciliation.list" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(payload) => (
          <table className="data">
            <thead>
              <tr>
                <th>Run</th><th>Started</th><th>Finished</th><th>Status</th>
                <th>Nonterminal intents</th><th>Entry blocked</th><th>Failure reasons</th>
              </tr>
            </thead>
            <tbody>
              {payload.items.map((r) => (
                <tr key={r.runId}>
                  <td>{r.runId}</td>
                  <td>{r.startedAt}</td>
                  <td>{r.finishedAt ?? '—'}</td>
                  <td><span className={`state-badge ${r.status}`}>{r.status}</span></td>
                  <td>{r.nonterminalIntentCount ?? '—'}</td>
                  <td>{r.entryBlockActive ? <span className="state-badge danger">blocked</span> : 'allowed'}</td>
                  <td>{r.failureReasons.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </StateFrame>
      <p className="subtitle">
        Scanner readiness must always agree with the authoritative /api/desktop/scanner-readiness
        endpoint. Acknowledging a reconciliation failure does NOT clear the entry block.
      </p>
    </ScreenLayout>
  );
}
