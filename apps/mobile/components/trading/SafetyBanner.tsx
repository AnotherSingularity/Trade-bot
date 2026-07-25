import { StyleSheet, Text, View } from 'react-native';
import type { BotStatus } from '@horizon/shared';
import { theme } from '../../theme';

/**
 * Persistent safety banner — mounted at the top of every authenticated screen.
 *
 * Renders visually distinct states so the operator ALWAYS sees:
 *   • Whether the deployment is DRY_RUN or LIVE (LIVE uses a red high-risk
 *     presentation).
 *   • Whether startup reconciliation is complete (blocks new entries).
 *   • Whether protective orders are exchange-native, polling-fallback, or
 *     unprotected (warning icon + label).
 */
export function SafetyBanner({ status }: { status: BotStatus | undefined }) {
  if (!status) return null;

  const isLive = !status.dryRun;
  const bg = isLive ? theme.colors.red : theme.colors.surface;
  const border = isLive ? theme.colors.red : theme.colors.border;
  const modeLabel = isLive ? '🔴 LIVE — REAL CAPITAL' : 'DRY RUN — SIMULATED';
  const modeColor = isLive ? theme.colors.white : theme.colors.green;

  const recon = status.reconciliationStatus;
  const reconOk = recon === 'ok';
  const reconLabel = reconOk
    ? null
    : recon === 'in_progress'
      ? 'Reconciling exchange state — entries disabled'
      : recon === 'failed'
        ? 'Reconciliation FAILED — entries disabled until resolved'
        : 'Reconciliation pending';
  const reconColor =
    recon === 'failed' ? theme.colors.red : recon === 'in_progress' ? theme.colors.amber : theme.colors.muted;

  const protection = status.protectionMode;
  const protectionLabel =
    protection === 'exchange_bracket'
      ? 'Protection: exchange brackets'
      : protection === 'polling_fallback'
        ? 'Protection: application polling (offline risk)'
        : 'UNPROTECTED — no stop protection';
  const protectionColor =
    protection === 'unprotected'
      ? theme.colors.red
      : protection === 'polling_fallback'
        ? theme.colors.amber
        : theme.colors.green;

  return (
    <View style={[styles.container, { backgroundColor: bg, borderColor: border }]}>
      <Text style={[styles.mode, { color: modeColor }]}>{modeLabel}</Text>
      {reconLabel ? (
        <Text style={[styles.line, { color: reconColor }]}>{reconLabel}</Text>
      ) : null}
      <Text style={[styles.line, { color: protectionColor }]}>{protectionLabel}</Text>
      <Text style={styles.version}>Strategy v{status.strategyVersion}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: 1,
  },
  mode: { fontSize: 11, letterSpacing: 1.5, fontFamily: theme.fonts.monoBold },
  line: { fontSize: 10, marginTop: 2, fontFamily: theme.fonts.mono },
  version: { color: theme.colors.muted, fontSize: 9, marginTop: 2, fontFamily: theme.fonts.mono },
});
