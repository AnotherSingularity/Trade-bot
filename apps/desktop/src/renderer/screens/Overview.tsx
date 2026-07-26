import { ScreenLayout, KVCard, LoadingState } from '../components/ScreenLayout';
import { useDesktopStatus, useSafeConfiguration, useServiceHealth } from '../hooks/useHorizon';

export function OverviewScreen() {
  const { status, loading: statusLoading } = useDesktopStatus();
  const { config, loading: configLoading } = useSafeConfiguration();
  const { services, loading: servicesLoading } = useServiceHealth();
  const loading = statusLoading || configLoading || servicesLoading;
  return (
    <ScreenLayout
      title="Overview"
      subtitle="System-wide safety, health, and versioning at a glance."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — Phase 3A desktop console operates in DRY_RUN only.' }}
    >
      {loading ? <LoadingState /> : (
        <>
          <h2>Safe flags</h2>
          <div className="grid grid-4">
            <KVCard label="DRY_RUN" value={String(status?.safeFlags.DRY_RUN)} status="healthy" />
            <KVCard label="ORDER_SUBMISSION_ENABLED" value={String(status?.safeFlags.ORDER_SUBMISSION_ENABLED)} status="disabled" />
            <KVCard label="SIMULATION_MODE" value={status?.safeFlags.SIMULATION_MODE ?? '—'} status="observer-only" />
            <KVCard label="Provider mode" value={status?.providerMode ?? '—'} status="observer-only" />
          </div>
          <h2>Versions</h2>
          <div className="grid grid-4">
            <KVCard label="Desktop version" value={status?.desktopVersion ?? '—'} />
            <KVCard label="Build commit" value={status?.buildCommit ?? '—'} />
            <KVCard label="Schema version" value={status?.schemaVersion ?? '—'} />
            <KVCard label="Champion version" value={String(config?.championConfigurationView.championVersion ?? '—')} />
          </div>
          <h2>Observer policy versions</h2>
          <div className="grid grid-3">
            {Object.entries(config?.observerPolicyVersions ?? {}).map(([k, v]) => (
              <KVCard key={k} label={k} value={v} status="observer-only" />
            ))}
          </div>
          <h2>Service health</h2>
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
          <h2>CreateOrder counters (must remain zero)</h2>
          <div className="grid grid-3">
            <KVCard label="Function invocations" value={status?.createOrderCounters.functionInvocations ?? 0} status="healthy" />
            <KVCard label="Attempt count" value={status?.createOrderCounters.attemptCount ?? 0} status="healthy" />
            <KVCard label="Network count" value={status?.createOrderCounters.networkCount ?? 0} status="healthy" />
          </div>
        </>
      )}
    </ScreenLayout>
  );
}
