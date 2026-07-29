import { useCallback, useEffect, useState } from 'react';
import { REPORT_KINDS, type ExportEnqueueEnvelope, type ExportListItem, type ExportStatusEnvelope, type ExportVerifyEnvelope, type ReportFormat, type ReportKind } from '@horizon/shared';
import { ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

/**
 * Stage 4E — real report-generation UI.
 *
 * The screen drives four Stage 4D tRPC procedures via
 * `horizon.desktopData(...)`:
 *   * `reports.get`     — read-only catalog (retained from Stage 3).
 *   * `reports.enqueue` — mutation that creates + serialises + writes
 *     the artifact synchronously; the response carries contentDigest
 *     + checksumSha256 + artifactPath OR a typed failure.
 *   * `reports.list`    — DESC-by-id recent jobs, installation-scoped.
 *   * `reports.verify`  — re-hashes the file bytes vs stored
 *     checksumSha256 + sizeBytes; returns `ok:false, reason:...` on
 *     drift.
 *
 * Every meaningful DOM anchor carries `data-testid` + at least one
 * of the seven Stage 4E runtime attributes (`data-report-kind`,
 * `data-export-format`, `data-export-state`, `data-job-id`,
 * `data-content-digest`, `data-checksum`, `data-verification-state`)
 * so native T56-T60 can assert against them without depending on
 * visible text alone.
 */

const FORMATS: readonly ReportFormat[] = ['json', 'csv', 'html'] as const;

// Report kinds that MUST supply a referenceId — everything else
// ignores it. Kept in sync with generators/generators.ts:decisionChain.
const REFERENCE_ID_REQUIRED: ReadonlySet<ReportKind> = new Set<ReportKind>(['decision_chain']);

interface EnqueueSlotState {
  readonly state: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
  readonly jobId: number | null;
  readonly artifactPath: string | null;
  readonly contentDigest: string | null;
  readonly checksum: string | null;
  readonly reportSpecVersion: string | null;
  readonly failureReason: string | null;
  readonly idempotencyKey: string | null;
  readonly generatedAt: string | null;
  readonly sizeBytes: number | null;
  readonly verify: {
    readonly state: 'idle' | 'ok' | 'mismatch';
    readonly reason: string | null;
    readonly detail: string | null;
    readonly observedChecksum: string | null;
    readonly observedContentDigest: string | null;
  };
}

const IDLE_SLOT: EnqueueSlotState = Object.freeze({
  state: 'idle',
  jobId: null,
  artifactPath: null,
  contentDigest: null,
  checksum: null,
  reportSpecVersion: null,
  failureReason: null,
  idempotencyKey: null,
  generatedAt: null,
  sizeBytes: null,
  verify: { state: 'idle', reason: null, detail: null, observedChecksum: null, observedContentDigest: null },
}) as EnqueueSlotState;

// Bridge type — the preload exposes exactly this shape as
// `window.horizon`. Narrow local type to keep the renderer free of
// preload internals.
type BridgeCallResult = { ok: true; envelope: unknown } | { ok: false; error: unknown };
type Bridge = {
  desktopData: (key: string, input?: unknown) => Promise<BridgeCallResult>;
  selectExportFolder: () => Promise<{ folder: string | null }>;
};

function bridge(): Bridge {
  return (window as unknown as { horizon: Bridge }).horizon;
}

export function ReportsScreen() {
  const list = useDesktopData('reports.get');
  const jobs = useDesktopData('reports.list');
  const [format, setFormat] = useState<ReportFormat>('json');
  const [targetFolder, setTargetFolder] = useState<string>('');
  const [referenceIds, setReferenceIds] = useState<Partial<Record<ReportKind, string>>>({});
  const [slots, setSlots] = useState<Partial<Record<ReportKind, EnqueueSlotState>>>({});

  // Prefer a HORIZON_REPORT_DIR default when the preload has exposed
  // it — this keeps native tests deterministic without an operator
  // dialog interaction.
  useEffect(() => {
    const initial = (window as unknown as { horizon?: { defaultReportDir?: string } }).horizon?.defaultReportDir;
    if (typeof initial === 'string' && initial.length > 0) setTargetFolder(initial);
  }, []);

  const pickFolder = useCallback(async () => {
    const res = await bridge().selectExportFolder();
    if (res.folder) setTargetFolder(res.folder);
  }, []);

  const enqueue = useCallback(async (kind: ReportKind) => {
    if (!targetFolder) return;
    const referenceId = REFERENCE_ID_REQUIRED.has(kind) ? (referenceIds[kind] ?? null) : null;
    if (REFERENCE_ID_REQUIRED.has(kind) && (referenceId === null || referenceId.trim() === '')) {
      setSlots((prev) => ({ ...prev, [kind]: { ...(prev[kind] ?? IDLE_SLOT), state: 'failed', failureReason: 'reference_id_required' } }));
      return;
    }
    setSlots((prev) => ({ ...prev, [kind]: { ...(prev[kind] ?? IDLE_SLOT), state: 'running' } }));
    const raw = await bridge().desktopData('reports.enqueue', {
      reportKind: kind, format, targetFolder, referenceId, requestOptions: {},
    });
    if (!raw.ok) {
      setSlots((prev) => ({ ...prev, [kind]: { ...(prev[kind] ?? IDLE_SLOT), state: 'failed', failureReason: `enqueue_failed:${JSON.stringify(raw.error).slice(0, 200)}` } }));
      return;
    }
    const env = raw.envelope as ExportEnqueueEnvelope;
    const data = env.data;
    if (env.status !== 'healthy' || !data) {
      setSlots((prev) => ({ ...prev, [kind]: { ...(prev[kind] ?? IDLE_SLOT), state: 'failed', failureReason: env.reasonCode ?? 'export_failed' } }));
      return;
    }
    setSlots((prev) => ({
      ...prev,
      [kind]: {
        state: 'completed',
        jobId: data.jobId,
        artifactPath: data.artifactPath,
        contentDigest: data.contentDigest,
        checksum: data.checksumSha256,
        reportSpecVersion: data.reportSpecVersion,
        failureReason: data.failureReason,
        idempotencyKey: data.idempotencyKey,
        generatedAt: env.generatedAt,
        sizeBytes: null,
        verify: { state: 'idle', reason: null, detail: null, observedChecksum: null, observedContentDigest: null },
      },
    }));
    // Follow-up: fetch size + generatedAt from status.
    void bridge().desktopData('reports.status', { jobId: data.jobId }).then((r) => {
      if (!r.ok) return;
      const senv = r.envelope as ExportStatusEnvelope;
      const sdata = senv.data;
      if (senv.status !== 'healthy' || !sdata) return;
      setSlots((prev) => ({
        ...prev,
        [kind]: {
          ...(prev[kind] ?? IDLE_SLOT),
          sizeBytes: sdata.artifact?.sizeBytes ?? null,
        },
      }));
    });
    jobs.refresh();
  }, [format, targetFolder, referenceIds, jobs]);

  const verifyJob = useCallback(async (kind: ReportKind, jobId: number) => {
    const raw = await bridge().desktopData('reports.verify', { jobId });
    if (!raw.ok) return;
    const env = raw.envelope as ExportVerifyEnvelope;
    const data = env.data;
    if (!data) return;
    setSlots((prev) => ({
      ...prev,
      [kind]: {
        ...(prev[kind] ?? IDLE_SLOT),
        verify: {
          state: data.ok ? 'ok' : 'mismatch',
          reason: data.reason,
          detail: data.detail,
          observedChecksum: data.checksumSha256,
          observedContentDigest: data.contentDigest,
        },
      },
    }));
  }, []);

  return (
    <ScreenLayout
      title="Reports"
      subtitle="Stage 4 — deterministic, content-addressable report generation."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — reports are read-only exports.' }}
    >
      <section data-testid="reports-controls">
        <div className="grid grid-4" style={{ marginBottom: '1rem' }}>
          <label>
            Format
            <select data-testid="format-select" value={format} onChange={(e) => setFormat(e.target.value as ReportFormat)}>
              {FORMATS.map((f) => (<option key={f} value={f}>{f.toUpperCase()}</option>))}
            </select>
          </label>
          <label>
            Target folder
            <input data-testid="target-folder-input" type="text" value={targetFolder} onChange={(e) => setTargetFolder(e.target.value)} placeholder="/path/to/export/folder" />
          </label>
          <button data-testid="pick-folder-button" type="button" onClick={pickFolder}>Pick folder…</button>
          <div data-testid="target-folder-current" data-target-folder={targetFolder}>{targetFolder || '(no folder selected)'}</div>
        </div>
      </section>

      <h2>Report catalog</h2>
      <StateFrame label="reports.get" state={list.state} envelope={list.envelope} error={list.error} refresh={list.refresh}>
        {(p) => (
          <table className="data" data-testid="report-catalog-table">
            <thead>
              <tr><th>Kind</th><th>Label</th><th>Available formats</th><th>Reference required</th><th>Action</th><th>Result</th></tr>
            </thead>
            <tbody>
              {REPORT_KINDS.map((kind) => {
                const catalog = p.catalog.find((c) => c.kind === kind);
                const slot = slots[kind] ?? IDLE_SLOT;
                const requiresRef = REFERENCE_ID_REQUIRED.has(kind);
                return (
                  <tr key={kind} data-testid={`report-row-${kind}`} data-report-kind={kind} data-export-state={slot.state}>
                    <td>{kind}</td>
                    <td>{catalog?.label ?? kind}</td>
                    <td data-export-format={format}>{FORMATS.join(', ')}</td>
                    <td>
                      {requiresRef ? (
                        <input
                          data-testid={`reference-id-${kind}`}
                          type="text"
                          value={referenceIds[kind] ?? ''}
                          onChange={(e) => setReferenceIds((prev) => ({ ...prev, [kind]: e.target.value }))}
                          placeholder="chain id"
                        />
                      ) : '—'}
                    </td>
                    <td>
                      <button
                        type="button"
                        data-testid={`generate-${kind}`}
                        onClick={() => enqueue(kind)}
                        disabled={slot.state === 'queued' || slot.state === 'running' || !targetFolder}
                      >
                        {slot.state === 'running' ? 'Running…' : 'Generate'}
                      </button>
                    </td>
                    <td>
                      {slot.state === 'completed' && slot.jobId !== null ? (
                        <span data-testid={`result-${kind}`} data-job-id={slot.jobId} data-content-digest={slot.contentDigest ?? ''} data-checksum={slot.checksum ?? ''}>
                          <div>job {slot.jobId} · {slot.reportSpecVersion}</div>
                          <div>digest {slot.contentDigest?.slice(0, 16)}…</div>
                          <div>sha256 {slot.checksum?.slice(0, 16)}…</div>
                          {slot.sizeBytes !== null && <div>{slot.sizeBytes} bytes</div>}
                          {slot.generatedAt && <div>at {slot.generatedAt}</div>}
                          <button
                            type="button"
                            data-testid={`verify-${kind}`}
                            onClick={() => verifyJob(kind, slot.jobId!)}
                          >Verify</button>
                          {slot.verify.state !== 'idle' && (
                            <div data-testid={`verify-result-${kind}`} data-verification-state={slot.verify.state}>
                              {slot.verify.state === 'ok'
                                ? <span className="state-badge healthy">OK</span>
                                : <span className="state-badge danger">MISMATCH: {slot.verify.reason ?? 'unknown'}</span>}
                              {slot.verify.detail && <div style={{ fontSize: '0.85em' }}>{slot.verify.detail}</div>}
                            </div>
                          )}
                        </span>
                      ) : slot.state === 'failed' ? (
                        <span data-testid={`result-${kind}`} className="state-badge danger" data-export-state="failed">
                          Failed: {slot.failureReason ?? 'unknown'}
                        </span>
                      ) : slot.state === 'idle' ? '—' : slot.state}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </StateFrame>

      <h2>Export-job history (installation-scoped)</h2>
      <StateFrame label="reports.list" state={jobs.state} envelope={jobs.envelope} error={jobs.error} refresh={jobs.refresh}>
        {(p) => (
          <table className="data" data-testid="report-jobs-table">
            <thead>
              <tr><th>Job</th><th>Kind</th><th>Format</th><th>Status</th><th>Requested</th><th>Completed</th><th>Content digest</th><th>Checksum</th></tr>
            </thead>
            <tbody>
              {p.items.length === 0
                ? (<tr><td colSpan={8} className="empty">No jobs yet.</td></tr>)
                : p.items.map((r: ExportListItem) => (
                  <tr key={r.jobId} data-testid={`job-row-${r.jobId}`} data-job-id={r.jobId} data-report-kind={r.reportKind} data-export-format={r.format} data-export-state={r.status}>
                    <td>{r.jobId}</td>
                    <td>{r.reportKind}</td>
                    <td>{r.format}</td>
                    <td><span className={`state-badge ${r.status}`}>{r.status}</span></td>
                    <td>{r.requestedAt}</td>
                    <td>{r.completedAt ?? '—'}</td>
                    <td data-content-digest={r.contentDigest ?? ''}>{r.contentDigest?.slice(0, 16) ?? '—'}</td>
                    <td data-checksum={r.checksumSha256 ?? ''}>{r.checksumSha256?.slice(0, 16) ?? '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </StateFrame>
    </ScreenLayout>
  );
}
