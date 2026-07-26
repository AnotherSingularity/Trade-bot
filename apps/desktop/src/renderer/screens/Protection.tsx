import { ScreenLayout, EmptyState } from '../components/ScreenLayout';

export function ProtectionScreen() {
  return (
    <ScreenLayout
      title="Protection"
      subtitle="Protection policies, capabilities, validation records and bracket-leg state."
      banner={{ kind: 'info', text: 'Protection is required for every candidate; degradation is capability-gated.' }}
    >
      <h2>Active protection policies</h2>
      <EmptyState message="Protection policies are surfaced from Gate 3C policy tables." />
      <h2>Recent protection instances</h2>
      <EmptyState message="Instances are recorded per candidate with partial-fill tracking." />
      <h2>Degradation events</h2>
      <EmptyState message="Degradation follows the evaluated protection-capability policy." />
    </ScreenLayout>
  );
}
