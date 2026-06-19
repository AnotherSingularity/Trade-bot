import { StyleSheet, Text, View } from 'react-native';
import type { Position } from '@horizon/shared';
import { theme, pnlColor } from '../../theme';
import { price, pct, usd } from '../../lib/format';

const MODE_COLOR: Record<Position['mode'], string> = {
  reversion: theme.colors.amber,
  breakout: theme.colors.green,
  macro: theme.colors.secondary,
};

export function PositionCard({ position }: { position: Position }) {
  const pnl = position.unrealizedPnlDollars ?? 0;
  const pnlPctValue = position.unrealizedPnlPct ?? 0;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.tokenRow}>
          <Text style={styles.token}>{position.token}</Text>
          <View style={[styles.modeBadge, { borderColor: MODE_COLOR[position.mode] }]}>
            <Text style={[styles.modeText, { color: MODE_COLOR[position.mode] }]}>
              {position.mode.toUpperCase()}
            </Text>
          </View>
        </View>
        <Text style={[styles.pnl, { color: pnlColor(pnl) }]}>{pct(pnlPctValue)}</Text>
      </View>

      <View style={styles.grid}>
        <Metric label="ENTRY" value={price(position.entryPrice)} />
        <Metric label="CURRENT" value={price(position.currentPrice)} />
        <Metric label="P&L" value={usd(pnl)} color={pnlColor(pnl)} />
      </View>
      <View style={styles.grid}>
        <Metric label="TAKE PROFIT" value={price(position.takeProfitPrice)} color={theme.colors.green} />
        <Metric label="STOP LOSS" value={price(position.stopLossPrice)} color={theme.colors.red} />
        <Metric label="ALLOC" value={`${position.allocationPct}%`} />
      </View>
    </View>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: theme.spacing.sm,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tokenRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  token: { color: theme.colors.white, fontSize: 18, fontFamily: theme.fonts.monoBold },
  modeBadge: {
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  modeText: { fontSize: 9, letterSpacing: 1, fontFamily: theme.fonts.mono },
  pnl: { fontSize: 18, fontFamily: theme.fonts.monoBold },
  grid: { flexDirection: 'row', marginTop: theme.spacing.md, justifyContent: 'space-between' },
  metric: { flex: 1 },
  metricLabel: { color: theme.colors.muted, fontSize: 9, letterSpacing: 0.5, fontFamily: theme.fonts.mono },
  metricValue: { color: theme.colors.white, fontSize: 13, fontFamily: theme.fonts.mono, marginTop: 2 },
});
