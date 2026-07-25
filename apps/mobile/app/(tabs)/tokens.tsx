import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { SafetyBanner } from '../../components/trading/SafetyBanner';
import { TokenRow } from '../../components/trading/TokenRow';
import { EmptyState } from '../../components/ui/EmptyState';
import { trpc } from '../../lib/trpc';
import { compactUsd } from '../../lib/format';
import { theme } from '../../theme';

export default function TokensScreen() {
  const utils = trpc.useUtils();
  const status = trpc.trading.status.useQuery(undefined, { refetchInterval: 15_000 });
  const tokens = trpc.tokens.list.useQuery(undefined, { refetchInterval: 15_000 });
  const volumeFilter = trpc.tokens.volumeFilter.useQuery();
  const setActive = trpc.tokens.setActive.useMutation({
    onSettled: () => utils.tokens.list.invalidate(),
  });

  return (
    <ErrorBoundary>
      <SafeAreaView style={styles.container} edges={['top']}>
        <SafetyBanner status={status.data} />
        <View style={styles.header}>
          <Text style={styles.title}>TOKEN UNIVERSE</Text>
          <View style={styles.filterBadge}>
            <Text style={styles.filterText}>
              MIN VOL {compactUsd(volumeFilter.data?.minVolume24h ?? 500000)}
            </Text>
          </View>
        </View>

        <FlatList
          data={tokens.data ?? []}
          keyExtractor={(item) => item.token}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <TokenRow
              entry={item}
              onToggleActive={(token, isActive) => setActive.mutate({ token, isActive })}
            />
          )}
          ListEmptyComponent={
            <EmptyState message={tokens.isLoading ? 'Loading tokens…' : 'No tokens available'} />
          }
        />
      </SafeAreaView>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: theme.spacing.md,
  },
  title: { color: theme.colors.white, fontSize: 16, letterSpacing: 1.5, fontFamily: theme.fonts.monoBold },
  filterBadge: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 4,
  },
  filterText: { color: theme.colors.secondary, fontSize: 10, fontFamily: theme.fonts.mono },
  list: { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.xl },
});
