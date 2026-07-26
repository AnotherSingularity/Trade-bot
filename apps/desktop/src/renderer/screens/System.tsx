import { ScreenLayout, KVCard, LoadingState } from '../components/ScreenLayout';
import { useApplicationVersion, useDesktopStatus, useServiceHealth } from '../hooks/useHorizon';

export function SystemScreen() {
  const { version } = useApplicationVersion();
  const { status } = useDesktopStatus();
  const { services, loading, refresh } = useServiceHealth();
  return (
    <ScreenLayout
      title="System"
      subtitle="Local services, build fingerprint and runtime environment."
      banner={{ kind: 'info', text: 'All service controls operate on the local runtime. No remote hosts.' }}
    >
      <h2>Build</h2>
      <div className="grid grid-4">
        <KVCard label="Desktop version" value={version?.desktopVersion ?? status?.desktopVersion ?? '—'} />
        <KVCard label="Build commit" value={version?.buildCommit ?? status?.buildCommit ?? '—'} />
        <KVCard label="Build timestamp" value={version?.buildTimestamp ?? '—'} />
        <KVCard label="Schema version" value={status?.schemaVersion ?? '—'} />
      </div>
      <h2>Runtime</h2>
      <div className="grid grid-4">
        <KVCard label="Electron" value={version?.electronVersion ?? '—'} />
        <KVCard label="Node" value={version?.nodeVersion ?? '—'} />
        <KVCard label="Platform" value={version?.platform ?? '—'} />
        <KVCard label="Database mode" value={status?.databaseMode ?? '—'} />
      </div>
      <h2>Services</h2>
      <button onClick={refresh}>Refresh</button>
      {loading ? <LoadingState /> : (
        <table className="data">
          <thead><tr><th>Service</th><th>State</th><th>Restarts</th><th>Crash loop</th><th>Detail</th></tr></thead>
          <tbody>
            {services.map((s) => (
              <tr key={s.kind}>
                <td>{s.kind}</td>
                <td><span className={`state-badge ${s.state.toLowerCase()}`}>{s.state}</span></td>
                <td>{s.restartCount}</td>
                <td>{s.crashLoopDetected ? 'YES' : 'no'}</td>
                <td>{s.detail ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ScreenLayout>
  );
}
