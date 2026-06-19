import { useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { trpc, createTrpcClient } from '../lib/trpc';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { theme } from '../theme';

/**
 * Root layout: wires up TanStack Query + tRPC providers, the global error
 * boundary, and the navigation stack (login + tabs).
 */
export default function RootLayout() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 5_000 },
        },
      }),
  );
  const [trpcClient] = useState(() => createTrpcClient());

  return (
    <ErrorBoundary>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <SafeAreaProvider>
            <StatusBar style="light" />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: theme.colors.bg },
              }}
            >
              <Stack.Screen name="login" />
              <Stack.Screen name="(tabs)" />
            </Stack>
          </SafeAreaProvider>
        </QueryClientProvider>
      </trpc.Provider>
    </ErrorBoundary>
  );
}
