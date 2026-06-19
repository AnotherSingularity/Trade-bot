import { create } from 'zustand';

/**
 * Local bot-control UI state for optimistic updates. The server remains the
 * source of truth (polled via TanStack Query); this store only tracks the
 * optimistic intent so the controls feel instant.
 */
interface BotStore {
  optimisticRunning: boolean | null;
  optimisticPaused: boolean | null;
  setOptimisticRunning: (v: boolean | null) => void;
  setOptimisticPaused: (v: boolean | null) => void;
  reset: () => void;
}

export const useBotStore = create<BotStore>((set) => ({
  optimisticRunning: null,
  optimisticPaused: null,
  setOptimisticRunning: (v) => set({ optimisticRunning: v }),
  setOptimisticPaused: (v) => set({ optimisticPaused: v }),
  reset: () => set({ optimisticRunning: null, optimisticPaused: null }),
}));
