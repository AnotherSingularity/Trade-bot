import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../../theme';

export function SectionHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
  },
  title: {
    color: theme.colors.secondary,
    fontSize: 12,
    letterSpacing: 1.5,
    fontFamily: theme.fonts.mono,
  },
});
