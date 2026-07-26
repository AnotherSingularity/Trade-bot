import { ScreenLayout, KVCard, LoadingState } from '../components/ScreenLayout';
import { useDesktopStatus } from '../hooks/useHorizon';

export function SafetyScreen() {
  const { status, loading } = useDesktopStatus();
  return (
    <ScreenLayout
      title="Safety"
      subtitle="Absolute safety invariants for Phase 3A operator console."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — this desktop cannot place, cancel or modify a live order.' }}
    >
      <h2>Safe flags (immutable in this build)</h2>
      {loading ? <LoadingState /> : (
        <div className="grid grid-4">
          <KVCard label="DRY_RUN" value={String(status?.safeFlags.DRY_RUN)} status="healthy" />
          <KVCard label="ORDER_SUBMISSION_ENABLED" value={String(status?.safeFlags.ORDER_SUBMISSION_ENABLED)} status="disabled" />
          <KVCard label="SIMULATION_MODE" value={status?.safeFlags.SIMULATION_MODE ?? '—'} status="observer-only" />
          <KVCard label="Live order submission disabled" value={String(status?.liveOrderSubmissionDisabled)} status="healthy" />
        </div>
      )}
      <h2>Provider posture</h2>
      {loading ? <LoadingState /> : (
        <div className="grid grid-3">
          <KVCard label="Provider mode" value={status?.providerMode ?? '—'} status="observer-only" />
          <KVCard label="Database mode" value={status?.databaseMode ?? '—'} />
          <KVCard label="Redis mode" value={status?.redisMode ?? '—'} />
        </div>
      )}
      <h2>CreateOrder counters — must remain zero</h2>
      {loading ? <LoadingState /> : (
        <div className="grid grid-3">
          <KVCard label="Function invocations" value={status?.createOrderCounters.functionInvocations ?? 0} status="healthy" />
          <KVCard label="Attempt count" value={status?.createOrderCounters.attemptCount ?? 0} status="healthy" />
          <KVCard label="Network count" value={status?.createOrderCounters.networkCount ?? 0} status="healthy" />
        </div>
      )}
      <h2>What this console cannot do</h2>
      <div className="card">
        <div className="k">Prohibited actions</div>
        <div className="v">
          <ul>
            <li>Place, cancel or modify a live order</li>
            <li>Toggle DRY_RUN or ORDER_SUBMISSION_ENABLED</li>
            <li>Select an external (production) Coinbase provider</li>
            <li>Run a non-interactive promotion of a challenger</li>
            <li>Bypass observer isolation, Kelly, or preflight/soak requirements</li>
            <li>Expose Coinbase credentials to the renderer, IPC, logs, exports, or crash reports</li>
          </ul>
        </div>
      </div>
    </ScreenLayout>
  );
}
