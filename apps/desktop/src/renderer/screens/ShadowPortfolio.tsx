import { KVCard, ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';
import type { PortfolioMeasurement } from '@horizon/shared';

/**
 * Stage 3 §7 — Shadow Portfolio.
 *
 * Bound to `desktop.portfolio.get`. Every measurement carries its own
 * status + reason; unknown values render `unknown` with the reason —
 * never a fabricated `0` or `n/a`.
 */
export function ShadowPortfolioScreen() {
  const { state, envelope, error, refresh } = useDesktopData('portfolio.get');

  return (
    <ScreenLayout
      title="Shadow Portfolio"
      subtitle="Cash, exposure, and portfolio-level risk from the latest Phase 2C snapshot."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — every value is server-computed from the shadow ledger.' }}
    >
      <StateFrame label="portfolio" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(p, env) => (
          <>
            <h2>Snapshot</h2>
            <div className="grid grid-4">
              <KVCard label="Snapshot id" value={p.snapshotId ?? '—'} />
              <KVCard label="Snapshot at" value={p.snapshotAt ?? '—'} />
              <KVCard label="Policy version" value={p.policyVersion ?? '—'} />
              <KVCard label="Envelope generated at" value={env.generatedAt} />
            </div>

            <h2>Cash</h2>
            <MeasurementGrid entries={[
              { label: 'Cash', m: p.cash },
              { label: 'Reserved', m: p.reservedCash },
              { label: 'Available (cash − reserved)', m: p.availableCash },
            ]} />

            <h2>Exposure</h2>
            <MeasurementGrid entries={[
              { label: 'Gross', m: p.grossExposure },
              { label: 'Net', m: p.netExposure },
              { label: 'Open stop risk', m: p.openStopRisk },
              { label: 'Pending-entry', m: p.pendingEntryExposure },
              { label: 'Pending-exit residual', m: p.pendingExitResidualExposure },
              { label: 'Unprotected', m: p.unprotectedExposure },
              { label: 'Illiquid', m: p.illiquidExposure },
              { label: 'BTC beta', m: p.btcBetaExposure },
              { label: 'ETH beta', m: p.ethBetaExposure },
            ]} />

            <h2>P&amp;L, drawdown, tail risk</h2>
            <MeasurementGrid entries={[
              { label: 'Daily realized', m: p.dailyRealizedResult },
              { label: 'Weekly realized', m: p.weeklyRealizedResult },
              { label: 'Current drawdown', m: p.drawdown },
              { label: 'Historical VaR', m: p.historicalVar },
              { label: 'Historical ES', m: p.historicalExpectedShortfall },
            ]} />

            <h2>Breakdowns</h2>
            <BreakdownTable title="Product exposure" rows={p.productExposures} />
            <BreakdownTable title="Strategy-mode exposure" rows={p.strategyModeExposures} />
            <BreakdownTable title="Cluster exposure" rows={p.clusterExposures} />

            <h2>Stress</h2>
            {p.stressResults.length === 0 ? (
              <div className="empty">No stress scenarios in the current snapshot.</div>
            ) : (
              <table className="data">
                <thead><tr><th>Scenario</th><th>Status</th><th>Value</th><th>Run at</th></tr></thead>
                <tbody>
                  {p.stressResults.map((s) => (
                    <tr key={s.scenarioId}>
                      <td>{s.scenarioName}</td>
                      <td><span className={`state-badge ${s.measurement.status}`}>{s.measurement.status}</span></td>
                      <td>{s.measurement.value ?? '—'}</td>
                      <td>{s.runAt ?? '—'}</td>
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

function MeasurementGrid(props: { entries: Array<{ label: string; m: PortfolioMeasurement }> }) {
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Measurement</th>
          <th>Status</th>
          <th>Value</th>
          <th>Unit</th>
          <th>Observed</th>
          <th>Policy</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        {props.entries.map(({ label, m }) => (
          <tr key={label}>
            <td>{label}</td>
            <td><span className={`state-badge ${m.status}`}>{m.status}</span></td>
            <td>{m.status === 'unknown' || m.status === 'unavailable' ? 'unknown' : (m.value ?? 'unknown')}</td>
            <td>{m.unit}</td>
            <td>{m.observedAt ?? '—'}</td>
            <td>{m.policyVersion ?? '—'}</td>
            <td>{m.reasonCode ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BreakdownTable(props: { title: string; rows: Array<{ key: string; label: string; measurement: PortfolioMeasurement }> }) {
  return (
    <>
      <h3>{props.title}</h3>
      {props.rows.length === 0 ? (
        <div className="empty">No breakdown available in the current snapshot.</div>
      ) : (
        <table className="data">
          <thead><tr><th>Key</th><th>Status</th><th>Value</th><th>Unit</th></tr></thead>
          <tbody>
            {props.rows.map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td><span className={`state-badge ${r.measurement.status}`}>{r.measurement.status}</span></td>
                <td>{r.measurement.value ?? 'unknown'}</td>
                <td>{r.measurement.unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
