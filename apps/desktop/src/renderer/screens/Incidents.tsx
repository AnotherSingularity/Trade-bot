import { useState } from 'react';
import { ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

export function IncidentsScreen() {
  const [severity, setSeverity] = useState<'any' | 'critical' | 'error' | 'warning' | 'info'>('any');
  const [ackStatus, setAckStatus] = useState<'any' | 'acknowledged' | 'unacknowledged'>('any');
  const filter: { severityIn?: ('critical' | 'error' | 'warning' | 'info')[]; acknowledged?: boolean } = {};
  if (severity !== 'any') filter.severityIn = [severity];
  if (ackStatus !== 'any') filter.acknowledged = ackStatus === 'acknowledged';
  const input = Object.keys(filter).length > 0 ? { filter } : undefined;
  const { state, envelope, error, refresh } = useDesktopData('incidents.list', input);
  const [ackingId, setAckingId] = useState<string | null>(null);
  const [ackResult, setAckResult] = useState<string | null>(null);

  async function acknowledge(id: string) {
    setAckingId(id); setAckResult(null);
    const win = window as unknown as { horizon?: { desktopData: (k: string, i?: unknown) => Promise<{ ok: boolean; envelope?: { data?: { ok: boolean; underlyingResolved: boolean; reasonCode: string | null } }; error?: { code: string } }> } };
    const r = await win.horizon?.desktopData('incidents.acknowledge', { incidentId: id });
    if (r?.ok && r.envelope?.data?.ok) {
      setAckResult(`Acknowledgement recorded — underlying fault NOT resolved (${r.envelope.data.reasonCode ?? 'ok'}).`);
    } else if (r?.ok && r.envelope?.data && !r.envelope.data.ok) {
      setAckResult(`Ack failed: ${r.envelope.data.reasonCode ?? 'unknown'}`);
    } else {
      setAckResult(`Ack failed: ${r?.error?.code ?? 'ipc_error'}`);
    }
    setAckingId(null);
    refresh();
  }

  return (
    <ScreenLayout
      title="Incidents"
      subtitle="Unified incident list. Acknowledgement records the operator marker — it does NOT resolve the underlying fault."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — acknowledgement is a marker, not a resolution.' }}
    >
      <div className="filter-bar">
        <label>Severity:</label>
        {(['any', 'critical', 'error', 'warning', 'info'] as const).map((s) => (
          <button key={s} type="button" className={severity === s ? 'active' : ''} onClick={() => setSeverity(s)}>{s}</button>
        ))}
        <label>Ack status:</label>
        {(['any', 'acknowledged', 'unacknowledged'] as const).map((s) => (
          <button key={s} type="button" className={ackStatus === s ? 'active' : ''} onClick={() => setAckStatus(s)}>{s}</button>
        ))}
      </div>
      {ackResult && <div className="banner info" role="status">{ackResult}</div>}
      <StateFrame label="incidents.list" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(payload) => (
          <table className="data">
            <thead>
              <tr>
                <th>Incident</th><th>Severity</th><th>Subsystem</th><th>Title</th>
                <th>State</th><th>Ack</th><th>Underlying resolved</th>
                <th>Opened</th><th>Last update</th><th></th>
              </tr>
            </thead>
            <tbody>
              {payload.items.map((r) => (
                <tr key={r.incidentId}>
                  <td>{r.incidentId}</td>
                  <td><span className={`state-badge ${r.severity}`}>{r.severity}</span></td>
                  <td>{r.subsystem}</td>
                  <td>{r.title}</td>
                  <td><span className={`state-badge ${r.state}`}>{r.state}</span></td>
                  <td>{r.acknowledged ? 'yes' : 'no'}</td>
                  <td>{r.underlyingResolved ? 'yes' : <span className="state-badge danger">no</span>}</td>
                  <td>{r.openedAt}</td>
                  <td>{r.lastUpdateAt ?? '—'}</td>
                  <td>
                    <button type="button" disabled={ackingId !== null || r.acknowledged} onClick={() => acknowledge(r.incidentId)}>
                      {r.acknowledged ? 'ack\'d' : ackingId === r.incidentId ? 'sending…' : 'Acknowledge'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </StateFrame>
    </ScreenLayout>
  );
}
