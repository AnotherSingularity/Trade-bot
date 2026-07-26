import { KVCard, ScreenLayout } from '../components/ScreenLayout';
import { StateFrame } from '../components/StateFrame';
import { useDesktopData } from '../hooks/useDesktopData';

export function ConfigurationScreen() {
  const { state, envelope, error, refresh } = useDesktopData('configuration.get');
  return (
    <ScreenLayout
      title="Configuration"
      subtitle="Sanitized read-only configuration. Safety-critical values are immutable."
      banner={{ kind: 'danger', text: 'LIVE ORDER SUBMISSION DISABLED — Safe flags, provider mode, and observer versions are read-only.' }}
    >
      <StateFrame label="configuration.get" state={state} envelope={envelope} error={error} refresh={refresh}>
        {(cfg) => (
          <>
            <h2>Safe flags (read-only)</h2>
            <div className="grid grid-4">
              <KVCard label="DRY_RUN" value={String(cfg.safeFlags.DRY_RUN)} status="healthy" />
              <KVCard label="ORDER_SUBMISSION_ENABLED" value={String(cfg.safeFlags.ORDER_SUBMISSION_ENABLED)} status="disabled" />
              <KVCard label="SIMULATION_MODE" value={cfg.safeFlags.SIMULATION_MODE} />
              <KVCard label="Safety-critical read-only" value={String(cfg.safetyCriticalReadOnly)} status="healthy" />
            </div>
            <h2>Startup + services</h2>
            <div className="grid grid-4">
              <KVCard label="Startup behavior" value={cfg.desktopStartupBehavior} />
              <KVCard label="Service mode" value={cfg.serviceMode} />
              <KVCard label="Database mode" value={cfg.databaseMode} />
              <KVCard label="Redis mode" value={cfg.redisMode} />
              <KVCard label="Provider mode" value={cfg.providerMode} />
            </div>
            <h2>Retention + reports</h2>
            <div className="grid grid-4">
              <KVCard label="Log retention (days)" value={cfg.retention.logRetentionDays} />
              <KVCard label="Raw event retention (days)" value={cfg.retention.rawEventRetentionDays} />
              <KVCard label="Report location" value={cfg.reportLocation || '—'} />
              <KVCard label="Report schedule" value={cfg.reportSchedule} />
              <KVCard label="Display time zone" value={cfg.timeZoneDisplay} />
            </div>
            <h2>Observer policy versions</h2>
            <div className="grid grid-3">
              {Object.entries(cfg.observerPolicyVersions).map(([k, v]) => (
                <KVCard key={k} label={k} value={v} status="observer-only" />
              ))}
            </div>
            <h2>Credential health (never the credentials themselves)</h2>
            <div className="grid grid-3">
              {Object.entries(cfg.credentialStatus).map(([k, v]) => (
                <KVCard key={k} label={k} value={v} status={v === 'present_encrypted' ? 'healthy' : v} />
              ))}
            </div>
            <p className="subtitle">
              This screen exposes sanitized configuration only. Raw environment variables,
              connection strings, tokens, and secrets are never returned by the API.
            </p>
          </>
        )}
      </StateFrame>
    </ScreenLayout>
  );
}
