import { Alert } from 'react-native';
import { trpc } from '../lib/trpc';
import { useBotStore } from '../store/botStore';

/**
 * Bot status with 10s polling and optimistic START/STOP/PAUSE controls.
 * The UI updates instantly via the Zustand store, then reconciles with the
 * server response.
 */
export function useBotStatus() {
  const utils = trpc.useUtils();
  const status = trpc.trading.status.useQuery(undefined, {
    refetchInterval: 10_000,
  });

  const { setOptimisticRunning, setOptimisticPaused, optimisticRunning, optimisticPaused } =
    useBotStore();

  const onSettled = () => {
    setOptimisticRunning(null);
    setOptimisticPaused(null);
    utils.trading.status.invalidate();
    utils.trading.activity.invalidate();
  };

  const start = trpc.trading.start.useMutation({
    onMutate: () => setOptimisticRunning(true),
    onError: (err) => Alert.alert('Start blocked', err.message),
    onSettled,
  });
  const stop = trpc.trading.stop.useMutation({
    onMutate: () => setOptimisticRunning(false),
    onSettled,
  });
  const pause = trpc.trading.pause.useMutation({
    onMutate: () => setOptimisticPaused(!(status.data?.isPaused ?? false)),
    onSettled,
  });
  const scanNow = trpc.trading.scanNow.useMutation({
    onSettled: () => utils.trading.activity.invalidate(),
  });
  const emergencyKill = trpc.trading.emergencyKill.useMutation({
    onSuccess: (r) =>
      Alert.alert(
        'Emergency kill result',
        `Attempted ${r.attempted} · closed ${r.closed} · pending ${r.pending} · failed ${r.failed}`,
      ),
    onSettled,
  });

  const isRunning = optimisticRunning ?? status.data?.isRunning ?? false;
  const isPaused = optimisticPaused ?? status.data?.isPaused ?? false;
  const isLive = !(status.data?.dryRun ?? true);

  return {
    status: status.data,
    isLoading: status.isLoading,
    isRunning,
    isPaused,
    isLive,
    start: () => start.mutate(),
    stop: () => stop.mutate(),
    pause: () => pause.mutate(),
    scanNow: () => scanNow.mutate(),
    emergencyKill: () => emergencyKill.mutate(),
    isScanning: scanNow.isPending,
  };
}
