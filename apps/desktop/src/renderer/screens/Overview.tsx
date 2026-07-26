import { KVCard, ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

/**
 * Stage 3 §6 — Overview screen.
 *
 * Bound to `desktop.overview.get`. Every displayed value comes from the
 * envelope; the renderer performs no financial arithmetic. Unknown
 * counters render `—`, never `0`.
 */
export function OverviewScreen() {
  const { state, envelope, error, refresh } = useDesktopData('overview.get');

  return (
    <ScreenLayout
      title="Overview"
      subtitle="System-wide safety, health, and versioning at a glance."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — the desktop console operates in DRY_RUN only.' }}
    >
      <StateFrame
        label="overview"
        state={state}
        envelope={envelope}
        error={error}
        refresh={refresh}
      >
        {(payload, env) => (
          <>
            {payload.schemaFingerprint.fingerprintMatch !== 'match' && (
              <div className="banner danger" role="alert">
                Schema fingerprint {payload.schemaFingerprint.fingerprintMatch}
                {payload.schemaFingerprint.reason ? ` — ${payload.schemaFingerprint.reason}` : ''}.
                Expected {payload.schemaFingerprint.expectedVersion}; observed{' '}
                {payload.schemaFingerprint.observedVersion ?? '—'}.
              </div>
            )}

            <h2>Safe flags</h2>
            <div className="grid grid-4">
              <KVCard label="DRY_RUN" value={String(payload.safeFlags.DRY_RUN)} status="healthy" />
              <KVCard label="ORDER_SUBMISSION_ENABLED" value={String(payload.safeFlags.ORDER_SUBMISSION_ENABLED)} status="disabled" />
              <KVCard label="SIMULATION_MODE" value={payload.safeFlags.SIMULATION_MODE} status="observer-only" />
              <KVCard label="Provider mode" value={payload.providerMode} status="observer-only" />
            </div>

            <h2>Versions</h2>
            <div className="grid grid-4">
              <KVCard label="Desktop version" value={payload.desktopVersion} />
              <KVCard label="Server version" value={payload.serverVersion ?? '—'} />
              <KVCard label="Build commit" value={payload.buildCommit ?? '—'} />
              <KVCard label="Schema version (observed)" value={payload.schemaFingerprint.observedVersion ?? '—'} />
            </div>

            <h2>Champion + observers</h2>
            <div className="grid grid-4">
              <KVCard label="Champion version" value={payload.championVersion ?? '—'} />
              {Object.entries(payload.observerPolicyVersions).map(([k, v]) => (
                <KVCard key={k} label={`observer:${k}`} value={v} status="observer-only" />
              ))}
            </div>

            <h2>Health</h2>
            <table className="data">
              <thead><tr><th>Kind</th><th>State</th><th>Detail</th><th>Last checked</th></tr></thead>
              <tbody>
                {payload.services.map((s) => (
                  <tr key={s.kind}>
                    <td>{s.kind}</td>
                    <td><span className={`state-badge ${s.state}`}>{s.state}</span></td>
                    <td>{s.detail ?? '—'}</td>
                    <td>{s.lastCheckedAt ?? '—'}</td>
                  </tr>
                ))}
                <tr>
                  <td>scanner</td>
                  <td><span className={`state-badge ${payload.scannerReadiness.state}`}>{payload.scannerReadiness.state}</span></td>
                  <td>{payload.scannerReadiness.blockingReasons.join(', ') || '—'}</td>
                  <td>{payload.scannerReadiness.observedAt ?? '—'}</td>
                </tr>
                <tr>
                  <td>reconciliation</td>
                  <td><span className={`state-badge ${payload.reconciliationHealth.state}`}>{payload.reconciliationHealth.state}</span></td>
                  <td>{payload.reconciliationHealth.reasonCode ?? (payload.reconciliationHealth.unresolvedCount != null ? `unresolved=${payload.reconciliationHealth.unresolvedCount}` : '—')}</td>
                  <td>{payload.reconciliationHealth.lastRunAt ?? '—'}</td>
                </tr>
              </tbody>
            </table>

            <h2>Portfolio integrity</h2>
            <div className="grid grid-4">
              <KVCard label="Open positions" value={payload.openPositionCount ?? '—'} />
              <KVCard label="Unprotected exposure (USD)" value={payload.unprotectedExposure ?? '—'} />
              <KVCard label="Broken accepted lineage" value={payload.accountingIntegrity.brokenAcceptedLineageCount ?? '—'} />
              <KVCard label="Missing mandatory attribution" value={payload.accountingIntegrity.missingMandatoryAttributionCount ?? '—'} />
            </div>

            <h2>CreateOrder counters (must remain zero)</h2>
            <div className="grid grid-3">
              <KVCard
                label="Function invocations"
                value={payload.createOrderCounters.functionInvocations ?? '—'}
                status={payload.createOrderCounters.functionInvocations === 0 ? 'healthy' : 'danger'}
              />
              <KVCard
                label="Attempt count"
                value={payload.createOrderCounters.attemptCount ?? '—'}
                status={payload.createOrderCounters.attemptCount === 0 ? 'healthy' : 'danger'}
              />
              <KVCard
                label="Network count"
                value={payload.createOrderCounters.networkCount ?? '—'}
                status={payload.createOrderCounters.networkCount === 0 ? 'healthy' : 'danger'}
              />
            </div>
            <p className="subtitle">
              Envelope generated at <time>{env.generatedAt}</time>{env.sourceVersion ? ` · source=${env.sourceVersion}` : ''}.
            </p>
          </>
        )}
      </StateFrame>
    </ScreenLayout>
  );
}
