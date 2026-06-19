import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { MarketWindow } from '@horizon/shared';
import { theme } from '../../theme';

const WINDOW_META: Record<MarketWindow, { color: string; label: string }> = {
  PRIME: { color: theme.colors.green, label: 'PRIME WINDOW' },
  ACTIVE: { color: theme.colors.amber, label: 'ACTIVE WINDOW' },
  CLOSED: { color: theme.colors.muted, label: 'MARKET CLOSED' },
};

/**
 * Shows the current market window. Re-renders every minute so the local EST
 * clock stays in sync with the server's window calculation.
 */
export function MarketWindowBadge({ window }: { window: MarketWindow | undefined }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const meta = WINDOW_META[window ?? 'CLOSED'];
  return (
    <View style={[styles.badge, { borderColor: meta.color }]}>
      <View style={[styles.dot, { backgroundColor: meta.color }]} />
      <Text style={[styles.text, { color: meta.color }]}>{meta.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 4,
    gap: 6,
    alignSelf: 'flex-start',
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { fontSize: 10, letterSpacing: 1, fontFamily: theme.fonts.mono },
});
