import { StyleSheet, Text, View } from 'react-native';
import type { Trade } from '@horizon/shared';
import { theme, pnlColor } from '../../theme';
import { price, pct, usd, relativeTime } from '../../lib/format';

export function TradeHistoryRow({ trade }: { trade: Trade }) {
  const isClosed = trade.outcome !== 'open';
  const pnl = trade.pnlDollars ?? 0;

  return (
    <View style={styles.row}>
      <View style={styles.left}>
        <View style={styles.tokenRow}>
          <Text style={styles.token}>{trade.token}</Text>
          <Text style={styles.mode}>{trade.mode}</Text>
        </View>
        <Text style={styles.time}>
          {trade.side.toUpperCase()} · {relativeTime(trade.executedAt)}
        </Text>
      </View>

      <View style={styles.middle}>
        <Text style={styles.detail}>
          {price(trade.entryPrice)}
          {trade.exitPrice !== null ? ` → ${price(trade.exitPrice)}` : ''}
        </Text>
      </View>

      <View style={styles.right}>
        {isClosed ? (
          <>
            <Text style={[styles.pnl, { color: pnlColor(pnl) }]}>{usd(pnl)}</Text>
            <Text style={[styles.pnlPct, { color: pnlColor(pnl) }]}>{pct(trade.pnlPct)}</Text>
          </>
        ) : (
          <Text style={styles.open}>OPEN</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  left: { flex: 1.2 },
  tokenRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  token: { color: theme.colors.white, fontSize: 14, fontFamily: theme.fonts.monoBold },
  mode: { color: theme.colors.secondary, fontSize: 10, fontFamily: theme.fonts.mono },
  time: { color: theme.colors.muted, fontSize: 10, fontFamily: theme.fonts.mono, marginTop: 2 },
  middle: { flex: 1.4 },
  detail: { color: theme.colors.secondary, fontSize: 11, fontFamily: theme.fonts.mono },
  right: { flex: 0.9, alignItems: 'flex-end' },
  pnl: { fontSize: 14, fontFamily: theme.fonts.monoBold },
  pnlPct: { fontSize: 11, fontFamily: theme.fonts.mono, marginTop: 2 },
  open: { color: theme.colors.amber, fontSize: 11, fontFamily: theme.fonts.mono },
});
