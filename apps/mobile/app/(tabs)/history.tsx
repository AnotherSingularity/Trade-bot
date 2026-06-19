import { useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { HistoryFilter } from '@horizon/shared';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { TradeHistoryRow } from '../../components/trading/TradeHistoryRow';
import { EmptyState } from '../../components/ui/EmptyState';
import { trpc } from '../../lib/trpc';
import { usd } from '../../lib/format';
import { theme, pnlColor } from '../../theme';

const FILTERS: { key: HistoryFilter; label: string }[] = [
  { key: 'all', label: 'ALL' },
  { key: 'wins', label: 'WINS' },
  { key: 'losses', label: 'LOSSES' },
];

export default function HistoryScreen() {
  const [filter, setFilter] = useState<HistoryFilter>('all');

  const query = trpc.history.list.useInfiniteQuery(
    { filter, limit: 20 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );

  const trades = useMemo(
    () => query.data?.pages.flatMap((p) => p.trades) ?? [],
    [query.data],
  );
  const summary = query.data?.pages[0]?.summary;

  return (
    <ErrorBoundary>
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.summaryBar}>
          <Stat label="TRADES" value={String(summary?.totalTrades ?? 0)} />
          <Stat
            label="WIN RATE"
            value={`${(summary?.winRate ?? 0).toFixed(0)}%`}
            color={theme.colors.green}
          />
          <Stat
            label="NET P&L"
            value={usd(summary?.totalPnlDollars ?? 0)}
            color={pnlColor(summary?.totalPnlDollars ?? 0)}
          />
        </View>

        <View style={styles.tabs}>
          {FILTERS.map((f) => (
            <TouchableOpacity
              key={f.key}
              style={[styles.tab, filter === f.key && styles.tabActive]}
              onPress={() => setFilter(f.key)}
            >
              <Text style={[styles.tabText, filter === f.key && styles.tabTextActive]}>
                {f.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <FlatList
          data={trades}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => <TradeHistoryRow trade={item} />}
          onEndReached={() => query.hasNextPage && query.fetchNextPage()}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            <EmptyState
              message={query.isLoading ? 'Loading trades…' : 'No trades yet'}
            />
          }
        />
      </SafeAreaView>
    </ErrorBoundary>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.bg },
  summaryBar: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingVertical: theme.spacing.md,
  },
  stat: { flex: 1, alignItems: 'center' },
  statLabel: { color: theme.colors.muted, fontSize: 9, letterSpacing: 1, fontFamily: theme.fonts.mono },
  statValue: { color: theme.colors.white, fontSize: 16, fontFamily: theme.fonts.monoBold, marginTop: 2 },
  tabs: { flexDirection: 'row', padding: theme.spacing.md, gap: theme.spacing.sm },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  tabActive: { borderColor: theme.colors.green, backgroundColor: theme.colors.surface },
  tabText: { color: theme.colors.secondary, fontSize: 12, fontFamily: theme.fonts.mono, letterSpacing: 1 },
  tabTextActive: { color: theme.colors.green },
  list: { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.xl },
});
