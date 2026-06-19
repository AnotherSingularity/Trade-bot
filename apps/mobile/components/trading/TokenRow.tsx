import { StyleSheet, Switch, Text, View } from 'react-native';
import type { TokenUniverseEntry } from '@horizon/shared';
import { theme, pnlColor } from '../../theme';
import { price, pct, compactUsd } from '../../lib/format';

interface Props {
  entry: TokenUniverseEntry;
  onToggleActive: (token: string, isActive: boolean) => void;
}

export function TokenRow({ entry, onToggleActive }: Props) {
  return (
    <View style={styles.row}>
      <View style={styles.left}>
        <Text style={styles.token}>{entry.token}</Text>
        <View style={styles.subRow}>
          <Text style={styles.volume}>VOL {compactUsd(entry.volume24h)}</Text>
          {!entry.passesVolumeFilter && entry.volume24h !== null ? (
            <Text style={styles.lowVol}>LOW</Text>
          ) : null}
        </View>
      </View>

      <View style={styles.center}>
        <Text style={styles.price}>{price(entry.price)}</Text>
        <Text style={[styles.change, { color: pnlColor(entry.changePct24h ?? 0) }]}>
          {pct(entry.changePct24h)}
        </Text>
      </View>

      <View style={styles.right}>
        <Text style={styles.winRate}>
          {entry.winRate === null ? '—' : `${entry.winRate.toFixed(0)}%`}
        </Text>
        <Text style={styles.winRateLabel}>
          {entry.totalTrades > 0 ? `${entry.totalTrades} trades` : 'no trades'}
        </Text>
      </View>

      <Switch
        value={entry.isActive}
        onValueChange={(v) => onToggleActive(entry.token, v)}
        trackColor={{ false: theme.colors.muted, true: theme.colors.green }}
        thumbColor={theme.colors.white}
      />
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
    gap: theme.spacing.sm,
  },
  left: { width: 90 },
  token: { color: theme.colors.white, fontSize: 15, fontFamily: theme.fonts.monoBold },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  volume: { color: theme.colors.muted, fontSize: 10, fontFamily: theme.fonts.mono },
  lowVol: { color: theme.colors.red, fontSize: 9, fontFamily: theme.fonts.mono },
  center: { flex: 1 },
  price: { color: theme.colors.white, fontSize: 13, fontFamily: theme.fonts.mono },
  change: { fontSize: 11, fontFamily: theme.fonts.mono, marginTop: 2 },
  right: { width: 64, alignItems: 'flex-end' },
  winRate: { color: theme.colors.white, fontSize: 14, fontFamily: theme.fonts.monoBold },
  winRateLabel: { color: theme.colors.muted, fontSize: 9, fontFamily: theme.fonts.mono },
});
