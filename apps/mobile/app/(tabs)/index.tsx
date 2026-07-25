import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { PortfolioHeader } from '../../components/trading/PortfolioHeader';
import { PositionCard } from '../../components/trading/PositionCard';
import { ActivityFeedItem } from '../../components/trading/ActivityFeedItem';
import { MarketWindowBadge } from '../../components/trading/MarketWindowBadge';
import { BotControlBar } from '../../components/trading/BotControlBar';
import { SafetyBanner } from '../../components/trading/SafetyBanner';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { EmptyState } from '../../components/ui/EmptyState';
import { useBotStatus } from '../../hooks/useBotStatus';
import { usePortfolio, useActivity } from '../../hooks/usePortfolio';
import { useNotifications } from '../../hooks/useNotifications';
import { theme } from '../../theme';

export default function DashboardScreen() {
  const bot = useBotStatus();
  const { portfolio, isLoading } = usePortfolio();
  const { items: activity } = useActivity();

  // Fire local notifications for trade events while the bot is running.
  useNotifications(bot.isRunning);

  return (
    <ErrorBoundary>
      <SafeAreaView style={styles.container} edges={['top']}>
        <SafetyBanner status={bot.status} />
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.topRow}>
            <MarketWindowBadge window={bot.status?.marketWindow} />
            {bot.status?.circuitBreakerActive ? (
              <MarketWindowBadge window="CLOSED" />
            ) : null}
          </View>

          <PortfolioHeader portfolio={portfolio} isLoading={isLoading} />

          <View style={styles.controls}>
            <BotControlBar
              isRunning={bot.isRunning}
              isPaused={bot.isPaused}
              isScanning={bot.isScanning}
              isLive={bot.isLive}
              onStart={bot.start}
              onStop={bot.stop}
              onPause={bot.pause}
              onScanNow={bot.scanNow}
              onEmergencyKill={bot.emergencyKill}
            />
          </View>

          <SectionHeader title="OPEN POSITIONS" />
          {portfolio && portfolio.openPositions.length > 0 ? (
            portfolio.openPositions.map((p) => <PositionCard key={p.id} position={p} />)
          ) : (
            <EmptyState message="No open positions" />
          )}

          <SectionHeader title="ACTIVITY FEED" />
          {activity.length > 0 ? (
            <View style={styles.feed}>
              {activity.map((entry) => (
                <ActivityFeedItem key={entry.id} entry={entry} />
              ))}
            </View>
          ) : (
            <EmptyState message="No recent activity" />
          )}
        </ScrollView>
      </SafeAreaView>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.bg },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  topRow: { flexDirection: 'row', gap: theme.spacing.sm, marginBottom: theme.spacing.md },
  controls: { marginTop: theme.spacing.md },
  feed: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
  },
});
