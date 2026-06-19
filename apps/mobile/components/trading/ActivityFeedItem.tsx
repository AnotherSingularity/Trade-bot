import { StyleSheet, Text, View } from 'react-native';
import type { ActivityLogEntry } from '@horizon/shared';
import { theme } from '../../theme';
import { relativeTime } from '../../lib/format';

const TYPE_COLOR: Record<ActivityLogEntry['type'], string> = {
  scan: theme.colors.secondary,
  signal: theme.colors.amber,
  trade: theme.colors.green,
  system: theme.colors.white,
  error: theme.colors.red,
};

export function ActivityFeedItem({ entry }: { entry: ActivityLogEntry }) {
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: TYPE_COLOR[entry.type] }]} />
      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Text style={styles.action}>
            {entry.token ? `${entry.token} · ` : ''}
            {entry.action}
          </Text>
          <Text style={styles.time}>{relativeTime(entry.createdAt)}</Text>
        </View>
        <Text style={styles.detail} numberOfLines={2}>
          {entry.detail}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingVertical: theme.spacing.sm, gap: theme.spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  content: { flex: 1 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between' },
  action: {
    color: theme.colors.white,
    fontSize: 12,
    fontFamily: theme.fonts.monoBold,
    letterSpacing: 0.5,
  },
  time: { color: theme.colors.muted, fontSize: 10, fontFamily: theme.fonts.mono },
  detail: { color: theme.colors.secondary, fontSize: 12, marginTop: 2, fontFamily: theme.fonts.sans },
});
