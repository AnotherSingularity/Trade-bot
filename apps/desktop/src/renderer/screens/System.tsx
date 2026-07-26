import { KVCard, ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

export function SystemScreen() {
  const { state, envelope, error, refresh } = useDesktopData('system.get');
  return (
    <ScreenLayout
      title="System"
      subtitle="Runtime versions, service ownership, migration + schema state."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — read-only system view.' }}
    >
      <StateFrame label="system.get" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(sys) => (
          <>
            <h2>Build</h2>
            <div className="grid grid-4">
              <KVCard label="Desktop version" value={sys.desktopVersion} />
              <KVCard label="Server version" value={sys.serverVersion ?? '—'} />
              <KVCard label="Build commit" value={sys.buildCommit ?? '—'} />
              <KVCard label="Build timestamp" value={sys.buildTimestamp ?? '—'} />
            </div>
            <h2>Runtime</h2>
            <div className="grid grid-4">
              <KVCard label="Electron" value={sys.electronVersion ?? '—'} />
              <KVCard label="Node" value={sys.nodeVersion ?? '—'} />
              <KVCard label="Platform" value={sys.platform} />
              <KVCard label="Runtime mode" value={sys.runtimeMode} />
              <KVCard label="Uptime (seconds)" value={sys.uptimeSeconds ?? '—'} />
              <KVCard label="Log health" value={sys.logHealth} />
            </div>
            <h2>Schema + migrations</h2>
            <div className="grid grid-4">
              <KVCard label="Applied count" value={sys.migrationState.appliedCount ?? '—'} />
              <KVCard label="Schema (observed)" value={sys.migrationState.schemaVersion ?? '—'} />
              <KVCard label="Fingerprint" value={sys.schemaState.fingerprintMatch} status={sys.schemaState.fingerprintMatch === 'match' ? 'healthy' : sys.schemaState.fingerprintMatch === 'mismatch' ? 'danger' : 'unknown'} />
              <KVCard label="Expected version" value={sys.schemaState.expectedVersion} />
            </div>
            <h2>Processes</h2>
            <table className="data">
              <thead><tr><th>Kind</th><th>PID</th><th>State</th><th>Started at</th></tr></thead>
              <tbody>
                {sys.processes.map((p, i) => (
                  <tr key={`${p.kind}-${i}`}>
                    <td>{p.kind}</td>
                    <td>{p.pid ?? '—'}</td>
                    <td>{p.state}</td>
                    <td>{p.startedAt ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h2>Service ownership</h2>
            <table className="data">
              <thead><tr><th>Service</th><th>Owner</th></tr></thead>
              <tbody>{sys.serviceOwnership.map((s) => (
                <tr key={s.service}><td>{s.service}</td><td>{s.owner}</td></tr>
              ))}</tbody>
            </table>
            <h2>Runtime assets</h2>
            {sys.runtimeAssets.length === 0 ? (
              <div className="empty">No runtime assets registered.</div>
            ) : (
              <table className="data">
                <thead><tr><th>Asset</th><th>Version</th></tr></thead>
                <tbody>{sys.runtimeAssets.map((a) => (
                  <tr key={a.name}><td>{a.name}</td><td>{a.version ?? '—'}</td></tr>
                ))}</tbody>
              </table>
            )}
            <p className="subtitle">
              Sensitive paths are redacted or normalized. Absent workers appear absent —
              never healthy. Managed Docker runtime verification remains pending.
            </p>
          </>
        )}
      </StateFrame>
    </ScreenLayout>
  );
}
