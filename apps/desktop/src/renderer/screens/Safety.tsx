import { KVCard, ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

export function SafetyScreen() {
  const { state, envelope, error, refresh } = useDesktopData('safety.get');
  return (
    <ScreenLayout
      title="Safety"
      subtitle="Authoritative safety gates. Live capital remains prohibited."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — this desktop cannot place, cancel, or modify a live order.' }}
    >
      <StateFrame label="safety.get" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(s) => (
          <>
            <h2>Safe flags</h2>
            <div className="grid grid-4">
              <KVCard label="DRY_RUN" value={String(s.safeFlags.DRY_RUN)} status="healthy" />
              <KVCard label="ORDER_SUBMISSION_ENABLED" value={String(s.safeFlags.ORDER_SUBMISSION_ENABLED)} status="disabled" />
              <KVCard label="SIMULATION_MODE" value={s.safeFlags.SIMULATION_MODE} status="observer-only" />
              <KVCard label="Live order submission disabled" value={String(s.safeFlags.liveOrderSubmissionDisabled)} status="healthy" />
            </div>

            <h2>CreateOrder barrier</h2>
            <div className="grid grid-4">
              <KVCard label="Barrier active" value={String(s.createOrderBarrierActive)} status="healthy" />
              <KVCard label="Counter source" value={s.createOrderCounters.source} />
              <KVCard label="Counters known" value={String(s.createOrderCounters.known)} status={s.createOrderCounters.known ? 'healthy' : 'unknown'} />
              <KVCard label="Reason" value={s.createOrderCounters.reasonCode ?? '—'} />
            </div>
            <div className="grid grid-3">
              <KVCard label="Function invocations" value={s.createOrderCounters.functionInvocations ?? 'unknown'} status={s.createOrderCounters.functionInvocations === 0 ? 'healthy' : 'danger'} />
              <KVCard label="Attempt count" value={s.createOrderCounters.attemptCount ?? 'unknown'} status={s.createOrderCounters.attemptCount === 0 ? 'healthy' : 'danger'} />
              <KVCard label="Network count" value={s.createOrderCounters.networkCount ?? 'unknown'} status={s.createOrderCounters.networkCount === 0 ? 'healthy' : 'danger'} />
            </div>

            <h2>Gates</h2>
            <table className="data">
              <thead><tr><th>Gate</th><th>State</th><th>Detail</th></tr></thead>
              <tbody>
                <tr>
                  <td>Scanner</td>
                  <td><span className={`state-badge ${s.scannerGate.state}`}>{s.scannerGate.state}</span></td>
                  <td>{s.scannerGate.blockingReasons.join(', ') || '—'}</td>
                </tr>
                <tr>
                  <td>Reconciliation</td>
                  <td><span className={`state-badge ${s.reconciliationGate.state}`}>{s.reconciliationGate.state}</span></td>
                  <td>{s.reconciliationGate.reasonCode ?? (s.reconciliationGate.unresolvedCount != null ? `unresolved=${s.reconciliationGate.unresolvedCount}` : '—')}</td>
                </tr>
              </tbody>
            </table>

            <h2>Prohibited postures (contractually locked)</h2>
            <div className="grid grid-3">
              <KVCard label="Observer enforcement" value={s.observerEnforcementActive ? 'ACTIVE' : 'disabled'} status={s.observerEnforcementActive ? 'danger' : 'disabled'} />
              <KVCard label="Promotion" value={s.promotionEnabled ? 'ENABLED' : 'disabled'} status={s.promotionEnabled ? 'danger' : 'disabled'} />
              <KVCard label="Kelly" value={s.kellyEnabled ? 'ENABLED' : 'disabled'} status={s.kellyEnabled ? 'danger' : 'disabled'} />
              <KVCard label="Live capital authorized" value={s.liveCapitalAuthorized ? 'AUTHORIZED' : 'prohibited'} status={s.liveCapitalAuthorized ? 'danger' : 'disabled'} />
              <KVCard label="Simulation mode" value={s.simulationMode} status="observer-only" />
              <KVCard label="Provider mode" value={s.providerMode} status="observer-only" />
            </div>
          </>
        )}
      </StateFrame>
    </ScreenLayout>
  );
}
