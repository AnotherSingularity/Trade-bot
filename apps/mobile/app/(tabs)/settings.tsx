import { useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ConnectionTestResult } from '@horizon/shared';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { trpc } from '../../lib/trpc';
import { useAuth } from '../../hooks/useAuth';
import { theme } from '../../theme';

export default function SettingsScreen() {
  const { logout } = useAuth();
  const info = trpc.settings.info.useQuery();
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const test = trpc.settings.testConnection.useMutation({
    onSuccess: (data) => setResult(data),
  });

  return (
    <ErrorBoundary>
      <SafeAreaView style={styles.container} edges={['top']}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>SETTINGS</Text>

          <SectionHeader title="STRATEGY" />
          <View style={styles.card}>
            <Row label="Strategy Version" value={`v${info.data?.strategyVersion ?? '—'}`} />
            <Row label="Token Universe" value={`${info.data?.tokenCount ?? '—'} tokens`} />
            <Row label="Max Open Positions" value={String(info.data?.maxOpenPositions ?? '—')} />
            <Row
              label="Min 24h Volume"
              value={info.data ? `$${info.data.minVolume24h.toLocaleString()}` : '—'}
            />
            <Row label="Mode" value={info.data?.dryRun ? 'DRY RUN' : 'LIVE'} last />
          </View>

          <SectionHeader title="CONNECTIONS" />
          <View style={styles.card}>
            <Row
              label="Coinbase"
              value={statusLabel(result?.coinbase.connected, info.data?.coinbaseConfigured)}
              valueColor={statusColor(result?.coinbase.connected, info.data?.coinbaseConfigured)}
            />
            {result?.coinbase.message ? (
              <Text style={styles.detail}>{result.coinbase.message}</Text>
            ) : null}
            <Row
              label="Anthropic"
              value={statusLabel(result?.anthropic.connected, info.data?.anthropicConfigured)}
              valueColor={statusColor(result?.anthropic.connected, info.data?.anthropicConfigured)}
              last
            />
            {result?.anthropic.message ? (
              <Text style={styles.detail}>{result.anthropic.message}</Text>
            ) : null}
          </View>

          <TouchableOpacity
            style={styles.testButton}
            onPress={() => test.mutate()}
            disabled={test.isPending}
            activeOpacity={0.8}
          >
            {test.isPending ? (
              <ActivityIndicator color={theme.colors.bg} />
            ) : (
              <Text style={styles.testButtonText}>TEST CONNECTION</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.logoutButton} onPress={logout} activeOpacity={0.8}>
            <Text style={styles.logoutText}>LOG OUT</Text>
          </TouchableOpacity>

          <Text style={styles.footer}>
            Horizon Holdings · Trading parameters are fixed and not editable.
          </Text>
        </ScrollView>
      </SafeAreaView>
    </ErrorBoundary>
  );
}

function statusLabel(connected: boolean | undefined, configured: boolean | undefined): string {
  if (connected === true) return 'CONNECTED';
  if (connected === false) return 'ERROR';
  return configured ? 'NOT TESTED' : 'NOT CONFIGURED';
}
function statusColor(connected: boolean | undefined, configured: boolean | undefined): string {
  if (connected === true) return theme.colors.green;
  if (connected === false) return theme.colors.red;
  return configured ? theme.colors.secondary : theme.colors.muted;
}

function Row({
  label,
  value,
  valueColor,
  last,
}: {
  label: string;
  value: string;
  valueColor?: string;
  last?: boolean;
}) {
  return (
    <View style={[styles.row, last && styles.rowLast]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.bg },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  title: { color: theme.colors.white, fontSize: 16, letterSpacing: 1.5, fontFamily: theme.fonts.monoBold },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.fonts.sans },
  rowValue: { color: theme.colors.white, fontSize: 13, fontFamily: theme.fonts.mono },
  detail: {
    color: theme.colors.muted,
    fontSize: 11,
    fontFamily: theme.fonts.mono,
    paddingBottom: theme.spacing.sm,
  },
  testButton: {
    backgroundColor: theme.colors.green,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    alignItems: 'center',
    marginTop: theme.spacing.lg,
  },
  testButtonText: { color: theme.colors.bg, fontFamily: theme.fonts.monoBold, letterSpacing: 1.5 },
  logoutButton: {
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    alignItems: 'center',
    marginTop: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.red,
  },
  logoutText: { color: theme.colors.red, fontFamily: theme.fonts.monoBold, letterSpacing: 1.5 },
  footer: {
    color: theme.colors.muted,
    fontSize: 10,
    textAlign: 'center',
    marginTop: theme.spacing.xl,
    fontFamily: theme.fonts.mono,
  },
});
