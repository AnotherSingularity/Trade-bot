import { useDesktopStatus } from '../hooks/useHorizon';

/**
 * Phase 3A §H, §I — top health bar. Always shows the safe-flag
 * state and the live-order-disabled banner.
 */

export function HealthBar() {
  const { status, loading } = useDesktopStatus();
  return (
    <header className="health-bar">
      <strong>Horizon Trade</strong>
      <span>{loading ? 'loading…' : `v${status?.desktopVersion ?? '?'} @ ${status?.buildCommit?.slice(0, 8) ?? 'unknown'}`}</span>
      <span>schema: {status?.schemaVersion ?? '?'}</span>
      <span className="badge safe">DRY_RUN = TRUE</span>
      <span className="badge disabled">LIVE ORDER SUBMISSION DISABLED</span>
      <span>simulation: {status?.safeFlags.SIMULATION_MODE ?? '—'}</span>
      <span>provider: {status?.providerMode ?? '—'}</span>
      <span style={{ marginLeft: 'auto' }}>
        CreateOrder invocations={status?.createOrderCounters.functionInvocations ?? 0}, attempts={status?.createOrderCounters.attemptCount ?? 0}, network={status?.createOrderCounters.networkCount ?? 0}
      </span>
    </header>
  );
}
