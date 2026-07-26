import { ScreenLayout, EmptyState } from '../components/ScreenLayout';

export function IncidentsScreen() {
  return (
    <ScreenLayout
      title="Incidents"
      subtitle="Desktop and system incidents. Each preserves logs, environment snapshot and remediation notes."
      banner={{ kind: 'info', text: 'Incidents surface from desktop_incidents (Phase 3A) and legacy incident tables.' }}
    >
      <h2>Open incidents</h2>
      <EmptyState message="No open incidents in this session." />
      <h2>Recently resolved</h2>
      <EmptyState message="Recently resolved incidents include a remediation note and audit trail." />
    </ScreenLayout>
  );
}
