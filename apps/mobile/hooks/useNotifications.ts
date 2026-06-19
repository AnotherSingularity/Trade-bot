import { useEffect, useRef } from 'react';
import { trpc } from '../lib/trpc';
import { notifyTrade, requestNotificationPermissions } from '../lib/notifications';

/**
 * Watches the activity feed and fires a local notification whenever a new trade
 * (open/close) event appears. Tracks the last-seen id to avoid duplicates.
 */
export function useNotifications(enabled: boolean) {
  const lastSeenId = useRef<number | null>(null);
  const granted = useRef(false);

  const activity = trpc.trading.activity.useQuery(
    { limit: 10 },
    { refetchInterval: enabled ? 10_000 : false, enabled },
  );

  useEffect(() => {
    if (!enabled) return;
    requestNotificationPermissions().then((g) => {
      granted.current = g;
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !granted.current) return;
    const items = activity.data?.items ?? [];
    if (items.length === 0) return;

    const newestId = items[0].id;
    if (lastSeenId.current === null) {
      lastSeenId.current = newestId;
      return;
    }
    const fresh = items.filter((i) => i.id > (lastSeenId.current ?? 0) && i.type === 'trade');
    for (const entry of fresh.reverse()) {
      void notifyTrade(`${entry.token ?? 'Bot'} · ${entry.action}`, entry.detail);
    }
    lastSeenId.current = newestId;
  }, [activity.data, enabled]);
}
