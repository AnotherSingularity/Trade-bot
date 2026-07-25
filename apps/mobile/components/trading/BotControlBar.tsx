import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ConfirmButton } from '../ui/ConfirmButton';
import { theme } from '../../theme';

interface Props {
  isRunning: boolean;
  isPaused: boolean;
  isScanning: boolean;
  isLive: boolean;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  onScanNow: () => void;
  onEmergencyKill: () => void;
}

export function BotControlBar({
  isRunning,
  isPaused,
  isScanning,
  isLive,
  onStart,
  onStop,
  onPause,
  onScanNow,
  onEmergencyKill,
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
          <ConfirmButton
            label="START"
            color={isLive ? theme.colors.red : theme.colors.green}
            onConfirm={onStart}
            confirmTitle={isLive ? 'Start LIVE trading?' : 'Start bot?'}
            confirmMessage={
              isLive
                ? 'This will begin placing REAL orders on Coinbase against your account.'
                : 'This will begin scanning and (simulated) trading in DRY RUN mode.'
            }
            destructive={isLive}
          />
        ) : (
          <>
            <ConfirmButton
              label={isPaused ? 'RESUME' : 'PAUSE'}
              color={theme.colors.amber}
              onConfirm={onPause}
              confirmTitle={isPaused ? 'Resume entries?' : 'Pause new entries?'}
              confirmMessage={
                isPaused
                  ? 'The bot will begin evaluating new entries again.'
                  : 'The bot will stop opening new positions. Risk management continues.'
              }
            />
            <ConfirmButton
              label="STOP"
              color={theme.colors.red}
              onConfirm={onStop}
              confirmTitle="Stop bot?"
              confirmMessage="The recurring scan will stop. Open positions remain and continue to be managed on the server side."
              destructive
            />
          </>
        )}
        {isRunning ? (
          <ConfirmButton
            label="KILL"
            color={theme.colors.red}
            onConfirm={onEmergencyKill}
            confirmTitle="Emergency kill?"
            confirmMessage="Attempts to flatten ALL open positions immediately. Any failed exits will be reported."
            destructive
          />
        ) : null}
        <TouchableOpacity
          style={[styles.button, { borderColor: theme.colors.secondary }]}
          onPress={onScanNow}
          disabled={isScanning}
          activeOpacity={0.7}
        >
          {isScanning ? (
            <ActivityIndicator color={theme.colors.secondary} size="small" />
          ) : (
            <Text style={[styles.buttonText, { color: theme.colors.secondary }]}>SCAN</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
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
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { color: theme.colors.white, fontFamily: theme.fonts.monoBold, letterSpacing: 1 },
  buttons: { flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' },
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
