import { StyleSheet, Text, View } from 'react-native';
import type { PortfolioSummary } from '@horizon/shared';
import { theme, pnlColor } from '../../theme';
import { usd, pct } from '../../lib/format';

interface Props {
  portfolio: PortfolioSummary | undefined;
  isLoading: boolean;
}

export function PortfolioHeader({ portfolio, isLoading }: Props) {
  const total = portfolio?.totalValue ?? 0;
  const pnl = portfolio?.unrealizedPnlDollars ?? 0;
  const pnlPctValue = portfolio?.unrealizedPnlPct ?? 0;

  return (
    <View style={styles.container}>
      <Text style={styles.label}>PORTFOLIO VALUE</Text>
      <Text style={styles.value}>{isLoading && !portfolio ? '—' : usd(total)}</Text>
      <View style={styles.row}>
        <Text style={[styles.pnl, { color: pnlColor(pnl) }]}>
          {usd(pnl)} ({pct(pnlPctValue)})
        </Text>
      </View>
      <View style={styles.breakdown}>
        <View style={styles.breakdownItem}>
          <Text style={styles.breakdownLabel}>CASH</Text>
          <Text style={styles.breakdownValue}>{usd(portfolio?.cashBalance ?? 0)}</Text>
        </View>
        <View style={styles.breakdownItem}>
          <Text style={styles.breakdownLabel}>POSITIONS</Text>
          <Text style={styles.breakdownValue}>{usd(portfolio?.positionsValue ?? 0)}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  label: {
    color: theme.colors.secondary,
    fontSize: 11,
    letterSpacing: 1.5,
    fontFamily: theme.fonts.mono,
  },
  value: {
    color: theme.colors.white,
    fontSize: 36,
    fontFamily: theme.fonts.monoBold,
    marginTop: theme.spacing.xs,
  },
  row: { flexDirection: 'row', marginTop: theme.spacing.xs },
  pnl: { fontSize: 16, fontFamily: theme.fonts.mono },
  breakdown: {
    flexDirection: 'row',
    marginTop: theme.spacing.md,
    gap: theme.spacing.xl,
  },
  breakdownItem: {},
  breakdownLabel: {
    color: theme.colors.muted,
    fontSize: 10,
    letterSpacing: 1,
    fontFamily: theme.fonts.mono,
  },
  breakdownValue: {
    color: theme.colors.white,
    fontSize: 15,
    fontFamily: theme.fonts.mono,
    marginTop: 2,
  },
});
