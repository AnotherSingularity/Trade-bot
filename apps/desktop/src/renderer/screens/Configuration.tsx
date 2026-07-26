import { ScreenLayout, KVCard, LoadingState } from '../components/ScreenLayout';
import { useSafeConfiguration } from '../hooks/useHorizon';

export function ConfigurationScreen() {
  const { config, loading } = useSafeConfiguration();
  const credential = config?.credentialStatus ?? {};
  return (
    <ScreenLayout
      title="Configuration"
      subtitle="Read-only safe configuration + tightly controlled operator changes. Safety flags are immutable."
      banner={{ kind: 'warn', text: 'DRY_RUN, ORDER_SUBMISSION_ENABLED and provider selection cannot be changed from this console.' }}
    >
      {loading ? <LoadingState /> : (
        <>
          <h2>Startup + services</h2>
          <div className="grid grid-4">
            <KVCard label="Startup behavior" value={config?.desktopStartupBehavior ?? '—'} />
            <KVCard label="Service mode" value={config?.serviceMode ?? '—'} />
            <KVCard label="Database mode" value={config?.databaseMode ?? '—'} />
            <KVCard label="Provider selection" value={config?.providerSelection ?? '—'} />
          </div>
          <h2>Retention + reports</h2>
          <div className="grid grid-4">
            <KVCard label="Log retention (days)" value={config?.logRetentionDays ?? 0} />
            <KVCard label="Raw event retention (days)" value={config?.rawEventRetentionDays ?? 0} />
            <KVCard label="Report location" value={config?.reportLocation || '—'} />
            <KVCard label="Report schedule" value={config?.reportSchedule ?? '—'} />
          </div>
          <h2>Time zone</h2>
          <div className="grid grid-4">
            <KVCard label="Display time zone" value={config?.timeZoneDisplay ?? '—'} />
          </div>
          <h2>Credential status</h2>
          <div className="grid grid-3">
            {Object.entries(credential).map(([k, v]) => (
              <KVCard key={k} label={k} value={v} status={v === 'present_encrypted' ? 'healthy' : v} />
            ))}
          </div>
          <h2>Observer policy versions</h2>
          <div className="grid grid-3">
            {Object.entries(config?.observerPolicyVersions ?? {}).map(([k, v]) => (
              <KVCard key={k} label={k} value={v} status="observer-only" />
            ))}
          </div>
        </>
      )}
    </ScreenLayout>
  );
}
