import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme } from '../../theme';

interface Props {
  isRunning: boolean;
  isPaused: boolean;
  isScanning: boolean;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  onScanNow: () => void;
}

export function BotControlBar({
  isRunning,
  isPaused,
  isScanning,
  onStart,
  onStop,
  onPause,
  onScanNow,
}: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.statusRow}>
        <View
          style={[
            styles.statusDot,
            {
              backgroundColor: !isRunning
                ? theme.colors.muted
                : isPaused
                  ? theme.colors.amber
                  : theme.colors.green,
            },
          ]}
        />
        <Text style={styles.statusText}>
          {!isRunning ? 'STOPPED' : isPaused ? 'PAUSED' : 'RUNNING'}
        </Text>
      </View>

      <View style={styles.buttons}>
        {!isRunning ? (
          <ControlButton label="START" color={theme.colors.green} onPress={onStart} />
        ) : (
          <>
            <ControlButton
              label={isPaused ? 'RESUME' : 'PAUSE'}
              color={theme.colors.amber}
              onPress={onPause}
            />
            <ControlButton label="STOP" color={theme.colors.red} onPress={onStop} />
          </>
        )}
        <ControlButton
          label={isScanning ? '…' : 'SCAN'}
          color={theme.colors.secondary}
          onPress={onScanNow}
          loading={isScanning}
        />
      </View>
    </View>
  );
}

function ControlButton({
  label,
  color,
  onPress,
  loading,
}: {
  label: string;
  color: string;
  onPress: () => void;
  loading?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.button, { borderColor: color }]}
      onPress={onPress}
      disabled={loading}
      activeOpacity={0.7}
    >
      {loading ? (
        <ActivityIndicator color={color} size="small" />
      ) : (
        <Text style={[styles.buttonText, { color }]}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { color: theme.colors.white, fontFamily: theme.fonts.monoBold, letterSpacing: 1 },
  buttons: { flexDirection: 'row', gap: theme.spacing.sm },
  button: {
    borderWidth: 1,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    minWidth: 64,
    alignItems: 'center',
  },
  buttonText: { fontSize: 12, fontFamily: theme.fonts.monoBold, letterSpacing: 1 },
});
