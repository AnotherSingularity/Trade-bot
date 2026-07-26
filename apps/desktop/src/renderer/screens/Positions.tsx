import { useState } from 'react';
import { ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

/**
 * Stage 3 §8 — Positions.
 *
 * List via `desktop.positions.list` with cursor pagination. Selecting a
 * row fetches `desktop.positions.get`. Partial exits stay OPEN, dust
 * remains explicit, unknown protection is not promoted to confirmed.
 */
export function PositionsScreen() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useDesktopData('positions.list');
  const detail = useDesktopData(
    'positions.get',
    selectedId ? { id: selectedId } : undefined,
    { skip: selectedId === null },
  );

  return (
    <ScreenLayout
      title="Positions"
      subtitle="Position lifecycle, protection state, and fills — read-only view."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — positions here are shadow-mode only.' }}
    >
      <h2>Positions</h2>
      <StateFrame label="positions.list" state={list.state} envelope={list.envelope} error={list.error} refresh={list.refresh}>
        {(payload) => (
          <table className="data">
            <thead>
              <tr>
                <th>Product</th><th>State</th><th>Remaining base qty</th><th>Weighted entry</th>
                <th>Protection</th><th>Reconciliation</th><th>Data quality</th><th>Opened</th><th>Updated</th><th></th>
              </tr>
            </thead>
            <tbody>
              {payload.items.map((p) => (
                <tr key={p.id} className={selectedId === p.id ? 'selected' : ''}>
                  <td>{p.product}</td>
                  <td><span className={`state-badge ${p.state}`}>{p.state}</span></td>
                  <td>{p.remainingBaseQuantity ?? 'unknown'}</td>
                  <td>{p.weightedEntryPrice ?? 'unknown'}</td>
                  <td><span className={`state-badge ${p.protectionState}`}>{p.protectionState}</span></td>
                  <td>{p.reconciliationState}</td>
                  <td>{p.dataQualityState}</td>
                  <td>{p.openedAt ?? '—'}</td>
                  <td>{p.lastUpdateAt ?? '—'}</td>
                  <td>
                    <button type="button" onClick={() => setSelectedId(p.id)}>
                      Detail
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </StateFrame>

      {selectedId !== null && (
        <>
          <h2>Position {selectedId}</h2>
          <StateFrame label="positions.get" state={detail.state} envelope={detail.envelope} error={detail.error} refresh={detail.refresh}>
            {(p) => (
              <>
                <div className="grid grid-4">
                  <div className="card"><div className="k">Product</div><div className="v">{p.product}</div></div>
                  <div className="card"><div className="k">State</div><div className="v"><span className={`state-badge ${p.state}`}>{p.state}</span></div></div>
                  <div className="card"><div className="k">Residual quantity</div><div className="v">{p.residualQuantity ?? 'unknown'}</div></div>
                  <div className="card"><div className="k">Entry fees</div><div className="v">{p.entryFees ?? 'unknown'}</div></div>
                  <div className="card"><div className="k">Target</div><div className="v">{p.targetPrice ?? 'unknown'}</div></div>
                  <div className="card"><div className="k">Stop</div><div className="v">{p.stopPrice ?? 'unknown'}</div></div>
                  <div className="card"><div className="k">Protected quantity</div><div className="v">{p.protectedQuantity ?? 'unknown'}</div></div>
                  <div className="card"><div className="k">Data quality</div><div className="v">{p.dataQualityState}</div></div>
                </div>

                {p.dustQuantity !== null && (
                  <div className="banner warn" role="status">
                    Dust residual: {p.dustQuantity} ({p.dustClassification ?? 'unknown'})
                  </div>
                )}

                <h3>Entry fills</h3>
                {p.entryFills.length === 0 ? (
                  <div className="empty">No fills recorded.</div>
                ) : (
                  <table className="data">
                    <thead><tr><th>Fill</th><th>Qty</th><th>Price</th><th>Fee</th><th>Filled at</th></tr></thead>
                    <tbody>
                      {p.entryFills.map((f) => (
                        <tr key={f.fillId}>
                          <td>{f.fillId}</td>
                          <td>{f.quantity}</td>
                          <td>{f.price}</td>
                          <td>{f.fee ?? '—'}</td>
                          <td>{f.filledAt}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <h3>Partial exits</h3>
                {p.partialExits.length === 0 ? (
                  <div className="empty">No partial exits.</div>
                ) : (
                  <table className="data">
                    <thead><tr><th>Attempt</th><th>Qty</th><th>Proceeds</th><th>Fee</th><th>State</th><th>Completed</th></tr></thead>
                    <tbody>
                      {p.partialExits.map((e) => (
                        <tr key={e.exitAttemptId}>
                          <td>{e.exitAttemptId}</td><td>{e.quantity}</td><td>{e.proceeds ?? '—'}</td>
                          <td>{e.fee ?? '—'}</td><td>{e.state}</td><td>{e.completedAt ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <h3>Bracket legs</h3>
                {p.bracketLegs.length === 0 ? (
                  <div className="empty">No bracket legs recorded.</div>
                ) : (
                  <table className="data">
                    <thead><tr><th>Leg</th><th>Role</th><th>State</th><th>Qty</th><th>Trigger</th></tr></thead>
                    <tbody>
                      {p.bracketLegs.map((l) => (
                        <tr key={l.legId}>
                          <td>{l.legId}</td><td>{l.role}</td><td>{l.state}</td>
                          <td>{l.quantity ?? '—'}</td><td>{l.triggerPrice ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <h3>Round trip</h3>
                {p.roundTrip ? (
                  <div className="grid grid-4">
                    <div className="card"><div className="k">Outcome</div><div className="v">{p.roundTrip.outcomeLabel}</div></div>
                    <div className="card"><div className="k">Net P&amp;L</div><div className="v">{p.roundTrip.netPnl ?? 'unknown'}</div></div>
                    <div className="card"><div className="k">Closed at</div><div className="v">{p.roundTrip.closedAt ?? '—'}</div></div>
                  </div>
                ) : (
                  <div className="empty">Position still open — no round-trip outcome yet.</div>
                )}

                <h3>Broken lineage markers</h3>
                {p.brokenLineageMarkers.length === 0 ? (
                  <div className="empty">None.</div>
                ) : (
                  <ul>{p.brokenLineageMarkers.map((m) => <li key={m}>{m}</li>)}</ul>
                )}
              </>
            )}
          </StateFrame>
        </>
      )}
    </ScreenLayout>
  );
}
