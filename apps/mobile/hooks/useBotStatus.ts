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

  const isRunning = optimisticRunning ?? status.data?.isRunning ?? false;
  const isPaused = optimisticPaused ?? status.data?.isPaused ?? false;

  return {
    status: status.data,
    isLoading: status.isLoading,
    isRunning,
    isPaused,
    start: () => start.mutate(),
    stop: () => stop.mutate(),
    pause: () => pause.mutate(),
    scanNow: () => scanNow.mutate(),
    isScanning: scanNow.isPending,
  };
}
