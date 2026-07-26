import { ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

export function ReportsScreen() {
  const { state, envelope, error, refresh } = useDesktopData('reports.get');
  return (
    <ScreenLayout
      title="Reports"
      subtitle="Report catalog and export-job history. Actual generation is deferred to Stage 4."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — report generation is Stage-4 pending.' }}
    >
      <StateFrame label="reports.get" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(p) => (
          <>
            <div className="banner warn" role="status" data-testid="report-generation-pending-banner">
              Report generation is NOT YET IMPLEMENTED — every catalog entry surfaces
              <code> generationAvailable: false</code> with reason <code>{p.reasonCode}</code>.
              Actual deterministic report generation and export lands in Stage 4.
            </div>
            <h2>Report catalog</h2>
            <table className="data">
              <thead>
                <tr><th>Kind</th><th>Label</th><th>Description</th><th>Formats</th><th>Available</th><th>Reason</th></tr>
              </thead>
              <tbody>
                {p.catalog.map((c) => (
                  <tr key={c.kind}>
                    <td><code>{c.kind}</code></td>
                    <td>{c.label}</td>
                    <td>{c.description}</td>
                    <td>{c.supportedFormats.join(', ')}</td>
                    <td><span className="state-badge disabled">no</span></td>
                    <td><code>{c.reasonCode}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h2>Export-job history</h2>
            {p.history.items.length === 0 ? (
              <div className="empty">No export jobs recorded yet.</div>
            ) : (
              <table className="data">
                <thead>
                  <tr><th>Job</th><th>Kind</th><th>Status</th><th>Requested</th><th>Completed</th><th>Checksum</th><th>Reason</th></tr>
                </thead>
                <tbody>
                  {p.history.items.map((r) => (
                    <tr key={r.jobId}>
                      <td>{r.jobId}</td>
                      <td>{r.kind}</td>
                      <td><span className={`state-badge ${r.status}`}>{r.status}</span></td>
                      <td>{r.requestedAt}</td>
                      <td>{r.completedAt ?? '—'}</td>
                      <td>{r.artifactChecksum ? <code>{r.artifactChecksum.slice(0, 16)}</code> : '—'}</td>
                      <td>{r.reasonCode ?? '—'}</td>
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
