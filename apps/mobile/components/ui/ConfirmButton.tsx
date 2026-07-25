import { Alert, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { theme } from '../../theme';

/**
 * Button that requires operator confirmation before firing its `onConfirm`
 * handler. Used for state-changing bot controls (start, stop, pause, manual
 * close, emergency kill, live-mode activation).
 */
export function ConfirmButton({
  label,
  color,
  onConfirm,
  confirmTitle,
  confirmMessage,
  destructive,
  disabled,
}: {
  label: string;
  color: string;
  onConfirm: () => void;
  confirmTitle: string;
  confirmMessage: string;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const press = () => {
    Alert.alert(confirmTitle, confirmMessage, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: destructive ? 'Confirm' : 'OK',
        style: destructive ? 'destructive' : 'default',
        onPress: onConfirm,
      },
    ]);
  };
  return (
    <TouchableOpacity
      style={[styles.button, { borderColor: color }, disabled && styles.disabled]}
      onPress={press}
      activeOpacity={0.7}
      disabled={disabled}
    >
      <Text style={[styles.text, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    borderWidth: 1,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    alignItems: 'center',
    minWidth: 84,
  },
  text: { fontSize: 12, fontFamily: theme.fonts.monoBold, letterSpacing: 1 },
  disabled: { opacity: 0.4 },
});
