import { trpc } from '../lib/trpc';

/** Portfolio summary + open positions, polled every 10 seconds. */
export function usePortfolio() {
  const portfolio = trpc.trading.portfolio.useQuery(undefined, {
    refetchInterval: 10_000,
  });
  return {
    portfolio: portfolio.data,
    isLoading: portfolio.isLoading,
    refetch: portfolio.refetch,
  };
}

/** Recent activity feed, polled every 10 seconds. */
export function useActivity() {
  const activity = trpc.trading.activity.useQuery(
    { limit: 30 },
    { refetchInterval: 10_000 },
  );
  return {
    items: activity.data?.items ?? [],
    isLoading: activity.isLoading,
  };
}
