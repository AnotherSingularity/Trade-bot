import { useState } from 'react';
import type { DecisionRecord } from '@horizon/shared';
import { ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

/**
 * Stage 3 §9 — Decision Journal.
 *
 * Bound to `desktop.decisions.list` + `desktop.decisions.get`. Detail
 * view separates champion-influence records (drove the decision) from
 * observer-only records; separates decision-time evidence from
 * post-decision + post-outcome evidence. Broken lineage stays visible.
 */
export function DecisionJournalScreen() {
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  const list = useDesktopData('decisions.list');
  const detail = useDesktopData(
    'decisions.get',
    selectedChainId ? { chainId: selectedChainId } : undefined,
    { skip: selectedChainId === null },
  );

  return (
    <ScreenLayout
      title="Decision Journal"
      subtitle="Every decision chain — champion evidence + observer evidence, separately."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — chains reflect shadow-mode reasoning only.' }}
    >
      <h2>Decision chains</h2>
      <StateFrame label="decisions.list" state={list.state} envelope={list.envelope} error={list.error} refresh={list.refresh}>
        {(payload) => (
          <table className="data">
            <thead>
              <tr><th>Chain</th><th>When</th><th>Product</th><th>Champion</th><th>Outcome</th><th>Position</th><th>Label</th><th>Lineage</th><th></th></tr>
            </thead>
            <tbody>
              {payload.items.map((r) => (
                <tr key={r.chainId} className={selectedChainId === r.chainId ? 'selected' : ''}>
                  <td>{r.chainId}</td>
                  <td>{r.createdAt}</td>
                  <td>{r.product ?? '—'}</td>
                  <td>{r.championVersion ?? '—'}</td>
                  <td><span className={`state-badge ${r.authorizationOutcome}`}>{r.authorizationOutcome}</span></td>
                  <td>{r.positionState ?? '—'}</td>
                  <td>{r.outcomeLabel ?? '—'}</td>
                  <td>{r.brokenLineage ? <span className="state-badge danger">broken</span> : 'ok'}</td>
                  <td><button type="button" onClick={() => setSelectedChainId(r.chainId)}>Detail</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </StateFrame>

      {selectedChainId !== null && (
        <>
          <h2>Chain {selectedChainId}</h2>
          <StateFrame label="decisions.get" state={detail.state} envelope={detail.envelope} error={detail.error} refresh={detail.refresh}>
            {(p) => (
              <>
                <div className="grid grid-4">
                  <div className="card"><div className="k">Product</div><div className="v">{p.product ?? '—'}</div></div>
                  <div className="card"><div className="k">Champion</div><div className="v">{p.championVersion ?? '—'}</div></div>
                  <div className="card"><div className="k">Observed at</div><div className="v">{p.createdAt}</div></div>
                  <div className="card"><div className="k">Broken markers</div><div className="v">{p.brokenLineageMarkers.length}</div></div>
                </div>

                <h3>Champion chain — decision-time evidence</h3>
                <RecordTable rows={[
                  ['scan_run', p.chain.scanRun],
                  ['market_observation', p.chain.marketObservation],
                  ['product_eligibility', p.chain.productEligibility],
                  ['setup_evaluation', p.chain.setupEvaluation],
                  ['champion_routing', p.chain.championRouting],
                  ['cost_forecast', p.chain.costForecast],
                  ['quantitative_authorization', p.chain.quantitativeAuthorization],
                  ['claude_decision', p.chain.claudeDecision],
                  ['approved_preview', p.chain.approvedPreview],
                  ['execution_plan', p.chain.executionPlan],
                ]} />

                <h3>Champion chain — post-decision evidence</h3>
                <RecordTable rows={[
                  ['position', p.chain.position],
                  ['protection', p.chain.protection],
                  ['round_trip', p.chain.roundTrip],
                ]} />
                <RecordArraySection title="Order intents" records={p.chain.orderIntents} />
                <RecordArraySection title="Fills" records={p.chain.fills} />
                <RecordArraySection title="Exit activity" records={p.chain.exitActivity} />
                <RecordArraySection title="Cash ledger" records={p.chain.cashLedger} />

                <h3>Champion chain — post-outcome evidence</h3>
                <RecordTable rows={[['outcome_label', p.chain.outcomeLabel]]} />

                <h3>Observer evidence (observer_only — did NOT influence the champion)</h3>
                <RecordTable rows={[
                  ['phase2A_fingerprint', p.observers.phase2AFingerprint],
                  ['phase2B_regime', p.observers.phase2BRegime],
                  ['phase2C_risk', p.observers.phase2CRisk],
                  ['phase2D_microstructure', p.observers.phase2DMicrostructure],
                  ['phase2E_context', p.observers.phase2EContext],
                  ['phase2F_unified_challenger', p.observers.phase2FUnifiedChallenger],
                  ['validation_attribution', p.observers.validationAttribution],
                ]} />

                {p.brokenLineageMarkers.length > 0 && (
                  <div className="banner warn" role="status">
                    Broken lineage: {p.brokenLineageMarkers.join(', ')}
                  </div>
                )}
              </>
            )}
          </StateFrame>
        </>
      )}
    </ScreenLayout>
  );
}

function RecordTable(props: { rows: Array<[string, DecisionRecord | null]> }) {
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Stage</th><th>Record</th><th>Recorded at</th>
          <th>Champion influence</th><th>Observer only</th>
          <th>Known @ decision</th><th>Known after decision</th><th>Known after outcome</th>
          <th>Broken reason</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map(([stage, r]) => (
          <tr key={stage} className={r === null ? 'missing' : ''}>
            <td>{stage}</td>
            <td>{r?.recordId ?? '— (absent)'}</td>
            <td>{r?.recordedAt ?? '—'}</td>
            <td>{r?.provenance.championInfluence ? 'yes' : '—'}</td>
            <td>{r?.provenance.observerOnly ? 'yes' : '—'}</td>
            <td>{r?.provenance.knownAtDecisionTime ? 'yes' : '—'}</td>
            <td>{r?.provenance.knownAfterDecision ? 'yes' : '—'}</td>
            <td>{r?.provenance.knownAfterOutcome ? 'yes' : '—'}</td>
            <td>{r?.brokenReason ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RecordArraySection(props: { title: string; records: DecisionRecord[] }) {
  return (
    <>
      <h4>{props.title}</h4>
      {props.records.length === 0 ? (
        <div className="empty">No {props.title.toLowerCase()} recorded for this chain.</div>
      ) : (
        <table className="data">
          <thead><tr><th>Record</th><th>Recorded at</th><th>Champion influence</th><th>Broken reason</th></tr></thead>
          <tbody>
            {props.records.map((r, i) => (
              <tr key={`${r.stage}-${i}`}>
                <td>{r.recordId}</td><td>{r.recordedAt ?? '—'}</td>
                <td>{r.provenance.championInfluence ? 'yes' : '—'}</td>
                <td>{r.brokenReason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
