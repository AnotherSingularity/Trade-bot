import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../../theme';

export function EmptyState({ message }: { message: string }) {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingVertical: theme.spacing.xl, alignItems: 'center' },
  text: { color: theme.colors.muted, fontSize: 13, fontFamily: theme.fonts.mono },
});
